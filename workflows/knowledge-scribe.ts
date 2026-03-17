import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, WorkflowResult } from "../src/types.js";

export async function runKnowledgeScribe(
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("knowledge-scribe");
  const startedAt = new Date().toISOString();

  try {
    // Step 1: Fetch dbt manifest
    const manifestResult = await orchestrator.dispatchToAgent(
      "dbt",
      "knowledge-scribe",
      "get_manifest",
      {}
    );

    const models = (manifestResult.payload.models ?? []) as Array<{
      name: string;
      description: string;
      columns: Array<{ name: string; description: string; type: string }>;
      tests: string[];
      depends_on: string[];
    }>;

    // Step 2: For each model, create or update Confluence page
    for (const model of models) {
      if (config.integrations.confluence?.enabled) {
        await orchestrator.executeWriteAction(
          "comms",
          "knowledge-scribe",
          "confluence_upsert_page",
          {
            model: model.name,
            description: model.description,
            columns: model.columns,
            tests: model.tests,
            lineage: model.depends_on,
            spaceKey: config.integrations.confluence.space_key,
          },
          {}
        );
      }
    }

    orchestrator.recordWorkflowComplete(runId, "completed", {
      modelsProcessed: models.length,
    });

    return {
      workflow: "knowledge-scribe",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: { dbt: manifestResult.payload },
      auditIds: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "knowledge-scribe",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
