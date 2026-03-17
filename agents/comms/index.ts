import { startAgentRuntime, type ToolFn } from "../runtime.js";
import { loadConfig } from "../../src/config.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

async function main() {
  const config = loadConfig();
  const slack    = config.integrations?.slack;
  const jira     = config.integrations?.jira;
  const conf     = config.integrations?.confluence;

  const slackCfg = slack ? {
    botToken:          slack.bot_token,
    appToken:          slack.app_token,
    allowedChannels:   slack.allowed_channels ?? [],
    approvalTimeoutMs: (slack.approval_timeout_seconds ?? 300) * 1000,
  } : null;

  const jiraCfg = jira ? {
    baseUrl:        jira.base_url,
    email:          jira.email,
    apiToken:       jira.api_token,
    defaultProject: jira.default_project ?? "DE",
  } : null;

  const confluenceCfg = conf ? {
    baseUrl:  conf.base_url,
    email:    conf.email,
    apiToken: conf.api_token,
    spaceKey: conf.space_key,
  } : null;

  if (!slackCfg) console.warn("[comms] Slack not configured — message tools will fail gracefully");
  if (!jiraCfg) console.warn("[comms] Jira not configured — ticket tools will fail gracefully");
  if (!confluenceCfg) console.warn("[comms] Confluence not configured — page tools will fail gracefully");

  const notConfigured = (name: string) => async () => {
    throw new Error(`${name} is not configured. Add credentials to .env and enable it in duckpipe.yaml`);
  };

  const registry = new Map<string, ToolFn>([
    ["slack_post_message",       wrap(async (p) => {
      if (!slackCfg) return notConfigured("Slack")();
      return tools.slackPostMessage(slackCfg, p.channel as string, p.text as string);
    })],
    ["slack_post_thread_reply",  wrap(async (p) => {
      if (!slackCfg) return notConfigured("Slack")();
      return tools.slackPostThreadReply(slackCfg, p.channel as string, p.thread_ts as string, p.text as string);
    })],
    ["slack_get_channel_history", wrap(async (p) => {
      if (!slackCfg) return { messages: [] };
      return { messages: await tools.slackGetChannelHistory(slackCfg, p.channel as string, (p.limit as number) ?? 20) };
    })],
    ["jira_create_issue",        wrap(async (p) => {
      if (!jiraCfg) return notConfigured("Jira")();
      return tools.jiraCreateIssue(jiraCfg, p.project as string, p.summary as string, p.description as string, (p.issue_type as string) ?? "Bug");
    })],
    ["jira_get_issue",           wrap(async (p) => {
      if (!jiraCfg) return notConfigured("Jira")();
      return tools.jiraGetIssue(jiraCfg, p.issue_key as string);
    })],
    ["jira_search_issues",       wrap(async (p) => {
      if (!jiraCfg) return { issues: [] };
      return { issues: await tools.jiraSearchIssues(jiraCfg, p.jql as string, (p.limit as number) ?? 10) };
    })],
    ["confluence_create_page",   wrap(async (p) => {
      if (!confluenceCfg) return notConfigured("Confluence")();
      return tools.confluenceCreatePage(confluenceCfg, p.title as string, p.body as string, p.parent_id as string);
    })],
    ["confluence_update_page",   wrap(async (p) => {
      if (!confluenceCfg) return notConfigured("Confluence")();
      return tools.confluenceUpdatePage(confluenceCfg, p.page_id as string, p.title as string, p.body as string, p.version as number);
    })],
    ["confluence_upsert_page",   wrap(async (p) => {
      if (!confluenceCfg) return notConfigured("Confluence")();
      return tools.confluenceUpsertPage(
        confluenceCfg,
        p.title as string,
        p.body as string,
        p.parent_id as string | undefined,
      );
    })],
    ["confluence_find_page",     wrap(async (p) => {
      if (!confluenceCfg) return { page: null };
      return { page: await tools.confluenceFindPageByTitle(confluenceCfg, p.title as string) };
    })],
    ["confluence_search_pages",  wrap(async (p) => {
      if (!confluenceCfg) return { pages: [] };
      return { pages: await tools.confluenceSearchPages(confluenceCfg, p.query as string, (p.limit as number) ?? 5) };
    })],
    ["format_incident_message",  wrap(async (p) => ({ text: tools.formatIncidentMessage(p as any) }))],
    ["format_cost_alert",        wrap(async (p) => ({ text: tools.formatCostAlert(p as any) }))],
    ["format_sla_warning",       wrap(async (p) => ({ text: tools.formatSlaWarning(p as any) }))],
    ["extract_entity_from_message", wrap(async (p) => tools.extractEntityFromMessage(p.text as string))],
  ]);

  startAgentRuntime({ name: "comms", busDir: BUS_DIR, tools: registry });
}

main().catch(console.error);
