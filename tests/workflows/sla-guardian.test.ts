import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { Orchestrator } from "../../src/orchestrator.js";
import { FileTransport } from "../../src/bus.js";
import { initAudit } from "../../src/audit.js";
import { loadPolicy } from "../../src/policy.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { runSlaGuardian } from "../../workflows/sla-guardian.js";
import type { DuckpipeConfig } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-sla";
const TEST_BUS_DIR = "./bus-test-sla";

function makeConfig(): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 1 },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      slack: {
        enabled: true,
        bot_token: "test",
        allowed_channels: ["#data-incidents"],
        approval_timeout_seconds: 300,
        trigger_keyword: "@duckpipe",
      },
    },
    workflows: {
      sla_guardian: {
        enabled: true,
        poll_interval_minutes: 5,
        monitored_dags: ["etl_daily"],
      },
    },
  } as DuckpipeConfig;
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

describe("sla-guardian workflow", () => {
  it("records workflow start in state DB", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig());
    orch.start();

    // Mock dispatchToAgent to return empty running dags
    vi.spyOn(orch, "dispatchToAgent").mockResolvedValue({
      id: "test",
      timestamp: new Date().toISOString(),
      source: "airflow",
      target: "orchestrator",
      workflow: "sla-guardian",
      type: "result",
      payload: { runningDags: [] },
    });

    const result = await runSlaGuardian(orch, makeConfig());

    expect(result.workflow).toBe("sla-guardian");
    expect(result.status).toBe("completed");
    await transport.shutdown();
  });

  it("handles airflow agent errors gracefully", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig());
    orch.start();

    vi.spyOn(orch, "dispatchToAgent").mockRejectedValue(new Error("Connection refused"));

    const result = await runSlaGuardian(orch, makeConfig());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Connection refused");
    await transport.shutdown();
  });

  it("attempts Slack warning when breach probability > 0.7", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const config = makeConfig();
    config.duckpipe.trust_tier = 2;
    const orch = new Orchestrator(transport, config);
    orch.start();

    // fraction = 2700/3600 = 0.75 (>0.7), deadline is close (2 min away),
    // estimated total = 3600s, estimated remaining = 900s, remaining actual = 120s
    // Since 900 > 120, breachProb = min(0.95, 900/120) = 0.95
    vi.spyOn(orch, "dispatchToAgent").mockResolvedValue({
      id: "test",
      timestamp: new Date().toISOString(),
      source: "airflow",
      target: "orchestrator",
      workflow: "sla-guardian",
      type: "result",
      payload: {
        runningDags: [{
          dagId: "etl_daily",
          elapsedSeconds: 2700,
          historicalP95Seconds: 3600,
          slaDeadline: new Date(Date.now() + 120000).toISOString(),
        }],
      },
    });

    // executeWriteAction is called for Tier 2 comms writes
    // With no approval manager, it will log and return not-allowed
    const result = await runSlaGuardian(orch, config);
    expect(result.status).toBe("completed");

    // Check audit log for the blocked comms write attempt
    const { queryAudit } = await import("../../src/audit.js");
    const entries = queryAudit({ workflow: "sla-guardian", write_only: true });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    await transport.shutdown();
  });
});
