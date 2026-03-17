# DuckPipe 🦆
**Your data stack is on fire at 3am. DuckPipe already knows why.**

Open-source autonomous agents for Airflow · dbt · Snowflake · Jira · Slack · Confluence
Built by Duckcode.ai · MIT · Runs in your network — your creds never leave

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

## Quick Start

```bash
git clone https://github.com/duckcodeai/duckpipe
cd duckpipe
cp config-examples/.env.example .env          # add your API keys
cp config-examples/duckpipe.example.yaml duckpipe.yaml
npx duckpipe verify                            # check connections before trusting anything
npx duckpipe start
```

## Trust Tiers

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

## Workflows

**Incident Autopilot** detects Airflow failures, correlates root causes across your DAGs, source tables, and dbt models, then files a Jira ticket and Slack alert with full diagnosis — before your team wakes up.

**Pipeline Whisperer** watches Snowflake schemas for drift, finds every dbt model affected by the change, rewrites them, and opens a PR with tests — all before the next dbt run breaks.

**Cost Sentinel** monitors Snowflake credit burn in real time, alerts on expensive queries, and kills runaway queries that exceed your threshold — with your approval or automatically within policy.

**SLA Guardian** predicts pipeline breaches before they happen by comparing current run progress against historical P95 timing, and alerts your team while there's still time to act.

**Knowledge Scribe** turns your dbt manifest into living Confluence documentation — model descriptions, column lineage, test coverage, freshness — updated every night or on every PR merge.

**Query Sage** responds to `@duckpipe why is X slow` in Slack with a plain-English explanation, rewritten SQL, and estimated credit savings — backed by actual query execution plans.

## Security

DuckPipe runs in your network. Your credentials go: `.env` → memory → HTTPS to your API. They never touch disk, never appear in logs, never leave your machine or VPC. We don't even have a server to send them to.

Every action is logged to an append-only audit log before it executes. The audit log has SQLite triggers that prevent updates and deletes — not by convention, by enforcement. Agent containers run with no network access; they communicate only through filesystem IPC managed by the orchestrator.

Run `npx duckpipe verify` at any time to see exactly what DuckPipe can access and what it cannot. There's no trust-me — only show-me.

## Contributing

DuckPipe is designed to grow through **skills**, not core PRs. To add support for Databricks, BigQuery, or Great Expectations, create a `.duck/skills/add-{name}/SKILL.md` that describes the agent, tools, and config needed. Core stays small and auditable. Skills are community-powered.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full guide.

## License

Apache 2.0 — [Duckcode.ai](https://duckcode.ai)
