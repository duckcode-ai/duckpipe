# DuckPipe Trust Tiers

DuckPipe uses three trust tiers to control what actions agents can perform. You set the tier in `duckpipe.yaml`; it applies globally. Start at Tier 1 and promote when ready.

---

## Overview

| Tier | Writes | Approval | Use Case |
|------|--------|----------|----------|
| 1 — Sandbox | None | N/A | Evaluation, monitoring only |
| 2 — Supervised | Yes | Slack required | Production, human in the loop |
| 3 — Autonomous | Yes | Policy match = auto; else Slack | Mature teams, pre-approved actions |

---

## Tier 1: Read-Only Sandbox

This is the default. DuckPipe connects with the minimum permissions needed to observe. It cannot modify anything in any integrated system.

### What Tier 1 Enables

- **Incident Autopilot**: Observes and reports failures (no Jira, no Slack posts unless configured)
- **SLA Guardian**: Predicts pipeline breaches, posts warnings to Slack
- **Query Sage**: Explains slow queries, suggests optimizations (no SQL changes)
- **Cost Sentinel**: Reports expensive queries (no query killing)

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

- Bot scopes: `chat:write`, `channels:read`

### Security Guarantee

When `trust_tier: 1`, the policy engine returns `{ allowed: false }` for every write action. No configuration, policy file, or agent behavior can override this. This is enforced in code and verified by automated tests.

---

## Tier 2: Supervised Writes

Every write action pauses and posts an approval request to Slack. A human must react with ✅ to approve or ❌ to reject within `approval_timeout_seconds`. If no response, the action is skipped and logged. This is the recommended configuration for production.

### What Tier 2 Adds

- **Incident Autopilot** (full mode): Files Jira tickets, posts Slack alerts, optionally retries failed tasks (with approval)
- **Pipeline Whisperer**: Opens dbt model fix PRs on GitHub (with approval)
- **Knowledge Scribe**: Creates and updates Confluence pages (with approval)
- **Cost Sentinel** (full mode): Kills runaway queries after Slack approval

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

**GitHub** (for Pipeline Whisperer)

- Fine-grained token: `Contents: Read and Write` (branch push only), `Pull requests: Read and Write`
- Token cannot push to main/master — enforce via branch protection rules in GitHub

**Slack**

- Same as Tier 1; used for approval requests and alerts
- Socket Mode required for real-time approval handling (`SLACK_APP_TOKEN`)

**Jira**

- Create issue, read issue

**Confluence**

- Create page, update page

### Approval Flow

When a write action is triggered:

1. DuckPipe posts an approval request to the configured Slack channel
2. The message includes: action description, details preview, workflow name, timeout
3. An engineer reacts with ✅ to approve or ❌ to reject
4. If approved: action executes and is logged to the audit system
5. If rejected or timeout: action is skipped and logged as skipped

```
🦆 DuckPipe approval needed
Action: Create Jira ticket for DAG failure
Details: P2 — ingestion_stripe_payments failed (connection_error)
Workflow: incident-autopilot
React ✅ to approve or ❌ to skip (timeout: 5 minutes)
```

---

## Tier 3: Autonomous

Specific actions are pre-approved in `policy.yaml`. If an action matches a rule, it runs immediately without Slack approval. If it does not match, it falls back to Tier 2 (approval required).

### Example `policy.yaml`

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

| Suffix | Behavior |
|---|---|
| `*_prefix` | String must start with value |
| `*_less_than` | Numeric field must be less than value |
| `*_greater_than` | Numeric field must be greater than value |
| Array value | Actual value must be in the list |

### Permissions

Same as Tier 2. Tier 3 does not require additional permissions; it only changes when approval is required.

### Best Practices for Tier 3

- Start with a narrow policy (e.g., only auto-retry specific ingestion DAGs)
- Monitor the audit log for autonomous actions
- Review and tighten policy rules monthly
- Keep `failure_type` conditions specific — never auto-retry `logic_error` failures
- Set credit thresholds conservatively for auto-kill policies

---

## Changing Tiers

1. Update `trust_tier` in `duckpipe.yaml`
2. Ensure the target tier's permissions are granted in the integrated systems
3. For Tier 3: create or update `policy.yaml` in the project root
4. **Restart DuckPipe** (tier is loaded at boot, not hot-reloaded — this is intentional)
5. Run `npx duckpipe verify` to confirm connections and permissions match the new tier

### Tier Change Audit Trail

When DuckPipe starts, the current trust tier is recorded in the audit log. Comparing audit entries before and after a tier change provides a clear record of when the promotion occurred.

---

## Recommendations by Organization Size

| Team Size | Recommended Tier | Rationale |
|---|---|---|
| 1-5 engineers | Tier 1 or 2 | Small team can review approvals quickly |
| 5-20 engineers | Tier 2 | Human-in-the-loop for production safety |
| 20+ engineers | Tier 2 with selective Tier 3 | Auto-retry ingestion failures; human approval for everything else |

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
