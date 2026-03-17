import { startAgentRuntime, type ToolFn } from "../runtime.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

const registry = new Map<string, ToolFn>([
  ["slack_post_message", wrap(async (p) => tools.slackPostMessage(p.config as any, p.channel as string, p.text as string))],
  ["slack_post_thread_reply", wrap(async (p) => tools.slackPostThreadReply(p.config as any, p.channel as string, p.thread_ts as string, p.text as string))],
  ["slack_get_channel_history", wrap(async (p) => ({ messages: await tools.slackGetChannelHistory(p.config as any, p.channel as string, p.limit as number) }))],
  ["jira_create_issue", wrap(async (p) => tools.jiraCreateIssue(p.config as any, p.project as string, p.summary as string, p.description as string, p.issue_type as string))],
  ["jira_get_issue", wrap(async (p) => tools.jiraGetIssue(p.config as any, p.issue_key as string))],
  ["confluence_create_page", wrap(async (p) => tools.confluenceCreatePage(p.config as any, p.title as string, p.body as string, p.parent_id as string))],
  ["confluence_update_page", wrap(async (p) => tools.confluenceUpdatePage(p.config as any, p.page_id as string, p.title as string, p.body as string, p.version as number))],
  ["format_incident_message", wrap(async (p) => ({ text: tools.formatIncidentMessage(p as any) }))],
  ["format_cost_alert", wrap(async (p) => ({ text: tools.formatCostAlert(p as any) }))],
  ["format_sla_warning", wrap(async (p) => ({ text: tools.formatSlaWarning(p as any) }))],
]);

startAgentRuntime({ name: "comms", busDir: BUS_DIR, tools: registry });
