# DuckPipe 🦆
**Your data stack is on fire at 3am. DuckPipe already knows why.**

Open-source autonomous agents for Airflow · dbt · Snowflake · Jira · Slack · Confluence
Built by [Duckcode.ai](https://duckcode.ai) · Apache 2.0 · Runs in your network — your creds never leave

---

```
$ npx duckpipe start

[03:14:02] 🦆 DuckPipe started — trust tier 1 (read-only)
[03:14:02] Starting agents...
  ✓ airflow agent started
  ✓ dbt agent started
  ✓ snowflake agent started
  ✓ comms agent started
[03:14:02] Scheduled workflows: incident-autopilot, sla-guardian, cost-sentinel
[03:14:15] ⚠ DAG failure detected: ingestion_stripe_payments
[03:14:16] Spawning airflow agent → analyzing task logs...
[03:14:18] Root cause: upstream API timeout (task: extract_payments)
[03:14:18] Severity: P2 — degraded but not SLA-critical
[03:14:19] → Slack #data-incidents:
           🟡 *P2 — ingestion_stripe_payments failed*
           Root cause: Stripe API timeout during extract_payments
[03:14:20] Starting autonomous retro analysis...
[03:14:20] [retro L1] Investigating: "What exactly happened?"
[03:14:35] [retro L2] Investigating: "Why did it happen?"
[03:15:10] [retro L3] Investigating: "What changed in the last 24h?"
[03:15:45] Retro complete — 3 levels, confidence=high
```

---

## Quick Start

```bash
git clone https://github.com/duckcode-ai/duckpipe
cd duckpipe
npm install
cp config-examples/.env.example .env          # add your API keys
cp config-examples/duckpipe.example.yaml duckpipe.yaml
npx duckpipe start                             # dashboard at http://localhost:9876
```

### Prerequisites

- **Node.js** >= 20.0.0
- **Docker** (optional, for agent container isolation — falls back to process mode)
- API credentials for your integrations (Airflow, Snowflake, dbt Cloud, Slack, etc.)
- **OpenAI API key** (for LLM-powered retro analysis and incident investigation)

---

## How It Works

DuckPipe runs at **Tier 1 (read-only)** — it connects to your data infrastructure with minimum read permissions, detects failures, and explains what happened. It never modifies anything in your systems.

### What DuckPipe Does

1. **Detects** — Polls Airflow for DAG failures every 2 minutes
2. **Investigates** — Dispatches agents to Airflow, dbt, and Snowflake to gather evidence
3. **Diagnoses** — Correlates failures across DAGs, dbt models, and Snowflake tables
4. **Alerts** — Posts a structured diagnosis to Slack with severity, root cause, and evidence
5. **Retrospects** — Runs an autonomous 5-level retro analysis (5-whys) with sub-agents

### What DuckPipe Does NOT Do

- Never triggers DAG runs or retries tasks
- Never modifies Snowflake tables, roles, or warehouses
- Never pushes code or opens PRs
- Never creates Jira tickets or Confluence pages without explicit future tier promotion

---

## Agents

DuckPipe runs four specialized agents, each connecting to one part of your stack:

| Agent | Connects To | Tools | What It Reads |
|---|---|---|---|
| **Airflow** | Airflow REST API | `check_failures`, `list_dags`, `get_dag_runs`, `get_task_instances`, `get_task_logs`, `get_running_dags` | DAG status, run state, task logs |
| **dbt** | dbt Cloud API + GitHub | `list_jobs`, `get_run`, `get_manifest`, `list_models`, `find_affected_models`, `check_recent_changes`, `get_project_graph`, `load_local_manifest` | Job runs, model lineage, recent changes |
| **Snowflake** | Snowflake SQL API | `execute_query`, `get_query_history`, `get_query_profile`, `get_warehouse_usage`, `fetch_schemas`, `check_source_anomalies`, `get_query_plans`, `analyze_query_performance` | Query history, schema state, warehouse costs |
| **Comms** | Slack, Jira, Confluence | `slack_post_message`, `slack_post_thread_reply`, `slack_get_channel_history`, `jira_create_issue`, `jira_get_issue`, `jira_search_issues`, `confluence_find_page`, `confluence_search_pages`, `format_incident_message` | Channel history (for context); posts alerts |

Each agent runs in its own isolated process (or Docker container). Agents never talk to each other — all coordination flows through the orchestrator via a filesystem message bus.

See individual agent docs: [Airflow](agents/airflow/AGENT.md) · [dbt](agents/dbt/AGENT.md) · [Snowflake](agents/snowflake/AGENT.md) · [Comms](agents/comms/AGENT.md)

---

## Workflows

| Workflow | What It Does | Poll Interval | Agents Used |
|---|---|---|---|
| **Incident Autopilot** | Detects Airflow failures, diagnoses root cause, alerts Slack, runs autonomous retro | 120s | airflow, dbt, snowflake, comms |
| **SLA Guardian** | Predicts pipeline SLA breaches from historical run times | 300s | airflow, comms |
| **Cost Sentinel** | Monitors Snowflake credit burn, alerts on expensive queries | 600s | snowflake, comms |
| **Pipeline Whisperer** | Watches Snowflake schemas for drift, finds affected dbt models | 900s | snowflake, dbt, comms |
| **Knowledge Scribe** | Syncs dbt manifest to Confluence documentation | Nightly | dbt, comms |

### Autonomous Retro Analysis

When an incident is detected, DuckPipe automatically runs a **5-level retrospective** (5-whys):

| Level | Question | Sub-Agents |
|---|---|---|
| 1 | What exactly happened? | Airflow failure analysis |
| 2 | Why did it happen? | dbt lineage trace, Snowflake object checks |
| 3 | What changed in the last 24h? | dbt recent changes, Snowflake schema anomalies |
| 4 | What is the blast radius? | dbt dependency graph, downstream impact |
| 5 | Has this happened before? | Historical incidents, Slack/Jira/Confluence context |

Sub-agents are **dynamically selected** based on the question context — e.g., level 2 spawns a Snowflake access agent only if an upstream dependency failure is suspected.

Each level has a **45-second timeout** to prevent hangs. Results are persisted to the database after each level so the dashboard shows live progress.

---

## Setup Guide

### Step 1: Environment Variables (`.env`)

```bash
# ── LLM Provider (required for retro analysis) ──
OPENAI_API_KEY=sk-...

# ── Airflow ──
AIRFLOW_BASE_URL=http://localhost:8080          # your Airflow webserver URL
AIRFLOW_USERNAME=duckpipe                        # Viewer role user
AIRFLOW_PASSWORD=...

# ── Snowflake ──
SNOWFLAKE_ACCOUNT=myorg.us-east-1
SNOWFLAKE_USER=DUCKPIPE_SVC
SNOWFLAKE_PASSWORD=...                           # or use SNOWFLAKE_PRIVATE_KEY_PATH
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=ANALYTICS
SNOWFLAKE_ROLE=DUCKPIPE_READER

# ── dbt Cloud ──
DBT_API_TOKEN=dbtc_...
DBT_ACCOUNT_ID=12345
DBT_PROJECT_ID=67890

# ── Slack ──
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...                         # for Socket Mode listener

# ── Optional: Jira ──
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=duckpipe@company.com
JIRA_API_TOKEN=...

# ── Optional: Confluence ──
CONFLUENCE_BASE_URL=https://your-company.atlassian.net/wiki
CONFLUENCE_EMAIL=duckpipe@company.com
CONFLUENCE_API_TOKEN=...

# ── Optional: GitHub (for Pipeline Whisperer PRs) ──
GITHUB_TOKEN=github_pat_...
GITHUB_REPO=your-org/your-dbt-repo

# ── Optional: Dashboard remote access ──
DUCKPIPE_DASHBOARD_TOKEN=...                     # set to enable bearer auth
```

### Step 2: Configuration (`duckpipe.yaml`)

```yaml
duckpipe:
  team_name: "my-data-team"
  trust_tier: 1                                  # read-only — the only supported tier today

secrets:
  backend: "env"                                 # reads from .env file

agents:
  runtime: "process"                             # or "docker" / "podman"
  timeout_seconds: 120
  memory_limit_mb: 512

integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"
    username: "${AIRFLOW_USERNAME}"
    password: "${AIRFLOW_PASSWORD}"
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    password: "${SNOWFLAKE_PASSWORD}"
    role: "${SNOWFLAKE_ROLE}"
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
    allowed_channels:
      - "#data-incidents"
      - "#data-engineering"
  jira:
    enabled: false                               # set true + add creds to enable
    base_url: "${JIRA_BASE_URL}"
    email: "${JIRA_EMAIL}"
    api_token: "${JIRA_API_TOKEN}"
  confluence:
    enabled: false
    base_url: "${CONFLUENCE_BASE_URL}"
    email: "${CONFLUENCE_EMAIL}"
    api_token: "${CONFLUENCE_API_TOKEN}"

llm:
  provider: "openai"
  model: "gpt-4o-mini"
  api_key: "${OPENAI_API_KEY}"

workflows:
  incident_autopilot:
    enabled: true
    poll_interval_seconds: 120
    auto_page_on_p1: false
  sla_guardian:
    enabled: true
    poll_interval_seconds: 300
  cost_sentinel:
    enabled: true
    poll_interval_seconds: 600
  pipeline_whisperer:
    enabled: false                               # enable when ready
  knowledge_scribe:
    enabled: false
```

### Step 3: Start

```bash
npx tsx src/cli.ts start --dashboard
# Dashboard available at http://localhost:9876
```

### Connection Guides

Step-by-step guides with permissions, grant scripts, and troubleshooting:

- [Connecting Airflow](docs/CONNECTING-AIRFLOW.md) — Cloud Composer, MWAA, Astronomer, self-hosted
- [Connecting Snowflake](docs/CONNECTING-SNOWFLAKE.md) — key-pair auth, role grants, network policy
- [Connecting dbt Cloud](docs/CONNECTING-DBT.md) — API token, account/project IDs

---

## Security

DuckPipe runs in your network. Your credentials go: `.env` → memory → HTTPS to your API. They never touch disk, never appear in logs, never leave your machine or VPC.

Every action is logged to an append-only audit log before it executes. SQLite triggers prevent updates and deletes — not by convention, by enforcement. Agents run in isolation; they communicate only through filesystem IPC managed by the orchestrator.

### Security Controls

| Control | Implementation |
|---|---|
| **Trust Tier 1** | Read-only enforced — no write actions possible at code level |
| **Credential isolation** | Secrets never written to disk; memory-only vault |
| **Agent sandboxing** | Each agent runs in its own process/container with scoped credentials |
| **Audit immutability** | SQLite triggers prevent UPDATE/DELETE on audit_log |
| **Input validation** | SQL injection prevention; strict regex on all identifiers |
| **Dashboard auth** | Localhost-only by default; bearer token for remote access |
| **No telemetry** | Zero outbound connections to Duckcode servers; fully air-gappable |
| **Least privilege** | Read-only roles for Airflow (Viewer), Snowflake (DUCKPIPE_READER), dbt (read scopes) |

For the complete security review — threat model, data flow, SLC checklist, compliance mapping, and pen-test guidance — see [docs/SECURITY.md](docs/SECURITY.md) and [docs/SLC-REVIEW.md](docs/SLC-REVIEW.md).

---

## Observability Dashboard

DuckPipe ships an embedded web dashboard at `http://localhost:9876`:

- **Incident timeline** — click any incident to see full diagnosis and retro analysis
- **Retro viewer** — expandable investigation levels with sub-agent calls, facts, sources, and confidence
- **Workflow monitoring** — real-time status via Server-Sent Events
- **Agent health** — per-agent tool registration and connectivity status
- **Audit log** — filterable action log with CSV/JSON export

---

## Architecture

```
Scheduler (cron/interval)
        │
        ▼
  ┌─────────────┐     tasks     ┌──────────────────┐
  │  Webhooks   │──────────────▶│   Orchestrator    │
  │  Slack      │               │  policy · audit   │
  └─────────────┘               │  dedup · routing  │
                                └───────┬───────────┘
                                        │
                    ┌───────────────┬────┴────┬───────────────┐
                    ▼               ▼         ▼               ▼
            ┌────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
            │  Airflow   │  │   dbt    │  │Snowflake │  │  Comms   │
            │  Agent     │  │  Agent   │  │  Agent   │  │  Agent   │
            └────────────┘  └──────────┘  └──────────┘  └──────────┘
                    │               │         │               │
                    ▼               ▼         ▼               ▼
             Airflow API     dbt Cloud   Snowflake API   Slack/Jira/
                             GitHub                      Confluence
```

Agents communicate via a filesystem message bus (`bus/` directory). The orchestrator writes task JSON to `bus/agents/<name>/in/`, agents poll every 200ms, execute, and write results to `bus/agents/<name>/out/`.

Full architecture documentation: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Roadmap

DuckPipe currently operates at **Tier 1 (read-only)**. Future tiers will add supervised and autonomous write capabilities:

| Tier | Status | Description |
|---|---|---|
| **Tier 1 — Read-Only** | Available | Monitor, detect, diagnose, alert |
| **Tier 2 — Supervised** | Planned | Write actions with Slack approval (retry tasks, kill queries, open PRs) |
| **Tier 3 — Autonomous** | Planned | Policy-bounded auto-actions (auto-retry, auto-kill, auto-PR) |

See [docs/TRUST-TIERS.md](docs/TRUST-TIERS.md) for the full roadmap.

---

## Contributing

DuckPipe is designed to grow through **skills**, not core PRs. To add support for Databricks, BigQuery, or Great Expectations, create a `.duck/skills/add-{name}/SKILL.md` that describes the agent, tools, and config needed. Core stays small and auditable. Skills are community-powered.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

Copyright 2026 Duckcode.ai

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

```
SPDX-License-Identifier: Apache-2.0
```
