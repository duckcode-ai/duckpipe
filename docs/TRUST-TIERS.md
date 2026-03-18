# DuckPipe Trust Tiers

DuckPipe uses a trust tier model to control what actions agents can perform. You set the tier in `duckpipe.yaml`; it applies globally. **Currently, only Tier 1 (read-only) is supported.** Tiers 2 and 3 are on the roadmap.

---

## Current: Tier 1 — Read-Only

This is the default and only supported tier. DuckPipe connects with the minimum permissions needed to observe. It **cannot modify anything** in any integrated system.

### What Tier 1 Enables

- **Incident Autopilot**: Detects Airflow failures, diagnoses root cause, alerts Slack, runs autonomous retro analysis
- **SLA Guardian**: Predicts pipeline SLA breaches, posts warnings to Slack
- **Cost Sentinel**: Monitors Snowflake credit burn, alerts on expensive queries
- **Pipeline Whisperer**: Detects schema drift, identifies affected dbt models (reporting only)
- **Knowledge Scribe**: Reads dbt manifest for lineage understanding (reporting only)

### Permissions Required

**Airflow**

- Role: `Viewer`
- Allowed: `GET /api/v1/dags`, `GET /api/v1/dags/*/dagRuns`, `GET /api/v1/dags/*/dagRuns/*/taskInstances`, `GET /api/v1/dags/*/dagRuns/*/taskInstances/*/logs`
- Forbidden: any POST, PATCH, DELETE

**Snowflake**

```sql
CREATE ROLE IF NOT EXISTS DUCKPIPE_READER;
GRANT USAGE ON WAREHOUSE <wh> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON DATABASE <db> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <db> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL TABLES IN DATABASE <db> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE <db> TO ROLE DUCKPIPE_READER;
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE DUCKPIPE_READER;
```

**dbt Cloud**

- API token scope: `read:jobs`, `read:runs`, `read:projects`
- No write scopes

**Slack**

- Bot scopes: `chat:write`, `channels:read`

### Security Guarantee

When `trust_tier: 1`, the policy engine returns `{ allowed: false }` for every write action. No configuration, policy file, or agent behavior can override this. This is enforced in code and verified by automated tests.

### What This Means in Practice

| System | Can Read | Cannot Do |
|---|---|---|
| **Airflow** | DAGs, runs, task instances, logs | Trigger runs, retry tasks, clear failures |
| **Snowflake** | Query history, schemas, warehouse usage, execution plans | Execute DML/DDL, cancel queries, resize warehouses |
| **dbt Cloud** | Jobs, runs, manifest, models | Trigger runs, modify projects |
| **Slack** | Channel history (for context) | Post messages (unless explicitly configured) |
| **Jira** | Read issues | Create or update tickets |
| **Confluence** | Search pages | Create or update pages |

---

## Roadmap: Tier 2 — Supervised Writes

> **Status: Planned** — not yet available.

Every write action will pause and post an approval request to Slack. A human must react with ✅ to approve or ❌ to reject. If no response within timeout, the action is skipped and logged.

**Will add:**
- Retry failed Airflow tasks (with approval)
- Kill runaway Snowflake queries (with approval)
- Open dbt model fix PRs on GitHub (with approval)
- Create Jira tickets and Confluence pages (with approval)

**Will require:**
- Airflow `Op` role (scoped to `allowed_dags`)
- Snowflake `DUCKPIPE_OPERATOR` role (OPERATE on warehouse)
- GitHub fine-grained token (Contents + Pull requests)
- Slack Socket Mode (`SLACK_APP_TOKEN`) for real-time approval

---

## Roadmap: Tier 3 — Autonomous

> **Status: Planned** — not yet available.

Specific actions will be pre-approved in `policy.yaml`. Matching actions run immediately without human approval. Non-matching actions fall back to Tier 2.

**Example policy (future):**

```yaml
autonomous:
  - name: "Retry failed ingestion tasks once"
    agent: airflow
    action: trigger_dag_run
    conditions:
      dag_id_prefix: "ingestion_"
      retry_count_less_than: 2
      failure_type: ["timeout", "connection_error"]

  - name: "Kill queries over 500 credits"
    agent: snowflake
    action: cancel_query
    conditions:
      credits_consumed_greater_than: 500
      query_age_minutes_greater_than: 30
```

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
