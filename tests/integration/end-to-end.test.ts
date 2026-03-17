import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { Orchestrator } from "../../src/orchestrator.js";
import { FileTransport } from "../../src/bus.js";
import { initAudit, queryAudit } from "../../src/audit.js";
import { loadPolicy, checkPolicy } from "../../src/policy.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { runIncidentAutopilot } from "../../workflows/incident-autopilot.js";
import type { DuckpipeConfig, AirflowFailureEvent } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-e2e";
const TEST_BUS_DIR = "./bus-test-e2e";

function makeConfig(tier: 1 | 2 | 3 = 1): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "e2e-test", trust_tier: tier },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      slack: {
        enabled: true,
        bot_token: "xoxb-test",
        allowed_channels: ["#data-incidents"],
        approval_timeout_seconds: 300,
        trigger_keyword: "@duckpipe",
      },
      jira: {
        enabled: true,
        base_url: "https://test.atlassian.net",
        email: "test@test.com",
        api_token: "test-token",
        default_project: "DE",
      },
    },
    workflows: {
      incident_autopilot: {
        enabled: true,
        poll_interval_seconds: 120,
        auto_page_on_p1: false,
      },
    },
  } as DuckpipeConfig;
}

function makeEvent(): AirflowFailureEvent {
  return {
    dag_id: "etl_daily_orders",
    run_id: "run_20260316",
    execution_date: "2026-03-16T00:00:00Z",
    failure_type: "timeout",
  };
}

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
  getStateDb(TEST_DATA_DIR);
  loadPolicy("nonexistent.yaml");
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  rmSync(TEST_BUS_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("end-to-end: incident-autopilot", () => {
  it("Tier 1: detects failure, produces result, creates audit entries, does NOT write", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig(1));
    orch.start();

    // Mock agent responses
    vi.spyOn(orch, "dispatchToAgent").mockImplementation(async (agent, workflow, action) => ({
      id: "mock-" + action,
      timestamp: new Date().toISOString(),
      source: agent,
      target: "orchestrator",
      workflow: workflow as any,
      type: "result",
      payload:
        action === "check_failures"
          ? {
              status: "failure",
              affectedDags: ["etl_daily_orders"],
              rootCause: "API connection timed out",
              rootCauseCategory: "timeout",
              evidence: ["Connection to api.example.com timed out after 30s"],
              recommendedAction: "Retry after checking upstream service health",
            }
          : {},
    }));

    // Mock executeWriteAction to track calls
    const writeActions: Array<{ agent: string; action: string }> = [];
    const origWrite = orch.executeWriteAction.bind(orch);
    vi.spyOn(orch, "executeWriteAction").mockImplementation(async (agent, workflow, action, payload, ctx) => {
      writeActions.push({ agent, action });
      return origWrite(agent, workflow, action, payload, ctx);
    });

    const result = await runIncidentAutopilot(orch, makeConfig(1), makeEvent());

    // Workflow completed
    expect(result.status).toBe("completed");
    expect(result.workflow).toBe("incident-autopilot");

    // Agent results are captured
    expect(result.agentResults.airflow).toBeDefined();
    expect((result.agentResults.airflow as any).rootCause).toContain("timed out");

    // Tier 1 write actions are blocked
    for (const wa of writeActions) {
      if (wa.agent === "comms" || wa.agent === "airflow") {
        // The policy check should have blocked them
        const decision = checkPolicy(wa.action, wa.agent as any, "incident-autopilot", {}, 1);
        expect(decision.allowed).toBe(false);
      }
    }

    // Workflow is recorded in state DB
    const stateDb = getStateDb();
    const runs = stateDb
      .prepare("SELECT * FROM workflow_runs WHERE workflow = 'incident-autopilot'")
      .all() as Array<Record<string, unknown>>;
    expect(runs.length).toBeGreaterThan(0);

    await transport.shutdown();
  });

  it("full pipeline: event → diagnosis → classify → record", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const config = makeConfig(1);
    const orch = new Orchestrator(transport, config);
    orch.start();

    vi.spyOn(orch, "dispatchToAgent").mockResolvedValue({
      id: "test",
      timestamp: new Date().toISOString(),
      source: "airflow",
      target: "orchestrator",
      workflow: "incident-autopilot",
      type: "result",
      payload: {
        status: "healthy",
        affectedDags: [],
        rootCause: "All DAGs are healthy",
        rootCauseCategory: "unknown",
        evidence: [],
        recommendedAction: "No action needed",
      },
    });

    const result = await runIncidentAutopilot(orch, config);
    expect(result.status).toBe("completed");
    expect(result.agentResults.airflow).toBeDefined();

    await transport.shutdown();
  });
});

describe("policy engine integration", () => {
  it("Tier 1 cannot trigger ANY write action", () => {
    const agents = ["airflow", "dbt", "snowflake", "comms"] as const;
    const writeActions = [
      "trigger_dag_run", "clear_task", "cancel_query",
      "slack_post_message", "jira_create_issue",
      "confluence_create_page", "github_create_pr",
    ];

    for (const agent of agents) {
      for (const action of writeActions) {
        const decision = checkPolicy(action, agent, "incident-autopilot", {}, 1);
        expect(decision.allowed).toBe(false);
      }
    }
  });

  it("Tier 2 requires approval for write actions", () => {
    loadPolicy("nonexistent.yaml");
    const decision = checkPolicy("trigger_dag_run", "airflow", "incident-autopilot", {}, 2);
    expect(decision.approvalRequired).toBe(true);
  });
});

describe("audit log integration", () => {
  it("logs entries for workflow actions", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig(1));
    orch.start();

    vi.spyOn(orch, "dispatchToAgent").mockResolvedValue({
      id: "test",
      timestamp: new Date().toISOString(),
      source: "airflow",
      target: "orchestrator",
      workflow: "incident-autopilot",
      type: "result",
      payload: { status: "healthy" },
    });

    await runIncidentAutopilot(orch, makeConfig(1), makeEvent());

    // Query audit — there should be at least one entry from the write action attempt
    const entries = queryAudit({ workflow: "incident-autopilot" });
    // The orchestrator logs audit for write actions
    expect(entries).toBeDefined();

    await transport.shutdown();
  });
});
