import { getStateDb } from "./db.js";
import { investigateIncidentQuestion } from "./investigator.js";
import { getLlmProvider } from "./llm.js";
import { runIncidentSubAgents } from "./subagents.js";
import type {
  DuckpipeConfig,
  IncidentContext,
  InvestigationFact,
  RetroLevel,
  RetroReport,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LEVELS = 5;
const RETRO_TIMEOUT_MS = 180_000; // 3 minutes hard cap
const LEVEL_TIMEOUT_MS = 45_000; // 45s per level

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const RETRO_QUESTIONS: Array<{ depth: number; template: (ctx: IncidentContext) => string }> = [
  {
    depth: 1,
    template: (ctx) => {
      const dag = ctx.dag.dagId ?? ctx.impact.affectedDags[0] ?? "the pipeline";
      return `What exactly happened when ${dag} failed? Describe the execution path, the failing task, and the exact error.`;
    },
  },
  {
    depth: 2,
    template: (ctx) => {
      const cause = ctx.candidateCauses?.[0]?.summary ?? "the failure";
      return `Why did ${cause} occur? Trace the root cause through dbt lineage, Snowflake object state, and permissions.`;
    },
  },
  {
    depth: 3,
    template: (_ctx) =>
      "What changed in the last 24 hours that could have caused this? Check dbt model changes, Snowflake schema changes, deployment history, and config changes.",
  },
  {
    depth: 4,
    template: (ctx) => {
      const tables = ctx.impact.affectedTables.slice(0, 3).join(", ") || "affected tables";
      return `What is the full blast radius? Which downstream models, dashboards, reports, and SLAs depend on ${tables}?`;
    },
  },
  {
    depth: 5,
    template: (_ctx) =>
      "Has this exact issue or a similar pattern happened before? Check prior incidents, Slack discussions, Jira tickets, and Confluence runbooks for historical context and known fixes.",
  },
];

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function upsertRetroReport(report: RetroReport): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO incident_retro_reports (incident_run_id, report_json, status, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(incident_run_id) DO UPDATE SET
       report_json = excluded.report_json,
       status = excluded.status,
       completed_at = excluded.completed_at`,
  ).run(
    report.incidentRunId,
    JSON.stringify(report),
    report.status,
    report.startedAt,
    report.completedAt,
  );
}

export function getRetroReport(incidentRunId: string): RetroReport | null {
  const db = getStateDb();
  const row = db.prepare(
    `SELECT report_json FROM incident_retro_reports WHERE incident_run_id = ?`,
  ).get(incidentRunId) as { report_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.report_json) as RetroReport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sufficiency check — LLM decides if we have enough to explain the incident
// ---------------------------------------------------------------------------

async function checkSufficiency(
  levels: RetroLevel[],
  context: IncidentContext,
  config: DuckpipeConfig,
): Promise<{ sufficient: boolean; confidence: "high" | "medium" | "low"; reason: string }> {
  try {
    const provider = getLlmProvider(config, "comms");

    const levelSummaries = levels
      .map((l) => `Level ${l.depth} (${l.confidence}): Q: ${l.question.slice(0, 100)} → A: ${l.answer.slice(0, 200)}`)
      .join("\n");

    const prompt = [
      `Incident: ${context.incidentId} | Severity: ${context.severity} | DAG: ${context.dag.dagId ?? "unknown"}`,
      `Root cause candidate: ${context.candidateCauses?.[0]?.summary ?? "unknown"}`,
      "",
      "Investigation levels completed so far:",
      levelSummaries,
      "",
      `Total facts gathered: ${levels.reduce((sum, l) => sum + l.facts.length, 0)}`,
      "",
      "Do we have enough information to:",
      "1. Explain what happened and why?",
      "2. Identify the root cause chain?",
      "3. Propose a concrete solution?",
      "",
      'Return JSON: { "sufficient": boolean, "confidence": "high"|"medium"|"low", "reason": "..." }',
    ].join("\n");

    const systemPrompt =
      "You are an incident analysis quality judge. Evaluate whether the investigation has gathered enough evidence to produce a useful retrospective. Be practical — don't demand perfection, but ensure the core 'why' is answered.";

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(normalized);
    return {
      sufficient: Boolean(parsed.sufficient),
      confidence: parsed.confidence ?? "medium",
      reason: String(parsed.reason ?? ""),
    };
  } catch (err) {
    console.error(`[retro-runner] Sufficiency check error: ${err instanceof Error ? err.message : String(err)}`);
    return { sufficient: false, confidence: "low", reason: "Sufficiency check failed" };
  }
}

// ---------------------------------------------------------------------------
// Final synthesis — produce root cause chain + solution from all levels
// ---------------------------------------------------------------------------

async function synthesizeRetro(
  levels: RetroLevel[],
  context: IncidentContext,
  config: DuckpipeConfig,
): Promise<{ rootCauseChain: string[]; solutionApproach: string; confidence: "high" | "medium" | "low" }> {
  try {
    const provider = getLlmProvider(config, "comms");

    const levelDetails = levels
      .map((l) => `### Level ${l.depth}: ${l.question}\n${l.answer}\nFacts: ${l.facts.map((f) => f.summary).join("; ")}\nSources: ${l.sources.join(", ")}`)
      .join("\n\n");

    const prompt = [
      `Incident: ${context.incidentId} | Severity: ${context.severity}`,
      `DAG: ${context.dag.dagId ?? "unknown"} | Trigger: ${context.triggerSource}`,
      "",
      "## Full Investigation",
      levelDetails,
      "",
      "Based on all levels above, produce:",
      "1. **rootCauseChain**: An array of strings tracing the cause from the triggering event to the deepest root cause. E.g. ['DAG dbt_dag failed', 'Task stg_orders.run threw SQL compilation error', 'Table ANALYTICS.stg_orders was dropped', 'Schema migration ran at 2am without downstream checks']",
      "2. **solutionApproach**: Markdown with specific, actionable fix steps including prevention measures.",
      "3. **confidence**: overall confidence in this analysis.",
      "",
      'Return JSON: { "rootCauseChain": string[], "solutionApproach": string, "confidence": "high"|"medium"|"low" }',
    ].join("\n");

    const systemPrompt =
      "You are a senior data engineering incident commander. Synthesize a multi-level investigation into a clear root cause chain and actionable solution. Be specific — cite table names, model names, timestamps. Write the solution as markdown with ## headers.";

    const raw = await provider.complete(prompt, systemPrompt);
    const normalized = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(normalized);
    return {
      rootCauseChain: Array.isArray(parsed.rootCauseChain) ? parsed.rootCauseChain : [],
      solutionApproach: String(parsed.solutionApproach ?? "No solution generated."),
      confidence: parsed.confidence ?? "medium",
    };
  } catch (err) {
    console.error(`[retro-runner] Synthesis error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      rootCauseChain: [context.candidateCauses?.[0]?.summary ?? "Unknown root cause"],
      solutionApproach: "Synthesis failed. Review the individual investigation levels for details.",
      confidence: "low",
    };
  }
}

// ---------------------------------------------------------------------------
// Investigate a single retro level using parallel sub-agents
// ---------------------------------------------------------------------------

async function investigateLevel(
  depth: number,
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  priorFacts: InvestigationFact[],
): Promise<RetroLevel> {
  const t0 = Date.now();
  const tag = `[retro L${depth}]`;
  console.log(`${tag} Investigating: "${question.slice(0, 80)}"`);

  try {
    // Run primary investigation + sub-agents with per-level timeout
    const emptyInvestigation = {
      playbook: "retro-fallback", summary: "", facts: [] as InvestigationFact[],
      hypotheses: [] as Array<{ id: string; summary: string; status: string; confidence: string }>,
      unknowns: [] as string[], nextChecks: [] as string[], sources: [] as string[],
      evidenceIds: [] as string[], usedLiveData: false,
      steps: [] as Array<{ name: string; status: string; durationMs: number }>,
      objectChecks: [] as Array<{ objectName: string; status: string; detail: string }>,
      lineage: { failingModels: [] as string[], upstreamSources: [] as string[], modelPaths: [] as string[], modelSchemas: [] as string[] },
      priorIncidents: [] as Array<{ incidentRunId: string; startedAt: string; severity?: string; rootCause?: string }>,
      externalContext: { slackMentions: [] as any[], jiraIssues: [] as any[], confluencePages: [] as any[] },
    };

    const [primary, subAgentRuns] = await Promise.all([
      withTimeout(
        investigateIncidentQuestion(question, context, config, orchestrator),
        LEVEL_TIMEOUT_MS,
        emptyInvestigation as any,
      ),
      withTimeout(
        runIncidentSubAgents(question, context, config, orchestrator),
        LEVEL_TIMEOUT_MS,
        [] as Awaited<ReturnType<typeof runIncidentSubAgents>>,
      ),
    ]);

    // Merge facts (dedup against prior levels)
    const priorSummaries = new Set(priorFacts.map((f) => f.summary));
    const newFacts = [
      ...primary.facts,
      ...subAgentRuns.flatMap((r) => r.result.facts),
    ].filter((f: InvestigationFact) => !priorSummaries.has(f.summary));

    const sources: string[] = [...new Set([
      ...primary.sources as string[],
      ...subAgentRuns.flatMap((r) => r.result.sources as string[]),
    ])];
    const subAgentsUsed = subAgentRuns.map((r) => r.name);

    // Generate a concise answer for this level using LLM
    const answer = await withTimeout(
      generateLevelAnswer(depth, question, primary, subAgentRuns, context, config),
      15_000,
      primary.summary || "Level investigation timed out.",
    );

    const level: RetroLevel = {
      depth,
      question,
      answer,
      facts: newFacts.slice(0, 8),
      sources,
      subAgentsUsed,
      confidence: (primary.hypotheses?.[0]?.confidence as "high" | "medium" | "low") ?? "medium",
      durationMs: Date.now() - t0,
    };

    console.log(`${tag} Done in ${level.durationMs}ms — ${newFacts.length} new facts, ${subAgentsUsed.length} sub-agents`);
    return level;
  } catch (err) {
    console.error(`${tag} Error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      depth,
      question,
      answer: `Investigation failed: ${err instanceof Error ? err.message : String(err)}`,
      facts: [],
      sources: [],
      subAgentsUsed: [],
      confidence: "low",
      durationMs: Date.now() - t0,
    };
  }
}

async function generateLevelAnswer(
  depth: number,
  question: string,
  primary: Awaited<ReturnType<typeof investigateIncidentQuestion>>,
  subAgentRuns: Awaited<ReturnType<typeof runIncidentSubAgents>>,
  context: IncidentContext,
  config: DuckpipeConfig,
): Promise<string> {
  try {
    const provider = getLlmProvider(config, "comms");

    const factsSummary = [
      ...primary.facts.slice(0, 5),
      ...subAgentRuns.flatMap((r) => r.result.facts).slice(0, 3),
    ]
      .map((f) => `- [${f.source}] ${f.summary}`)
      .join("\n");

    const hypothesesSummary = primary.hypotheses
      .slice(0, 3)
      .map((h) => `- ${h.summary} (${h.confidence})`)
      .join("\n");

    const prompt = [
      `Level ${depth} Investigation Question: ${question}`,
      "",
      `Incident: ${context.severity} — DAG: ${context.dag.dagId ?? "unknown"}`,
      "",
      "Facts discovered:",
      factsSummary || "No new facts.",
      "",
      "Hypotheses:",
      hypothesesSummary || "No hypotheses formed.",
      "",
      `Sub-agents used: ${subAgentRuns.map((r) => r.name).join(", ") || "none"}`,
      "",
      "Write a clear, concise answer to the question based on these findings. Use markdown. 2-4 paragraphs max.",
    ].join("\n");

    const systemPrompt = "You are a data engineering incident analyst. Answer concisely with evidence. Cite specific table names, error messages, and timestamps when available.";

    return await provider.complete(prompt, systemPrompt);
  } catch {
    return primary.summary || "Unable to generate answer for this level.";
  }
}

// ---------------------------------------------------------------------------
// Main entry: startRetroAnalysis (fire-and-forget from autopilot)
// ---------------------------------------------------------------------------

export async function startRetroAnalysis(
  incidentRunId: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<void> {
  const tag = `[retro-runner ${incidentRunId.slice(0, 8)}]`;
  const t0 = Date.now();
  console.log(`${tag} Starting autonomous retro analysis`);

  const report: RetroReport = {
    incidentRunId,
    levels: [],
    rootCauseChain: [],
    solutionApproach: "",
    confidence: "low",
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: 0,
    status: "running",
  };

  // Persist initial "running" state
  upsertRetroReport(report);

  try {
    const allFacts: InvestigationFact[] = [];

    for (let i = 0; i < MAX_LEVELS; i++) {
      // Time budget check
      if (Date.now() - t0 > RETRO_TIMEOUT_MS * 0.85) {
        console.log(`${tag} Time budget exhausted at level ${i + 1}`);
        report.status = "partial";
        break;
      }

      const questionDef = RETRO_QUESTIONS[i];
      const question = questionDef.template(context);

      const level = await investigateLevel(
        questionDef.depth,
        question,
        context,
        config,
        orchestrator,
        allFacts,
      );

      report.levels.push(level);
      allFacts.push(...level.facts);

      // Persist progress after each level so the UI can show live updates
      report.durationMs = Date.now() - t0;
      upsertRetroReport(report);

      // Sufficiency check — should we keep going?
      if (i < MAX_LEVELS - 1) {
        console.log(`${tag} Checking sufficiency after level ${i + 1}`);
        const check = await checkSufficiency(report.levels, context, config);
        console.log(`${tag} Sufficiency: sufficient=${check.sufficient} confidence=${check.confidence} — ${check.reason}`);

        if (check.sufficient && check.confidence === "high") {
          console.log(`${tag} Sufficient at level ${i + 1}, stopping early`);
          report.confidence = check.confidence;
          break;
        }
      }
    }

    // Final synthesis
    console.log(`${tag} Synthesizing retro from ${report.levels.length} levels`);
    const synthesis = await synthesizeRetro(report.levels, context, config);
    report.rootCauseChain = synthesis.rootCauseChain;
    report.solutionApproach = synthesis.solutionApproach;
    report.confidence = synthesis.confidence;
    report.status = report.status === "partial" ? "partial" : "completed";
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - t0;

    upsertRetroReport(report);
    console.log(`${tag} Retro complete — ${report.levels.length} levels, confidence=${report.confidence}, ${report.durationMs}ms`);
  } catch (err) {
    console.error(`${tag} Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    report.status = "partial";
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - t0;
    upsertRetroReport(report);
  }
}
