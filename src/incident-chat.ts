import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDb } from "./db.js";
import { getLlmProvider } from "./llm.js";
import { loadAgentSpec } from "./agent-spec.js";
import { getIncidentWorkspace } from "./incident-memory.js";
import { superviseIncidentQuestion } from "./supervisor.js";
import type {
  DuckpipeConfig,
  IncidentChatAnswer,
  IncidentChatMessage,
  IncidentContext,
  InvestigationResult,
  StoryOutput,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

interface IncidentRunRecord {
  id: string;
  workflow: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  result_json: string | null;
}

const IncidentChatAnswerSchema = z.object({
  answer: z.string().min(10),
  evidenceIds: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  usedLiveData: z.boolean().default(false),
});

export function getSuggestedIncidentQuestions(context: IncidentContext): string[] {
  const modelName = inferModelNames(context)[0];
  const sourceTable = context.impact.affectedTables[0];
  const dagName = context.impact.affectedDags[0] ?? context.dag.dagId ?? "this DAG";

  return [
    `What exactly failed in ${dagName}?`,
    modelName ? `Show the dbt lineage for ${modelName}.` : "Show the relevant dbt lineage.",
    sourceTable ? `Did Snowflake find problems with ${sourceTable}?` : "What does Snowflake say about the impacted data?",
    "What should I check next, and who owns it?",
  ];
}

export function listIncidentChatMessages(incidentRunId: string): IncidentChatMessage[] {
  const db = getStateDb();
  const rows = db.prepare(
    `SELECT id, incident_run_id, role, content, metadata_json, created_at
     FROM incident_chat_messages
     WHERE incident_run_id = ?
     ORDER BY created_at ASC, id ASC`
  ).all(incidentRunId) as Array<{
    id: string;
    incident_run_id: string;
    role: "user" | "assistant";
    content: string;
    metadata_json: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    incidentRunId: row.incident_run_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as IncidentChatMessage["metadata"] : undefined,
  }));
}

export function getIncidentChatState(incidentRunId: string): {
  incidentRunId: string;
  context: IncidentContext;
  story: StoryOutput | null;
  messages: IncidentChatMessage[];
  suggestedQuestions: string[];
  workspace: ReturnType<typeof getIncidentWorkspace>;
} {
  const incident = getIncidentRun(incidentRunId);
  return {
    incidentRunId,
    context: incident.context,
    story: incident.story,
    messages: listIncidentChatMessages(incidentRunId),
    suggestedQuestions: getSuggestedIncidentQuestions(incident.context),
    workspace: getIncidentWorkspace(incidentRunId),
  };
}

export async function askIncidentQuestion(
  incidentRunId: string,
  question: string,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<{
  incidentRunId: string;
  message: IncidentChatMessage;
  messages: IncidentChatMessage[];
  suggestedQuestions: string[];
  workspace: ReturnType<typeof getIncidentWorkspace>;
}> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error("Question is required");
  }

  const incident = getIncidentRun(incidentRunId);
  const userMessage = insertIncidentChatMessage(incidentRunId, "user", trimmed);
  const priorMessages = listIncidentChatMessages(incidentRunId);

  // Fast path: answer directly from incident context + story with a single LLM call.
  // This avoids the slow supervisor loop (10+ agent dispatches through file bus).
  const t0 = Date.now();
  console.log(`[incident-chat] Fast-path for ${incidentRunId.slice(0, 8)}: "${trimmed.slice(0, 60)}"`);
  const fastAnswer = await fastPathAnswer(trimmed, incident.context, incident.story, priorMessages, config);
  if (fastAnswer) {
    console.log(`[incident-chat] Fast-path answered in ${Date.now() - t0}ms`);
    const workspace = getIncidentWorkspace(incidentRunId);
    const assistantMessage = insertIncidentChatMessage(incidentRunId, "assistant", fastAnswer.answer, {
      sources: fastAnswer.sources,
      evidenceIds: fastAnswer.evidenceIds,
      followUps: fastAnswer.followUps,
      usedLiveData: false,
    });
    return {
      incidentRunId,
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      suggestedQuestions: fastAnswer.followUps.length > 0 ? fastAnswer.followUps : getSuggestedIncidentQuestions(incident.context),
      workspace,
    };
  }

  // Slow path: full supervisor investigation (only if fast path fails)
  console.log(`[incident-chat] Fast-path failed, falling back to full supervisor`);
  const { investigation, workspace } = await superviseIncidentQuestion(
    incidentRunId,
    trimmed,
    incident.context,
    config,
    orchestrator,
  );
  const answer = await generateIncidentAnswer(trimmed, incident.context, incident.story, investigation, config);
  const assistantMessage = insertIncidentChatMessage(incidentRunId, "assistant", answer.answer, {
    sources: answer.sources,
    evidenceIds: answer.evidenceIds,
    followUps: answer.followUps,
    usedLiveData: answer.usedLiveData,
    investigation: answer.investigation,
  });

  return {
    incidentRunId,
    message: assistantMessage,
    messages: [userMessage, assistantMessage],
    suggestedQuestions: answer.followUps.length > 0 ? answer.followUps : getSuggestedIncidentQuestions(incident.context),
    workspace,
  };
}

async function fastPathAnswer(
  question: string,
  context: IncidentContext,
  story: StoryOutput | null,
  priorMessages: IncidentChatMessage[],
  config: DuckpipeConfig,
): Promise<IncidentChatAnswer | null> {
  try {
    const provider = getLlmProvider(config, "comms");

    const conversationHistory = priorMessages.slice(-6).map((m) =>
      `${m.role === "user" ? "User" : "DuckPipe"}: ${m.content.slice(0, 500)}`
    ).join("\n\n");

    const systemPrompt = [
      loadAgentSpec("comms"),
      "You are DuckPipe's incident investigator for data engineering teams (Airflow, dbt, Snowflake).",
      "Answer the user's question using ONLY the incident context and story provided below.",
      "Be specific, cite evidence IDs when relevant, and structure your answer with markdown.",
      "Include sections as appropriate: ## What Happened, ## Evidence, ## Root Cause, ## Impact, ## Next Steps.",
      "Never guess — if information is missing, say so clearly.",
      "Return strict JSON: { \"answer\": string, \"evidenceIds\": string[], \"followUps\": string[], \"sources\": string[] }",
    ].join("\n\n");

    const evidenceSummary = (context.evidence || []).slice(0, 5).map((e) =>
      `[${e.id}] (${e.source}) ${e.summary}`
    ).join("\n");

    const impactSummary = [
      `Severity: ${context.severity}`,
      `DAGs: ${context.impact.affectedDags.join(", ")}`,
      `Tables: ${context.impact.affectedTables.slice(0, 5).join(", ")}`,
      `Models: ${(context.impact.affectedModels || []).join(", ") || "none"}`,
      `Owner: ${context.impact.likelyOwner || "unknown"}`,
    ].join("\n");

    const prompt = [
      `Question: ${question}`,
      `\nIncident: ${context.incidentId} | Severity: ${context.severity} | DAG: ${context.dag.dagId ?? "unknown"}`,
      `Root Cause: ${context.candidateCauses?.[0]?.summary ?? "unknown"}`,
      `\nEvidence:\n${evidenceSummary || "No structured evidence"}`,
      `\nImpact:\n${impactSummary}`,
      story?.oncallSummary ? `\nOn-Call Summary:\n${story.oncallSummary.slice(0, 600)}` : "",
      story?.managerSummary ? `\nManager Summary:\n${story.managerSummary.slice(0, 400)}` : "",
      conversationHistory ? `\nPrior Conversation:\n${conversationHistory}` : "",
      "\nAnswer the question concisely with markdown formatting. Return JSON.",
    ].filter(Boolean).join("\n");

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    const parsed = IncidentChatAnswerSchema.parse(JSON.parse(normalized));
    return parsed;
  } catch (err) {
    console.error(`[incident-chat] Fast-path LLM error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function getIncidentRun(incidentRunId: string): {
  record: IncidentRunRecord;
  context: IncidentContext;
  story: StoryOutput | null;
} {
  const db = getStateDb();
  const row = db.prepare(
    `SELECT id, workflow, started_at, completed_at, status, result_json
     FROM workflow_runs
     WHERE id = ?
     LIMIT 1`
  ).get(incidentRunId) as IncidentRunRecord | undefined;

  if (!row) {
    throw new Error(`Incident ${incidentRunId} not found`);
  }

  const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
  const context = result.incidentContext as IncidentContext | undefined;
  if (!context) {
    throw new Error(
      `Incident ${incidentRunId} has no incident context. ` +
      `This run may be a healthy check (status: ${result.status ?? row.status}). ` +
      `Only real failures with detected issues can be investigated.`
    );
  }

  return {
    record: row,
    context,
    story: (result.storyOutput as StoryOutput | undefined) ?? null,
  };
}

function insertIncidentChatMessage(
  incidentRunId: string,
  role: IncidentChatMessage["role"],
  content: string,
  metadata?: IncidentChatMessage["metadata"],
): IncidentChatMessage {
  const db = getStateDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO incident_chat_messages (id, incident_run_id, role, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, incidentRunId, role, content, metadata ? JSON.stringify(metadata) : null, createdAt);

  return {
    id,
    incidentRunId,
    role,
    content,
    createdAt,
    metadata,
  };
}

async function generateIncidentAnswer(
  question: string,
  context: IncidentContext,
  story: StoryOutput | null,
  investigation: InvestigationResult,
  config: DuckpipeConfig,
): Promise<IncidentChatAnswer> {
  return (await generateIncidentAnswerWithLlm(question, context, story, investigation, config))
    ?? generateIncidentAnswerFallback(question, context, story, investigation);
}

async function generateIncidentAnswerWithLlm(
  question: string,
  context: IncidentContext,
  story: StoryOutput | null,
  investigation: InvestigationResult,
  config: DuckpipeConfig,
): Promise<IncidentChatAnswer | null> {
  try {
    const provider = getLlmProvider(config, "comms");
    const systemPrompt = [
      loadAgentSpec("comms"),
      "You are DuckPipe's autonomous incident investigator for data engineering teams (Airflow, dbt, Snowflake).",
      "Answer only from the provided incident context and structured investigation result.",
      "Never guess. If evidence is missing, say what is still unknown.",
      "The investigation includes a self-critique phase and auto-investigated follow-up questions.",
      "Structure your answer with markdown: use ## headings for sections, **bold** for key terms, and bullet lists for facts.",
      "Include these sections: Best Explanation, Supporting Evidence, Critique & Follow-ups (if any), Remaining Unknowns, Recommended Next Steps.",
      "Return strict JSON only with keys: answer, evidenceIds, followUps, sources, usedLiveData.",
    ].join("\n\n");

    const critiqueContext = investigation.critique
      ? `\nCritique: ${JSON.stringify(investigation.critique)}`
      : "";
    const followUpContext = (investigation.followUpInvestigations ?? []).length > 0
      ? `\nAuto-investigated follow-ups: ${JSON.stringify(investigation.followUpInvestigations!.map((fu) => ({ question: fu.question, summary: fu.result.summary, facts: fu.result.facts.slice(0, 3) })))}`
      : "";

    const prompt = [
      `Question: ${question}`,
      `IncidentContext: ${JSON.stringify(context)}`,
      `StoryOutput: ${JSON.stringify(story)}`,
      `InvestigationResult: ${JSON.stringify(investigation)}`,
      critiqueContext,
      followUpContext,
      "Write a crisp, markdown-formatted answer covering: best explanation, supporting evidence, critique insights, remaining unknowns, and next steps.",
    ].filter(Boolean).join("\n\n");

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    const parsed = IncidentChatAnswerSchema.parse(JSON.parse(normalized));
    return { ...parsed, investigation };
  } catch {
    return null;
  }
}

function generateIncidentAnswerFallback(
  question: string,
  context: IncidentContext,
  story: StoryOutput | null,
  investigation: InvestigationResult,
): IncidentChatAnswer {
  const lines: string[] = [];
  const opening = story?.oncallSummary?.split("\n").slice(0, 2).join(" ")
    ?? `Incident ${context.incidentId} is under investigation.`;
  lines.push(opening);
  lines.push(`*Playbook: ${investigation.playbook}*`);

  if (investigation.hypotheses[0]) {
    lines.push(`\n## Best Explanation\n**${investigation.hypotheses[0].summary}** (confidence: ${investigation.hypotheses[0].confidence})`);
  }
  if (investigation.facts.length > 0) {
    lines.push("\n## Supporting Evidence");
    for (const fact of investigation.facts.slice(0, 4)) {
      lines.push(`- **${fact.source}**: ${fact.summary}`);
    }
  }

  // Critique & follow-up results
  const critique = investigation.critique;
  const followUpInvs = investigation.followUpInvestigations ?? [];
  if (critique && (critique.questions.length > 0 || followUpInvs.length > 0)) {
    lines.push("\n## Critique & Follow-ups");
    if (critique.confidence !== "low") {
      lines.push(`Critique confidence: **${critique.confidence}**`);
    }
    for (const fu of followUpInvs) {
      lines.push(`- **Q: ${fu.question}** \u2192 ${fu.result.summary}`);
    }
    const unansweredCritique = critique.questions.filter(
      (q) => !followUpInvs.some((fu) => fu.question === q),
    );
    for (const q of unansweredCritique.slice(0, 2)) {
      lines.push(`- *Still to investigate:* ${q}`);
    }
  }

  if (investigation.unknowns.length > 0) {
    lines.push("\n## Remaining Unknowns");
    for (const item of investigation.unknowns.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  }
  if (investigation.nextChecks.length > 0) {
    lines.push("\n## Recommended Next Steps");
    for (const item of investigation.nextChecks.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  }

  if (investigation.subAgents && investigation.subAgents.length > 0) {
    lines.push(`\n---\n*Investigation depth: ${investigation.investigationDepth ?? 1} | Sub-agents: ${investigation.subAgents.map((a) => a.name).join(", ")} | Follow-ups auto-investigated: ${followUpInvs.length}*`);
  }

  const followUps = buildFollowUps(question, context, investigation);
  return {
    answer: lines.join("\n"),
    evidenceIds: investigation.evidenceIds,
    followUps,
    sources: investigation.sources,
    usedLiveData: investigation.usedLiveData,
    investigation,
  };
}

function buildFollowUps(
  question: string,
  context: IncidentContext,
  investigation: InvestigationResult,
): string[] {
  const lower = question.toLowerCase();
  const modelName = inferModelNames(context)[0];
  const sourceTable = context.impact.affectedTables[0] ?? investigation.sources.find((item) => item.startsWith("snowflake:"))?.replace(/^snowflake:/, "");

  // Prioritize remaining unknowns and unanswered critique questions
  const autoInvestigated = new Set((investigation.followUpInvestigations ?? []).map((fu) => fu.question.toLowerCase().trim()));
  const remainingCritiqueQs = (investigation.critique?.questions ?? [])
    .filter((q) => !autoInvestigated.has(q.toLowerCase().trim()));
  const remainingUnknowns = investigation.unknowns
    .filter((u) => !autoInvestigated.has(u.toLowerCase().trim()))
    .map((item) => item.endsWith("?") ? item : `${item.replace(/\.$/, "")}?`);

  if (remainingCritiqueQs.length > 0 || remainingUnknowns.length > 0) {
    return uniq([
      ...remainingCritiqueQs,
      ...remainingUnknowns,
      ...investigation.nextChecks.map((item) => item.endsWith("?") ? item : `${item.replace(/\.$/, "")}?`),
    ]).slice(0, 4);
  }

  if (/owner|next|fix/.test(lower)) {
    return [
      modelName ? `Show the dbt lineage for ${modelName}.` : "Show the relevant dbt lineage.",
      sourceTable ? `Does ${sourceTable} exist in the current Snowflake target?` : "Which Snowflake object is missing?",
      "What evidence supports the current hypothesis?",
    ];
  }
  if (/snowflake|object|table|permission/.test(lower)) {
    return [
      modelName ? `Which dbt sources feed ${modelName}?` : "Which dbt model depends on this source?",
      "Is this a permissions issue or a missing object?",
      "Who should fix this and what is the next step?",
    ];
  }
  if (/dbt|lineage|model|source/.test(lower)) {
    return [
      sourceTable ? `Did Snowflake find ${sourceTable} during schema scans?` : "Did Snowflake confirm the upstream source exists?",
      "What changed in dbt recently?",
      "What should the on-call engineer do next?",
    ];
  }

  return uniq([
    ...investigation.nextChecks.map((item) => item.endsWith("?") ? item : `${item.replace(/\.$/, "")}?`),
    ...getSuggestedIncidentQuestions(context),
  ]).slice(0, 4);
}

function inferModelNames(context: IncidentContext): string[] {
  const names = new Set<string>(context.impact.affectedModels ?? []);
  for (const task of context.dag.failedTasks) {
    const inferred = task.taskId.replace(/\.(run|test|seed|snapshot)$/, "");
    if (inferred && inferred !== task.taskId) names.add(inferred);
  }
  return [...names].filter(Boolean);
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean);
}
