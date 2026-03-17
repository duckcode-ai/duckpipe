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
      "get_project_graph",
      {}
    );

    const models = (manifestResult.payload.models ?? []) as Array<{
      name: string;
      description: string;
      columns: Array<{ name: string; description: string; type: string }>;
      dependsOn?: string[];
      tests?: string[];
    }>;

    // Step 2: For each model, create or update Confluence page
    for (const model of models) {
      if (config.integrations.confluence?.enabled) {
        await orchestrator.executeWriteAction(
          "comms",
          "knowledge-scribe",
          "confluence_upsert_page",
          {
            title: `DuckPipe Catalog — ${model.name}`,
            body: [
              `<h1>${model.name}</h1>`,
              `<p>${model.description ?? "No description provided."}</p>`,
              `<h2>Columns</h2>`,
              `<ul>${(model.columns ?? []).map((column) => `<li><strong>${column.name}</strong> — ${column.type} — ${column.description ?? ""}</li>`).join("")}</ul>`,
              `<h2>Lineage</h2>`,
              `<p>${(model.dependsOn ?? []).join(", ") || "No lineage available."}</p>`,
              `<h2>Tests</h2>`,
              `<p>${(model.tests ?? []).join(", ") || "No tests recorded."}</p>`,
            ].join(""),
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
