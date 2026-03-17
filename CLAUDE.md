# DuckPipe 🦆
### Autonomous agentic data engineering platform — by Duckcode.ai
### Complete Claude Code build instructions

---

## What you are building

DuckPipe is an open-source autonomous agent platform for data engineering teams. It runs
specialized AI agents in isolated Docker containers that collaborate to monitor, fix, and
document a team's data stack — covering Apache Airflow, dbt, Snowflake, Jira, Slack, and
Confluence.

Inspired by nanoclaw's philosophy: small enough to read in 30 minutes, secure by container
isolation, AI-native from day one. DuckPipe is nanoclaw for the enterprise data stack.

The #1 design goal: a senior data engineer at a Fortune 500 company must be able to connect
DuckPipe to their production Airflow and Snowflake and trust that nothing bad will happen.
Every architectural decision flows from that requirement.

---

## Core philosophy

1. **Never cloud-relay credentials.** DuckPipe runs entirely inside the user's network.
   No telemetry, no callbacks to duckpipe.dev, no SaaS relay. Credentials go: .env →
   vault module (memory only) → agent container (memory only) → HTTPS to the actual API.
   They never touch disk. They never appear in logs. They never leave the user's machine or VPC.

2. **Three trust tiers, one config flag.** Users start with read-only (Tier 1) in 10 minutes.
   They promote to supervised writes (Tier 2) when they're ready. Full autonomy (Tier 3) is
   opt-in per workflow. The tier is set in `duckpipe.yaml`, not hardcoded in code.

3. **Read-only by default, always.** Every MCP tool that causes a write action is disabled
   unless explicitly enabled in config. A fresh install can never accidentally modify production.

4. **Verify before trust.** The `duckpipe verify` command connects to each integration and
   reports exactly what permissions it found, what it can do, and what it cannot. Users run
   this before enabling any workflow.

5. **Agents are isolated.** Each agent runs in its own Docker container. Containers cannot
   reach each other over the network. They communicate only through filesystem IPC managed
   by the orchestrator. A compromised dbt agent cannot access Snowflake credentials.

6. **Audit before action.** Every agent action is written to the immutable audit log BEFORE
   it executes. If the audit write fails, the action does not run. The audit log cannot be
   updated or deleted — it is append-only enforced at the SQLite trigger level.

7. **Small enough to understand.** The orchestrator, vault, bus, and audit modules combined
   should be readable in under 30 minutes. No framework abstractions. No dependency injection
   containers. If Claude Code can't explain every line, the code is too complex.

8. **Skills over features.** New integrations (Databricks, Great Expectations, BigQuery) are
   contributed as `.duck/skills/` files, not as PRs to core. Core stays small and auditable.

---

## The three trust tiers — implement all three

### Tier 1 — Sandbox (read-only, zero risk)

This is how every user starts. DuckPipe connects with the minimum permissions needed to
observe. It cannot modify anything.

**Airflow permissions required:**
- Role: `Viewer`
- Allowed endpoints: `GET /api/v1/dags`, `GET /api/v1/dags/*/dagRuns`,
  `GET /api/v1/dags/*/dagRuns/*/taskInstances`
- Forbidden: any POST, PATCH, DELETE

**Snowflake permissions required:**
```sql
GRANT USAGE ON WAREHOUSE <wh> TO ROLE duckpipe_reader;
GRANT USAGE ON DATABASE <db> TO ROLE duckpipe_reader;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <db> TO ROLE duckpipe_reader;
GRANT SELECT ON ALL TABLES IN DATABASE <db> TO ROLE duckpipe_reader;
GRANT SELECT ON ALL VIEWS IN DATABASE <db> TO ROLE duckpipe_reader;
-- Query history access (no data access):
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE duckpipe_reader;
```

**dbt Cloud permissions required:**
- API token scope: `read:jobs`, `read:runs`, `read:projects`
- No write scopes

**What Tier 1 enables:**
- Incident autopilot (observe and report only — no auto-Jira, no auto-Slack unless configured)
- SLA guardian (predictive alerts to Slack, no DAG modifications)
- Query sage (explains slow queries, no SQL changes)
- Cost sentinel (reports only, no query killing)

### Tier 2 — Supervised (writes require Slack approval)

Every write action pauses and posts an approval request to Slack. The agent waits up to
`approval_timeout_seconds` for a human to react with ✅ or ❌. If no response, the action
is skipped and logged. This is the recommended production setup.

**Additional Airflow permissions:**
- Role: `Op`
- Additional endpoints: `POST /api/v1/dags/*/dagRuns` (trigger), `DELETE` on task instances
- Scoped per DAG list in config — agent can only touch declared DAGs

**Additional Snowflake permissions:**
```sql
GRANT OPERATE ON WAREHOUSE <wh> TO ROLE duckpipe_operator;
-- Allows: ALTER WAREHOUSE SUSPEND/RESUME, SELECT SYSTEM$CANCEL_QUERY()
-- Does NOT allow: CREATE, DROP, ALTER TABLE, INSERT, UPDATE, DELETE
```

**Additional GitHub permissions:**
- Fine-grained token: `Contents: Read and Write` (branch push only), `Pull requests: Read and Write`
- The token cannot push to main/master — enforced by branch protection rules in GitHub,
  not just by DuckPipe policy

**What Tier 2 adds:**
- Incident autopilot full mode (files Jira, posts Slack, optionally retries failed tasks)
- Pipeline whisperer (opens dbt model fix PRs)
- Knowledge scribe (writes Confluence pages)
- Cost sentinel full mode (kills runaway queries after Slack approval)

### Tier 3 — Autonomous (pre-approved action scope)

Specific actions are pre-approved in `policy.yaml`. The orchestrator checks the policy
before executing — if the action matches an approved rule, it runs immediately and is logged.
If it doesn't match, it falls back to Tier 2 approval flow.

**Example `policy.yaml`:**
```yaml
# DuckPipe autonomous action policy
# Actions listed here execute without human approval.
# All other actions require Slack confirmation (Tier 2 behavior).

autonomous:
  - name: "Retry failed tasks once"
    agent: airflow
    action: trigger_dag_run
    conditions:
      dag_id_prefix: "ingestion_"   # only DAGs starting with this prefix
      retry_count_less_than: 2       # only if not already retried twice
      failure_type: ["timeout", "connection_error"]  # not logic errors

  - name: "Kill expensive queries"
    agent: snowflake
    action: cancel_query
    conditions:
      credits_consumed_greater_than: 50
      query_age_minutes_greater_than: 30
      warehouse: ["COMPUTE_WH"]      # only this warehouse

  - name: "Post Slack alerts"
    agent: comms
    action: slack_post_message
    conditions:
      channels: ["#data-incidents", "#data-alerts"]
      # no conditions on content — agent decides what to say
```

---

## Repository structure

```
duckpipe/
├── CLAUDE.md                        ← this file
├── README.md                        ← viral readme (spec below)
├── LICENSE                          ← MIT
├── package.json
├── tsconfig.json
├── .mcp.json                        ← MCP server registry
├── .gitignore                       ← must include .env, duckpipe.yaml, data/, bus/
│
├── src/
│   ├── index.ts                     ← entry point: init vault → orchestrator → scheduler → listeners
│   ├── orchestrator.ts              ← agent lifecycle, bus routing, policy check
│   ├── scheduler.ts                 ← cron trigger engine for scheduled workflows
│   ├── audit.ts                     ← append-only SQLite audit log
│   ├── vault.ts                     ← credential management (env / hashicorp / aws / file)
│   ├── bus.ts                       ← filesystem IPC between orchestrator and agents
│   ├── policy.ts                    ← RBAC policy engine, tier enforcement
│   ├── verify.ts                    ← `duckpipe verify` command — connection + permission checker
│   ├── router.ts                    ← routes incoming events to correct workflow
│   └── db.ts                        ← SQLite state, events, known schema snapshots
│
├── agents/
│   ├── airflow/
│   │   ├── AGENT.md                 ← system prompt (read by Claude Code when spawning)
│   │   ├── Dockerfile               ← FROM node:20-slim, no extra network access
│   │   └── tools.ts                 ← typed wrappers around Airflow MCP tools
│   ├── dbt/
│   │   ├── AGENT.md
│   │   ├── Dockerfile
│   │   └── tools.ts
│   ├── snowflake/
│   │   ├── AGENT.md
│   │   ├── Dockerfile
│   │   └── tools.ts
│   └── comms/
│       ├── AGENT.md
│       ├── Dockerfile
│       └── tools.ts
│
├── workflows/
│   ├── incident-autopilot.ts
│   ├── pipeline-whisperer.ts
│   ├── cost-sentinel.ts
│   ├── knowledge-scribe.ts
│   ├── sla-guardian.ts
│   └── query-sage.ts
│
├── integrations/
│   ├── airflow.mcp.json
│   ├── dbt.mcp.json
│   ├── snowflake.mcp.json
│   ├── jira.mcp.json
│   ├── slack.mcp.json
│   └── confluence.mcp.json
│
├── security/
│   ├── policy.example.yaml          ← reference policy file
│   └── audit-schema.sql             ← audit log DDL with immutability triggers
│
├── config-examples/
│   ├── duckpipe.example.yaml        ← full annotated config reference
│   ├── docker-compose.yaml          ← local full-stack development
│   ├── .env.example                 ← credential template (no real values)
│   └── k8s/                         ← Kubernetes manifests
│       ├── namespace.yaml
│       ├── secret.yaml              ← how to use k8s secrets with DuckPipe
│       ├── deployment.yaml
│       └── rbac.yaml
│
├── .duck/
│   └── skills/
│       ├── add-databricks/SKILL.md
│       ├── add-great-expectations/SKILL.md
│       └── add-bigquery/SKILL.md
│
├── scripts/
│   └── generate-snowflake-grants.sql  ← copy-paste SQL to create duckpipe roles
│
└── docs/
    ├── SECURITY.md
    ├── ARCHITECTURE.md
    ├── CONNECTING-AIRFLOW.md        ← step-by-step Airflow connection guide
    ├── CONNECTING-SNOWFLAKE.md      ← step-by-step Snowflake connection guide
    ├── CONNECTING-DBT.md
    ├── TRUST-TIERS.md               ← explains the 3-tier model in plain English
    └── CONTRIBUTING.md
```

---

## Key source file specifications

### `src/verify.ts` — THE most important file for adoption

This is what makes engineers trust DuckPipe. Running `npx duckpipe verify` connects to each
configured integration and prints exactly what it found. Build this first.

Output format:
```
DuckPipe connection verify — checking your integrations...

✓  Airflow  connected  (version 2.8.1)
   Permissions: GET /dags ✓  GET /dagRuns ✓  POST /dagRuns ✗ (Tier 1 read-only)
   DAGs visible: 47

✓  Snowflake  connected  (account: myorg.us-east-1)
   Role: DUCKPIPE_READER  Warehouse: COMPUTE_WH
   Permissions: SELECT ✓  OPERATE ✗  CREATE ✗  DROP ✗
   Query history access: ✓
   Tables visible: 312

✗  dbt Cloud  connection failed
   Error: 401 Unauthorized — check DBT_API_TOKEN in your .env
   Fix: https://docs.duckpipe.dev/connecting-dbt

✓  Slack  connected  (workspace: Acme Corp)
   Bot scopes: chat:write ✓  channels:read ✓
   Channels accessible: #data-incidents ✓  #data-engineering ✓

-  Jira  not configured  (optional)

Current trust tier: 1 (read-only)
Safe to enable: incident-autopilot (observe mode), sla-guardian, query-sage

To enable Tier 2 (supervised writes): set trust_tier: 2 in duckpipe.yaml
then re-run: npx duckpipe verify
```

The verify command must never store results. It reads config, tests connections, prints output,
exits. It is always safe to run at any time.

### `src/vault.ts`

Four backends, selected by `secrets.backend` in config:

**`env` backend (development default):**
```typescript
// Reads from process.env — print a loud warning if used with trust_tier > 1
// Warning: "You are using environment variables for secrets with Tier 2+ trust.
//  Consider using a secrets backend for production. See docs/SECURITY.md"
```

**`file` backend (single-machine production):**
Uses `age` encryption (https://age-encryption.org). The encrypted file is committed to git
(it is safe — it is encrypted). The age private key is kept outside the repo. On startup,
vault decrypts the file into memory, never writes the plaintext anywhere.

**`hashicorp-vault` backend:**
Connects to Vault KV v2 via the HTTP API using a Vault token or AppRole auth.
Renews the lease automatically before expiry.

**`aws-secrets-manager` backend:**
Uses the AWS SDK with instance role or explicit credentials. Caches secrets in memory
with a 5-minute TTL and refreshes automatically.

All backends implement this interface:
```typescript
interface VaultBackend {
  get(key: string): Promise<string>;
  // No set(), no delete() — DuckPipe never writes to the vault
}
```

### `src/audit.ts`

```typescript
// Append-only audit log. The two most important properties:
// 1. logAction() writes the entry BEFORE the action executes
// 2. There is no deleteAction(), updateAction(), or clearAudit() function
//    If you need to add one for any reason, stop and reconsider the design.

export async function logAction(entry: AuditEntry): Promise<string>
export async function queryAudit(filters: AuditFilters): Promise<AuditEntry[]>
export async function exportAuditJSON(dateRange: DateRange): Promise<string>
export async function exportAuditCSV(dateRange: DateRange): Promise<string>
```

Schema (`security/audit-schema.sql`):
```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  workflow      TEXT NOT NULL,
  agent         TEXT NOT NULL,
  tool          TEXT NOT NULL,
  tier          INTEGER NOT NULL,
  input_json    TEXT NOT NULL,
  output_json   TEXT,
  write_action  INTEGER NOT NULL DEFAULT 0,
  approved_by   TEXT,  -- 'auto' | 'slack:username' | 'policy:rule-name'
  duration_ms   INTEGER,
  success       INTEGER NOT NULL DEFAULT 1,
  error_message TEXT
);

CREATE TRIGGER prevent_audit_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no updates permitted'); END;

CREATE TRIGGER prevent_audit_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no deletes permitted'); END;
```

### `src/bus.ts`

Filesystem IPC — identical model to nanoclaw. No Redis, no RabbitMQ, no Kafka.

```
bus/
  orchestrator/       ← agents write results here
  agents/
    airflow/in/       ← orchestrator writes events here for the airflow agent
    airflow/out/      ← airflow agent writes results here
    dbt/in/
    dbt/out/
    snowflake/in/
    snowflake/out/
    comms/in/
    comms/out/
```

Each message is a JSON file named `{timestamp}-{uuid}.json`. The orchestrator uses chokidar
to watch `out/` directories. Agents poll their `in/` directory every 200ms. Files are deleted
after processing. The bus directory is created fresh on startup — it is transient state, not
persistent. Add `bus/` to `.gitignore`.

### `src/policy.ts`

```typescript
// Called by orchestrator before EVERY write action.
// Returns: { allowed: boolean, reason: string, approvalRequired: boolean }
// If approvalRequired: true, orchestrator must get Slack approval before proceeding.
// If allowed: false, action is logged and skipped, never executed.

export async function checkPolicy(
  action: string,
  agent: AgentName,
  workflow: string,
  context: Record<string, unknown>,
  tier: TrustTier
): Promise<PolicyDecision>
```

The policy engine reads `policy.yaml` on startup and caches it. It does NOT hot-reload —
a restart is required to pick up policy changes. This is intentional: policy changes should
be deliberate, not accidental.

---

## Agent AGENT.md specifications

### `agents/airflow/AGENT.md`

```markdown
# Airflow agent — DuckPipe

You are the Airflow monitoring agent for DuckPipe. You connect to an Apache Airflow instance
via its REST API using the MCP tools listed below.

## Your role
Monitor DAG runs, detect failures, identify root causes from task logs, and report findings
to the orchestrator in structured JSON. In Tier 2+, you may trigger DAG retries when
explicitly approved.

## Available MCP tools
- airflow_list_dags — list all DAGs and their current state
- airflow_get_dag_runs — get recent runs for a specific DAG, with status
- airflow_get_task_logs — fetch logs for a specific task instance
- airflow_get_task_instances — list task instances for a run with their state
- airflow_trigger_dag_run — [WRITE — requires policy approval] trigger a new DAG run
- airflow_clear_task — [WRITE — requires policy approval] clear a failed task for retry

## Output contract
Always return this JSON structure:
{
  "status": "failure" | "warning" | "healthy",
  "affectedDags": string[],
  "rootCause": string,           // plain English, one sentence
  "rootCauseCategory": "timeout" | "connection_error" | "logic_error" | "upstream_dependency" | "unknown",
  "evidence": string[],          // log excerpts, max 3, max 200 chars each
  "recommendedAction": string,   // plain English, one sentence
  "confidence": "high" | "medium" | "low",
  "writeActionsNeeded": string[] // empty array if none
}

## Rules
- Never trigger a DAG run without the orchestrator policy check returning approved: true
- Never access task logs for DAGs not in your allowed_dags config list
- Never retry a task that has already been retried twice — escalate to human instead
- If you cannot determine root cause with high confidence, say so — do not guess
```

### `agents/dbt/AGENT.md`

```markdown
# dbt agent — DuckPipe

You are the dbt model management agent. You connect to dbt Cloud via MCP and to GitHub
for PR creation. You detect schema drift and propose model fixes as pull requests.

## Available MCP tools
- dbt_list_jobs — list all dbt jobs in the project
- dbt_get_run — get details of a specific run including errors
- dbt_get_manifest — fetch the compiled dbt manifest.json (lineage graph)
- dbt_list_models — list all models with their current status
- github_create_branch — [WRITE] create a new feature branch
- github_push_file — [WRITE] push a modified file to a branch
- github_create_pr — [WRITE] open a pull request with description

## Output contract
When proposing model changes:
{
  "driftDetected": boolean,
  "affectedModels": string[],
  "proposedChanges": [{
    "model": string,
    "filePath": string,
    "diff": string,          // unified diff format
    "reason": string,        // plain English explanation
    "testsAdded": string[]   // names of new dbt tests proposed
  }],
  "prTitle": string,
  "prBody": string,          // markdown, includes what changed and why
  "requiresHumanReview": boolean,
  "riskLevel": "low" | "medium" | "high"
}

## Rules
- NEVER push to main or master branch — always create a new branch named duckpipe/{date}/{description}
- NEVER propose changes to models outside the configured dbt project
- ALWAYS include at least one dbt test for any new or modified column
- If riskLevel is high, always set requiresHumanReview: true regardless of tier setting
- Proposed PRs must reference the schema change event that triggered the workflow
```

### `agents/snowflake/AGENT.md`

```markdown
# Snowflake agent — DuckPipe

You monitor Snowflake query performance and credit consumption. In Tier 2+, you can kill
runaway queries and resize warehouses with approval.

## Available MCP tools
- snowflake_query — execute a SELECT query (read-only role enforced at DB level)
- snowflake_get_query_history — fetch QUERY_HISTORY from SNOWFLAKE.ACCOUNT_USAGE
- snowflake_get_query_profile — fetch execution plan for a specific query_id
- snowflake_cancel_query — [WRITE] cancel a running query by query_id
- snowflake_get_warehouse_usage — get credit consumption by warehouse

## Key queries you will use
-- Top expensive queries in last 24h:
SELECT query_id, query_text, user_name, warehouse_name,
       credits_used_cloud_services, total_elapsed_time/1000 as seconds
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -1, CURRENT_TIMESTAMP())
ORDER BY credits_used_cloud_services DESC NULLS LAST
LIMIT 20;

## Output contract
{
  "expensiveQueries": [{
    "queryId": string,
    "user": string,
    "warehouse": string,
    "creditsConsumed": number,
    "runtimeSeconds": number,
    "queryPreview": string,    // first 200 chars
    "optimizationSuggestion": string,
    "estimatedCreditSavings": number
  }],
  "totalCredits24h": number,
  "anomalyDetected": boolean,
  "anomalyDescription": string | null,
  "killCandidates": string[]   // query_ids that exceed kill threshold
}

## Rules
- NEVER run any query that is not a SELECT or a SYSTEM$ function
- NEVER cancel a query without orchestrator policy approval
- NEVER access tables outside the configured database list
- When suggesting SQL optimizations, always show the rewritten query, not just advice
- Credit thresholds for kill decisions come from config, not your judgment
```

### `agents/comms/AGENT.md`

```markdown
# Comms agent — DuckPipe

You draft and send messages to Slack, create Jira tickets, and update Confluence pages.
You are the only agent that communicates with humans.

## Available MCP tools
- slack_post_message — [WRITE] post to a Slack channel
- slack_post_thread_reply — [WRITE] reply in a Slack thread
- slack_get_channel_history — read recent messages from a channel
- jira_create_issue — [WRITE] create a Jira ticket
- jira_get_issue — read a Jira ticket
- confluence_create_page — [WRITE] create a new Confluence page
- confluence_update_page — [WRITE] update an existing Confluence page

## Message format rules
- Slack messages: use mrkdwn format, include severity emoji (🔴 P1, 🟡 P2, 🟢 P3)
- Always end Slack messages with: "_Detected by DuckPipe — duckcode.ai_"
- Jira tickets: use structured description with Cause / Impact / Steps sections
- Confluence: use standard Data Catalog template from config
- Never send DMs to individual users — only post to configured channels
- Never post to a channel not listed in the slack.allowed_channels config

## Approval request format (Tier 2)
When the orchestrator needs human approval before a write action, post this format:
"🦆 *DuckPipe approval needed*
Action: {description}
Details: {preview}
Workflow: {workflow_name}
React ✅ to approve or ❌ to skip (timeout: {N} minutes)"

## Rules
- Never fabricate data — only use information provided by the orchestrator
- If asked to post something that references credentials or internal hostnames, redact them
- Always check that the target channel is in the allowed_channels list before posting
```

---

## Workflow implementations

### `workflows/incident-autopilot.ts`

```typescript
// Trigger: Airflow failure webhook OR poll every 2 minutes
// Tier 1: observe and log only
// Tier 2: file Jira + post Slack (with Slack approval)
// Tier 3: also retry failed tasks (within policy)

export async function runIncidentAutopilot(event: AirflowFailureEvent): Promise<WorkflowResult> {
  // 1. Log workflow start to audit
  // 2. Spawn airflow agent: get logs + root cause for failed DAG
  // 3. Spawn dbt agent (parallel): check if any upstream model changed in last 2 hours
  // 4. Spawn snowflake agent (parallel): check source table row count anomalies
  // 5. Orchestrator assembles: rootCause + evidence from all three agents
  // 6. Classify severity: P1 (SLA breach imminent), P2 (degraded), P3 (isolated failure)
  // 7. Comms agent: create Jira ticket with full diagnosis
  // 8. Comms agent: post Slack alert with Jira link + one-line summary
  // 9. If P1 and config.auto_page_on_p1: hit PagerDuty webhook
  // 10. If Tier 3 and rootCauseCategory matches approved retry conditions: airflow agent retries
  // 11. Log workflow complete to audit with all agent results
}
```

### `workflows/pipeline-whisperer.ts`

```typescript
// Trigger: scheduled every 15 minutes
// Compares current Snowflake schemas against last-known snapshot in SQLite
// If drift: dbt agent rewrites affected models and opens PR

export async function runPipelineWhisperer(): Promise<WorkflowResult> {
  // 1. Snowflake agent: fetch current schema for all tables in watched databases
  // 2. Compare against snapshot stored in db.ts (last known good state)
  // 3. If no drift: update snapshot timestamp, exit
  // 4. If drift detected:
  //    a. dbt agent: load manifest.json, find all models sourcing changed tables
  //    b. dbt agent: propose model rewrites for each affected model
  //    c. For each proposed change: check policy (Tier 2 = needs approval, Tier 3 = auto)
  //    d. dbt agent: push changes to branch, open PR
  //    e. comms agent: post PR link to Slack with drift summary
  //    f. comms agent: update Confluence schema change log
  // 5. Update snapshot to new schema state
  // 6. Log full audit trail
}
```

### `workflows/cost-sentinel.ts`

```typescript
// Trigger: continuous monitoring every 10 minutes + weekly Monday 8am report
// Monitors Snowflake credit consumption and kills runaway queries

export async function runCostSentinel(): Promise<WorkflowResult> {
  // 1. Snowflake agent: get query history for last 10 minutes
  // 2. For each query exceeding cost_alert_threshold_credits:
  //    a. Post Slack alert with query preview + user + credits consumed
  // 3. For each query exceeding kill_threshold_credits:
  //    a. Check policy: is kill_queries enabled for this warehouse?
  //    b. Tier 2: post Slack approval request, wait for ✅
  //    c. Tier 3: cancel query immediately (if matches autonomous policy)
  //    d. Log kill to audit with full query text
  // 4. If weekly_report scheduled:
  //    a. Snowflake agent: aggregate last 7 days by user, warehouse, query tag
  //    b. Comms agent: post Slack report + update Confluence cost tracking page
}
```

### `workflows/sla-guardian.ts`

```typescript
// Trigger: every 5 minutes during business_hours in config
// Predicts pipeline breaches before they happen

export async function runSlaGuardian(): Promise<WorkflowResult> {
  // 1. Airflow agent: get current run status for all SLA-monitored DAGs
  // 2. For each running DAG:
  //    a. Fetch historical P95 run time from db.ts (built up over time)
  //    b. Calculate: elapsed_time / historical_p95 = completion_fraction
  //    c. Project: if fraction > 0.7 and sla_deadline approaching, compute breach_probability
  // 3. If breach_probability > 0.7:
  //    a. Comms agent: post predictive alert (NOT an incident — just a warning)
  //    b. Include: which tasks are slowest, what to prioritize
  // 4. If actual breach occurs: hand off to incident-autopilot workflow
  // 5. Update historical run time records in db.ts
}
```

### `workflows/knowledge-scribe.ts`

```typescript
// Trigger: nightly at 2am OR on dbt PR merge to main
// Auto-writes Confluence documentation from dbt lineage + git history

export async function runKnowledgeScribe(): Promise<WorkflowResult> {
  // 1. dbt agent: fetch manifest.json — all models, columns, tests, descriptions, lineage
  // 2. For each model:
  //    a. Check if Confluence page exists (query db.ts cache of known pages)
  //    b. If no page: comms agent creates from Data Catalog template
  //    c. If page exists: diff current model metadata against last-written version
  //    d. If diff: comms agent updates only changed sections (not full page rewrite)
  // 3. Generate lineage diagram as Mermaid in Confluence attachment
  // 4. Link recent Jira tickets (from incident-autopilot) to affected model pages
  // 5. Update db.ts with page IDs and last-written timestamps
}
```

### `workflows/query-sage.ts`

```typescript
// Trigger: Slack message matching /@duckpipe (why|explain|optimize|fix).*(slow|expensive|query)/i
// Also triggered by: @duckpipe why is {model} slow

export async function runQuerySage(slackMessage: SlackMessage): Promise<WorkflowResult> {
  // 1. Comms agent: extract model/table name from Slack message using Claude
  // 2. Snowflake agent: fetch last 10 execution plans for that object
  // 3. Snowflake agent: identify most expensive operations
  //    (FULL TABLE SCAN, SPILLOVER TO DISK, CARTESIAN JOIN, no clustering key used)
  // 4. Snowflake agent: generate rewritten query with specific optimizations
  //    - clustering keys
  //    - partition pruning
  //    - join order
  //    - materialization strategy
  // 5. Comms agent: post thread reply with:
  //    - Plain English explanation of the problem
  //    - Rewritten SQL in code block
  //    - Estimated credit savings
  //    - Link to Snowflake query profile
  // 6. If user replies "apply it": dbt agent opens a PR with the optimization
}
```

---

## Connection guides to generate (in docs/)

### `docs/CONNECTING-AIRFLOW.md` must cover:

1. **If using Airflow Cloud (Astronomer / MWAA / Cloud Composer)**: where to find the API endpoint
2. **If self-hosted**: enabling the REST API (it may be disabled by default)
3. **Creating the viewer role** — exact SQL/UI steps for each platform
4. **Generating an API key** — UI walkthrough
5. **Testing the connection manually**: `curl -u user:pass https://your-airflow/api/v1/dags`
6. **Adding to .env**: which variable names to use
7. **Running verify**: `npx duckpipe verify --integration airflow`
8. **Common errors and fixes**: 401, 403, connection refused, SSL errors

### `docs/CONNECTING-SNOWFLAKE.md` must cover:

1. **Copy-paste SQL** to create the duckpipe roles (Tier 1 and Tier 2 versions)
   — also available as `scripts/generate-snowflake-grants.sql`
2. **Using key-pair authentication** (recommended — no password in .env)
   — how to generate the RSA key pair
   — where to put the private key (not in git — in .env or vault)
3. **Using password authentication** (simpler, less secure)
4. **Network policy**: if your Snowflake has an IP allowlist, what IP does DuckPipe use?
   (Answer: your machine's IP or your VPC's NAT gateway — DuckPipe never cloud-relays)
5. **Testing**: `npx duckpipe verify --integration snowflake`

---

## `duckpipe.yaml` full configuration reference

```yaml
duckpipe:
  version: "1"
  name: "my-data-team"          # used in Slack messages and audit log
  trust_tier: 1                  # 1 | 2 | 3 — start here, promote when ready

secrets:
  backend: "env"                 # env | file | hashicorp-vault | aws-secrets-manager
  # file backend:
  # age_key_file: "~/.config/duckpipe/age.key"
  # encrypted_secrets_file: "./secrets.age"
  # hashicorp-vault backend:
  # vault_addr: "https://vault.internal:8200"
  # vault_token: "${VAULT_TOKEN}"
  # vault_path: "secret/data/duckpipe"

agents:
  runtime: "docker"              # docker | podman
  image_prefix: "ghcr.io/duckcodeai/duckpipe"
  memory_limit_mb: 512
  cpu_limit: 0.5
  timeout_seconds: 120           # agent killed if no result after this

integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"          # e.g. https://airflow.internal or Astronomer URL
    username: "${AIRFLOW_USERNAME}"
    password: "${AIRFLOW_PASSWORD}"          # or: api_key: "${AIRFLOW_API_KEY}"
    allowed_dags: []                         # empty = all DAGs visible; list = scoped access
    verify_ssl: true                         # set false only for self-signed internal certs

  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"

  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"          # e.g. myorg.us-east-1
    user: "${SNOWFLAKE_USER}"
    # choose one:
    password: "${SNOWFLAKE_PASSWORD}"        # simple auth
    # private_key_path: "${SNOWFLAKE_PRIVATE_KEY_PATH}"  # key-pair auth (recommended)
    role: "DUCKPIPE_READER"                  # or DUCKPIPE_OPERATOR for Tier 2
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
    watched_databases: []                    # empty = only configured database

  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
    trigger_keyword: "@duckpipe"
    allowed_channels:
      - "#data-incidents"
      - "#data-engineering"
      - "#data-costs"
    approval_timeout_seconds: 300            # 5 minutes to approve a Tier 2 action

  jira:
    enabled: true
    base_url: "${JIRA_BASE_URL}"
    email: "${JIRA_EMAIL}"
    api_token: "${JIRA_API_TOKEN}"
    default_project: "DE"

  confluence:
    enabled: true
    base_url: "${CONFLUENCE_BASE_URL}"
    email: "${CONFLUENCE_EMAIL}"
    api_token: "${CONFLUENCE_API_TOKEN}"
    space_key: "DATA"
    catalog_parent_page: "Data Catalog"

workflows:
  incident_autopilot:
    enabled: true
    poll_interval_seconds: 120
    auto_page_on_p1: false                   # set true to hit PagerDuty on P1
    pagerduty_webhook: "${PAGERDUTY_WEBHOOK_URL}"

  pipeline_whisperer:
    enabled: true
    poll_interval_minutes: 15
    github_repo: "${GITHUB_REPO}"            # owner/repo format
    base_branch: "main"

  cost_sentinel:
    enabled: true
    poll_interval_minutes: 10
    cost_alert_threshold_credits: 100
    kill_threshold_credits: 500              # Tier 2+: post approval; Tier 3: auto-kill
    weekly_report:
      enabled: true
      day: "monday"
      hour: 8

  knowledge_scribe:
    enabled: true
    schedule: "0 2 * * *"                   # nightly at 2am

  sla_guardian:
    enabled: true
    poll_interval_minutes: 5
    business_hours:
      start: 7
      end: 22
      timezone: "America/Chicago"
    monitored_dags: []                       # empty = all DAGs with SLA set in Airflow

  query_sage:
    enabled: true
    auto_apply_optimizations: false          # if true, opens PR automatically without asking
```

---

## README.md — write this to land on HN front page

Open with these exact lines, no introduction:

```
# DuckPipe 🦆
**Your data stack is on fire at 3am. DuckPipe already knows why.**

Open-source autonomous agents for Airflow · dbt · Snowflake · Jira · Slack · Confluence
Built by Duckcode.ai · MIT · Runs in your network — your creds never leave
```

Immediately follow with a real terminal output block showing `npx duckpipe verify` output
followed by the incident autopilot firing and producing a Slack message and Jira ticket.
Show the exact output. Not a screenshot. Not a description. The output itself in a code block.

Then: Quick Start (must be exactly these steps, no more):
```
git clone https://github.com/duckcodeai/duckpipe
cd duckpipe
cp config-examples/.env.example .env   # add your API keys
cp config-examples/duckpipe.example.yaml duckpipe.yaml
npx duckpipe verify                    # check connections before trusting anything
npx duckpipe start
```

Then: the three trust tiers explained in a table (Tier 1 / Tier 2 / Tier 3 with what each enables).

Then: one paragraph per workflow, one sentence each — punchy, no bullet lists.

Then: the security section. Lead with:
"DuckPipe runs in your network. Your credentials go: `.env` → memory → HTTPS to your API.
They never touch disk, never appear in logs, never leave your machine or VPC. We don't even
have a server to send them to."

Then: Contributing — explain the skills model. Then: License (MIT).

The README must not contain: the word "revolutionary", "game-changing", "cutting-edge",
or "leverage". It must not have more than 6 items in any bullet list. It must not have
screenshots (DuckPipe is terminal and Slack — show terminal output in code blocks instead).

---

## Build sequence for `/setup`

When Claude Code runs `/setup`:

1. `npm install`
2. Check Docker is running: `docker info` — if not, print install instructions and exit
3. Pull base image: `docker pull node:20-slim`
4. Create directories: `./data/`, `./bus/agents/airflow/{in,out}`, `./bus/agents/dbt/{in,out}`,
   `./bus/agents/snowflake/{in,out}`, `./bus/agents/comms/{in,out}`, `./bus/orchestrator/`
5. If `duckpipe.yaml` does not exist: copy from `config-examples/duckpipe.example.yaml`
6. If `.env` does not exist: copy from `config-examples/.env.example` and print:
   "Edit .env with your API keys, then run: npx duckpipe verify"
7. `npx tsc --noEmit`
8. `npx vitest run`
9. Print setup summary

When Claude Code runs `/verify`:
- Run `npx duckpipe verify` and show the output

When Claude Code runs `/audit`:
- Query the last 50 audit log entries and present in a readable table
- Show: timestamp, workflow, agent, action, tier, approved_by, success

When Claude Code runs `/add-{integration}`:
- Load `.duck/skills/add-{integration}/SKILL.md` and follow its instructions exactly

---

## Testing requirements

Tests live in `tests/`. Use Vitest exclusively.

Every workflow test must:
- Use a mock MCP server (defined in `tests/mocks/`) — never call real APIs in tests
- Verify audit log receives an entry for every agent action
- Verify policy engine is consulted before any write action
- Verify that an agent container crash does not crash the orchestrator
- Verify Tier 1 config cannot trigger any write action regardless of workflow logic
- Run in under 10 seconds

Required test files:
- `tests/audit.test.ts` — immutability triggers, append behavior, export formats
- `tests/vault.test.ts` — all four backends with mock backends
- `tests/policy.test.ts` — tier enforcement, policy rule matching
- `tests/verify.test.ts` — connection check output format
- `tests/workflows/incident-autopilot.test.ts`
- `tests/workflows/cost-sentinel.test.ts`
- `tests/workflows/query-sage.test.ts`
- `tests/workflows/pipeline-whisperer.test.ts`

---

## Hard rules — Claude Code must never violate these

- Never log any value fetched from the vault, even at debug level
- Never write a secret to disk, even temporarily
- Never allow an agent to call any URL not declared in its MCP server config
- Never skip the audit log write — if it fails, the action must not execute
- Never implement a feature that requires outbound connections to duckpipe.dev or any
  Duckcode-controlled server — the tool is fully self-hosted
- Never add a dependency that has not been updated in the last 6 months
- Never add a configuration option that makes Tier 1 capable of write actions
- Never create a PR that merges to main/master — always a feature branch
- Never modify audit-schema.sql's immutability triggers for any reason

---

## Phased milestones

### v0.1 — "First Quack" (weeks 1–3) — get this out the door fast
- [ ] Project scaffolded, all files created
- [ ] `duckpipe verify` works for Airflow and Snowflake
- [ ] Vault module works (env backend)
- [ ] Bus IPC works between orchestrator and one agent
- [ ] Audit log is append-only and immutable
- [ ] Airflow agent connects and reads DAG state
- [ ] Incident autopilot fires end-to-end in Tier 1 (observe only)
- [ ] README published, repo public on GitHub

### v0.2 — "Full Stack" (weeks 4–6)
- [ ] All four agents containerized and tested
- [ ] All six workflows running
- [ ] Slack listener live (`@duckpipe` trigger)
- [ ] Tier 2 approval flow working (Slack ✅/❌)
- [ ] Policy engine enforcing tier rules
- [ ] docker-compose for local full-stack dev
- [ ] `duckpipe verify` covers all six integrations

### v0.3 — "Enterprise Ready" (weeks 7–9)
- [ ] HashiCorp Vault and AWS Secrets Manager backends
- [ ] Tier 3 autonomous policy working end-to-end
- [ ] Kubernetes manifests tested
- [ ] Snowflake key-pair auth working
- [ ] Audit CSV/JSON export
- [ ] All connection guides written (Airflow, Snowflake, dbt)
- [ ] 3 community skills submitted (Databricks, Great Expectations, BigQuery)

### v1.0 — "Launch" (weeks 10–12)
- [ ] HN launch post written
- [ ] Demo video: DAG fails at 3am → DuckPipe diagnoses → Jira ticket + Slack posted
- [ ] Homebrew tap: `brew install duckcodeai/tap/duckpipe`
- [ ] docs.duckpipe.dev live
- [ ] Security review complete
- [ ] 10 GitHub stars from people outside Duckcode 😄

---

*Built by Duckcode.ai · https://duckcode.ai · MIT License*
*DuckPipe: the open-source engine. The Duckcode VS Code extension: the IDE where it comes alive.*
