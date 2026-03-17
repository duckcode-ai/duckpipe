import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, WorkflowResult } from "../src/types.js";

export async function runCostSentinel(
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("cost-sentinel");
  const startedAt = new Date().toISOString();

  try {
    const costConfig = config.workflows?.cost_sentinel;
    const alertThreshold = costConfig?.cost_alert_threshold_credits ?? 100;
    const killThreshold = costConfig?.kill_threshold_credits ?? 500;

    // Step 1: Get recent query history
    const historyResult = await orchestrator.dispatchToAgent(
      "snowflake",
      "cost-sentinel",
      "get_query_history",
      { windowMinutes: costConfig?.poll_interval_minutes ?? 10 }
    );

    const queries = (historyResult.payload.expensiveQueries ?? []) as Array<{
      queryId: string;
      creditsConsumed: number;
      warehouse: string;
    }>;

    // Step 2: Alert on expensive queries
    for (const q of queries) {
      if (q.creditsConsumed >= alertThreshold) {
        if (config.integrations.slack?.enabled) {
          await orchestrator.dispatchToAgent(
            "comms",
            "cost-sentinel",
            "slack_post_cost_alert",
            {
              channel: config.integrations.slack.allowed_channels.find((c) =>
                c.includes("cost")
              ) ?? config.integrations.slack.allowed_channels[0],
              query: q,
            }
          );
        }
      }

      // Step 3: Kill candidate queries
      if (q.creditsConsumed >= killThreshold) {
        await orchestrator.executeWriteAction(
          "snowflake",
          "cost-sentinel",
          "cancel_query",
          { query_id: q.queryId },
          {
            credits_consumed: q.creditsConsumed,
            warehouse: q.warehouse,
          }
        );
      }
    }

    orchestrator.recordWorkflowComplete(runId, "completed", {
      queriesChecked: queries.length,
    });

    return {
      workflow: "cost-sentinel",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: { snowflake: historyResult.payload },
      auditIds: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "cost-sentinel",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
