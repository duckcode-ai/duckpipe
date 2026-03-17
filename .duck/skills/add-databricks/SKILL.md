# Skill: Add Databricks Integration

## Overview
This skill adds Databricks as a data platform integration to DuckPipe,
enabling query monitoring, cost tracking, and job management.

## Steps
1. Create `agents/databricks/` with AGENT.md, Dockerfile, tools.ts
2. Add `integrations/databricks.mcp.json` with tool definitions
3. Add Databricks config section to `duckpipe.yaml`
4. Wire the Databricks agent into the orchestrator
5. Add Databricks to the `verify` command

## Required Permissions
- Workspace-level API token with CAN_VIEW on jobs and clusters
- For Tier 2: CAN_MANAGE_RUN on specific jobs
