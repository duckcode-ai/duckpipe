import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { MockTransport } from "../mocks/mock-transport.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { runIncidentAutopilot } from "../../workflows/incident-autopilot.js";
import { initAudit, queryAudit } from "../../src/audit.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { loadPolicy } from "../../src/policy.js";
import type { DuckpipeConfig, BusMessage } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-incident";

function makeConfig(tier: 1 | 2 | 3 = 1): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: tier },
    secrets: { backend: "env" },
    agents: {
      runtime: "process",
      memory_limit_mb: 512,
      cpu_limit: 0.5,
      timeout_seconds: 5,
    },
    integrations: {
      slack: {
        enabled: true,
        bot_token: "xoxb-test",
        allowed_channels: ["#data-incidents"],
        approval_timeout_seconds: 60,
        trigger_keyword: "@duckpipe",
      },
    },
  };
}

let transport: MockTransport;
let orchestrator: Orchestrator;

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
  getStateDb(TEST_DATA_DIR);
  loadPolicy("nonexistent.yaml");

  transport = new MockTransport();

  // Mock airflow agent: returns a failure diagnosis
  transport.registerAgentHandler("airflow", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      status: "failure",
      affectedDags: ["ingestion_stripe_payments"],
      rootCause: "Stripe API timeout",
      rootCauseCategory: "timeout",
      evidence: ["HTTPSConnectionPool: Read timed out"],
      recommendedAction: "Retry after checking Stripe status",
      confidence: "high",
      retryCount: 0,
    })
  );

  // Mock dbt agent
  transport.registerAgentHandler("dbt", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      recentChanges: [],
      modelsAffected: 0,
    })
  );

  // Mock snowflake agent
  transport.registerAgentHandler("snowflake", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      anomalies: [],
      rowCountNormal: true,
    })
  );

  // Mock comms agent
  transport.registerAgentHandler("comms", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      posted: true,
      channel: "#data-incidents",
    })
  );
});

afterEach(async () => {
  await orchestrator?.shutdown();
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("incident-autopilot workflow", () => {
  it("runs end-to-end in Tier 1 and creates audit entries", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    const result = await runIncidentAutopilot(orchestrator, makeConfig(1), {
      dag_id: "ingestion_stripe_payments",
      run_id: "scheduled__2026-03-16",
      execution_date: "2026-03-16T03:00:00Z",
    });

    expect(result.status).toBe("completed");
    expect(result.workflow).toBe("incident-autopilot");

    // Should have dispatched to airflow agent
    const airflowMsgs = transport.getMessagesSentTo("airflow");
    expect(airflowMsgs.length).toBeGreaterThanOrEqual(1);

    // Should have dispatched to comms agent (Slack post)
    const commsMsgs = transport.getMessagesSentTo("comms");
    expect(commsMsgs.length).toBeGreaterThanOrEqual(1);

    // Audit log should have entries
    const auditEntries = queryAudit({});
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("does not trigger write actions in Tier 1", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    const result = await runIncidentAutopilot(orchestrator, makeConfig(1), {
      dag_id: "ingestion_stripe_payments",
      run_id: "scheduled__2026-03-16",
      execution_date: "2026-03-16T03:00:00Z",
    });

    expect(result.status).toBe("completed");

    // In Tier 1, no write actions should be allowed
    const writeEntries = queryAudit({ write_only: true });
    for (const entry of writeEntries) {
      expect(entry.success).toBe(false);
    }
  });

  it("handles healthy response gracefully", async () => {
    // Override airflow handler to return healthy
    transport.registerAgentHandler("airflow", (msg: BusMessage) =>
      MockTransport.createResponse(msg, { status: "healthy" })
    );

    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    const result = await runIncidentAutopilot(orchestrator, makeConfig(1));

    expect(result.status).toBe("completed");
    expect(result.agentResults.airflow).toMatchObject({ status: "healthy" });
  });

  it("records workflow run in state DB", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    await runIncidentAutopilot(orchestrator, makeConfig(1), {
      dag_id: "test_dag",
      run_id: "run_1",
      execution_date: "2026-03-16T00:00:00Z",
    });

    const db = getStateDb(TEST_DATA_DIR);
    const runs = db
      .prepare("SELECT * FROM workflow_runs WHERE workflow = 'incident-autopilot'")
      .all() as Array<Record<string, unknown>>;

    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");
  });
});
