import { z } from "zod";

export type TrustTier = 1 | 2 | 3;

export type AgentName = "airflow" | "dbt" | "snowflake" | "comms";

export type WorkflowName =
  | "incident-autopilot"
  | "pipeline-whisperer"
  | "cost-sentinel"
  | "knowledge-scribe"
  | "sla-guardian"
  | "query-sage";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed";

export interface AuditEntry {
  id?: string;
  created_at?: string;
  workflow: string;
  agent: string;
  tool: string;
  tier: TrustTier;
  input_json: string;
  output_json?: string;
  write_action: boolean;
  approved_by?: string;
  duration_ms?: number;
  success: boolean;
  error_message?: string;
}

export interface AuditFilters {
  workflow?: string;
  agent?: string;
  from?: string;
  to?: string;
  limit?: number;
  write_only?: boolean;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  approvalRequired: boolean;
}

export interface PolicyRule {
  name: string;
  agent: AgentName;
  action: string;
  conditions: Record<string, unknown>;
}

export interface BusMessage {
  id: string;
  timestamp: string;
  source: AgentName | "orchestrator";
  target: AgentName | "orchestrator";
  workflow: WorkflowName;
  type: "task" | "result" | "error" | "llm_request" | "llm_response";
  payload: Record<string, unknown>;
}

export interface Transport {
  send(agent: AgentName | "orchestrator", message: BusMessage): Promise<void>;
  subscribe(
    agent: AgentName | "orchestrator",
    handler: (msg: BusMessage) => void
  ): void;
  shutdown(): Promise<void>;
}

export interface VaultBackend {
  get(key: string): Promise<string>;
}

export interface WorkflowResult {
  workflow: WorkflowName;
  status: WorkflowStatus;
  startedAt: string;
  completedAt: string;
  agentResults: Record<string, unknown>;
  auditIds: string[];
  error?: string;
}

export interface AirflowFailureEvent {
  dag_id: string;
  run_id: string;
  task_id?: string;
  execution_date: string;
  failure_type?: string;
}

export interface SlackMessage {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export const DuckpipeConfigSchema = z.object({
  duckpipe: z.object({
    version: z.string(),
    name: z.string(),
    trust_tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  secrets: z.object({
    backend: z.enum(["env", "file", "hashicorp-vault", "aws-secrets-manager"]),
  }),
  agents: z.object({
    runtime: z.enum(["docker", "podman", "process"]).default("docker"),
    image_prefix: z.string().optional(),
    memory_limit_mb: z.number().default(512),
    cpu_limit: z.number().default(0.5),
    timeout_seconds: z.number().default(120),
  }),
  integrations: z.object({
    airflow: z
      .object({
        enabled: z.boolean(),
        base_url: z.string(),
        username: z.string().optional(),
        password: z.string().optional(),
        api_key: z.string().optional(),
        allowed_dags: z.array(z.string()).default([]),
        verify_ssl: z.boolean().default(true),
      })
      .optional(),
    dbt: z
      .object({
        enabled: z.boolean(),
        cloud_url: z.string().default("https://cloud.getdbt.com"),
        api_token: z.string(),
        account_id: z.string(),
        project_id: z.string(),
      })
      .optional(),
    snowflake: z
      .object({
        enabled: z.boolean(),
        account: z.string(),
        user: z.string(),
        password: z.string().optional(),
        private_key_path: z.string().optional(),
        role: z.string().default("DUCKPIPE_READER"),
        warehouse: z.string(),
        database: z.string(),
        watched_databases: z.array(z.string()).default([]),
      })
      .optional(),
    slack: z
      .object({
        enabled: z.boolean(),
        bot_token: z.string(),
        app_token: z.string().optional(),
        trigger_keyword: z.string().default("@duckpipe"),
        allowed_channels: z.array(z.string()),
        approval_timeout_seconds: z.number().default(300),
      })
      .optional(),
    jira: z
      .object({
        enabled: z.boolean(),
        base_url: z.string(),
        email: z.string(),
        api_token: z.string(),
        default_project: z.string().default("DE"),
      })
      .optional(),
    confluence: z
      .object({
        enabled: z.boolean(),
        base_url: z.string(),
        email: z.string(),
        api_token: z.string(),
        space_key: z.string(),
        catalog_parent_page: z.string().optional(),
      })
      .optional(),
  }),
  workflows: z
    .object({
      incident_autopilot: z
        .object({
          enabled: z.boolean(),
          poll_interval_seconds: z.number().default(120),
          auto_page_on_p1: z.boolean().default(false),
          pagerduty_webhook: z.string().optional(),
        })
        .optional(),
      pipeline_whisperer: z
        .object({
          enabled: z.boolean(),
          poll_interval_minutes: z.number().default(15),
          github_repo: z.string().optional(),
          base_branch: z.string().default("main"),
        })
        .optional(),
      cost_sentinel: z
        .object({
          enabled: z.boolean(),
          poll_interval_minutes: z.number().default(10),
          cost_alert_threshold_credits: z.number().default(100),
          kill_threshold_credits: z.number().default(500),
          weekly_report: z
            .object({
              enabled: z.boolean(),
              day: z.string().default("monday"),
              hour: z.number().default(8),
            })
            .optional(),
        })
        .optional(),
      knowledge_scribe: z
        .object({
          enabled: z.boolean(),
          schedule: z.string().default("0 2 * * *"),
        })
        .optional(),
      sla_guardian: z
        .object({
          enabled: z.boolean(),
          poll_interval_minutes: z.number().default(5),
          business_hours: z
            .object({
              start: z.number().default(7),
              end: z.number().default(22),
              timezone: z.string().default("America/Chicago"),
            })
            .optional(),
          monitored_dags: z.array(z.string()).default([]),
        })
        .optional(),
      query_sage: z
        .object({
          enabled: z.boolean(),
          auto_apply_optimizations: z.boolean().default(false),
        })
        .optional(),
    })
    .optional(),
});

export type DuckpipeConfig = z.infer<typeof DuckpipeConfigSchema>;
