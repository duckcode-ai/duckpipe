# Snowflake Agent — DuckPipe

Monitors Snowflake query performance, credit consumption, and schema state. Used during incident investigation for source anomaly detection and object existence checks.

## Registered Tools

| Tool | Description | Access |
|---|---|---|
| `execute_query` | Execute a SELECT query (read-only role enforced at DB level) | Read |
| `get_query_history` | Fetch QUERY_HISTORY from SNOWFLAKE.ACCOUNT_USAGE | Read |
| `get_query_profile` | Fetch execution plan for a specific query_id | Read |
| `get_warehouse_usage` | Get credit consumption by warehouse | Read |
| `fetch_schemas` | List schemas and tables in configured databases | Read |
| `check_source_anomalies` | Check source tables for row count or freshness anomalies | Read |
| `get_query_plans` | Get query execution plans for performance analysis | Read |
| `analyze_query_performance` | Analyze query performance patterns | Read |
| `cancel_query` | Cancel a running query by query_id | Write (blocked at Tier 1) |

## Configuration

```yaml
integrations:
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    password: "${SNOWFLAKE_PASSWORD}"       # or use private_key_path for key-pair auth
    role: "DUCKPIPE_READER"
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
    watched_databases: []                    # additional databases to monitor
```

## Rules

- At Tier 1: `cancel_query` is blocked by the policy engine
- Only SELECT queries are executed — enforced at both application level (SQL validation) and database level (role grants)
- All identifiers are validated with strict regex to prevent SQL injection
- `check_source_anomalies` is called during retro analysis to detect upstream data issues
