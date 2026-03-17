import type { DuckpipeConfig } from "./types.js";
import { buildAssistantReadinessReport } from "./registry.js";

export function runDoctor(config: DuckpipeConfig): ReturnType<typeof buildAssistantReadinessReport> {
  return buildAssistantReadinessReport(config);
}

export function printDoctorReport(config: DuckpipeConfig): void {
  const report = runDoctor(config);

  console.log("DuckPipe doctor — assistant readiness\n");

  console.log(report.ok ? "✓ Workflow registry intact" : "✗ Workflow registry has errors");
  for (const error of report.errors) console.log(`  - ${error}`);
  for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);

  console.log();
  if (report.llm.configured) {
    console.log(`✓ LLM configured: ${report.llm.provider} / ${report.llm.model}`);
  } else {
    console.log("⚠ LLM is not configured; structured story generation will fall back to deterministic summaries");
  }

  console.log();
  console.log("Workflow readiness:");
  for (const [workflow, state] of Object.entries(report.workflows)) {
    if (!state) continue;
    console.log(`${state.ready ? "✓" : "⚠"} ${workflow}`);
    for (const issue of state.issues) console.log(`  - ${issue}`);
  }

  console.log();
  console.log("What works now:");
  const ready = Object.entries(report.workflows)
    .filter(([, state]) => state?.ready)
    .map(([workflow]) => workflow);
  console.log(`  ${ready.length > 0 ? ready.join(", ") : "No workflows are fully ready yet."}`);

  console.log("\nWhat stories will be available:");
  if (config.workflows?.incident_autopilot?.enabled) console.log("  - Incident summaries for Airflow failures");
  if (config.workflows?.pipeline_whisperer?.enabled) console.log("  - Schema drift stories for Snowflake/dbt changes");
  if (config.workflows?.knowledge_scribe?.enabled) console.log("  - Knowledge pages for dbt assets");

  if (!report.ok) {
    throw new Error("Doctor found blocking readiness issues.");
  }
}
