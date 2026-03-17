import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { MockTransport } from "../mocks/mock-transport.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { runCostSentinel } from "../../workflows/cost-sentinel.js";
import { initAudit, queryAudit } from "../../src/audit.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { loadPolicy } from "../../src/policy.js";
import type { DuckpipeConfig, BusMessage } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-cost";

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
        allowed_channels: ["#data-costs"],
        approval_timeout_seconds: 60,
        trigger_keyword: "@duckpipe",
      },
    },
    workflows: {
      cost_sentinel: {
        enabled: true,
        poll_interval_minutes: 10,
        cost_alert_threshold_credits: 100,
        kill_threshold_credits: 500,
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

  transport.registerAgentHandler("snowflake", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      expensiveQueries: [
        {
          queryId: "q-123",
          creditsConsumed: 200,
          warehouse: "COMPUTE_WH",
          user: "analyst@corp.com",
          runtimeSeconds: 1800,
        },
      ],
    })
  );

  transport.registerAgentHandler("comms", (msg: BusMessage) =>
    MockTransport.createResponse(msg, { posted: true })
  );
});

afterEach(async () => {
  await orchestrator?.shutdown();
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("cost-sentinel workflow", () => {
  it("detects expensive queries and completes (Tier 1 blocks writes)", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    const result = await runCostSentinel(orchestrator, makeConfig(1));

    expect(result.status).toBe("completed");

    // Tier 1 blocks comms writes via executeWriteAction policy check
    // Audit should record the blocked write attempt
    const writes = queryAudit({ write_only: true, workflow: "cost-sentinel" });
    for (const w of writes) {
      expect(w.success).toBe(false);
    }
  });

  it("creates audit trail for monitoring actions", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    await runCostSentinel(orchestrator, makeConfig(1));

    const entries = queryAudit({ workflow: "cost-sentinel" });
    expect(entries.length).toBeGreaterThan(0);
  });

  it("blocks kill actions in Tier 1", async () => {
    orchestrator = new Orchestrator(transport, makeConfig(1));
    orchestrator.start();

    const config = makeConfig(1);
    config.workflows!.cost_sentinel!.kill_threshold_credits = 100;
    await runCostSentinel(orchestrator, config);

    const writes = queryAudit({ write_only: true });
    for (const w of writes) {
      expect(w.success).toBe(false);
    }
  });
});
