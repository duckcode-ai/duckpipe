import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";
import { FileTransport } from "../src/bus.js";
import { initAudit } from "../src/audit.js";
import { loadPolicy } from "../src/policy.js";
import { getStateDb, closeAll } from "../src/db.js";
import type { DuckpipeConfig, VaultBackend } from "../src/types.js";

const TEST_DATA_DIR = "./data-test-orch-approval";
const TEST_BUS_DIR = "./bus-test-orch-approval";
const TEST_POLICY_DIR = "./policy-test-orch-approval";

function makeConfig(tier: 1 | 2 | 3 = 2): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: tier },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      slack: {
        enabled: true,
        bot_token: "${SLACK_BOT_TOKEN}",
        app_token: "${SLACK_APP_TOKEN}",
        trigger_keyword: "@duckpipe",
        allowed_channels: ["#data-incidents"],
        approval_timeout_seconds: 1,
      },
    },
  } as DuckpipeConfig;
}

function makeVault(): VaultBackend {
  return {
    get: vi.fn(async (key: string) => {
      if (key === "SLACK_BOT_TOKEN") return "xoxb-test";
      if (key === "SLACK_APP_TOKEN") return "xapp-test";
      return "";
    }),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_POLICY_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
  getStateDb(TEST_DATA_DIR);
  loadPolicy(`${TEST_POLICY_DIR}/nonexistent.yaml`);
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  rmSync(TEST_BUS_DIR, { recursive: true, force: true });
  rmSync(TEST_POLICY_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Orchestrator with approval flow", () => {
  it("Tier 1 blocks all write actions without approval", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig(1));

    const result = await orch.executeWriteAction(
      "comms",
      "incident-autopilot",
      "slack_post_message",
      { channel: "#test", text: "hello" },
      {}
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toContain("Tier 1");
    await transport.shutdown();
  });

  it("Tier 2 requires approval for write actions", async () => {
    // Mock fetch for Slack API
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, channel: "C123", ts: "1234.5678" }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, message: { reactions: [] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig(2), makeVault());

    const result = await orch.executeWriteAction(
      "comms",
      "incident-autopilot",
      "slack_post_message",
      { channel: "#test", text: "hello" },
      {}
    );

    // Should time out since no approval reaction
    expect(result.decision.allowed).toBe(false);

    vi.unstubAllGlobals();
    await transport.shutdown();
  });

  it("Tier 2 without Slack returns disallowed when approval required", async () => {
    const config = makeConfig(2);
    delete (config.integrations as any).slack;

    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, config);

    const result = await orch.executeWriteAction(
      "airflow",
      "incident-autopilot",
      "trigger_dag_run",
      { dag_id: "test" },
      {}
    );

    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toContain("not configured");
    await transport.shutdown();
  });
});
