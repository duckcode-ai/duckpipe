import type {
  AgentName,
  DuckpipeConfig,
  TrustTier,
  VaultBackend,
  WorkflowName,
} from "./types.js";
import { logAction } from "./audit.js";
import { resolveConfigValue } from "./vault.js";

const SLACK_API_BASE = "https://slack.com/api";
const POLL_INTERVAL_MS = 2000;
const APPROVE_EMOJI = "white_check_mark";
const REJECT_EMOJI = "x";

export interface ApprovalRequest {
  description: string;
  preview: string;
  workflow: WorkflowName;
  agent: AgentName;
  action: string;
  tier: TrustTier;
}

export interface ApprovalResult {
  approved: boolean;
  approvedBy: string;
  timedOut: boolean;
}

interface SlackPostMessageResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

interface SlackReactionsGetResponse {
  ok: boolean;
  message?: {
    reactions?: Array<{
      name: string;
      users: string[];
      count: number;
    }>;
  };
  error?: string;
}

export class ApprovalManager {
  private botToken: string | null = null;
  private channel: string;
  private timeoutSeconds: number;

  constructor(
    private config: DuckpipeConfig,
    private vault: VaultBackend
  ) {
    const slack = config.integrations.slack;
    if (!slack?.enabled || !slack.allowed_channels.length) {
      throw new Error(
        "Slack approval requires integrations.slack.enabled and at least one allowed_channel"
      );
    }
    this.channel = slack.allowed_channels[0];
    this.timeoutSeconds = slack.approval_timeout_seconds ?? 300;
  }

  private async getToken(): Promise<string> {
    if (!this.botToken) {
      const slack = this.config.integrations.slack;
      if (!slack) throw new Error("Slack not configured");
      this.botToken = await resolveConfigValue(this.vault, slack.bot_token);
    }
    return this.botToken;
  }

  private buildApprovalMessage(request: ApprovalRequest): string {
    const timeoutMinutes = Math.ceil(this.timeoutSeconds / 60);
    return [
      "🦆 *DuckPipe approval needed*",
      `Action: ${request.description}`,
      `Details: ${request.preview}`,
      `Workflow: ${request.workflow}`,
      `React ✅ to approve or ❌ to skip (timeout: ${timeoutMinutes} minutes)`,
    ].join("\n");
  }

  private async postApprovalRequest(
    message: string
  ): Promise<{ channel: string; ts: string }> {
    const token = await this.getToken();
    const resp = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: this.channel,
        text: message,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Slack API error: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as SlackPostMessageResponse;
    if (!data.ok || !data.ts || !data.channel) {
      throw new Error(data.error ?? "Slack chat.postMessage failed");
    }
    return { channel: data.channel, ts: data.ts };
  }

  private async getReactions(channel: string, timestamp: string): Promise<
    Array<{ name: string; users: string[] }>
  > {
    const token = await this.getToken();
    const params = new URLSearchParams({
      channel,
      timestamp,
    });
    const resp = await fetch(
      `${SLACK_API_BASE}/reactions.get?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!resp.ok) {
      throw new Error(`Slack API error: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as SlackReactionsGetResponse;
    if (!data.ok) {
      if (data.error === "no_reaction" || data.error === "message_not_found") {
        return [];
      }
      throw new Error(data.error ?? "Slack reactions.get failed");
    }

    const reactions = data.message?.reactions ?? [];
    return reactions.map((r) => ({ name: r.name, users: r.users }));
  }

  private async resolveApprover(
    channel: string,
    timestamp: string
  ): Promise<{ approved: boolean; approvedBy: string } | null> {
    const reactions = await this.getReactions(channel, timestamp);

    const approveReaction = reactions.find(
      (r) =>
        r.name === APPROVE_EMOJI ||
        r.name === "heavy_check_mark" ||
        r.name === "ballot_box_with_check"
    );
    const rejectReaction = reactions.find(
      (r) => r.name === REJECT_EMOJI || r.name === "negative_squared_cross_mark"
    );

    if (approveReaction && approveReaction.users.length > 0) {
      return {
        approved: true,
        approvedBy: `slack:${approveReaction.users[0]}`,
      };
    }
    if (rejectReaction && rejectReaction.users.length > 0) {
      return {
        approved: false,
        approvedBy: `slack:${rejectReaction.users[0]}`,
      };
    }
    return null;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const message = this.buildApprovalMessage(request);
    const { channel, ts: timestamp } = await this.postApprovalRequest(message);

    const deadline = Date.now() + this.timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const result = await this.resolveApprover(channel, timestamp);
      if (result) {
        logAction({
          workflow: request.workflow,
          agent: request.agent,
          tool: `approval:${request.action}`,
          tier: request.tier,
          input_json: JSON.stringify({
            description: request.description,
            preview: request.preview,
            action: request.action,
          }),
          write_action: true,
          approved_by: result.approvedBy,
          success: true,
        });

        return {
          approved: result.approved,
          approvedBy: result.approvedBy,
          timedOut: false,
        };
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    logAction({
      workflow: request.workflow,
      agent: request.agent,
      tool: `approval:${request.action}`,
      tier: request.tier,
      input_json: JSON.stringify({
        description: request.description,
        preview: request.preview,
        action: request.action,
      }),
      write_action: true,
      approved_by: "timeout",
      success: false,
      error_message: "Approval request timed out",
    });

    return {
      approved: false,
      approvedBy: "timeout",
      timedOut: true,
    };
  }
}
