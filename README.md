# DuckPipe 🦆
**Your data stack is on fire at 3am. DuckPipe already knows why.**

Open-source autonomous agents for Airflow · dbt · Snowflake · Jira · Slack · Confluence
Built by [Duckcode.ai](https://duckcode.ai) · Apache 2.0 · Runs in your network — your creds never leave

---

```
$ npx duckpipe verify

DuckPipe connection verify — checking your integrations...

✓ Airflow connected (version 2.8.1)
  Permissions: GET /dags ✓  GET /dagRuns ✓  POST /dagRuns ✗ (Tier 1 read-only)
  DAGs visible: 47

✓ Snowflake connected (account: myorg.us-east-1)
  Role: DUCKPIPE_READER  Warehouse: COMPUTE_WH
  Permissions: SELECT ✓  OPERATE ✗  CREATE ✗  DROP ✗
  Query history access: ✓
  Tables visible: 312

✓ Slack connected (workspace: Acme Corp)
  Bot scopes: chat:write ✓  channels:read ✓
  Channels accessible: #data-incidents ✓  #data-engineering ✓

✓ dbt Cloud connected (account: 12345)
  Projects: 3  Jobs: 18  Last run: 2 min ago

- Jira not configured (optional)
- Confluence not configured (optional)

Current trust tier: 1 (read-only)
Safe to enable: incident-autopilot (observe mode), sla-guardian, query-sage
```

```
$ npx duckpipe start

[03:14:02] 🦆 DuckPipe started — trust tier 1 (read-only)
[03:14:02] Watching 47 DAGs, 312 tables, 18 dbt jobs
[03:14:15] ⚠ DAG failure detected: ingestion_stripe_payments (run_id: scheduled__2026-03-16)
[03:14:16] Spawning airflow agent → analyzing task logs...
[03:14:18] Root cause: upstream API timeout (task: extract_payments, attempt 2/2)
[03:14:18] Severity: P2 — degraded but not SLA-critical
[03:14:19] → Slack #data-incidents:
           🟡 *P2 — ingestion_stripe_payments failed*
           Root cause: Stripe API timeout during extract_payments (connection_error)
           Evidence: "HTTPSConnectionPool: Read timed out (read timeout=30)"
           Recommended: Retry after verifying Stripe API status
           _Detected by DuckPipe — duckcode.ai_
```

---

## Quick Start

```bash
git clone https://github.com/duckcode-ai/duckpipe
cd duckpipe
npm install
cp config-examples/.env.example .env          # add your API keys
cp config-examples/duckpipe.example.yaml duckpipe.yaml
npx duckpipe verify                            # check connections before trusting anything
npx duckpipe start
```

### Prerequisites

- **Node.js** >= 20.0.0
- **Docker** (or Podman) for agent container isolation
- API credentials for your integrations (Airflow, Snowflake, dbt Cloud, Slack, etc.)

### Docker Compose (Full Stack)

```bash
cp config-examples/.env.example .env
docker compose -f config-examples/docker-compose.yaml up -d
```

### Kubernetes

Manifests are in `config-examples/k8s/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for deployment details.

---

## Trust Tiers

DuckPipe enforces a three-tier trust model. You start at Tier 1 (read-only) and promote when your team is ready.

| | Tier 1 — Sandbox | Tier 2 — Supervised | Tier 3 — Autonomous |
|---|---|---|---|
| **Risk** | Zero | Controlled | Pre-approved scope |
| **Writes** | Never | With Slack approval | Within policy rules |
| **Setup time** | 10 minutes | 30 minutes | 1 hour |
| **Airflow** | Read DAGs, logs | + Retry failed tasks | + Auto-retry on policy match |
| **Snowflake** | Read queries, costs | + Kill runaway queries | + Auto-kill above threshold |
| **dbt** | Read models, runs | + Open fix PRs | + Auto-PR for known drift |
| **Slack** | Receive alerts | + Post alerts, request approval | + Post without confirmation |
| **Jira** | — | Create tickets with approval | Auto-file on P1 incidents |

See [docs/TRUST-TIERS.md](docs/TRUST-TIERS.md) for full permissions matrix and Snowflake/Airflow grant scripts.

---

## Workflows

**Incident Autopilot** detects Airflow failures, correlates root causes across your DAGs, source tables, and dbt models, then files a Jira ticket and Slack alert with full diagnosis — before your team wakes up.

**Pipeline Whisperer** watches Snowflake schemas for drift, finds every dbt model affected by the change, rewrites them, and opens a PR with tests — all before the next dbt run breaks.

**Cost Sentinel** monitors Snowflake credit burn in real time, alerts on expensive queries, and kills runaway queries that exceed your threshold — with your approval or automatically within policy.

**SLA Guardian** predicts pipeline breaches before they happen by comparing current run progress against historical P95 timing, and alerts your team while there's still time to act.

**Knowledge Scribe** turns your dbt manifest into living Confluence documentation — model descriptions, column lineage, test coverage, freshness — updated every night or on every PR merge.

**Query Sage** responds to `@duckpipe why is X slow` in Slack with a plain-English explanation, rewritten SQL, and estimated credit savings — backed by actual query execution plans.

---

## Security

DuckPipe runs in your network. Your credentials go: `.env` → memory → HTTPS to your API. They never touch disk, never appear in logs, never leave your machine or VPC. We don't even have a server to send them to.

Every action is logged to an append-only audit log before it executes. The audit log has SQLite triggers that prevent updates and deletes — not by convention, by enforcement. Agent containers run in isolation; they communicate only through filesystem IPC managed by the orchestrator.

Run `npx duckpipe verify` at any time to see exactly what DuckPipe can access and what it cannot. There's no trust-me — only show-me.

### Enterprise Security Summary

| Control | Implementation |
|---|---|
| **Credential isolation** | Secrets never written to disk; memory-only vault with env, HashiCorp Vault, AWS Secrets Manager backends |
| **Agent sandboxing** | Each agent runs in its own Docker container with no inter-container network access |
| **Audit immutability** | SQLite triggers prevent UPDATE/DELETE on audit_log; append-only enforced at database level |
| **Input validation** | SQL injection prevention with parameterized identifiers; strict regex validation on all user inputs |
| **Dashboard auth** | Bearer token authentication; binds to localhost-only when no token configured |
| **No telemetry** | Zero outbound connections to Duckcode servers; fully self-hosted, fully air-gappable |
| **Least privilege** | Read-only by default; write actions require explicit tier promotion and policy rules |

For a complete security review, including threat model, data flow diagrams, and SLC review checklist, see [docs/SECURITY.md](docs/SECURITY.md).

---

## Observability Dashboard

DuckPipe ships an embedded web dashboard at `http://localhost:9876` with:

- Real-time workflow monitoring via Server-Sent Events
- Approval queue for Tier 2 supervised write actions
- Agent health and container status
- Audit log viewer with filters and CSV/JSON export
- Setup wizard for first-run onboarding

```bash
npx duckpipe start    # dashboard available at http://localhost:9876
```

---

## Installation & Configuration

### Environment Variables

Copy `config-examples/.env.example` and fill in your credentials:

```bash
# Required
AIRFLOW_BASE_URL=https://airflow.internal.company.com
AIRFLOW_USERNAME=duckpipe
AIRFLOW_PASSWORD=...
SNOWFLAKE_ACCOUNT=myorg.us-east-1
SNOWFLAKE_USER=DUCKPIPE_SVC
SNOWFLAKE_PASSWORD=...              # or use SNOWFLAKE_PRIVATE_KEY_PATH for key-pair auth
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=ANALYTICS
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...            # required for Slack Socket Mode listener
DBT_API_TOKEN=dbt_...
DBT_ACCOUNT_ID=12345
DBT_PROJECT_ID=67890

# Optional
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=duckpipe@company.com
JIRA_API_TOKEN=...
CONFLUENCE_BASE_URL=https://your-company.atlassian.net/wiki
CONFLUENCE_EMAIL=duckpipe@company.com
CONFLUENCE_API_TOKEN=...
DUCKPIPE_DASHBOARD_TOKEN=...        # set to enable remote dashboard access with auth
```

### Configuration File

Copy `config-examples/duckpipe.example.yaml` to `duckpipe.yaml` in the project root. The full reference includes trust tier, secrets backend, agent runtime, integration endpoints, and workflow schedules.

### Connection Guides

Step-by-step guides with exact permissions, grant scripts, and troubleshooting:

- [Connecting Airflow](docs/CONNECTING-AIRFLOW.md) — Cloud Composer, MWAA, Astronomer, self-hosted
- [Connecting Snowflake](docs/CONNECTING-SNOWFLAKE.md) — key-pair auth, role grants, network policy
- [Connecting dbt Cloud](docs/CONNECTING-DBT.md) — API token, account/project IDs

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
            │ (container)│  │(container)│  │(container)│  │(container)│
            └────────────┘  └──────────┘  └──────────┘  └──────────┘
                    │               │         │               │
                    ▼               ▼         ▼               ▼
             Airflow API     dbt Cloud   Snowflake API   Slack/Jira/
                             GitHub                      Confluence
```

Full architecture documentation: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Enterprise Adoption

DuckPipe is built for enterprise data teams connecting to production systems. Before deploying:

1. **Run `npx duckpipe verify`** — confirms every connection, every permission, every scope. Nothing hidden.
2. **Start at Tier 1** — zero-risk read-only monitoring. Evaluate for days or weeks before promoting.
3. **Review the SLC checklist** — [docs/SECURITY.md](docs/SECURITY.md) contains a full Software Lifecycle review package for your security team: threat model, data flow, compliance mapping, and penetration test guidance.
4. **Use HashiCorp Vault or AWS Secrets Manager** — production secrets backends are built-in. The `env` backend is for development only.
5. **Deploy on Kubernetes** — production manifests with RBAC, secrets, and health probes are in `config-examples/k8s/`.

See [docs/SCENARIOS.md](docs/SCENARIOS.md) for real-world deployment examples.

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
