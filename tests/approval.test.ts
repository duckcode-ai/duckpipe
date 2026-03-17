import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { ApprovalManager, type ApprovalRequest } from "../src/approval.js";
import { initAudit } from "../src/audit.js";
import { closeAll } from "../src/db.js";
import type { DuckpipeConfig, VaultBackend } from "../src/types.js";

const TEST_DATA_DIR = "./data-test-approval";

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
        approval_timeout_seconds: 2,
      },
    },
  } as DuckpipeConfig;
}

function makeVault(token = "xoxb-test-token"): VaultBackend {
  return {
    get: vi.fn(async (key: string) => {
      if (key === "SLACK_BOT_TOKEN") return token;
      if (key === "SLACK_APP_TOKEN") return "xapp-test";
      return "";
    }),
  };
}

function makeRequest(): ApprovalRequest {
  return {
    description: "comms/slack_post_message",
    preview: '{"channel":"#test"}',
    workflow: "incident-autopilot",
    agent: "comms",
    action: "slack_post_message",
    tier: 2,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ApprovalManager", () => {
  it("throws if Slack is not enabled", () => {
    const config = makeConfig();
    (config.integrations.slack as any).enabled = false;
    expect(() => new ApprovalManager(config, makeVault()))
      .toThrow("Slack approval requires");
  });

  it("throws if no allowed channels", () => {
    const config = makeConfig();
    (config.integrations.slack as any).allowed_channels = [];
    expect(() => new ApprovalManager(config, makeVault()))
      .toThrow("Slack approval requires");
  });

  it("builds approval message with correct format", () => {
    const mgr = new ApprovalManager(makeConfig(), makeVault());
    const msg = (mgr as any).buildApprovalMessage(makeRequest());
    expect(msg).toContain("DuckPipe approval needed");
    expect(msg).toContain("comms/slack_post_message");
    expect(msg).toContain("incident-autopilot");
    expect(msg).toContain("React ✅ to approve");
  });

  it("times out when no approval reaction is received", async () => {
    // Mock fetch to simulate Slack API
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, channel: "C123", ts: "1234.5678" }),
      })
      // Subsequent calls return no reactions
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, message: { reactions: [] } }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig();
    config.integrations.slack!.approval_timeout_seconds = 1;
    const mgr = new ApprovalManager(config, makeVault());

    const result = await mgr.requestApproval(makeRequest());
    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.approvedBy).toBe("timeout");

    vi.unstubAllGlobals();
  });
});
