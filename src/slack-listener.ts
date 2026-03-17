/**
 * Slack Socket Mode listener for @duckpipe mentions.
 * Uses Slack's WebSocket-based Socket Mode to receive events in real-time
 * without exposing a public HTTP endpoint.
 */

import type { DuckpipeConfig, SlackMessage, VaultBackend } from "./types.js";
import { resolveConfigValue } from "./vault.js";

const SLACK_API = "https://slack.com/api";

interface SlackSocketEvent {
  envelope_id: string;
  type: string;
  payload?: {
    event?: {
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };
  };
}

export class SlackListener {
  private config: DuckpipeConfig;
  private vault: VaultBackend;
  private ws: WebSocket | null = null;
  private running = false;
  private handler: ((msg: SlackMessage) => void) | null = null;
  private triggerKeyword: string;
  private allowedChannels: string[];

  constructor(config: DuckpipeConfig, vault: VaultBackend) {
    this.config = config;
    this.vault = vault;
    this.triggerKeyword = config.integrations.slack?.trigger_keyword ?? "@duckpipe";
    this.allowedChannels = config.integrations.slack?.allowed_channels ?? [];
  }

  onMessage(handler: (msg: SlackMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const slack = this.config.integrations.slack;
    if (!slack?.enabled || !slack.app_token) {
      console.log("  Slack listener disabled (no app_token configured)");
      return;
    }

    const appToken = await resolveConfigValue(this.vault, slack.app_token);
    this.running = true;

    await this.connect(appToken);
  }

  private async connect(appToken: string): Promise<void> {
    try {
      const resp = await fetch(`${SLACK_API}/apps.connections.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const data = (await resp.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) {
        console.error(`  Slack Socket Mode failed: ${data.error ?? "no URL returned"}`);
        return;
      }

      this.ws = new WebSocket(data.url);

      this.ws.onopen = () => {
        console.log("  ✓ Slack listener connected (Socket Mode)");
      };

      this.ws.onmessage = (event) => {
        this.handleSocketEvent(event.data as string);
      };

      this.ws.onclose = () => {
        if (this.running) {
          console.log("  Slack WebSocket closed — reconnecting in 5s");
          setTimeout(() => this.connect(appToken), 5000);
        }
      };

      this.ws.onerror = (err) => {
        console.error("  Slack WebSocket error:", err);
      };
    } catch (err) {
      console.error("  Slack listener connection error:", err instanceof Error ? err.message : err);
      if (this.running) {
        setTimeout(() => this.connect(appToken), 10000);
      }
    }
  }

  private handleSocketEvent(raw: string): void {
    let event: SlackSocketEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    // Acknowledge all events
    if (event.envelope_id && this.ws) {
      this.ws.send(JSON.stringify({ envelope_id: event.envelope_id }));
    }

    if (event.type !== "events_api" || !event.payload?.event) return;

    const slackEvent = event.payload.event;
    if (slackEvent.type !== "message" && slackEvent.type !== "app_mention") return;

    const text = slackEvent.text ?? "";
    if (!text.toLowerCase().includes(this.triggerKeyword.replace("@", "").toLowerCase())) return;

    if (
      this.allowedChannels.length > 0 &&
      slackEvent.channel &&
      !this.allowedChannels.includes(slackEvent.channel)
    ) {
      return;
    }

    const message: SlackMessage = {
      channel: slackEvent.channel ?? "",
      user: slackEvent.user ?? "",
      text,
      ts: slackEvent.ts ?? "",
      thread_ts: slackEvent.thread_ts,
    };

    this.handler?.(message);
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
