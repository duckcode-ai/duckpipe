import type { Orchestrator } from "../src/orchestrator.js";
import type {
  AirflowFailureEvent,
  DuckpipeConfig,
  WorkflowResult,
} from "../src/types.js";

export async function runIncidentAutopilot(
  orchestrator: Orchestrator,
  config: DuckpipeConfig,
  event?: AirflowFailureEvent
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("incident-autopilot");
  const startedAt = new Date().toISOString();
  const auditIds: string[] = [];

  try {
    // Step 1: Poll Airflow for failed DAGs if no event provided
    const airflowResult = await orchestrator.dispatchToAgent(
      "airflow",
      "incident-autopilot",
      "check_failures",
      event ? { dag_id: event.dag_id, run_id: event.run_id } : {}
    );

    const failures = airflowResult.payload;
    if (failures.status === "healthy") {
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

    // Step 2: Check for upstream dbt model changes (parallel)
    const dbtPromise = orchestrator.dispatchToAgent(
      "dbt",
      "incident-autopilot",
      "check_recent_changes",
      { timeWindowHours: 2 }
    );

    // Step 3: Check source table anomalies (parallel)
    const snowflakePromise = orchestrator.dispatchToAgent(
      "snowflake",
      "incident-autopilot",
      "check_source_anomalies",
      { tables: failures.affectedTables ?? [] }
    );

    const [dbtResult, snowflakeResult] = await Promise.allSettled([
      dbtPromise,
      snowflakePromise,
    ]);

    // Step 4: Classify severity
    const rootCause = failures.rootCause as string ?? "unknown";
    const category = failures.rootCauseCategory as string ?? "unknown";
    const severity = classifySeverity(category, failures);

    // Step 5: Post Slack alert (Tier 1+)
    if (config.integrations.slack?.enabled) {
      const slackPayload = {
        channel: config.integrations.slack.allowed_channels[0] ?? "#data-incidents",
        severity,
        dagId: event?.dag_id ?? (failures.affectedDags as string[])?.[0],
        rootCause,
        category,
        evidence: failures.evidence ?? [],
        recommendedAction: failures.recommendedAction ?? "Investigate manually",
      };

      await orchestrator.dispatchToAgent(
        "comms",
        "incident-autopilot",
        "slack_post_incident",
        slackPayload
      );
    }

    // Step 6: If Tier 2+, create Jira ticket
    if (config.duckpipe.trust_tier >= 2 && config.integrations.jira?.enabled) {
      const jiraResult = await orchestrator.executeWriteAction(
        "comms",
        "incident-autopilot",
        "jira_create_issue",
        {
          project: config.integrations.jira.default_project,
          summary: `[DuckPipe] ${severity} — ${event?.dag_id ?? "pipeline"} failure`,
          description: rootCause,
        },
        { severity }
      );
    }

    // Step 7: If Tier 3 and retriable, retry the task
    if (
      config.duckpipe.trust_tier >= 2 &&
      (category === "timeout" || category === "connection_error")
    ) {
      await orchestrator.executeWriteAction(
        "airflow",
        "incident-autopilot",
        "trigger_dag_run",
        {
          dag_id: event?.dag_id,
          run_id: event?.run_id,
        },
        {
          dag_id: event?.dag_id ?? "",
          retry_count: (failures.retryCount as number) ?? 0,
          failure_type: category,
        }
      );
    }

    orchestrator.recordWorkflowComplete(runId, "completed", { severity, rootCause });

    return {
      workflow: "incident-autopilot",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {
        airflow: failures,
        dbt: dbtResult.status === "fulfilled" ? dbtResult.value.payload : null,
        snowflake: snowflakeResult.status === "fulfilled" ? snowflakeResult.value.payload : null,
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
      auditIds,
      error: msg,
    };
  }
}

function classifySeverity(
  category: string,
  failures: Record<string, unknown>
): "P1" | "P2" | "P3" {
  if (failures.slaBreachImminent) return "P1";
  if (category === "logic_error") return "P2";
  if (category === "timeout" || category === "connection_error") return "P2";
  return "P3";
}
