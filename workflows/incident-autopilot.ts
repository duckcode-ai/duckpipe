import type { Orchestrator } from "../src/orchestrator.js";
import type {
  AirflowFailureEvent,
  DuckpipeConfig,
  IncidentContext,
  IncidentEvidence,
  AssetRef,
  WorkflowResult,
} from "../src/types.js";
import { buildCandidateCauses, generateIncidentStory } from "../src/story.js";
import { enrichIncidentContext } from "../src/entity-graph.js";
import { startRetroAnalysis } from "../src/retro-runner.js";

function classifySeverity(
  category: string,
  failures: Record<string, unknown>
): "P1" | "P2" | "P3" {
  if (failures.slaBreachImminent) return "P1";
  if (category === "logic_error") return "P2";
  if (category === "timeout" || category === "connection_error") return "P2";
  return "P3";
}

/**
 * Assemble a human-readable root cause story from the three agent findings.
 *
 * Story pattern:
 *   "DAG X failed (timeout). Snowflake source table Y has 0 rows — possible
 *    load failure. dbt model Z was modified 1h ago. Most likely cause:
 *    upstream data load failure cascaded into dbt model Z, which caused DAG X
 *    to fail with a timeout reading empty data."
 */
function assembleStory(opts: {
  affectedDags: string[];
  rootCause: string;
  rootCauseCategory: string;
  severity: string;
  evidence: string[];
  recommendedAction: string;
  dbtChanges?: Array<{ type: string; name: string; description: string }>;
  anomalies?: Array<{ table: string; rowCount: number; anomalyDetected: boolean; anomalyDescription: string | null }>;
}): string {
  const {
    affectedDags, rootCause, rootCauseCategory, severity,
    evidence, recommendedAction, dbtChanges = [], anomalies = [],
  } = opts;

  const lines: string[] = [];

  // Header
  const dagList = affectedDags.slice(0, 3).join(", ") || "unknown pipeline";
  lines.push(`${severity === "P1" ? "🔴" : severity === "P2" ? "🟡" : "🟢"} *${severity} Incident — ${dagList}*`);
  lines.push("");

  // Root cause
  lines.push(`*Root Cause:* ${rootCause} _(${rootCauseCategory})_`);
  lines.push(`*Recommended Action:* ${recommendedAction}`);
  lines.push("");

  // Snowflake anomalies
  const detectedAnomalies = anomalies.filter(a => a.anomalyDetected);
  if (detectedAnomalies.length > 0) {
    lines.push("*Snowflake Data Issues Detected:*");
    for (const a of detectedAnomalies) {
      lines.push(`  • \`${a.table}\` — ${a.anomalyDescription ?? `${a.rowCount} rows`}`);
    }
    lines.push("");
  } else if (anomalies.length > 0) {
    const sample = anomalies.slice(0, 3).map(a => `\`${a.table}\` (${a.rowCount.toLocaleString()} rows)`).join(", ");
    lines.push(`*Source tables checked:* ${sample} — no anomalies`);
    lines.push("");
  }

  // dbt changes
  if (dbtChanges.length > 0) {
    lines.push(`*Recent dbt changes (last 2h):*`);
    for (const c of dbtChanges.slice(0, 5)) {
      lines.push(`  • ${c.description}`);
    }
    lines.push("");
  }

  // Evidence from logs
  if (evidence.length > 0) {
    lines.push("*Log Evidence:*");
    for (const e of evidence.slice(0, 3)) {
      lines.push("```");
      lines.push(e.trim().slice(0, 300));
      lines.push("```");
    }
    lines.push("");
  }

  // Narrative conclusion
  if (detectedAnomalies.length > 0 && dbtChanges.length > 0) {
    lines.push(`*Most likely:* ${dagList} failed because a recent dbt change (${dbtChanges[0].name}) combined with empty source data in ${detectedAnomalies[0].table} caused the ${rootCauseCategory}.`);
  } else if (detectedAnomalies.length > 0) {
    lines.push(`*Most likely:* ${dagList} failed because source table ${detectedAnomalies[0].table} has no data — upstream load likely failed.`);
  } else if (dbtChanges.length > 0) {
    lines.push(`*Most likely:* ${dagList} failed because a recent dbt model change (${dbtChanges[0].name}) introduced the ${rootCauseCategory}.`);
  } else {
    lines.push(`*Most likely:* ${rootCause}. No upstream dbt or Snowflake anomalies detected — this may be an isolated infrastructure issue.`);
  }

  lines.push("");
  lines.push("_Detected by DuckPipe — duckcode.ai_");

  return lines.join("\n");
}

function buildImpactAssets(
  dags: string[],
  anomalies: Array<{ table: string; anomalyDetected: boolean }>,
  models: Array<{ name: string } | string>,
): AssetRef[] {
  return [
    ...dags.map((dag) => ({ kind: "dag" as const, name: dag })),
    ...anomalies.filter((item) => item.anomalyDetected).map((item) => ({ kind: "table" as const, name: item.table })),
    ...models.map((model) => ({ kind: "model" as const, name: typeof model === "string" ? model : model.name })),
  ];
}

function buildEvidence(
  failures: Record<string, unknown>,
  dbtChanges: Array<{ description: string; name: string }>,
  anomalies: Array<{ table: string; anomalyDescription: string | null; anomalyDetected: boolean }>
): IncidentEvidence[] {
  const evidence: IncidentEvidence[] = [];

  for (const [index, item] of (((failures.evidence as string[]) ?? []).slice(0, 3)).entries()) {
    evidence.push({
      id: `log-${index + 1}`,
      source: "airflow",
      kind: "log",
      summary: item.trim().slice(0, 180),
      detail: item,
      confidence: "high",
    });
  }

  for (const [index, change] of dbtChanges.slice(0, 3).entries()) {
    evidence.push({
      id: `change-${index + 1}`,
      source: "dbt",
      kind: "change",
      summary: change.description,
      detail: change.name,
      confidence: "medium",
    });
  }

  for (const [index, anomaly] of anomalies.filter((item) => item.anomalyDetected).slice(0, 3).entries()) {
    evidence.push({
      id: `anomaly-${index + 1}`,
      source: "snowflake",
      kind: "anomaly",
      summary: anomaly.anomalyDescription ?? anomaly.table,
      detail: anomaly.table,
      confidence: "medium",
      asset: { kind: "table", name: anomaly.table },
    });
  }

  return evidence;
}

export async function runIncidentAutopilot(
  orchestrator: Orchestrator,
  config: DuckpipeConfig,
  event?: AirflowFailureEvent
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("incident-autopilot");
  const startedAt = new Date().toISOString();
  const auditIds: string[] = [];

  try {
    // ── Step 1: Check Airflow for failures ───────────────────────────────
    const airflowResult = await orchestrator.dispatchToAgent(
      "airflow",
      "incident-autopilot",
      "check_failures",
      event ? { dag_id: event.dag_id, run_id: event.run_id } : {}
    );

    const failures = airflowResult.payload;

    // Agent error (connection refused, timeout, config missing) — not a real incident
    if (airflowResult.type === "error" || failures.error) {
      console.log(`[incident-autopilot] Airflow agent error: ${failures.error ?? "unknown"} — skipping (not an incident)`);
      orchestrator.recordWorkflowComplete(runId, "completed", { status: "skipped", reason: "airflow_unreachable" });
      return {
        workflow: "incident-autopilot",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { airflow: { status: "unreachable", error: failures.error } },
        auditIds,
      };
    }

    // Only treat "failure" or "warning" as real incidents — anything else is healthy
    const isRealIncident = failures.status === "failure" || failures.status === "warning";
    if (!isRealIncident) {
      orchestrator.recordWorkflowComplete(runId, "completed", { status: "healthy" });
      return {
        workflow: "incident-autopilot",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { airflow: failures },
        auditIds,
      };
    }

    // Must have at least one affected DAG to be meaningful
    const affectedDagsRaw = (failures.affectedDags as string[]) ?? [];
    if (affectedDagsRaw.length === 0) {
      orchestrator.recordWorkflowComplete(runId, "completed", { status: "healthy" });
      return {
        workflow: "incident-autopilot",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { airflow: failures },
        auditIds,
      };
    }

    const rootCause    = (failures.rootCause as string) ?? "Unknown failure";
    const category     = (failures.rootCauseCategory as string) ?? "unknown";
    const severity     = classifySeverity(category, failures);
    const affectedDags = affectedDagsRaw;

    // ── Steps 2+3: Cross-reference dbt changes and Snowflake anomalies (parallel) ──
    const affectedTables = (failures.affectedTables as string[]) ?? [];

    const [dbtResult, snowflakeResult, impactedModelsResult] = await Promise.allSettled([
      orchestrator.dispatchToAgent("dbt", "incident-autopilot", "check_recent_changes", {
        lookback_hours: 2,
      }),
      orchestrator.dispatchToAgent("snowflake", "incident-autopilot", "check_source_anomalies", {
        tables: affectedTables,
      }),
      orchestrator.dispatchToAgent("dbt", "incident-autopilot", "find_affected_models", {
        changed_tables: affectedTables,
      }),
    ]);

    const dbtChanges = dbtResult.status === "fulfilled"
      ? ((dbtResult.value.payload.changes ?? []) as Array<{ type: string; name: string; description: string }>)
      : [];

    const anomalies = snowflakeResult.status === "fulfilled"
      ? ((snowflakeResult.value.payload.anomalies ?? []) as Array<{ table: string; rowCount: number; anomalyDetected: boolean; anomalyDescription: string | null }>)
      : [];

    const affectedModels = impactedModelsResult.status === "fulfilled"
      ? ((impactedModelsResult.value.payload.models ?? []) as Array<{ name: string } | string>)
      : [];

    const structuredEvidence = buildEvidence(failures, dbtChanges, anomalies);
    const impactAssets = buildImpactAssets(affectedDags, anomalies, affectedModels);
    const incidentContext = enrichIncidentContext({
      incidentId: `incident-${runId}`,
      workflow: "incident-autopilot",
      triggerSource: event ? "airflow_webhook" : "airflow_poll",
      triggerEvent: event ? { ...event } : {},
      startedAt,
      severity,
      status: (failures.status as "failure" | "warning" | "healthy") ?? "failure",
      dag: {
        dagId: event?.dag_id ?? affectedDags[0],
        runId: event?.run_id,
        executionDate: event?.execution_date,
        failedTasks: ((failures.failedTasks as Array<{ taskId: string; tryNumber?: number; durationSeconds?: number | null }>) ?? []),
        retryCount: (failures.retryCount as number) ?? 0,
      },
      evidence: structuredEvidence,
      impactedAssets: impactAssets,
      recentChanges: dbtChanges,
      candidateCauses: buildCandidateCauses(
        rootCause,
        category as "timeout" | "connection_error" | "logic_error" | "upstream_dependency" | "unknown",
        structuredEvidence,
        anomalies.some((item) => item.anomalyDetected),
        dbtChanges.length > 0,
      ),
      recommendedActions: [
        {
          summary: (failures.recommendedAction as string) ?? "Investigate manually",
          priority: "immediate",
          owner: anomalies.some((item) => item.anomalyDetected) ? "Data platform owner" : "Data engineering on-call",
          mode: config.duckpipe.trust_tier >= 3 ? "autonomous" : config.duckpipe.trust_tier >= 2 ? "approval-required" : "read-only",
        },
      ],
      impact: {
        severity,
        affectedDags,
        affectedTables,
        affectedModels: affectedModels.map((item) => typeof item === "string" ? item : item.name),
        blastRadius: impactAssets,
        likelyOwner: anomalies.some((item) => item.anomalyDetected) ? "Data platform owner" : "Data engineering on-call",
      },
      securityMode: {
        trustTier: config.duckpipe.trust_tier,
        actionMode: config.duckpipe.trust_tier >= 3 ? "autonomous" : config.duckpipe.trust_tier >= 2 ? "approval-required" : "read-only",
      },
    });

    // ── Step 4: Assemble the story ────────────────────────────────────────
    const assembledStory = assembleStory({
      affectedDags,
      rootCause,
      rootCauseCategory: category,
      severity,
      evidence: (failures.evidence as string[]) ?? [],
      recommendedAction: (failures.recommendedAction as string) ?? "Investigate manually",
      dbtChanges,
      anomalies,
    });
    const storyOutput = await generateIncidentStory(incidentContext, config);
    incidentContext.story = storyOutput;
    const story = `${storyOutput.oncallSummary}\n\n${assembledStory}`;

    console.log(`[incident-autopilot] ${severity} incident — ${affectedDags.join(", ")}`);
    console.log(`[incident-autopilot] Root cause: ${rootCause} (${category})`);
    if (dbtChanges.length > 0) console.log(`[incident-autopilot] Related dbt changes: ${dbtChanges.length}`);
    if (anomalies.some(a => a.anomalyDetected)) console.log(`[incident-autopilot] Snowflake anomalies detected`);

    // ── Step 5: Post Slack alert ──────────────────────────────────────────
    if (config.integrations.slack?.enabled) {
      const slackChannel = config.integrations.slack.allowed_channels[0] ?? "#data-incidents";
      await orchestrator.executeWriteAction(
        "comms",
        "incident-autopilot",
        "slack_post_message",
        { channel: slackChannel, text: story },
        { severity, channels: [slackChannel] }
      );
    }

    // ── Step 5.5: Kick off autonomous retro analysis (fire-and-forget) ──
    startRetroAnalysis(runId, incidentContext, config, orchestrator).catch((err) =>
      console.error(`[incident-autopilot] Retro analysis failed: ${err instanceof Error ? err.message : String(err)}`),
    );

    // ── Step 6: Create Jira ticket (Tier 2+) ─────────────────────────────
    if (config.duckpipe.trust_tier >= 2 && config.integrations.jira?.enabled) {
      await orchestrator.executeWriteAction(
        "comms",
        "incident-autopilot",
        "jira_create_issue",
        {
          project:     config.integrations.jira.default_project,
          summary:     `[DuckPipe] ${severity} — ${affectedDags[0] ?? "pipeline"} failure: ${rootCause}`,
          description: story,
          issue_type:  "Bug",
        },
        { severity }
      );
    }

    // ── Step 7: Auto-retry (Tier 3, retriable failures only) ─────────────
    if (
      config.duckpipe.trust_tier >= 3 &&
      (category === "timeout" || category === "connection_error") &&
      event?.dag_id
    ) {
      await orchestrator.executeWriteAction(
        "airflow",
        "incident-autopilot",
        "trigger_dag_run",
        { dag_id: event.dag_id },
        {
          dag_id: event.dag_id,
          retry_count: (failures.retryCount as number) ?? 0,
          failure_type: category,
        }
      );
    }

    orchestrator.recordWorkflowComplete(runId, "completed", {
      severity,
      rootCause,
      rootCauseCategory: category,
      story,
      storyOutput,
      incidentContext,
      dbtChangesFound: dbtChanges.length,
      anomaliesFound: anomalies.filter(a => a.anomalyDetected).length,
    });

    return {
      workflow: "incident-autopilot",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {
        airflow:   failures,
        dbt:       dbtResult.status === "fulfilled" ? dbtResult.value.payload : null,
        snowflake: snowflakeResult.status === "fulfilled" ? snowflakeResult.value.payload : null,
        incidentContext,
        storyOutput,
        story,
      },
      auditIds,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "incident-autopilot",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
