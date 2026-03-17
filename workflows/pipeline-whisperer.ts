import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, WorkflowResult } from "../src/types.js";

export async function runPipelineWhisperer(
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("pipeline-whisperer");
  const startedAt = new Date().toISOString();

  try {
    // Step 1: Fetch current schemas from Snowflake
    const schemaResult = await orchestrator.dispatchToAgent(
      "snowflake",
      "pipeline-whisperer",
      "fetch_schemas",
      {
        databases: config.integrations.snowflake?.watched_databases ?? [
          config.integrations.snowflake?.database ?? "",
        ],
      }
    );

    const currentSchemas = schemaResult.payload.schemas as Array<{
      database: string;
      schema: string;
      table: string;
      columns: Array<{ name: string; type: string }>;
    }> ?? [];

    // Step 2: Compare against stored snapshots
    // (Schema comparison logic would check state DB here)
    const driftDetected = (schemaResult.payload.driftDetected as boolean) ?? false;

    if (!driftDetected) {
      orchestrator.recordWorkflowComplete(runId, "completed", { drift: false });
      return {
        workflow: "pipeline-whisperer",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { snowflake: { drift: false } },
        auditIds: [],
      };
    }

    // Step 3: Find affected dbt models
    const dbtResult = await orchestrator.dispatchToAgent(
      "dbt",
      "pipeline-whisperer",
      "find_affected_models",
      { changedTables: schemaResult.payload.changedTables ?? [] }
    );

    // Step 4: Propose model rewrites and open PR
    if ((dbtResult.payload.affectedModels as unknown[])?.length > 0) {
      await orchestrator.executeWriteAction(
        "dbt",
        "pipeline-whisperer",
        "github_create_pr",
        {
          models: dbtResult.payload.affectedModels,
          changes: dbtResult.payload.proposedChanges,
          repo: config.workflows?.pipeline_whisperer?.github_repo,
          baseBranch: config.workflows?.pipeline_whisperer?.base_branch ?? "main",
        },
        {}
      );

      // Step 5: Post PR link to Slack
      if (config.integrations.slack?.enabled) {
        await orchestrator.dispatchToAgent(
          "comms",
          "pipeline-whisperer",
          "slack_post_drift_summary",
          {
            channel: config.integrations.slack.allowed_channels[0],
            driftSummary: schemaResult.payload.changedTables,
            prUrl: dbtResult.payload.prUrl,
          }
        );
      }
    }

    orchestrator.recordWorkflowComplete(runId, "completed", { drift: true });

    return {
      workflow: "pipeline-whisperer",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {
        snowflake: schemaResult.payload,
        dbt: dbtResult.payload,
      },
      auditIds: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "pipeline-whisperer",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
