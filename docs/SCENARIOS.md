# DuckPipe Enterprise Scenarios

Real-world deployment scenarios for enterprise data teams. Each scenario includes the problem, DuckPipe configuration, trust tier, and expected outcome.

---

## Scenario 1: Nightly Ingestion Monitoring (Tier 1)

### Problem

A retail company runs 80+ Airflow DAGs that ingest data from Stripe, Shopify, and internal APIs every night between 1am and 5am. The on-call engineer checks Slack manually at 7am to see if anything failed. By then, downstream dbt models have already run on stale data, and the BI team is reporting incorrect numbers.

### DuckPipe Solution

Deploy DuckPipe at Tier 1 (read-only). The Incident Autopilot workflow polls Airflow every 2 minutes. When a DAG fails, it:

1. Reads task logs to identify the root cause
2. Classifies the failure (timeout, connection_error, logic_error, upstream_dependency)
3. Checks Snowflake source tables for row count anomalies
4. Checks dbt Cloud for recent model changes that might correlate
5. Assembles a diagnosis and posts to `#data-incidents` in Slack

### Configuration

```yaml
duckpipe:
  trust_tier: 1

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
    role: "DUCKPIPE_READER"
    warehouse: "COMPUTE_WH"
    database: "RAW"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    allowed_channels: ["#data-incidents"]

workflows:
  incident_autopilot:
    enabled: true
    poll_interval_seconds: 120
```

### Expected Outcome

The on-call engineer receives a Slack message at 3:17am:

```
🟡 P2 — ingestion_stripe_payments failed
Root cause: Stripe API timeout during extract_payments (connection_error)
Evidence: "HTTPSConnectionPool: Read timed out (read timeout=30)"
Recommended: Retry after verifying Stripe API status
Detected by DuckPipe — duckcode.ai
```

No manual investigation needed. The engineer can decide whether to retry from bed or wait until morning.

### Permissions Required

- Airflow: Viewer role
- Snowflake: DUCKPIPE_READER (SELECT only)
- Slack: chat:write, channels:read

---

## Scenario 2: Snowflake Cost Control (Tier 2)

### Problem

A fintech company spends $180K/month on Snowflake. Analysts occasionally run unoptimized queries that consume 500+ credits in a single execution. By the time anyone notices, the monthly budget is blown. The data platform team needs real-time cost monitoring with the ability to kill runaway queries — but only after a human approves.

### DuckPipe Solution

Deploy DuckPipe at Tier 2 (supervised writes). The Cost Sentinel workflow:

1. Monitors Snowflake QUERY_HISTORY every 10 minutes
2. Alerts on any query exceeding 100 credits
3. For queries exceeding 500 credits: posts an approval request to Slack
4. An engineer reacts with ✅ to approve the kill, or ❌ to skip
5. If approved, DuckPipe cancels the query and logs the action

### Configuration

```yaml
duckpipe:
  trust_tier: 2

integrations:
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    private_key_path: "${SNOWFLAKE_PRIVATE_KEY_PATH}"
    role: "DUCKPIPE_OPERATOR"
    warehouse: "COMPUTE_WH"
    database: "ANALYTICS"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
    allowed_channels: ["#data-costs", "#data-incidents"]
    approval_timeout_seconds: 300

workflows:
  cost_sentinel:
    enabled: true
    poll_interval_minutes: 10
    cost_alert_threshold_credits: 100
    kill_threshold_credits: 500
    weekly_report:
      enabled: true
      day: "monday"
      hour: 8
```

### Expected Outcome

Slack approval request at 2:45pm:

```
🦆 DuckPipe approval needed
Action: Cancel query consuming 847 credits
Details: SELECT * FROM raw.events JOIN ... (user: analyst_jane, warehouse: COMPUTE_WH, running 47 min)
Workflow: cost-sentinel
React ✅ to approve or ❌ to skip (timeout: 5 minutes)
```

Engineer reacts ✅. Query cancelled. Audit log records: who approved, when, which query, credits saved.

Monday 8am: weekly cost report posted to `#data-costs` with breakdown by user, warehouse, and query tag.

### Permissions Required

- Snowflake: DUCKPIPE_OPERATOR (SELECT + OPERATE on warehouse)
- Slack: chat:write, channels:read, reactions:read

---

## Scenario 3: Schema Drift Auto-Fix (Tier 3)

### Problem

A healthcare analytics company has 200+ dbt models sourcing from a Snowflake data warehouse. Upstream teams occasionally add, rename, or drop columns in source tables without notifying the analytics team. The next dbt run fails, breaking dashboards and reports. The analytics team spends 2-3 hours per incident manually updating models.

### DuckPipe Solution

Deploy DuckPipe at Tier 3 with autonomous policy for low-risk drift fixes. The Pipeline Whisperer workflow:

1. Compares current Snowflake schemas against last-known snapshots every 15 minutes
2. If a column is added: automatically opens a dbt PR that adds the column to the source definition
3. If a column is renamed or dropped: opens a PR but flags it for human review (high risk)
4. Posts the PR link to `#data-engineering` in Slack

### Configuration

```yaml
duckpipe:
  trust_tier: 3

integrations:
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    private_key_path: "${SNOWFLAKE_PRIVATE_KEY_PATH}"
    role: "DUCKPIPE_READER"
    warehouse: "ANALYTICS_WH"
    database: "RAW"
    watched_databases: ["RAW", "STAGING"]

workflows:
  pipeline_whisperer:
    enabled: true
    poll_interval_minutes: 15
    github_repo: "acme-health/dbt-analytics"
    base_branch: "main"
```

### Policy (`policy.yaml`)

```yaml
autonomous:
  - name: "Auto-PR for column additions"
    agent: dbt
    action: github_create_pr
    conditions:
      drift_type: ["column_added"]
      risk_level: ["low"]

  - name: "Post drift alerts"
    agent: comms
    action: slack_post_message
    conditions:
      channels: ["#data-engineering"]
```

### Expected Outcome

At 3:15am, an upstream team adds a `loyalty_tier` column to `raw.customers`. At 3:30am, DuckPipe:

1. Detects the schema drift
2. Opens PR `duckpipe/2026-03-16/add-loyalty-tier-to-customers` with:
   - Updated source definition in `models/staging/stg_customers.sql`
   - New dbt test for the column
   - PR description explaining what changed and why
3. Posts to `#data-engineering`: "Schema drift detected in raw.customers: column `loyalty_tier` added. PR opened: [link]"

The analytics team reviews and merges the PR before the morning dbt run.

---

## Scenario 4: SLA Prediction (Tier 1)

### Problem

A logistics company has strict SLA requirements: the `daily_shipment_summary` DAG must complete by 6am EST for the operations team. The DAG typically runs 2-4 hours depending on data volume. When it runs long, nobody knows until 6am when the dashboard is empty.

### DuckPipe Solution

Deploy DuckPipe at Tier 1. The SLA Guardian workflow:

1. Checks running DAG progress every 5 minutes during business hours
2. Compares elapsed time against historical P95 run time
3. If projected completion time exceeds the SLA deadline with >70% probability: alerts Slack
4. Includes which tasks are running slowest and what to prioritize

### Configuration

```yaml
duckpipe:
  trust_tier: 1

workflows:
  sla_guardian:
    enabled: true
    poll_interval_minutes: 5
    business_hours:
      start: 2      # start monitoring at 2am (DAGs start at 2am)
      end: 8        # stop at 8am
      timezone: "America/New_York"
    monitored_dags: ["daily_shipment_summary", "daily_inventory_sync"]
```

### Expected Outcome

At 4:30am, the `daily_shipment_summary` DAG is 60% complete but running 40% slower than usual. DuckPipe posts:

```
⚠ SLA risk: daily_shipment_summary
Projected completion: 6:45am EST (SLA: 6:00am)
Breach probability: 82%
Slowest task: transform_shipment_details (running 47 min, P95: 28 min)
Suggestion: Check warehouse size or data volume spike
```

The on-call engineer scales up the Snowflake warehouse before the SLA is breached.

---

## Scenario 5: Automated Documentation (Tier 2)

### Problem

An insurance company has 400+ dbt models across 5 projects. Documentation in Confluence is always outdated. New team members spend weeks understanding the data model. The documentation team cannot keep up with weekly schema changes.

### DuckPipe Solution

Deploy DuckPipe at Tier 2. The Knowledge Scribe workflow:

1. Runs nightly at 2am
2. Fetches the dbt manifest (models, columns, tests, descriptions, lineage)
3. Creates or updates Confluence pages for each model
4. Generates Mermaid lineage diagrams
5. Links recent Jira incidents to affected model pages

### Configuration

```yaml
duckpipe:
  trust_tier: 2

integrations:
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
  confluence:
    enabled: true
    base_url: "${CONFLUENCE_BASE_URL}"
    email: "${CONFLUENCE_EMAIL}"
    api_token: "${CONFLUENCE_API_TOKEN}"
    space_key: "DATA"
    catalog_parent_page: "Data Catalog"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    app_token: "${SLACK_APP_TOKEN}"
    allowed_channels: ["#data-engineering"]
    approval_timeout_seconds: 600

workflows:
  knowledge_scribe:
    enabled: true
    schedule: "0 2 * * *"
```

### Expected Outcome

Every morning, the Confluence Data Catalog space has up-to-date pages for every dbt model:
- Model description, owner, tags
- Column names, types, descriptions
- Tests and freshness checks
- Upstream/downstream lineage (Mermaid diagram)
- Recent incidents linked from Jira

New team members onboard in days instead of weeks.

---

## Scenario 6: Interactive Query Optimization (Tier 1)

### Problem

Data analysts at a media company regularly write ad-hoc Snowflake queries for reporting. Many queries are inefficient (full table scans, missing clustering keys, cartesian joins). The data platform team cannot review every query.

### DuckPipe Solution

Deploy DuckPipe at Tier 1 with the Query Sage workflow. Analysts type `@duckpipe why is my sales query slow` in Slack. DuckPipe:

1. Identifies the relevant query from recent Snowflake query history
2. Fetches the query execution plan
3. Identifies the most expensive operations
4. Rewrites the query with specific optimizations
5. Posts a plain-English explanation with the rewritten SQL

### Slack Interaction

Analyst posts:
```
@duckpipe why is the monthly_revenue query so expensive?
```

DuckPipe replies in thread:
```
📊 Query Analysis: monthly_revenue (query_id: 01b3...)

Problem: Full table scan on raw.events (2.1B rows). No clustering key on event_date.
The JOIN with dim_products uses a non-selective predicate causing 47M row shuffle.

Rewritten query:
​```sql
SELECT date_trunc('month', e.event_date) as month,
       sum(e.amount) as revenue
FROM raw.events e
  JOIN dim.products p ON p.product_id = e.product_id
WHERE e.event_date >= '2026-01-01'  -- partition pruning
  AND p.is_active = true             -- filter before join
GROUP BY 1
ORDER BY 1;
​```

Estimated savings: ~340 credits/month (based on current execution frequency)
Suggestion: Add clustering key on raw.events(event_date)
```

---

## Deployment Patterns

### Pattern A: Start Small, Grow Trust

1. **Week 1**: Deploy Tier 1 for incident monitoring only
2. **Week 2-4**: Evaluate alert quality, tune configuration
3. **Month 2**: Promote to Tier 2 for cost control (with Slack approval)
4. **Month 3**: Add Pipeline Whisperer and Knowledge Scribe
5. **Month 4**: Promote specific actions to Tier 3 (auto-retry ingestion failures)

### Pattern B: Team-Scoped Deployment

Deploy separate DuckPipe instances per team:

| Instance | Team | Tier | Integrations |
|---|---|---|---|
| duckpipe-ingestion | Data Engineering | Tier 2 | Airflow, Snowflake, Slack |
| duckpipe-analytics | Analytics | Tier 1 | Snowflake, Slack, dbt |
| duckpipe-platform | Platform | Tier 3 | All integrations |

Each instance has its own `duckpipe.yaml`, `policy.yaml`, and credentials scoped to that team's resources.

### Pattern C: Kubernetes Production

```
┌─────────────────────────────────┐
│ Kubernetes Cluster               │
│                                  │
│  ┌───────────────────────────┐  │
│  │ Namespace: duckpipe       │  │
│  │                           │  │
│  │  Deployment: orchestrator │  │
│  │  Secret: duckpipe-creds   │  │
│  │  PV: audit-data           │  │
│  │  ServiceAccount + RBAC    │  │
│  │                           │  │
│  │  Health probes:           │  │
│  │  /api/health/live         │  │
│  │  /api/health/ready        │  │
│  └───────────────────────────┘  │
│                                  │
│  HashiCorp Vault (external)     │
│  Snowflake (external)           │
│  Airflow (external)             │
└─────────────────────────────────┘
```

See `config-examples/k8s/` for production manifests.

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
