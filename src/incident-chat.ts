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

function getIncidentRun(incidentRunId: string): {
  record: IncidentRunRecord;
  context: IncidentContext;
  story: StoryOutput | null;
} {
  const db = getStateDb();
  const row = db.prepare(
    `SELECT id, workflow, started_at, completed_at, status, result_json
     FROM workflow_runs
     WHERE id = ? AND workflow = 'incident-autopilot'
     LIMIT 1`
  ).get(incidentRunId) as IncidentRunRecord | undefined;

  if (!row) {
    throw new Error(`Incident ${incidentRunId} not found`);
  }

  const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
  const context = result.incidentContext as IncidentContext | undefined;
  if (!context) {
    throw new Error(`Incident ${incidentRunId} has no incident context`);
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
      "You are DuckPipe's incident investigator.",
      "Answer only from the provided incident context and structured investigation result.",
      "Never guess. If evidence is missing, say what is still unknown.",
      "Return strict JSON only with keys: answer, evidenceIds, followUps, sources, usedLiveData.",
    ].join("\n\n");

    const prompt = [
      `Question: ${question}`,
      `IncidentContext: ${JSON.stringify(context)}`,
      `StoryOutput: ${JSON.stringify(story)}`,
      `InvestigationResult: ${JSON.stringify(investigation)}`,
      "Write a crisp answer that explains the current best explanation, supporting facts, unknowns, and next checks.",
    ].join("\n\n");

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
  lines.push(`Playbook: ${investigation.playbook}.`);

  if (investigation.hypotheses[0]) {
    lines.push(`Best current explanation: ${investigation.hypotheses[0].summary}`);
  }
  if (investigation.facts.length > 0) {
    lines.push("Key facts:");
    for (const fact of investigation.facts.slice(0, 3)) {
      lines.push(`- ${fact.summary}`);
    }
  }
  if (investigation.unknowns.length > 0) {
    lines.push("Still unknown:");
    for (const item of investigation.unknowns.slice(0, 2)) {
      lines.push(`- ${item}`);
    }
  }
  if (investigation.nextChecks.length > 0) {
    lines.push("Next checks:");
    for (const item of investigation.nextChecks.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
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
