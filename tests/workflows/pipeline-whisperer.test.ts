import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { MockTransport } from "../mocks/mock-transport.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { runPipelineWhisperer } from "../../workflows/pipeline-whisperer.js";
import { initAudit, queryAudit } from "../../src/audit.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { loadPolicy } from "../../src/policy.js";
import type { DuckpipeConfig, BusMessage } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-whisper";

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
      snowflake: {
        enabled: true,
        account: "test",
        user: "test",
        role: "DUCKPIPE_READER",
        warehouse: "COMPUTE_WH",
        database: "ANALYTICS",
        watched_databases: [],
      },
      slack: {
        enabled: true,
        bot_token: "xoxb-test",
        allowed_channels: ["#data-engineering"],
        approval_timeout_seconds: 60,
        trigger_keyword: "@duckpipe",
      },
    },
    workflows: {
      pipeline_whisperer: {
        enabled: true,
        github_repo: "test-org/test-repo",
        base_branch: "main",
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
      schemas: [],
      driftDetected: false,
    })
  );

  transport.registerAgentHandler("dbt", (msg: BusMessage) =>
    MockTransport.createResponse(msg, {
      affectedModels: [],
      proposedChanges: [],
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

describe("pipeline-whisperer workflow", () => {
  it("completes when no drift detected", async () => {
    orchestrator = new Orchestrator(transport, makeConfig());
    orchestrator.start();

    const result = await runPipelineWhisperer(orchestrator, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.agentResults.snowflake).toMatchObject({ drift: false });
  });

  it("detects drift and dispatches to dbt agent", async () => {
    transport.registerAgentHandler("snowflake", (msg: BusMessage) =>
      MockTransport.createResponse(msg, {
        driftDetected: true,
        changedTables: ["raw.stripe.payments"],
        schemas: [{ table: "raw.stripe.payments", columns: [{ name: "id", type: "NUMBER" }] }],
      })
    );

    transport.registerAgentHandler("dbt", (msg: BusMessage) =>
      MockTransport.createResponse(msg, {
        affectedModels: ["stg_payments"],
        proposedChanges: [{ model: "stg_payments", diff: "+  id NUMBER" }],
        prUrl: "https://github.com/test/test/pull/1",
      })
    );

    orchestrator = new Orchestrator(transport, makeConfig(2));
    orchestrator.start();

    const result = await runPipelineWhisperer(orchestrator, makeConfig(2));

    expect(result.status).toBe("completed");

    const dbtMsgs = transport.getMessagesSentTo("dbt");
    expect(dbtMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("creates audit entries for all agent interactions", async () => {
    orchestrator = new Orchestrator(transport, makeConfig());
    orchestrator.start();

    await runPipelineWhisperer(orchestrator, makeConfig());

    const entries = queryAudit({ workflow: "pipeline-whisperer" });
    expect(entries.length).toBeGreaterThan(0);
  });
});
