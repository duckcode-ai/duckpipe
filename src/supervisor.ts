import { getIncidentWorkspace, updateIncidentWorkspace, workspaceFromInvestigation } from "./incident-memory.js";
import { investigateIncidentQuestion } from "./investigator.js";
import { getLlmProvider } from "./llm.js";
import { runIncidentSubAgents } from "./subagents.js";
import type {
  CritiqueResult,
  DuckpipeConfig,
  FollowUpInvestigation,
  IncidentContext,
  InvestigationHypothesis,
  InvestigationResult,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

const MAX_CRITIQUE_QUESTIONS = 3;
const MAX_FOLLOWUP_INVESTIGATIONS = 2;

// Hard timeout for the entire investigation to prevent infinite hangs (90 seconds)
const SUPERVISOR_TIMEOUT_MS = 90_000;

export async function superviseIncidentQuestion(
  incidentRunId: string,
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<{ investigation: InvestigationResult; workspace: ReturnType<typeof getIncidentWorkspace> }> {
  const t0 = Date.now();
  const tag = `[supervisor ${incidentRunId.slice(0, 8)}]`;

  // Wrap the full investigation in a timeout so the HTTP handler never hangs
  return Promise.race([
    runSupervision(incidentRunId, question, context, config, orchestrator, tag, t0),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Investigation timed out after ${SUPERVISOR_TIMEOUT_MS / 1000}s`)), SUPERVISOR_TIMEOUT_MS),
    ),
  ]);
}

async function runSupervision(
  incidentRunId: string,
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  tag: string,
  t0: number,
): Promise<{ investigation: InvestigationResult; workspace: ReturnType<typeof getIncidentWorkspace> }> {
  console.log(`${tag} Starting investigation: "${question.slice(0, 80)}"`);

  // Phase 1: Primary investigation + parallel sub-agents
  console.log(`${tag} Phase 1: primary + sub-agents (parallel)`);
  const [primary, subAgentRuns] = await Promise.all([
    investigateIncidentQuestion(question, context, config, orchestrator),
    runIncidentSubAgents(question, context, config, orchestrator),
  ]);
  const merged = mergeInvestigations(incidentRunId, primary, subAgentRuns);
  console.log(`${tag} Phase 1 done in ${Date.now() - t0}ms — facts=${merged.facts.length} hypotheses=${merged.hypotheses.length}`);

  // Phase 2: Single critique + follow-up round (keep it fast for interactive chat)
  const MAX_DEPTH = 1;
  let depth = 0;
  let allFollowUps: FollowUpInvestigation[] = [];

  while (depth < MAX_DEPTH) {
    depth++;

    // Bail early if we're running out of time
    if (Date.now() - t0 > SUPERVISOR_TIMEOUT_MS * 0.7) {
      console.log(`${tag} Time budget exhausted, skipping further critique`);
      break;
    }

    console.log(`${tag} Phase 2 depth=${depth}: critique`);
    const critique = await critiqueHypotheses(merged, context, config);
    merged.critique = critique;
    console.log(`${tag} Critique confidence=${critique.confidence} questions=${critique.questions.length}`);

    if (critique.confidence === "high") break;

    const followUpQuestions = selectFollowUpQuestions(critique, merged.unknowns);
    if (followUpQuestions.length === 0) break;

    console.log(`${tag} Phase 2 depth=${depth}: investigating ${followUpQuestions.length} follow-ups`);
    const followUps = await investigateFollowUps(followUpQuestions, context, config, orchestrator);
    allFollowUps = [...allFollowUps, ...followUps];

    applyFollowUpResults(merged, followUps, critique);
  }

  merged.followUpInvestigations = allFollowUps;
  merged.investigationDepth = depth;

  const workspace = updateIncidentWorkspace(incidentRunId, {
    facts: merged.facts,
    hypotheses: merged.hypotheses,
    openQuestions: merged.unknowns,
    subAgents: workspaceFromInvestigation(incidentRunId, merged),
    incrementConversation: true,
  });

  merged.workspace = {
    incidentRunId,
    factCount: workspace.facts.length,
    hypothesisCount: workspace.hypotheses.length,
    messageCount: workspace.conversationCount,
    openQuestions: workspace.openQuestions.slice(0, 5),
    lastUpdated: workspace.lastUpdated,
  };

  console.log(`${tag} Investigation complete in ${Date.now() - t0}ms — depth=${depth} followUps=${allFollowUps.length}`);
  return { investigation: merged, workspace };
}

async function critiqueHypotheses(
  investigation: InvestigationResult,
  context: IncidentContext,
  config: DuckpipeConfig,
): Promise<CritiqueResult> {
  try {
    const provider = getLlmProvider(config, "comms");
    const systemPrompt = [
      "You are an expert incident analysis critic for data engineering incidents (Airflow, dbt, Snowflake).",
      "Given an investigation's hypotheses, facts, and unknowns, you must:",
      "1. Evaluate each hypothesis for weaknesses or gaps in evidence.",
      "2. Generate 2-3 specific testing questions that would confirm or rule out the hypotheses.",
      "3. Refine hypothesis confidence levels based on available evidence.",
      "Return strict JSON only: { \"questions\": string[], \"refinedHypotheses\": [{\"id\": string, \"summary\": string, \"status\": \"supported\"|\"possible\"|\"rejected\", \"confidence\": \"high\"|\"medium\"|\"low\"}], \"confidence\": \"high\"|\"medium\"|\"low\" }",
    ].join("\n");

    const prompt = [
      `Incident: ${context.incidentId} (${context.severity}) — DAG: ${context.dag.dagId ?? "unknown"}`,
      `Hypotheses: ${JSON.stringify(investigation.hypotheses)}`,
      `Facts: ${JSON.stringify(investigation.facts.slice(0, 6))}`,
      `Unknowns: ${JSON.stringify(investigation.unknowns)}`,
      `Next checks: ${JSON.stringify(investigation.nextChecks)}`,
      "Critique these hypotheses. What questions would test them? What evidence is missing?",
    ].join("\n\n");

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(normalized) as CritiqueResult;

    return {
      questions: (parsed.questions ?? []).slice(0, MAX_CRITIQUE_QUESTIONS),
      refinedHypotheses: (parsed.refinedHypotheses ?? []).slice(0, 6),
      confidence: parsed.confidence ?? "medium",
    };
  } catch {
    return { questions: [], refinedHypotheses: [], confidence: "low" };
  }
}

function selectFollowUpQuestions(critique: CritiqueResult, unknowns: string[]): string[] {
  const candidates = [
    ...critique.questions,
    ...unknowns.filter((u) => u.endsWith("?") || u.length > 20),
  ];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const q of candidates) {
    const key = q.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(q);
    if (selected.length >= MAX_FOLLOWUP_INVESTIGATIONS) break;
  }
  return selected;
}

async function investigateFollowUps(
  questions: string[],
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<FollowUpInvestigation[]> {
  if (questions.length === 0) return [];

  const results = await Promise.all(
    questions.map(async (question) => {
      const result = await investigateIncidentQuestion(question, context, config, orchestrator);
      return { question, result };
    }),
  );
  return results;
}

function applyFollowUpResults(
  merged: InvestigationResult,
  followUps: FollowUpInvestigation[],
  critique: CritiqueResult,
): void {
  // Merge facts from follow-ups
  for (const fu of followUps) {
    for (const fact of fu.result.facts) {
      if (!merged.facts.some((f) => f.id === fact.id || f.summary === fact.summary)) {
        merged.facts.push(fact);
      }
    }
    // Merge hypotheses from follow-ups
    for (const hyp of fu.result.hypotheses) {
      const existing = merged.hypotheses.find((h) => h.id === hyp.id || h.summary === hyp.summary);
      if (existing) {
        existing.status = hyp.status;
        existing.confidence = hyp.confidence;
      } else {
        merged.hypotheses.push(hyp);
      }
    }
    // Add follow-up steps
    for (const step of fu.result.steps) {
      merged.steps.push({ ...step, id: `followup-${step.id}`, title: `[Follow-up] ${step.title}` });
    }
  }

  // Apply refined hypotheses from critique
  for (const refined of critique.refinedHypotheses) {
    const existing = merged.hypotheses.find((h) => h.id === refined.id);
    if (existing) {
      existing.confidence = refined.confidence;
      existing.status = refined.status;
    }
  }

  // Remove unknowns that were answered by follow-ups
  const answeredQuestions = new Set(followUps.map((fu) => fu.question.toLowerCase().trim()));
  merged.unknowns = merged.unknowns.filter((u) => !answeredQuestions.has(u.toLowerCase().trim()));

  // Update summary with critique context
  const critiqueNote = critique.confidence !== "low"
    ? `Critique confidence: ${critique.confidence}. ${followUps.length} follow-up investigation(s) completed.`
    : "";
  if (critiqueNote) {
    merged.summary = `${merged.summary} ${critiqueNote}`;
  }

  // Cap arrays
  merged.facts = merged.facts.slice(0, 12);
  merged.hypotheses = merged.hypotheses.slice(0, 8);
  merged.steps = merged.steps.slice(0, 25);
}

function mergeInvestigations(
  incidentRunId: string,
  primary: InvestigationResult,
  subAgentRuns: Awaited<ReturnType<typeof runIncidentSubAgents>>,
): InvestigationResult {
  const facts = dedupeBySummary([
    ...primary.facts,
    ...subAgentRuns.flatMap((run) => run.result.facts),
  ]);

  const hypotheses = dedupeHypotheses([
    ...primary.hypotheses,
    ...subAgentRuns.flatMap((run) => run.result.hypotheses),
  ]);

  const unknowns = uniq([
    ...primary.unknowns,
    ...subAgentRuns.flatMap((run) => run.result.unknowns),
  ]);

  const nextChecks = uniq([
    ...primary.nextChecks,
    ...subAgentRuns.flatMap((run) => run.result.nextChecks),
  ]);

  const sources = uniq([
    ...primary.sources,
    ...subAgentRuns.flatMap((run) => run.result.sources),
  ]);

  const evidenceIds = uniq([
    ...primary.evidenceIds,
    ...subAgentRuns.flatMap((run) => run.result.evidenceIds),
  ]);

  const steps = [
    ...primary.steps,
    ...subAgentRuns.flatMap((run) => run.result.steps),
  ];

  const subAgents = subAgentRuns.map((run) => ({
    name: run.name,
    focus: run.focus,
    summary: run.result.summary,
    usedLiveData: run.result.usedLiveData,
  }));

  return {
    ...primary,
    summary: [
      primary.summary,
      subAgents.length > 0 ? `Sub-agents consulted: ${subAgents.map((item) => item.name).join(", ")}.` : null,
      nextChecks[0] ? `Supervisor next check: ${nextChecks[0]}` : null,
    ].filter(Boolean).join(" "),
    facts: facts.slice(0, 10),
    hypotheses: hypotheses.slice(0, 6),
    unknowns: unknowns.slice(0, 6),
    nextChecks: nextChecks.slice(0, 6),
    sources,
    evidenceIds,
    usedLiveData: primary.usedLiveData || subAgentRuns.some((run) => run.result.usedLiveData),
    steps: steps.slice(0, 20),
    objectChecks: dedupeObjectChecks([
      ...(primary.objectChecks ?? []),
      ...subAgentRuns.flatMap((run) => run.result.objectChecks ?? []),
    ]),
    lineage: primary.lineage ?? subAgentRuns.find((run) => (run.result.lineage?.failingModels.length ?? 0) > 0)?.result.lineage,
    priorIncidents: dedupePriorIncidents([
      ...(primary.priorIncidents ?? []),
      ...subAgentRuns.flatMap((run) => run.result.priorIncidents ?? []),
    ]),
    externalContext: {
      slackMentions: dedupeExternalItems([
        ...(primary.externalContext?.slackMentions ?? []),
        ...subAgentRuns.flatMap((run) => run.result.externalContext?.slackMentions ?? []),
      ], (item) => `${item.channel}:${item.ts}:${item.text}`),
      jiraIssues: dedupeExternalItems([
        ...(primary.externalContext?.jiraIssues ?? []),
        ...subAgentRuns.flatMap((run) => run.result.externalContext?.jiraIssues ?? []),
      ], (item) => `${item.key}:${item.summary}`),
      confluencePages: dedupeExternalItems([
        ...(primary.externalContext?.confluencePages ?? []),
        ...subAgentRuns.flatMap((run) => run.result.externalContext?.confluencePages ?? []),
      ], (item) => `${item.id}:${item.title}`),
    },
    subAgents,
    workspace: {
      incidentRunId,
      factCount: facts.length,
      hypothesisCount: hypotheses.length,
      messageCount: 0,
      openQuestions: unknowns.slice(0, 5),
      lastUpdated: new Date().toISOString(),
    },
  };
}

function dedupeBySummary<T extends { summary: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.summary)) continue;
    seen.add(item.summary);
    out.push(item);
  }
  return out;
}

function dedupeHypotheses<T extends { id: string; summary: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.id}:${item.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeObjectChecks<T extends { objectName: string; status: string; detail: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.objectName}:${item.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupePriorIncidents<T extends { incidentRunId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.incidentRunId)) continue;
    seen.add(item.incidentRunId);
    out.push(item);
  }
  return out;
}

function dedupeExternalItems<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean) as T[];
}
