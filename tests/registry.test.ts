import { describe, it, expect } from "vitest";
import { AGENT_TOOL_REGISTRY, validateWorkflowToolContracts } from "../src/registry.js";
import type { DuckpipeConfig } from "../src/types.js";

function makeConfig(): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 1 },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 5 },
    integrations: {
      airflow: { enabled: true, base_url: "http://airflow", allowed_dags: [], verify_ssl: true },
      dbt: { enabled: true, cloud_url: "https://cloud.getdbt.com" },
      snowflake: { enabled: true, account: "acct", user: "user", role: "DUCKPIPE_READER", warehouse: "wh", database: "db", watched_databases: [] },
      slack: { enabled: true, bot_token: "xoxb", allowed_channels: ["#data-incidents"], approval_timeout_seconds: 60, trigger_keyword: "@duckpipe" },
      jira: { enabled: false, base_url: "", email: "", api_token: "", default_project: "DE" },
      confluence: { enabled: false, base_url: "", email: "", api_token: "", space_key: "DATA" },
    },
    workflows: {
      incident_autopilot: { enabled: true, poll_interval_seconds: 60, auto_page_on_p1: false },
      pipeline_whisperer: { enabled: true, poll_interval_minutes: 15, base_branch: "main" },
      knowledge_scribe: { enabled: true, schedule: "0 2 * * *" },
      query_sage: { enabled: true, auto_apply_optimizations: false },
      cost_sentinel: { enabled: true, poll_interval_minutes: 10, cost_alert_threshold_credits: 100, kill_threshold_credits: 500 },
      sla_guardian: { enabled: true, poll_interval_minutes: 5, monitored_dags: [] },
    },
  };
}

describe("workflow registry validation", () => {
  it("keeps runtime tool contracts aligned", () => {
    const report = validateWorkflowToolContracts(makeConfig());
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("includes the assistant-only tools in the live registry", () => {
    expect(AGENT_TOOL_REGISTRY.comms).toContain("extract_entity_from_message");
    expect(AGENT_TOOL_REGISTRY.comms).toContain("confluence_upsert_page");
    expect(AGENT_TOOL_REGISTRY.snowflake).toContain("get_query_plans");
    expect(AGENT_TOOL_REGISTRY.snowflake).toContain("analyze_query_performance");
    expect(AGENT_TOOL_REGISTRY.dbt).toContain("get_project_graph");
  });
});
