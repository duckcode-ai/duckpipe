import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, WorkflowResult } from "../src/types.js";

export async function runSlaGuardian(
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("sla-guardian");
  const startedAt = new Date().toISOString();

  try {
    // Step 1: Get current run status for SLA-monitored DAGs
    const statusResult = await orchestrator.dispatchToAgent(
      "airflow",
      "sla-guardian",
      "get_running_dags",
      {
        monitored_dags: config.workflows?.sla_guardian?.monitored_dags ?? [],
      }
    );

    const runningDags = (statusResult.payload.runningDags ?? []) as Array<{
      dagId: string;
      elapsedSeconds: number;
      historicalP95Seconds: number;
      slaDeadline: string;
    }>;

    // Step 2: Check for breach probability
    for (const dag of runningDags) {
      const fraction = dag.elapsedSeconds / dag.historicalP95Seconds;
      const breachProbability = computeBreachProbability(
        fraction,
        dag.elapsedSeconds,
        dag.slaDeadline
      );

      if (breachProbability > 0.7) {
        // Step 3: Post predictive alert
        if (config.integrations.slack?.enabled) {
          await orchestrator.dispatchToAgent(
            "comms",
            "sla-guardian",
            "slack_post_sla_warning",
            {
              channel: config.integrations.slack.allowed_channels[0],
              dagId: dag.dagId,
              breachProbability,
              elapsedSeconds: dag.elapsedSeconds,
              historicalP95Seconds: dag.historicalP95Seconds,
            }
          );
        }
      }
    }

    orchestrator.recordWorkflowComplete(runId, "completed", {
      dagsChecked: runningDags.length,
    });

    return {
      workflow: "sla-guardian",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: { airflow: statusResult.payload },
      auditIds: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "sla-guardian",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}

function computeBreachProbability(
  completionFraction: number,
  elapsedSeconds: number,
  slaDeadline: string
): number {
  const now = Date.now();
  const deadline = new Date(slaDeadline).getTime();
  const remainingMs = deadline - now;
  if (remainingMs <= 0) return 1.0;

  const remainingSeconds = remainingMs / 1000;
  if (completionFraction >= 1.0) return 0.0;

  const estimatedTotalSeconds = elapsedSeconds / completionFraction;
  const estimatedRemainingSeconds = estimatedTotalSeconds - elapsedSeconds;

  if (estimatedRemainingSeconds > remainingSeconds) {
    return Math.min(0.95, estimatedRemainingSeconds / remainingSeconds);
  }

  return completionFraction > 0.7 ? completionFraction * 0.8 : 0.3;
}
