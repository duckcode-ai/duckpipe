# DuckPipe Trust Tiers

DuckPipe uses three trust tiers to control what actions agents can perform. You set the tier in `duckpipe.yaml`; it applies globally. Start at Tier 1 and promote when ready.

## Tier 1: Read-Only Sandbox

This is the default. DuckPipe connects with the minimum permissions needed to observe. It cannot modify anything.

### What Tier 1 Enables

- Incident autopilot: observe and report only (no Jira, no Slack unless configured for alerts)
- SLA guardian: predictive alerts to Slack, no DAG modifications
- Query sage: explains slow queries, no SQL changes
- Cost sentinel: reports only, no query killing

### Permissions Required

**Airflow**

- Role: `Viewer`
- Allowed: `GET /api/v1/dags`, `GET /api/v1/dags/*/dagRuns`, `GET /api/v1/dags/*/dagRuns/*/taskInstances`
- Forbidden: any POST, PATCH, DELETE

**Snowflake**

```sql
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

- Bot scopes: `chat:write`, `channels:read` (for posting alerts; no approval flow in Tier 1 for writes)

---

## Tier 2: Supervised Writes

Every write action pauses and posts an approval request to Slack. A human must react with checkmark or X within `approval_timeout_seconds`. If no response, the action is skipped and logged. Recommended for production.

### What Tier 2 Adds

- Incident autopilot full mode: files Jira, posts Slack, optionally retries failed tasks (with approval)
- Pipeline whisperer: opens dbt model fix PRs (with approval)
- Knowledge scribe: writes Confluence pages (with approval)
- Cost sentinel full mode: kills runaway queries after Slack approval

### Additional Permissions Required

**Airflow**

- Role: `Op`
- Additional: `POST /api/v1/dags/*/dagRuns` (trigger), DELETE on task instances
- Scoped per DAG list in config (`allowed_dags`)

**Snowflake**

```sql
GRANT OPERATE ON WAREHOUSE <wh> TO ROLE DUCKPIPE_OPERATOR;
-- Allows: ALTER WAREHOUSE SUSPEND/RESUME, SELECT SYSTEM$CANCEL_QUERY()
-- Does NOT allow: CREATE, DROP, ALTER TABLE, INSERT, UPDATE, DELETE
```

**GitHub** (for pipeline whisperer)

- Fine-grained token: `Contents: Read and Write` (branch push only), `Pull requests: Read and Write`
- Token cannot push to main/master; enforce via branch protection rules

**Slack**

- Same as Tier 1; used for approval requests and alerts

**Jira**

- Create issue, read issue

**Confluence**

- Create page, update page

---

## Tier 3: Autonomous

Specific actions are pre-approved in `policy.yaml`. If an action matches a rule, it runs immediately without Slack approval. If it does not match, it falls back to Tier 2 (approval required).

### Example policy.yaml

```yaml
autonomous:
  - name: "Retry failed tasks once"
    agent: airflow
    action: trigger_dag_run
    conditions:
      dag_id_prefix: "ingestion_"
      retry_count_less_than: 2
      failure_type: ["timeout", "connection_error"]

  - name: "Kill expensive queries"
    agent: snowflake
    action: cancel_query
    conditions:
      credits_consumed_greater_than: 50
      query_age_minutes_greater_than: 30
      warehouse: ["COMPUTE_WH"]

  - name: "Post Slack alerts"
    agent: comms
    action: slack_post_message
    conditions:
      channels: ["#data-incidents", "#data-alerts"]
```

### Condition Types

- `*_prefix`: string must start with value
- `*_less_than`: numeric field must be less than value
- `*_greater_than`: numeric field must be greater than value
- Array values: actual value must be in the list

### Permissions

Same as Tier 2. Tier 3 does not require additional permissions; it only changes when approval is required.

---

## Summary Table

| Tier | Writes | Approval | Use Case |
|------|--------|----------|----------|
| 1 | None | N/A | Evaluation, monitoring only |
| 2 | Yes | Slack required | Production, human in the loop |
| 3 | Yes | Policy match = auto; else Slack | Mature teams, pre-approved actions |

---

## Changing Tiers

1. Update `trust_tier` in `duckpipe.yaml`
2. Ensure the target tier's permissions are granted (e.g. DUCKPIPE_OPERATOR for Snowflake Tier 2)
3. For Tier 3, create or update `policy.yaml` in the project root
4. Restart DuckPipe
5. Run `npx duckpipe verify` to confirm connections and permissions
