import { describe, it, expect, vi, afterEach } from "vitest";
import { SlackListener } from "../src/slack-listener.js";
import type { DuckpipeConfig, SlackMessage, VaultBackend } from "../src/types.js";

function makeConfig(): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 2 },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      slack: {
        enabled: true,
        bot_token: "${SLACK_BOT_TOKEN}",
        app_token: "${SLACK_APP_TOKEN}",
        trigger_keyword: "@duckpipe",
        allowed_channels: ["#data-incidents", "#data-engineering"],
        approval_timeout_seconds: 300,
      },
    },
  } as DuckpipeConfig;
}

function makeVault(): VaultBackend {
  return {
    get: vi.fn(async (key: string) => {
      if (key === "SLACK_APP_TOKEN") return "xapp-test-token";
      if (key === "SLACK_BOT_TOKEN") return "xoxb-test-token";
      return "";
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlackListener", () => {
  it("can be constructed with valid config", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    expect(listener).toBeDefined();
  });

  it("registers message handler", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    const handler = vi.fn();
    listener.onMessage(handler);
    // Handler is stored — tested indirectly via event processing
    expect(listener).toBeDefined();
  });

  it("skips start when no app_token configured", async () => {
    const config = makeConfig();
    config.integrations.slack!.app_token = undefined;
    const listener = new SlackListener(config, makeVault());
    await listener.start();
    // Should not throw, just log and return
    listener.stop();
  });

  it("stop is idempotent", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    listener.stop();
    listener.stop();
  });

  it("handleSocketEvent parses app_mention events", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    const received: SlackMessage[] = [];
    listener.onMessage(msg => received.push(msg));

    // Simulate event processing by calling the private method
    const event = JSON.stringify({
      envelope_id: "env-123",
      type: "events_api",
      payload: {
        event: {
          type: "app_mention",
          text: "hey @duckpipe why is orders slow?",
          user: "U123",
          channel: "#data-incidents",
          ts: "1234.5678",
        },
      },
    });

    (listener as any).ws = { send: vi.fn() };
    (listener as any).handleSocketEvent(event);

    expect(received.length).toBe(1);
    expect(received[0].text).toContain("duckpipe");
    expect(received[0].channel).toBe("#data-incidents");
  });

  it("ignores events from non-allowed channels", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    const received: SlackMessage[] = [];
    listener.onMessage(msg => received.push(msg));

    const event = JSON.stringify({
      envelope_id: "env-456",
      type: "events_api",
      payload: {
        event: {
          type: "app_mention",
          text: "@duckpipe test",
          user: "U123",
          channel: "#random",
          ts: "1234.5679",
        },
      },
    });

    (listener as any).ws = { send: vi.fn() };
    (listener as any).handleSocketEvent(event);

    expect(received.length).toBe(0);
  });

  it("ignores events without trigger keyword", () => {
    const listener = new SlackListener(makeConfig(), makeVault());
    const received: SlackMessage[] = [];
    listener.onMessage(msg => received.push(msg));

    const event = JSON.stringify({
      envelope_id: "env-789",
      type: "events_api",
      payload: {
        event: {
          type: "message",
          text: "this is a normal message",
          user: "U123",
          channel: "#data-incidents",
          ts: "1234.5680",
        },
      },
    });

    (listener as any).ws = { send: vi.fn() };
    (listener as any).handleSocketEvent(event);

    expect(received.length).toBe(0);
  });
});
