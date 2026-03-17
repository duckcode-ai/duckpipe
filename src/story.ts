import { z } from "zod";
import { getLlmProvider } from "./llm.js";
import { loadAgentSpec } from "./agent-spec.js";
import type {
  CauseAssessment,
  DuckpipeConfig,
  IncidentContext,
  IncidentEvidence,
  StoryOutput,
} from "./types.js";

const StoryOutputSchema = z.object({
  oncallSummary: z.string().min(10),
  managerSummary: z.string().min(10),
  knowledgeSummary: z.string().min(10),
  topEvidence: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
});

export function buildCandidateCauses(
  rootCause: string,
  category: CauseAssessment["category"],
  evidence: IncidentEvidence[],
  anomaliesFound: boolean,
  dbtChangesFound: boolean
): CauseAssessment[] {
  const evidenceIds = evidence.slice(0, 4).map((item) => item.id);
  const causes: CauseAssessment[] = [
    {
      id: "cause-primary",
      category,
      summary: rootCause,
      confidence: evidenceIds.length > 0 ? "high" : "low",
      evidenceIds,
    },
  ];

  if (anomaliesFound && category !== "data_anomaly") {
    causes.push({
      id: "cause-data-anomaly",
      category: "data_anomaly",
      summary: "Upstream source data anomaly may have contributed to the incident.",
      confidence: "medium",
      evidenceIds,
      inference: "Snowflake anomaly checks found suspicious source-table signals.",
    });
  }

  if (dbtChangesFound && category !== "schema_drift") {
    causes.push({
      id: "cause-dbt-change",
      category: "schema_drift",
      summary: "A recent dbt change may have changed downstream behavior around the failing pipeline.",
      confidence: "medium",
      evidenceIds,
      inference: "Recent dbt changes overlapped with the incident window.",
    });
  }

  return causes;
}

export async function generateIncidentStory(
  context: IncidentContext,
  config?: DuckpipeConfig
): Promise<StoryOutput> {
  return (await generateWithLlm(context, config)) ?? generateFallbackStory(context);
}

async function generateWithLlm(
  context: IncidentContext,
  config?: DuckpipeConfig
): Promise<StoryOutput | null> {
  try {
    const provider = getLlmProvider(config, "comms");
    const systemPrompt = [
      loadAgentSpec("comms"),
      "Return strict JSON only.",
      "Never guess. Separate facts from inference. Cite evidence ids in prose when possible.",
      "Write for a data-engineering on-call audience first, then leadership, then knowledge capture.",
    ].filter(Boolean).join("\n\n");

    const prompt = [
      "Generate a structured incident story from this IncidentContext.",
      "Return JSON with keys: oncallSummary, managerSummary, knowledgeSummary, topEvidence, unknowns.",
      "Use concise markdown-friendly text.",
      JSON.stringify(context),
    ].join("\n\n");

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    return StoryOutputSchema.parse(JSON.parse(normalized));
  } catch {
    return null;
  }
}

function generateFallbackStory(context: IncidentContext): StoryOutput {
  const likelyCause = context.candidateCauses[0]?.summary ?? "Cause is still unclear";
  const blastRadius = context.impact.blastRadius.slice(0, 5).map((asset) => `${asset.kind}:${asset.name}`);
  const evidence = context.evidence.slice(0, 3).map((item) => `${item.id}: ${item.summary}`);
  const action = context.recommendedActions[0]?.summary ?? "Investigate manually";
  const owner = context.impact.likelyOwner ?? "Data engineering on-call";

  return {
    oncallSummary: [
      `${severityEmoji(context.severity)} *${context.severity} Incident — ${context.impact.affectedDags[0] ?? "pipeline"}*`,
      `What happened: ${likelyCause}`,
      `Impact: ${context.impact.affectedDags.length} DAG(s), ${context.impact.affectedTables.length} table(s), ${context.impact.affectedModels.length} model(s) in scope.`,
      `Top evidence: ${evidence.length > 0 ? evidence.join(" | ") : "No strong evidence yet."}`,
      `Next step: ${action}`,
      `Owner: ${owner}`,
      `_Execution mode: ${context.securityMode.actionMode} (tier ${context.securityMode.trustTier})_`,
    ].join("\n"),
    managerSummary: [
      `${context.impact.affectedDags[0] ?? "A pipeline"} is degraded with severity ${context.severity}.`,
      `Probable cause: ${likelyCause}.`,
      `Current blast radius: ${blastRadius.length > 0 ? blastRadius.join(", ") : "still being determined"}.`,
      `Immediate action: ${action}.`,
    ].join(" "),
    knowledgeSummary: [
      `## Incident Summary`,
      `- Incident ID: ${context.incidentId}`,
      `- Severity: ${context.severity}`,
      `- Trigger: ${context.triggerSource}`,
      `- Primary cause: ${likelyCause}`,
      ``,
      `## Evidence`,
      ...context.evidence.slice(0, 10).map((item) => `- [${item.id}] ${item.summary}`),
      ``,
      `## Impact`,
      `- Affected DAGs: ${context.impact.affectedDags.join(", ") || "none"}`,
      `- Affected tables: ${context.impact.affectedTables.join(", ") || "none"}`,
      `- Affected models: ${context.impact.affectedModels.join(", ") || "none"}`,
      `- Likely owner: ${owner}`,
      ``,
      `## Next Action`,
      `- ${action}`,
    ].join("\n"),
    topEvidence: evidence,
    unknowns: context.evidence.length === 0 ? ["No strong evidence captured yet."] : [],
  };
}

function severityEmoji(severity: IncidentContext["severity"]): string {
  return severity === "P1" ? "🔴" : severity === "P2" ? "🟡" : "🟢";
}
