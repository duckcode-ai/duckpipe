# Skill: Add Great Expectations Integration

## Overview
This skill adds Great Expectations data quality monitoring to DuckPipe,
enabling automated validation reporting and checkpoint management.

## Steps
1. Create `agents/great-expectations/` with AGENT.md, Dockerfile, tools.ts
2. Add `integrations/great-expectations.mcp.json` with tool definitions
3. Add GE config section to `duckpipe.yaml`
4. Wire the GE agent into the orchestrator
5. Add GE checkpoint results to incident-autopilot workflow

## Required Permissions
- Access to the GE data store (S3, GCS, or local filesystem)
- Read access to validation results
