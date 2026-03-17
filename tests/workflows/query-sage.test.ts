import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { MockTransport } from "../mocks/mock-transport.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { runQuerySage } from "../../workflows/query-sage.js";
import { initAudit } from "../../src/audit.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { loadPolicy } from "../../src/policy.js";
import type { DuckpipeConfig, BusMessage, SlackMessage } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-sage";

function makeConfig(): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 1 },
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
        allowed_channels: ["#data-engineering"],
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

  transport.registerAgentHandler("comms", (msg: BusMessage) => {
    if (msg.payload._taskType === "extract_entity_from_message") {
      return MockTransport.createResponse(msg, { entity: "stg_orders" });
    }
    return MockTransport.createResponse(msg, { posted: true });
  });

  transport.registerAgentHandler("snowflake", (msg: BusMessage) => {
    if (msg.payload._taskType === "get_query_plans") {
      return MockTransport.createResponse(msg, { plans: [{ queryId: "q1" }] });
    }
    return MockTransport.createResponse(msg, {
      explanation: "Full table scan on stg_orders",
      rewrittenSql: "SELECT * FROM stg_orders WHERE date > '2026-01-01'",
      estimatedSavings: 15,
    });
  });
});

afterEach(async () => {
  await orchestrator?.shutdown();
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("query-sage workflow", () => {
  it("processes a Slack question about a slow query", async () => {
    orchestrator = new Orchestrator(transport, makeConfig());
    orchestrator.start();

    const slackMsg: SlackMessage = {
      channel: "#data-engineering",
      user: "U123",
      text: "@duckpipe why is stg_orders slow",
      ts: "1234567890.123456",
    };

    const result = await runQuerySage(orchestrator, makeConfig(), slackMsg);

    expect(result.status).toBe("completed");
    expect(result.agentResults.snowflake).toBeDefined();
  });

  it("completes gracefully without a Slack message", async () => {
    orchestrator = new Orchestrator(transport, makeConfig());
    orchestrator.start();

    const result = await runQuerySage(orchestrator, makeConfig());
    expect(result.status).toBe("completed");
  });
});
