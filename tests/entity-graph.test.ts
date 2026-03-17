import { describe, it, expect } from "vitest";
import { buildEntityGraph, enrichIncidentContext } from "../src/entity-graph.js";
import type { IncidentContext } from "../src/types.js";

function makeContext(): IncidentContext {
  return {
    incidentId: "incident-graph-1",
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
      failedTasks: [{ taskId: "extract_orders", tryNumber: 2, durationSeconds: 180 }],
      retryCount: 1,
    },
    evidence: [{ id: "log-1", source: "airflow", kind: "log", summary: "Timed out", confidence: "high" }],
    impactedAssets: [
      { kind: "dag", name: "ingestion_orders" },
      { kind: "table", name: "RAW.PUBLIC.ORDERS" },
      { kind: "model", name: "stg_orders" },
    ],
    recentChanges: [{ type: "model_modified", name: "stg_orders", description: "dbt model stg_orders changed" }],
    candidateCauses: [{ id: "cause-1", category: "schema_drift", summary: "Recent model change likely contributed", confidence: "medium", evidenceIds: ["log-1"] }],
    recommendedActions: [{ summary: "Review the recent dbt change", priority: "immediate", mode: "read-only" }],
    impact: {
      severity: "P2",
      affectedDags: ["ingestion_orders"],
      affectedTables: ["RAW.PUBLIC.ORDERS"],
      affectedModels: ["stg_orders"],
      blastRadius: [{ kind: "table", name: "RAW.PUBLIC.ORDERS" }],
    },
    securityMode: { trustTier: 1, actionMode: "read-only" },
  };
}

describe("entity graph enrichment", () => {
  it("derives likely owner, runbook, and graph links", () => {
    const enriched = enrichIncidentContext(makeContext());
    expect(enriched.impact.likelyOwner).toBe("Analytics engineering owner");
    expect(enriched.impact.runbook).toContain("Schema drift");
    expect(enriched.entityGraph?.nodes.length).toBeGreaterThan(0);
    expect(enriched.entityGraph?.edges.length).toBeGreaterThan(0);
  });

  it("builds dag-task-table-model relationships", () => {
    const graph = buildEntityGraph(makeContext());
    expect(graph.nodes.some((node) => node.id === "dag:ingestion_orders")).toBe(true);
    expect(graph.nodes.some((node) => node.id === "task:extract_orders")).toBe(true);
    expect(graph.edges.some((edge) => edge.from === "dag:ingestion_orders" && edge.to === "task:extract_orders")).toBe(true);
    expect(graph.edges.some((edge) => edge.to === "model:stg_orders")).toBe(true);
  });
});
