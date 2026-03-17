import { describe, it, expect } from "vitest";
import { generateIncidentStory } from "../src/story.js";
import type { IncidentContext } from "../src/types.js";

function makeContext(): IncidentContext {
  return {
    incidentId: "incident-123",
    workflow: "incident-autopilot",
    triggerSource: "airflow_poll",
    triggerEvent: { dag_id: "ingestion_orders" },
    startedAt: new Date().toISOString(),
    severity: "P2",
    status: "failure",
    dag: {
      dagId: "ingestion_orders",
      runId: "run-1",
      executionDate: "2026-03-16T00:00:00Z",
      failedTasks: [{ taskId: "extract_orders", tryNumber: 2, durationSeconds: 90 }],
      retryCount: 1,
    },
    evidence: [
      { id: "log-1", source: "airflow", kind: "log", summary: "Connection timed out to upstream API", confidence: "high" },
      { id: "anomaly-1", source: "snowflake", kind: "anomaly", summary: "raw.orders has 0 rows", confidence: "medium" },
    ],
    impactedAssets: [
      { kind: "dag", name: "ingestion_orders" },
      { kind: "table", name: "RAW.PUBLIC.ORDERS" },
      { kind: "model", name: "stg_orders" },
    ],
    recentChanges: [{ type: "model_modified", name: "stg_orders", description: "dbt model stg_orders was modified" }],
    candidateCauses: [{ id: "cause-1", category: "timeout", summary: "API or database connection timed out", confidence: "high", evidenceIds: ["log-1"] }],
    recommendedActions: [{ summary: "Retry after checking the upstream API", priority: "immediate", owner: "Data engineering on-call", mode: "read-only" }],
    impact: {
      severity: "P2",
      affectedDags: ["ingestion_orders"],
      affectedTables: ["RAW.PUBLIC.ORDERS"],
      affectedModels: ["stg_orders"],
      blastRadius: [{ kind: "table", name: "RAW.PUBLIC.ORDERS" }],
      likelyOwner: "Data engineering on-call",
    },
    securityMode: { trustTier: 1, actionMode: "read-only" },
  };
}

describe("generateIncidentStory", () => {
  it("builds a structured fallback story without an LLM key", async () => {
    const story = await generateIncidentStory(makeContext());
    expect(story.oncallSummary).toContain("P2 Incident");
    expect(story.managerSummary).toContain("Probable cause");
    expect(story.knowledgeSummary).toContain("## Incident Summary");
    expect(story.topEvidence.length).toBeGreaterThan(0);
  });
});
