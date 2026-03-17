import { getIncidentWorkspace, updateIncidentWorkspace, workspaceFromInvestigation } from "./incident-memory.js";
import { investigateIncidentQuestion } from "./investigator.js";
import { runIncidentSubAgents } from "./subagents.js";
import type {
  DuckpipeConfig,
  IncidentContext,
  InvestigationResult,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

export async function superviseIncidentQuestion(
  incidentRunId: string,
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<{ investigation: InvestigationResult; workspace: ReturnType<typeof getIncidentWorkspace> }> {
  const primary = await investigateIncidentQuestion(question, context, config, orchestrator);
  const subAgentRuns = await runIncidentSubAgents(question, context, config, orchestrator);
  const merged = mergeInvestigations(incidentRunId, primary, subAgentRuns);

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

  return { investigation: merged, workspace };
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
