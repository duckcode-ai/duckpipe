# Skill: Add BigQuery Integration

## Overview
This skill adds Google BigQuery as a data platform integration to DuckPipe,
enabling query monitoring, cost tracking, and slot management.

## Steps
1. Create `agents/bigquery/` with AGENT.md, Dockerfile, tools.ts
2. Add `integrations/bigquery.mcp.json` with tool definitions
3. Add BigQuery config section to `duckpipe.yaml`
4. Wire the BigQuery agent into the orchestrator
5. Add BigQuery to the `verify` command

## Required Permissions
- Service account with `bigquery.jobs.list` and `bigquery.jobs.get`
- `bigquery.tables.list` and `bigquery.tables.get` on monitored datasets
- For Tier 2: `bigquery.jobs.delete` to cancel runaway queries
