import { describe, expect, it } from "vitest";
import { investigateIncidentQuestion } from "../src/investigator.js";
import type { DuckpipeConfig, IncidentContext } from "../src/types.js";

const config: DuckpipeConfig = {
  duckpipe: { version: "1", name: "test", trust_tier: 1 },
  secrets: { backend: "env" },
  agents: {
    runtime: "process",
    memory_limit_mb: 512,
    cpu_limit: 0.5,
    timeout_seconds: 5,
  },
  integrations: {
    snowflake: {
      enabled: true,
      account: "acct",
      user: "user",
      password: "pw",
      warehouse: "wh",
      database: "RAW",
      watched_databases: ["RAW", "ANALYTICS"],
    },
  },
};

const context: IncidentContext = {
  incidentId: "incident-1",
  workflow: "incident-autopilot",
  triggerSource: "airflow_poll",
  triggerEvent: {},
  startedAt: new Date().toISOString(),
  severity: "P2",
  status: "failure",
  dag: {
    dagId: "dbt_dag",
    runId: "manual__2026-03-17",
    failedTasks: [{ taskId: "stg_tpch_orders.run", tryNumber: 1, durationSeconds: 22 }],
    retryCount: 0,
  },
  evidence: [
    {
      id: "log-1",
      source: "airflow",
      kind: "log",
      summary: "SQL compilation error: Object does not exist, or operation cannot be performed.",
      confidence: "high",
    },
  ],
  impactedAssets: [
    { kind: "dag", name: "dbt_dag" },
    { kind: "model", name: "stg_tpch_orders" },
  ],
  recentChanges: [],
  candidateCauses: [
    {
      id: "cause-1",
      category: "upstream_dependency",
      summary: "Referenced Snowflake object is missing or inaccessible",
      confidence: "high",
      evidenceIds: ["log-1"],
    },
  ],
  recommendedActions: [
    {
      summary: "Check the Snowflake source object and dbt source configuration.",
      priority: "immediate",
      owner: "Data engineering on-call",
      mode: "read-only",
    },
  ],
  impact: {
    severity: "P2",
    affectedDags: ["dbt_dag"],
    affectedTables: ["RAW.TPCH.ORDERS"],
    affectedModels: ["stg_tpch_orders"],
    blastRadius: [{ kind: "dag", name: "dbt_dag" }],
    likelyOwner: "Data engineering on-call",
    runbook: "runbook/dbt-dag",
  },
  securityMode: { trustTier: 1, actionMode: "read-only" },
};

describe("investigateIncidentQuestion", () => {
  it("selects a missing-object playbook for Snowflake object questions", async () => {
    const result = await investigateIncidentQuestion(
      "Which Snowflake object is missing and what should I check next?",
      context,
      config,
      null,
    );

    expect(result.playbook).toBe("missing-object-trace");
    expect(result.hypotheses.length).toBeGreaterThan(0);
    expect(result.nextChecks.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Best current explanation");
    expect(result.lineage?.failingModels).toContain("stg_tpch_orders");
  });

  it("selects a dbt lineage playbook for model-lineage questions", async () => {
    const result = await investigateIncidentQuestion(
      "Show the dbt lineage for stg_tpch_orders.",
      context,
      config,
      null,
    );

    expect(result.playbook).toBe("dbt-lineage-trace");
    expect(result.steps.some((step) => step.id === "dbt-graph")).toBe(true);
  });

  it("uses prior-incident playbook for historical questions", async () => {
    const result = await investigateIncidentQuestion(
      "Has this happened before?",
      context,
      config,
      null,
    );

    expect(result.playbook).toBe("prior-incident-trace");
    expect(result.steps.some((step) => step.id === "prior-incidents")).toBe(true);
  });
});
