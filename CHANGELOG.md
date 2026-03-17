# Changelog

All notable changes to DuckPipe are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] — 2026-03-16

### Added

- **Agent Runtime**: Generic agent runtime (`agents/runtime.ts`) that polls the filesystem bus and dispatches to registered tool functions. All four agents (airflow, dbt, snowflake, comms) now have working entry points.
- **Docker Manager**: Container lifecycle management (`src/docker.ts`) supporting Docker, Podman, and process-mode fallback. Agents are started/stopped automatically with the orchestrator.
- **Approval Flow**: Slack-based approval workflow for Tier 2 write actions. The `ApprovalManager` posts approval requests to Slack and waits for human reaction (✅/❌) with configurable timeout.
- **Slack Listener**: Socket Mode listener (`src/slack-listener.ts`) for real-time `@duckpipe` mentions. Filters by allowed channels and trigger keyword. Dispatches to query-sage workflow.
- **Dashboard Enhancements**: Server-Sent Events (SSE) for real-time dashboard updates, approval queue page, agent status page, and guided setup wizard for first-run onboarding.
- **HashiCorp Vault Backend**: Full implementation of KV v2 API integration with in-memory caching (5-minute TTL) and automatic refresh.
- **Snowflake Key-Pair Auth**: RSA key-pair JWT authentication for Snowflake, eliminating the need for password-based authentication in production.
- **SQL Injection Prevention**: Strict input validation on all Snowflake agent tools — regex validation for query IDs, database names, and numeric parameters. SELECT-only enforcement at application and database levels.
- **Dashboard Authentication**: Bearer token authentication for the dashboard server. Binds to `127.0.0.1` by default; binds to `0.0.0.0` only when a token is configured.
- **Health Endpoints**: `/api/health/live` and `/api/health/ready` for Kubernetes liveness and readiness probes.
- **CORS Restrictions**: Dashboard CORS restricted to `http://localhost:9876` when no auth token is set.
- **Comprehensive Test Suite**: 121 tests across 20 test files covering agent runtime, Docker manager, SQL injection regression, approval flow, Slack listener, server authentication, and end-to-end integration.

### Changed

- All workflow write actions (Slack posts, Jira tickets, Confluence updates) now route through `orchestrator.executeWriteAction()` instead of direct `dispatchToAgent()`, ensuring policy enforcement for all communication actions.
- Policy engine is now consulted before every write action regardless of which agent performs it.

### Security

- Fixed potential SQL injection vectors in Snowflake agent tools
- Dashboard binds to localhost-only by default (no remote access without explicit token)
- Credentials sanitized from all audit log entries
- Bus message files containing credentials are deleted immediately after agent reads them

---

## [0.1.0] — 2026-03-10

### Added

- **Project scaffolding**: Complete TypeScript project structure with all directories, configuration files, and build tooling.
- **Orchestrator**: Central coordination process with agent dispatch, policy check, audit logging, event deduplication, and workflow lifecycle management.
- **Vault Module**: Credential management with `env` backend (reads from `process.env`). Interface defined for `file`, `hashicorp-vault`, and `aws-secrets-manager` backends.
- **Policy Engine**: Trust tier enforcement (Tier 1/2/3) with policy.yaml rule matching. Blocks all writes at Tier 1. Requires approval at Tier 2. Allows autonomous actions at Tier 3 when matching policy rules.
- **Audit System**: Append-only SQLite audit log with immutability triggers (prevent UPDATE and DELETE). Pre-execution logging ensures every action has an audit trail.
- **Filesystem IPC Bus**: JSON file-based inter-process communication between orchestrator and agents. FileTransport implementation with chokidar watching.
- **Scheduler**: Cron and interval-based workflow triggering using `croner`.
- **Router**: Event routing from triggers to workflow handlers.
- **Verify Command**: `npx duckpipe verify` connects to each configured integration and reports permissions, access levels, and current trust tier.
- **Six Workflows**: incident-autopilot, pipeline-whisperer, cost-sentinel, sla-guardian, knowledge-scribe, query-sage — all with structured output contracts.
- **Four Agents**: Airflow, dbt, Snowflake, and Comms agents with typed tool wrappers and AGENT.md system prompts.
- **Dashboard**: Embedded web UI with workflow monitoring, audit log viewer, and basic navigation.
- **CLI**: `duckpipe start`, `duckpipe verify`, `duckpipe setup`, `duckpipe audit` commands.
- **Configuration**: Full `duckpipe.yaml` schema with Zod validation, `.env.example`, and `docker-compose.yaml`.
- **Kubernetes Manifests**: Namespace, deployment, secret, and RBAC manifests in `config-examples/k8s/`.
- **Documentation**: README, ARCHITECTURE, SECURITY, TRUST-TIERS, CONTRIBUTING, and connection guides for Airflow, Snowflake, and dbt.
- **Test Suite**: Vitest-based tests for audit, vault, policy, verify, bus, orchestrator, router, scheduler, and all six workflows.

---

## [Unreleased]

### Planned for v0.3

- `file` (age encryption) vault backend — full implementation
- `aws-secrets-manager` vault backend — full implementation
- Per-user audit scoping on dashboard SSE
- Distributed audit log option (PostgreSQL backend)
- PagerDuty integration for P1 incidents
- Webhook receiver for external event triggers
- Community skills: Databricks, Great Expectations, BigQuery

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
