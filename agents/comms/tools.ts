/**
 * Comms agent — Slack messaging, Jira tickets, Confluence pages.
 * The comms agent is the only DuckPipe agent that communicates with humans.
 */

interface SlackConfig {
  botToken: string;
  appToken?: string;
  allowedChannels: string[];
}

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  defaultProject: string;
}

interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
}

interface SlackPostResult {
  ok: boolean;
  ts: string;
  channel: string;
  error?: string;
}

// ── Slack ──────────────────────────────────────────────

function checkChannel(config: SlackConfig, channel: string): void {
  if (
    config.allowedChannels.length > 0 &&
    !config.allowedChannels.includes(channel)
  ) {
    throw new Error(
      `Channel ${channel} is not in allowed_channels: ${config.allowedChannels.join(", ")}`
    );
  }
}

export async function slackPostMessage(
  config: SlackConfig,
  channel: string,
  text: string
): Promise<SlackPostResult> {
  checkChannel(config, channel);

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
  });

  const data = (await resp.json()) as SlackPostResult;
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

export async function slackPostThreadReply(
  config: SlackConfig,
  channel: string,
  threadTs: string,
  text: string
): Promise<SlackPostResult> {
  checkChannel(config, channel);

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs, mrkdwn: true }),
  });

  const data = (await resp.json()) as SlackPostResult;
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

export async function slackGetChannelHistory(
  config: SlackConfig,
  channel: string,
  limit = 20
): Promise<Array<{ user: string; text: string; ts: string }>> {
  checkChannel(config, channel);

  const resp = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${config.botToken}`,
      },
    }
  );

  const data = (await resp.json()) as {
    ok: boolean;
    messages: Array<{ user: string; text: string; ts: string }>;
    error?: string;
  };
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data.messages;
}

export async function postApprovalRequest(
  config: SlackConfig,
  channel: string,
  action: string,
  details: string,
  workflow: string,
  timeoutMinutes: number
): Promise<SlackPostResult> {
  const text =
    `🦆 *DuckPipe approval needed*\n` +
    `Action: ${action}\n` +
    `Details: ${details}\n` +
    `Workflow: ${workflow}\n` +
    `React ✅ to approve or ❌ to skip (timeout: ${timeoutMinutes} minutes)`;

  return slackPostMessage(config, channel, text);
}

// ── Slack message formatters ──────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
  P1: "🔴",
  P2: "🟡",
  P3: "🟢",
};

const FOOTER = "\n_Detected by DuckPipe — duckcode.ai_";

export function formatIncidentMessage(params: {
  severity: string;
  dagId: string;
  rootCause: string;
  category: string;
  evidence: string[];
  recommendedAction: string;
}): string {
  const emoji = SEVERITY_EMOJI[params.severity] ?? "⚪";
  const evidenceText =
    params.evidence.length > 0
      ? `Evidence: "${params.evidence[0]}"`
      : "";

  return (
    `${emoji} *${params.severity} — ${params.dagId} failed*\n` +
    `Root cause: ${params.rootCause} (${params.category})\n` +
    `${evidenceText}\n` +
    `Recommended: ${params.recommendedAction}` +
    FOOTER
  );
}

export function formatCostAlert(params: {
  queryId: string;
  user: string;
  warehouse: string;
  creditsConsumed: number;
  runtimeSeconds: number;
}): string {
  return (
    `💰 *Expensive query detected*\n` +
    `Query: \`${params.queryId}\`\n` +
    `User: ${params.user}  Warehouse: ${params.warehouse}\n` +
    `Credits: ${params.creditsConsumed}  Runtime: ${params.runtimeSeconds}s` +
    FOOTER
  );
}

export function formatSlaWarning(params: {
  dagId: string;
  breachProbability: number;
  elapsedSeconds: number;
  historicalP95Seconds: number;
}): string {
  const pct = Math.round(params.breachProbability * 100);
  return (
    `⏰ *SLA breach warning — ${params.dagId}*\n` +
    `Breach probability: ${pct}%\n` +
    `Elapsed: ${Math.round(params.elapsedSeconds / 60)}m / Historical P95: ${Math.round(params.historicalP95Seconds / 60)}m` +
    FOOTER
  );
}

// ── Jira ──────────────────────────────────────────────

export async function jiraCreateIssue(
  config: JiraConfig,
  project: string,
  summary: string,
  description: string,
  issueType = "Bug"
): Promise<{ key: string; id: string; self: string }> {
  const resp = await fetch(`${config.baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${config.email}:${config.apiToken}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: project || config.defaultProject },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: description }],
            },
          ],
        },
        issuetype: { name: issueType },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira API error: ${resp.status} ${body}`);
  }

  return (await resp.json()) as { key: string; id: string; self: string };
}

export async function jiraGetIssue(
  config: JiraConfig,
  issueKey: string
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${config.baseUrl}/rest/api/3/issue/${issueKey}`,
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${config.email}:${config.apiToken}`).toString("base64"),
        Accept: "application/json",
      },
    }
  );

  if (!resp.ok) throw new Error(`Jira API error: ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

// ── Confluence ────────────────────────────────────────

export async function confluenceCreatePage(
  config: ConfluenceConfig,
  title: string,
  body: string,
  parentId?: string
): Promise<{ id: string; title: string }> {
  const payload: Record<string, unknown> = {
    type: "page",
    title,
    space: { key: config.spaceKey },
    body: {
      storage: {
        value: body,
        representation: "storage",
      },
    },
  };

  if (parentId) {
    payload.ancestors = [{ id: parentId }];
  }

  const resp = await fetch(`${config.baseUrl}/rest/api/content`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${config.email}:${config.apiToken}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Confluence API error: ${resp.status} ${text}`);
  }

  return (await resp.json()) as { id: string; title: string };
}

export async function confluenceUpdatePage(
  config: ConfluenceConfig,
  pageId: string,
  title: string,
  body: string,
  version: number
): Promise<{ id: string; title: string }> {
  const resp = await fetch(`${config.baseUrl}/rest/api/content/${pageId}`, {
    method: "PUT",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${config.email}:${config.apiToken}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "page",
      title,
      body: {
        storage: {
          value: body,
          representation: "storage",
        },
      },
      version: { number: version },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Confluence API error: ${resp.status} ${text}`);
  }

  return (await resp.json()) as { id: string; title: string };
}
