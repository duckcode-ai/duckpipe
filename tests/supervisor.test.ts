import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeAll, getStateDb } from "../src/db.js";
import { superviseIncidentQuestion } from "../src/supervisor.js";
import type { DuckpipeConfig, IncidentContext } from "../src/types.js";

const TEST_DATA_DIR = "./data-test-supervisor";

const config: DuckpipeConfig = {
  duckpipe: { version: "1", name: "test", trust_tier: 1 },
  secrets: { backend: "env" },
  agents: {
    runtime: "process",
    memory_limit_mb: 512,
    cpu_limit: 0.5,
    timeout_seconds: 5,
  },
  integrations: {},
};

const context: IncidentContext = {
  incidentId: "incident-run-1",
  workflow: "incident-autopilot",
  triggerSource: "airflow_poll",
  triggerEvent: {},
  startedAt: new Date().toISOString(),
  severity: "P2",
  status: "failure",
  dag: {
    dagId: "dbt_dag",
    runId: "manual__2026-03-17",
    failedTasks: [{ taskId: "stg_tpch_orders.run", tryNumber: 1, durationSeconds: 30 }],
    retryCount: 0,
  },
  evidence: [{ id: "log-1", source: "airflow", kind: "log", summary: "Snowflake SQL compilation error", confidence: "high" }],
  impactedAssets: [{ kind: "dag", name: "dbt_dag" }],
  recentChanges: [],
  candidateCauses: [{ id: "cause-1", category: "upstream_dependency", summary: "Referenced Snowflake object is missing or inaccessible", confidence: "high", evidenceIds: ["log-1"] }],
  recommendedActions: [{ summary: "Check the upstream Snowflake object and dbt source configuration", priority: "immediate" }],
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

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = getStateDb(TEST_DATA_DIR);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow, status, started_at, completed_at)
     VALUES ('run-1', 'incident-autopilot', 'completed', datetime('now', 'utc'), datetime('now', 'utc'))`
  ).run();
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("supervisor", () => {
  it("delegates to specialist sub-agents and updates workspace", async () => {
    const result = await superviseIncidentQuestion(
      "run-1",
      "Which Snowflake object is missing and what should I check next?",
      context,
      config,
      null,
    );

    expect(result.investigation.subAgents?.length).toBeGreaterThan(0);
    expect(result.investigation.workspace?.factCount).toBeGreaterThan(0);
    expect(result.workspace.subAgents.length).toBeGreaterThan(0);
    expect(result.workspace.conversationCount).toBe(1);
  });
});
