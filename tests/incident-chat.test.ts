import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeAll, getStateDb } from "../src/db.js";
import { askIncidentQuestion, getIncidentChatState, getSuggestedIncidentQuestions } from "../src/incident-chat.js";
import type { DuckpipeConfig, IncidentContext, StoryOutput } from "../src/types.js";

const TEST_DATA_DIR = "./data-test-incident-chat";

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

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = getStateDb(TEST_DATA_DIR);

  const incidentContext: IncidentContext = {
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
    evidence: [
      {
        id: "log-1",
        source: "airflow",
        kind: "log",
        summary: "Snowflake SQL compilation error: Object does not exist.",
        confidence: "high",
      },
    ],
    impactedAssets: [{ kind: "dag", name: "dbt_dag" }],
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
    recommendedActions: [{ summary: "Check the upstream Snowflake object and dbt source configuration", priority: "immediate" }],
    impact: {
      severity: "P2",
      affectedDags: ["dbt_dag"],
      affectedTables: ["RAW.TPCH.ORDERS"],
      affectedModels: ["stg_tpch_orders"],
      blastRadius: [{ kind: "dag", name: "dbt_dag" }, { kind: "model", name: "stg_tpch_orders" }],
      likelyOwner: "Data engineering on-call",
      runbook: "https://example.internal/runbooks/dbt-dag",
    },
    securityMode: { trustTier: 1, actionMode: "read-only" },
  };

  const storyOutput: StoryOutput = {
    oncallSummary: "stg_tpch_orders failed because a Snowflake object appears missing or inaccessible.",
    managerSummary: "A dbt staging model failed and is blocking downstream pipeline work.",
    knowledgeSummary: "Detailed incident summary",
    topEvidence: ["log-1: Snowflake SQL compilation error"],
    unknowns: [],
  };

  db.prepare(
    `INSERT INTO workflow_runs (id, workflow, status, started_at, completed_at, result_json)
     VALUES (?, 'incident-autopilot', 'completed', datetime('now', 'utc'), datetime('now', 'utc'), ?)`
  ).run(
    "run-1",
    JSON.stringify({
      severity: "P2",
      rootCause: "Referenced Snowflake object is missing or inaccessible",
      rootCauseCategory: "upstream_dependency",
      story: storyOutput.oncallSummary,
      storyOutput,
      incidentContext,
    })
  );
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("incident chat", () => {
  it("returns suggested questions from the incident context", () => {
    const state = getIncidentChatState("run-1");
    expect(getSuggestedIncidentQuestions(state.context).length).toBeGreaterThan(0);
    expect(state.messages).toEqual([]);
  });

  it("stores a user question and assistant answer", async () => {
    const result = await askIncidentQuestion(
      "run-1",
      "What should I check next and who owns this?",
      config,
      null,
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toContain("Next checks");
    expect(result.messages[1].metadata?.investigation?.playbook).toBeTruthy();
    expect(result.messages[1].metadata?.investigation?.hypotheses?.length).toBeGreaterThan(0);

    const state = getIncidentChatState("run-1");
    expect(state.messages).toHaveLength(2);
  });
});
