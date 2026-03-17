import type { AgentName, AssistantReadinessReport, DuckpipeConfig, WorkflowName } from "./types.js";
import { getActiveLlmInfo } from "./llm.js";

type ToolRegistry = Record<AgentName, string[]>;
type WorkflowContract = Array<{ agent: AgentName; tool: string }>;

export const AGENT_TOOL_REGISTRY: ToolRegistry = {
  airflow: [
    "list_dags",
    "get_dag_runs",
    "get_running_dags",
    "get_task_instances",
    "get_task_logs",
    "trigger_dag_run",
    "clear_task",
    "check_failures",
  ],
  dbt: [
    "list_jobs",
    "get_run",
    "get_manifest",
    "list_models",
    "create_branch",
    "push_file",
    "create_pr",
    "find_affected_models",
    "load_local_manifest",
    "check_recent_changes",
    "get_project_graph",
  ],
  snowflake: [
    "execute_query",
    "get_query_history",
    "get_query_profile",
    "cancel_query",
    "get_warehouse_usage",
    "fetch_schemas",
    "check_source_anomalies",
    "get_query_plans",
    "analyze_query_performance",
  ],
  comms: [
    "slack_post_message",
    "slack_post_thread_reply",
    "slack_get_channel_history",
    "jira_create_issue",
    "jira_get_issue",
    "jira_search_issues",
    "confluence_create_page",
    "confluence_update_page",
    "confluence_upsert_page",
    "confluence_find_page",
    "confluence_search_pages",
    "format_incident_message",
    "format_cost_alert",
    "format_sla_warning",
    "extract_entity_from_message",
  ],
};

export const WORKFLOW_TOOL_CONTRACTS: Record<WorkflowName, WorkflowContract> = {
  "incident-autopilot": [
    { agent: "airflow", tool: "check_failures" },
    { agent: "dbt", tool: "check_recent_changes" },
    { agent: "snowflake", tool: "check_source_anomalies" },
    { agent: "comms", tool: "slack_post_message" },
    { agent: "comms", tool: "jira_create_issue" },
    { agent: "airflow", tool: "trigger_dag_run" },
  ],
  "pipeline-whisperer": [
    { agent: "snowflake", tool: "fetch_schemas" },
    { agent: "dbt", tool: "find_affected_models" },
    { agent: "comms", tool: "slack_post_message" },
    { agent: "dbt", tool: "create_pr" },
  ],
  "cost-sentinel": [
    { agent: "snowflake", tool: "get_query_history" },
    { agent: "comms", tool: "slack_post_message" },
    { agent: "snowflake", tool: "cancel_query" },
  ],
  "knowledge-scribe": [
    { agent: "dbt", tool: "get_project_graph" },
    { agent: "comms", tool: "confluence_upsert_page" },
  ],
  "sla-guardian": [
    { agent: "airflow", tool: "get_running_dags" },
    { agent: "comms", tool: "slack_post_message" },
  ],
  "query-sage": [
    { agent: "comms", tool: "extract_entity_from_message" },
    { agent: "snowflake", tool: "get_query_plans" },
    { agent: "snowflake", tool: "analyze_query_performance" },
    { agent: "comms", tool: "slack_post_thread_reply" },
  ],
};

export function validateWorkflowToolContracts(
  config?: DuckpipeConfig
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [workflow, requirements] of Object.entries(WORKFLOW_TOOL_CONTRACTS) as Array<[WorkflowName, WorkflowContract]>) {
    for (const requirement of requirements) {
      if (!AGENT_TOOL_REGISTRY[requirement.agent].includes(requirement.tool)) {
        errors.push(`${workflow} references missing tool ${requirement.agent}.${requirement.tool}`);
      }
    }
  }

  if (config?.integrations?.snowflake?.role?.toUpperCase() === "ACCOUNTADMIN") {
    warnings.push("Snowflake role is ACCOUNTADMIN; switch to a least-privilege reader/operator role for enterprise deployments.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function buildAssistantReadinessReport(config: DuckpipeConfig): AssistantReadinessReport {
  const registry = validateWorkflowToolContracts(config);
  const llm = getActiveLlmInfo(config);
  const workflows: AssistantReadinessReport["workflows"] = {};

  const enabled = {
    "incident-autopilot": config.workflows?.incident_autopilot?.enabled ?? false,
    "pipeline-whisperer": config.workflows?.pipeline_whisperer?.enabled ?? false,
    "cost-sentinel": config.workflows?.cost_sentinel?.enabled ?? false,
    "knowledge-scribe": config.workflows?.knowledge_scribe?.enabled ?? false,
    "sla-guardian": config.workflows?.sla_guardian?.enabled ?? false,
    "query-sage": config.workflows?.query_sage?.enabled ?? false,
  } satisfies Record<WorkflowName, boolean>;

  for (const workflow of Object.keys(enabled) as WorkflowName[]) {
    const issues: string[] = [];
    if (!enabled[workflow]) {
      issues.push("Workflow disabled in duckpipe.yaml");
    }

    if (workflow === "incident-autopilot") {
      if (!config.integrations.airflow?.enabled) issues.push("Airflow integration disabled");
      if (!config.integrations.slack?.enabled) issues.push("Slack alerts disabled; incidents will not be pushed to humans");
    }

    if (workflow === "pipeline-whisperer") {
      if (!config.integrations.snowflake?.enabled) issues.push("Snowflake integration disabled");
      if (!config.integrations.dbt?.enabled) issues.push("dbt integration disabled");
    }

    if (workflow === "knowledge-scribe") {
      if (!config.integrations.confluence?.enabled) issues.push("Confluence integration disabled");
      if (!config.integrations.dbt?.enabled) issues.push("dbt integration disabled");
    }

    if (workflow === "query-sage") {
      if (!config.integrations.slack?.enabled) issues.push("Slack integration disabled");
      if (!config.integrations.snowflake?.enabled) issues.push("Snowflake integration disabled");
    }

    workflows[workflow] = { ready: issues.length === 0, issues };
  }

  return {
    ok: registry.ok,
    errors: registry.errors,
    warnings: registry.warnings,
    llm: {
      configured: !!llm,
      provider: llm?.provider ?? null,
      model: llm?.model ?? null,
    },
    workflows,
  };
}

export function assertWorkflowToolContracts(config?: DuckpipeConfig): void {
  const report = validateWorkflowToolContracts(config);
  if (!report.ok) {
    throw new Error(`Workflow registry validation failed:\n- ${report.errors.join("\n- ")}`);
  }
}
