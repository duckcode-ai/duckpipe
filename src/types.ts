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

export interface AssetRef {
  kind:
    | "dag"
    | "task"
    | "table"
    | "model"
    | "query"
    | "slack_thread"
    | "jira_issue"
    | "confluence_page"
    | "runbook"
    | "owner";
  name: string;
  externalId?: string;
  database?: string;
  schema?: string;
  metadata?: Record<string, unknown>;
}

export interface EntityGraphNode {
  id: string;
  kind: AssetRef["kind"];
  name: string;
}

export interface EntityGraphEdge {
  from: string;
  to: string;
  relation: "contains" | "reads" | "writes" | "depends_on" | "alerts" | "owns" | "references";
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}

export interface IncidentEvidence {
  id: string;
  source: AgentName | "workflow" | "system";
  kind:
    | "log"
    | "metric"
    | "change"
    | "anomaly"
    | "lineage"
    | "history"
    | "policy"
    | "summary";
  summary: string;
  detail?: string;
  confidence: "high" | "medium" | "low";
  asset?: AssetRef;
}

export interface CauseAssessment {
  id: string;
  category:
    | "timeout"
    | "connection_error"
    | "logic_error"
    | "upstream_dependency"
    | "data_anomaly"
    | "schema_drift"
    | "performance"
    | "unknown";
  summary: string;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  inference?: string;
}

export interface RecommendedAction {
  summary: string;
  priority: "immediate" | "next" | "follow_up";
  owner?: string;
  mode?: "read-only" | "approval-required" | "autonomous";
}

export interface ImpactSummary {
  severity: "P1" | "P2" | "P3";
  affectedDags: string[];
  affectedTables: string[];
  affectedModels: string[];
  blastRadius: AssetRef[];
  likelyOwner?: string;
  runbook?: string;
}

export interface StoryOutput {
  oncallSummary: string;
  managerSummary: string;
  knowledgeSummary: string;
  topEvidence: string[];
  unknowns: string[];
}

export interface IncidentChatMessage {
  id: string;
  incidentRunId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  metadata?: {
    sources?: string[];
    evidenceIds?: string[];
    followUps?: string[];
    usedLiveData?: boolean;
    investigation?: InvestigationResult;
  };
}

export interface IncidentChatAnswer {
  answer: string;
  evidenceIds: string[];
  followUps: string[];
  sources: string[];
  usedLiveData: boolean;
  investigation?: InvestigationResult;
}

export interface InvestigationFact {
  id: string;
  summary: string;
  source: string;
  confidence: "high" | "medium" | "low";
}

export interface InvestigationHypothesis {
  id: string;
  summary: string;
  status: "supported" | "possible" | "rejected";
  confidence: "high" | "medium" | "low";
}

export interface InvestigationStep {
  id: string;
  title: string;
  outcome: string;
  usedLiveData: boolean;
}

export interface CritiqueResult {
  questions: string[];
  refinedHypotheses: InvestigationHypothesis[];
  confidence: "high" | "medium" | "low";
}

export interface FollowUpInvestigation {
  question: string;
  result: InvestigationResult;
}

export interface InvestigationResult {
  playbook: string;
  summary: string;
  facts: InvestigationFact[];
  hypotheses: InvestigationHypothesis[];
  unknowns: string[];
  nextChecks: string[];
  sources: string[];
  evidenceIds: string[];
  usedLiveData: boolean;
  steps: InvestigationStep[];
  critique?: CritiqueResult;
  followUpInvestigations?: FollowUpInvestigation[];
  investigationDepth?: number;
  objectChecks?: Array<{
    objectName: string;
    status: "exists" | "missing" | "inaccessible" | "unknown";
    detail: string;
  }>;
  lineage?: {
    failingModels: string[];
    upstreamSources: string[];
    modelPaths: string[];
    modelSchemas: string[];
  };
  priorIncidents?: Array<{
    incidentRunId: string;
    startedAt: string;
    severity?: string;
    rootCause?: string;
  }>;
  externalContext?: {
    slackMentions: Array<{
      channel: string;
      ts: string;
      text: string;
    }>;
    jiraIssues: Array<{
      key: string;
      summary: string;
      status?: string;
    }>;
    confluencePages: Array<{
      id: string;
      title: string;
    }>;
  };
  subAgents?: Array<{
    name: string;
    focus: string;
    summary: string;
    usedLiveData: boolean;
  }>;
  workspace?: {
    incidentRunId: string;
    factCount: number;
    hypothesisCount: number;
    messageCount: number;
    openQuestions: string[];
    lastUpdated: string;
  };
}

export interface IncidentWorkspace {
  incidentRunId: string;
  facts: InvestigationFact[];
  hypotheses: InvestigationHypothesis[];
  openQuestions: string[];
  subAgents: Array<{
    name: string;
    focus: string;
    summary: string;
    usedLiveData: boolean;
    ranAt: string;
  }>;
  conversationCount: number;
  lastUpdated: string;
}

export interface RetroLevel {
  depth: number;
  question: string;
  answer: string;
  facts: InvestigationFact[];
  sources: string[];
  subAgentsUsed: string[];
  confidence: "high" | "medium" | "low";
  durationMs: number;
}

export interface RetroReport {
  incidentRunId: string;
  levels: RetroLevel[];
  rootCauseChain: string[];
  solutionApproach: string;
  confidence: "high" | "medium" | "low";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  status: "running" | "completed" | "partial";
}

export interface IncidentContext {
  incidentId: string;
  workflow: WorkflowName;
  triggerSource: "airflow_webhook" | "airflow_poll" | "schedule" | "slack_message" | "manual";
  triggerEvent: Record<string, unknown>;
  startedAt: string;
  severity: "P1" | "P2" | "P3";
  status: "failure" | "warning" | "healthy";
  dag: {
    dagId?: string;
    runId?: string;
    executionDate?: string;
    failedTasks: Array<{ taskId: string; tryNumber?: number; durationSeconds?: number | null }>;
    retryCount?: number;
  };
  evidence: IncidentEvidence[];
  impactedAssets: AssetRef[];
  recentChanges: Array<{ type: string; name: string; description: string; filePath?: string }>;
  candidateCauses: CauseAssessment[];
  recommendedActions: RecommendedAction[];
  impact: ImpactSummary;
  entityGraph?: EntityGraph;
  story?: StoryOutput;
  securityMode: {
    trustTier: TrustTier;
    actionMode: "read-only" | "approval-required" | "autonomous";
  };
}

export interface AssistantReadinessReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  llm: {
    configured: boolean;
    provider?: string | null;
    model?: string | null;
  };
  workflows: Partial<Record<WorkflowName, { ready: boolean; issues: string[] }>>;
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
        api_token: z.string().optional(),
        account_id: z.string().optional(),
        project_id: z.string().optional(),
        // Path to a local manifest.json — preferred over dbt Cloud for local projects
        local_manifest_path: z.string().optional(),
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
  llm: z
    .object({
      provider: z
        .enum(["auto", "anthropic", "openai", "gemini"])
        .default("auto"),
      model: z.string().optional(),          // override the default model for the provider
      agents: z                              // per-agent model overrides
        .object({
          airflow:   z.string().optional(),  // e.g. use a cheaper model for monitoring
          snowflake: z.string().optional(),
          dbt:       z.string().optional(),
          comms:     z.string().optional(),  // comms benefits from a stronger model
        })
        .optional(),
    })
    .optional(),
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
