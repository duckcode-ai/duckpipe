# DuckPipe Security & Enterprise SLC Review

This document provides a comprehensive security review of DuckPipe for enterprise security teams evaluating the platform for production deployment. It covers the threat model, data flow analysis, control inventory, compliance mapping, and penetration testing guidance.

Use this document as the basis for your Software Lifecycle (SLC) security review.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Threat Model](#threat-model)
3. [Data Flow Analysis](#data-flow-analysis)
4. [Credential Management](#credential-management)
5. [Agent Isolation Model](#agent-isolation-model)
6. [Audit System](#audit-system)
7. [Network Security](#network-security)
8. [Input Validation & Injection Prevention](#input-validation--injection-prevention)
9. [Authentication & Access Control](#authentication--access-control)
10. [Trust Tier Enforcement](#trust-tier-enforcement)
11. [Dependency Security](#dependency-security)
12. [Compliance Mapping](#compliance-mapping)
13. [Penetration Testing Guide](#penetration-testing-guide)
14. [SLC Review Checklist](#slc-review-checklist)
15. [Known Limitations](#known-limitations)
16. [Incident Response](#incident-response)

---

## Executive Summary

DuckPipe is a self-hosted, autonomous agent platform that monitors and manages data infrastructure (Airflow, Snowflake, dbt) through isolated Docker containers. It is designed with the assumption that it will be connected to production systems and handles this responsibility through:

- **Zero cloud relay**: No data, credentials, or telemetry leaves the deployment network
- **Memory-only secrets**: Credentials are never written to disk or logged
- **Agent isolation**: Each agent runs in a separate process or Docker container with scoped credentials
- **Immutable audit log**: Every action is logged before execution; logs cannot be modified or deleted
- **Tier 1 read-only**: The only supported tier today — no write actions possible at code level

**Risk classification**: Low risk. DuckPipe operates exclusively at Tier 1 (read-only). No write actions are supported. The policy engine blocks all writes unconditionally.

---

## Threat Model

### Assets Under Protection

| Asset | Classification | Protection Mechanism |
|---|---|---|
| Snowflake credentials | Critical | Memory-only vault; never logged; container-scoped |
| Airflow API credentials | Critical | Memory-only vault; never logged; container-scoped |
| dbt Cloud API token | High | Memory-only vault; never logged |
| Slack bot/app tokens | High | Memory-only vault; never logged |
| Jira/Confluence tokens | Medium | Memory-only vault; never logged |
| Audit log data | High | SQLite triggers prevent modification/deletion |
| Production Snowflake data | Critical | Read-only role; no INSERT/UPDATE/DELETE grants |
| Production Airflow DAGs | Critical | Viewer role only — no write access granted |

### Threat Actors

| Actor | Motivation | Mitigations |
|---|---|---|
| Compromised agent container | Lateral movement to other integrations | Container isolation; agents receive only their own credentials |
| Malicious skill contributor | Code injection via skill PRs | Skills reviewed before merge; agents sandboxed; policy engine blocks unscoped writes |
| Insider with config access | Privilege escalation via tier/policy change | Only Tier 1 supported; higher tiers are not implemented; audit log is immutable |
| Network attacker | Credential interception | HTTPS-only for all API calls; no cloud relay; localhost-bound dashboard by default |
| Supply chain attack | Compromised npm dependency | Minimal dependency tree (6 runtime deps); locked versions; no auto-update |

### Attack Surfaces

| Surface | Exposure | Controls |
|---|---|---|
| Dashboard HTTP server | Port 9876, localhost by default | Bearer token auth; CORS restricted; binds 0.0.0.0 only when token is set |
| Filesystem IPC (bus/) | Local filesystem | Directory permissions; transient files deleted after processing |
| Agent Docker containers | No network ports exposed | No inter-container network; no host network mode |
| Slack Socket Mode | Outbound WebSocket to Slack | Filtered by allowed_channels; keyword matching; no DM support |
| Configuration files | Local filesystem | .env in .gitignore; duckpipe.yaml does not contain secrets directly |

---

## Data Flow Analysis

### Credential Flow (Memory-Only Path)

```
┌──────────────────┐     startup      ┌──────────────────┐
│  Secret Source    │────────────────▶│  Vault Module     │
│  .env / Vault /  │                  │  (in-memory only) │
│  AWS SM          │                  └────────┬─────────┘
└──────────────────┘                           │
                                               │ on-demand read
                                               ▼
                                    ┌──────────────────┐
                                    │  Orchestrator     │
                                    │  (main process)   │
                                    └────────┬─────────┘
                                             │
                              task dispatch (bus JSON, in-memory creds)
                                             │
                    ┌────────────┬───────────┼───────────┬────────────┐
                    ▼            ▼           ▼           ▼            │
            ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
            │  Airflow   │ │   dbt    │ │Snowflake │ │  Comms   │   │
            │  Agent     │ │  Agent   │ │  Agent   │ │  Agent   │   │
            └─────┬──────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
                  │             │             │            │          │
                  ▼             ▼             ▼            ▼          │
           Airflow API    dbt Cloud     Snowflake     Slack/Jira     │
           (HTTPS)        (HTTPS)       (HTTPS)       (HTTPS)       │
                                                                     │
                                                      Audit Log ◀────┘
                                                      (SQLite, local)
```

**Key properties:**
- Credentials exist in memory only. They are passed from the vault to the orchestrator to agents in bus message payloads.
- Bus files containing credentials are deleted immediately after the agent reads them.
- No credential is ever written to a log file, stdout, or the audit log.
- No outbound connection to any Duckcode-controlled server is made at any time.

### Data Access Flow

```
Snowflake ──SELECT──▶ Snowflake Agent ──results──▶ Orchestrator ──▶ Audit Log
                                                         │
                                                         ▼
                                                   Workflow Logic
                                                         │
                                                         ▼
                                                   Comms Agent ──▶ Slack/Jira
```

**Key properties:**
- Only SELECT queries are executed against Snowflake (enforced at DB role level and application level)
- Query results are used for analysis (cost, performance) and discarded — they are not persisted to disk
- Data posted to Slack/Jira is diagnostic (query metadata, error messages) — never raw table data

---

## Credential Management

### Vault Backends

| Backend | Use Case | Implementation Status |
|---|---|---|
| `env` | Development, CI/CD | Fully implemented. Prints warning at Tier 2+. |
| `file` (age encryption) | Single-machine production | Interface defined; implementation pending. |
| `hashicorp-vault` | Enterprise production | Fully implemented. KV v2 API, in-memory cache with 5-min TTL. |
| `aws-secrets-manager` | AWS production | Interface defined; implementation pending. |

### Vault Interface Contract

```typescript
interface VaultBackend {
  get(key: string): Promise<string>;
  // No set(), no delete() — DuckPipe never writes to the vault
}
```

The read-only interface is intentional. DuckPipe consumes secrets; it never manages them. Your secrets infrastructure (Vault, AWS SM, env files) remains the single source of truth.

### Credential Lifecycle

1. **Load**: On startup, vault backend reads credentials from source into process memory
2. **Cache**: Credentials cached in-memory (HashiCorp: 5-min TTL with auto-refresh)
3. **Distribute**: Orchestrator passes credentials to agents via bus task payloads (in-memory)
4. **Consume**: Agent uses credential for a single HTTPS API call
5. **Discard**: Bus file deleted after read; no persistent storage of credentials

### What Never Happens

- Credentials are never written to `console.log`, `console.debug`, or any log level
- Credentials are never written to the audit log (input_json is sanitized)
- Credentials are never written to the SQLite database
- Credentials are never written to bus files that persist (files are deleted after read)
- Credentials are never sent to any Duckcode-controlled server

---

## Agent Isolation Model

### Container Architecture

Each of the four agents (airflow, dbt, snowflake, comms) runs in its own Docker container:

```
┌─────────────────────────────────────────────────────────┐
│                    Host Machine                          │
│                                                          │
│  ┌──────────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐│
│  │ Airflow Agent│  │dbt Agent │  │ SF Agent │  │Comms ││
│  │  Container   │  │Container │  │Container │  │Agent ││
│  │              │  │          │  │          │  │      ││
│  │ Has: Airflow │  │Has: dbt  │  │Has: SF   │  │Has:  ││
│  │   creds only │  │creds only│  │creds only│  │Slack ││
│  │              │  │          │  │          │  │Jira  ││
│  │ No network   │  │No network│  │No network│  │Confl.││
│  │ to other     │  │to other  │  │to other  │  │creds ││
│  │ containers   │  │containers│  │containers│  │only  ││
│  └──────┬───────┘  └────┬─────┘  └────┬─────┘  └──┬───┘│
│         │               │             │            │     │
│         └───────────────┴──────┬──────┴────────────┘     │
│                                │                          │
│                    Filesystem IPC (bus/)                   │
│                    Orchestrator Process                    │
└─────────────────────────────────────────────────────────┘
```

### Isolation Guarantees

| Property | Enforcement |
|---|---|
| No inter-container networking | Docker network mode: none (or isolated bridge) |
| Credential scoping | Each agent receives only its own integration credentials |
| Resource limits | Configurable memory_limit_mb (default 512MB) and cpu_limit (default 0.5) |
| Timeout enforcement | Agent killed after timeout_seconds (default 120s) |
| Minimal base image | `node:20-slim` — no unnecessary packages |
| Read-only filesystem | Agent cannot write to host filesystem except through bus mount |

### Process Mode Fallback

When Docker is unavailable (development, CI), agents run as child processes. The same IPC bus is used. Credential scoping and timeout enforcement still apply. Container isolation is not available in process mode — document this in your risk assessment if using process mode in production.

---

## Audit System

### Immutability Enforcement

The audit log uses SQLite with triggers that prevent any modification:

```sql
CREATE TRIGGER prevent_audit_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no updates permitted'); END;

CREATE TRIGGER prevent_audit_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no deletes permitted'); END;
```

These triggers are enforced by the SQLite engine itself. Application code, SQL injection, or direct database access cannot bypass them without dropping and recreating the table (which requires file-level access and would be detected by file integrity monitoring).

### Pre-Execution Logging

The orchestrator calls `logAction()` **before** dispatching any agent task:

1. Audit entry written (workflow, agent, tool, tier, input, write_action flag)
2. If write fails (disk full, DB locked): action is **not executed**
3. Agent executes the task
4. Result (output, duration, success, error) written to companion table

This guarantees that every action that executes has a corresponding audit record created before execution began.

### Audit Schema

| Column | Purpose |
|---|---|
| `id` | UUID primary key |
| `created_at` | UTC timestamp |
| `workflow` | Which workflow triggered this action |
| `agent` | Which agent executed it |
| `tool` | Which MCP tool was called |
| `tier` | Trust tier at time of execution |
| `input_json` | Sanitized input parameters (no credentials) |
| `output_json` | Result data |
| `write_action` | Boolean: was this a write operation |
| `approved_by` | 'auto' / 'slack:username' / 'policy:rule-name' |
| `duration_ms` | Execution time |
| `success` | Boolean: did it succeed |
| `error_message` | Error details if failed |

### Export Capabilities

```bash
npx duckpipe audit --format json --since 2026-03-01 > audit-export.json
npx duckpipe audit --format csv --since 2026-03-01 > audit-export.csv
```

Exports include all fields. Use these for compliance reporting, incident investigation, or feeding into your SIEM.

---

## Network Security

### Outbound Connections

DuckPipe makes outbound HTTPS connections to **only** the services you configure:

| Destination | Purpose | Configurable |
|---|---|---|
| Airflow API | DAG monitoring, task logs | `integrations.airflow.base_url` |
| Snowflake | Query history, schema inspection | `integrations.snowflake.account` |
| dbt Cloud | Job/run status, manifest | `integrations.dbt.cloud_url` |
| Slack API | Alerts, approvals, query-sage | `integrations.slack.*` |
| Jira API | Ticket creation | `integrations.jira.base_url` |
| Confluence API | Page creation/update | `integrations.confluence.base_url` |
| HashiCorp Vault | Secret retrieval (if configured) | `secrets.vault_addr` |

### Connections That Never Happen

- No connection to `duckpipe.dev`, `duckcode.ai`, or any Duckcode-controlled server
- No telemetry, analytics, crash reporting, or usage tracking
- No license validation or phone-home
- No auto-update mechanism

### Inbound Connections

| Port | Service | Binding | Authentication |
|---|---|---|---|
| 9876 | Dashboard HTTP | `127.0.0.1` (localhost) by default | None required when localhost |
| 9876 | Dashboard HTTP | `0.0.0.0` when DUCKPIPE_DASHBOARD_TOKEN is set | Bearer token required |

### Air-Gap Compatibility

DuckPipe can run in air-gapped environments. Requirements:
1. Docker images pre-pulled and available in a local registry
2. npm packages installed from a local mirror or vendored
3. Configuration points to internal-only API endpoints

---

## Input Validation & Injection Prevention

### SQL Injection Prevention (Snowflake Agent)

All user-controlled inputs to Snowflake queries are validated:

| Input | Validation | Regex |
|---|---|---|
| Query ID | UUID format only | `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` |
| Database name | Alphanumeric + underscore only | `/^[A-Za-z_][A-Za-z0-9_]*$/` |
| Window (minutes) | Positive integer only | Numeric range check |
| Query text | SELECT-only enforcement | Prefix check + blocked keyword list |

The Snowflake agent rejects any query containing DDL/DML keywords (CREATE, DROP, ALTER, INSERT, UPDATE, DELETE, GRANT, REVOKE) regardless of trust tier. The Snowflake role grants enforce this at the database level as a second line of defense.

### Bus Message Validation

All inter-process messages are validated using Zod schemas before processing. Malformed messages are logged and discarded.

### Configuration Validation

`duckpipe.yaml` is validated against a Zod schema at startup. Invalid configuration prevents startup rather than falling back to defaults.

---

## Authentication & Access Control

### Dashboard Authentication

| Scenario | Binding | Auth Required |
|---|---|---|
| No `DUCKPIPE_DASHBOARD_TOKEN` set | `127.0.0.1:9876` | None (localhost only) |
| Token set | `0.0.0.0:9876` | `Authorization: Bearer <token>` |

Health endpoints (`/api/health/live`, `/api/health/ready`) bypass authentication for Kubernetes probes.

CORS is restricted to `http://localhost:9876` when no token is set, or `*` when a token is set (for reverse proxy deployments).

### Integration Authentication

| Integration | Auth Method | Notes |
|---|---|---|
| Airflow | Basic auth or API key | Configurable per deployment |
| Snowflake | Password or RSA key-pair JWT | Key-pair recommended for production |
| dbt Cloud | Service token | Read-only scopes for Tier 1 |
| Slack | Bot token + App token | Socket Mode for real-time events |
| Jira | Email + API token | Atlassian Cloud API |
| Confluence | Email + API token | Atlassian Cloud API |

---

## Trust Tier Enforcement

### Current State: Tier 1 Only

DuckPipe currently supports **only Tier 1 (read-only)**. Tiers 2 and 3 are on the roadmap but not implemented.

### Enforcement Points

The trust tier is checked at three levels:

1. **Policy engine** (`src/policy.ts`): Returns `{ allowed: false }` for **every** write action at Tier 1
2. **Orchestrator** (`src/orchestrator.ts`): `executeWriteAction()` calls policy check before dispatch — always blocked at Tier 1
3. **Agent tools**: Write tools exist in agent code but are unreachable at Tier 1

### Tier 1 Guarantee

When `trust_tier: 1` (the only supported value):
- The policy engine returns `{ allowed: false }` for **every** write action
- No configuration, policy file, or agent behavior can override this
- The code path for write execution is unreachable
- This is verified by automated tests (`tests/policy.test.ts`, `tests/orchestrator-approval.test.ts`)

### Permissions at Tier 1

| System | Role | Access Level |
|---|---|---|
| Airflow | Viewer | Read DAGs, runs, task instances, logs |
| Snowflake | DUCKPIPE_READER | SELECT only — no DML, DDL, or OPERATE |
| dbt Cloud | read:jobs, read:runs | Read jobs, runs, manifest |
| Slack | chat:write, channels:read | Read channel history; post alerts |
| Jira | Read only | Read issues (no creation) |
| Confluence | Read only | Search pages (no creation) |

---

## Dependency Security

### Runtime Dependencies (6 total)

| Package | Purpose | License |
|---|---|---|
| `better-sqlite3` | Audit log, state database | MIT |
| `chokidar` | Filesystem watching for bus IPC | MIT |
| `croner` | Cron scheduling for workflows | MIT |
| `uuid` | Unique identifiers | MIT |
| `yaml` | Configuration parsing | ISC |
| `zod` | Schema validation | MIT |

### Dependency Policy

- Maximum 6 runtime dependencies (enforced by project policy)
- All dependencies must have been updated within the last 6 months
- `package-lock.json` is committed and used for deterministic installs
- No post-install scripts in the dependency tree
- No native modules except `better-sqlite3` (compiled, audited, widely used)

### Supply Chain Mitigations

- Lock file ensures reproducible builds
- No dependency auto-update mechanism
- Recommend running `npm audit` as part of your CI pipeline
- All dependencies are from established, well-maintained projects

---

## Compliance Mapping

### SOC 2 Type II

| Control | DuckPipe Implementation |
|---|---|
| CC6.1 — Logical access | Trust tier model; role-based access to integrations |
| CC6.2 — Credential management | Memory-only vault; no disk persistence |
| CC6.3 — Encryption in transit | HTTPS for all API calls; no plaintext connections |
| CC7.1 — Monitoring | Immutable audit log; real-time dashboard |
| CC7.2 — Incident detection | Incident Autopilot workflow; SLA Guardian |
| CC8.1 — Change management | Policy changes require restart; audit trail for all actions |

### GDPR / Data Privacy

| Requirement | DuckPipe Stance |
|---|---|
| Data minimization | DuckPipe reads metadata (query history, DAG status), not business data |
| Data residency | Fully self-hosted; data never leaves your network |
| Right to erasure | DuckPipe does not store personal data; audit log contains action metadata only |
| Breach notification | Audit log provides complete action history for incident investigation |

### HIPAA (if applicable)

DuckPipe does not process, store, or transmit Protected Health Information (PHI). It accesses database metadata and query execution plans — not table contents. If your Snowflake query history may contain PHI in query text, configure `watched_databases` to scope access.

### PCI DSS

DuckPipe does not process cardholder data. It monitors pipeline health and query costs. Snowflake role grants should exclude databases containing cardholder data from DuckPipe's scope.

---

## Penetration Testing Guide

Use this section to scope a penetration test of your DuckPipe deployment.

### In-Scope

| Area | Test Cases |
|---|---|
| Dashboard API | Auth bypass, IDOR on audit endpoints, XSS in SSE events |
| Snowflake agent | SQL injection via bus message manipulation, query text validation bypass |
| Bus IPC | Message injection via filesystem, race conditions in file processing |
| Configuration | Tier escalation without restart, policy bypass via malformed YAML |
| Audit log | Attempt UPDATE/DELETE on audit_log table, trigger bypass |
| Container escape | Agent container breakout, host filesystem access beyond bus mount |

### Expected Findings (by design)

| Finding | Risk Accepted? | Justification |
|---|---|---|
| Dashboard has no auth on localhost | Yes | Binding to 127.0.0.1 limits exposure; token auth available |
| Bus files briefly exist on disk | Yes | Files contain task payloads, not raw credentials; deleted after read |
| Process mode lacks container isolation | Yes | Documented as dev-only; Docker required for production |

### Recommended Test Environment

1. Deploy DuckPipe with all integrations pointing to test/staging instances
2. Keep `trust_tier: 1` (the only supported value) to test realistic code paths
3. Monitor audit log during testing to verify action recording
4. Test with both Docker and process runtime modes

---

## SLC Review Checklist

Use this checklist for your enterprise security review board.

### Architecture & Design

- [ ] All credentials stored in memory only — never written to disk, logs, or database
- [ ] Agent containers isolated with no inter-container networking
- [ ] Audit log immutability enforced by SQLite triggers (not application logic)
- [ ] Trust tier model prevents Tier 1 from executing any write action
- [ ] No outbound connections to vendor-controlled servers
- [ ] No telemetry, analytics, or usage reporting

### Credential Management

- [ ] Vault module implements read-only interface (no set/delete operations)
- [ ] HashiCorp Vault backend implemented with in-memory caching
- [ ] AWS Secrets Manager backend available (interface defined)
- [ ] Snowflake key-pair JWT authentication supported (no password required)
- [ ] Credentials sanitized from audit log entries

### Access Control

- [ ] Dashboard binds to localhost by default; requires bearer token for remote access
- [ ] Slack listener filters by allowed_channels — no DM support
- [ ] Snowflake role grants follow least privilege (DUCKPIPE_READER — SELECT only)
- [ ] Airflow permissions use Viewer role (read-only)
- [ ] Policy engine blocks all write actions at Tier 1 (the only supported tier)

### Input Validation

- [ ] SQL injection prevention with strict regex validation on identifiers
- [ ] SELECT-only enforcement on Snowflake queries (application + database level)
- [ ] Bus messages validated against Zod schemas
- [ ] Configuration validated at startup — invalid config prevents boot

### Audit & Monitoring

- [ ] Every action logged before execution (pre-execution audit)
- [ ] Audit log supports JSON and CSV export for SIEM integration
- [ ] Dashboard provides real-time monitoring via SSE
- [ ] Health endpoints available for Kubernetes liveness/readiness probes

### Deployment

- [ ] Docker Compose configuration provided for local deployment
- [ ] Kubernetes manifests provided with RBAC, secrets, and probes
- [ ] Air-gap deployment supported (no external dependencies at runtime)
- [ ] Node.js >= 20 LTS required (active LTS with security updates)

### Testing

- [ ] 121+ automated tests covering policy, audit, injection prevention, workflows
- [ ] Mock transport used in tests — no real API calls in test suite
- [ ] Tier enforcement tested explicitly (Tier 1 cannot trigger writes)
- [ ] SQL injection regression tests for Snowflake agent

---

## Known Limitations

| Limitation | Mitigation | Planned Fix |
|---|---|---|
| `file` (age) vault backend not fully implemented | Use `env` or `hashicorp-vault` | v0.3 |
| `aws-secrets-manager` backend interface only | Use `env` or `hashicorp-vault` | v0.3 |
| Process mode lacks container isolation | Use Docker for production | Documented |
| Dashboard SSE has no per-user auth scoping | Use bearer token + reverse proxy | v0.3 |
| Audit log is local SQLite (not distributed) | Export to SIEM for distributed environments | v1.0 |
| No TLS on dashboard (relies on reverse proxy) | Deploy behind nginx/traefik with TLS | Documented |

---

## Incident Response

If you suspect a security issue in DuckPipe:

1. **Check the audit log**: `npx duckpipe audit --since <timestamp>` to see all actions
2. **Verify permissions**: `npx duckpipe verify` to confirm current access levels
3. **Revoke credentials**: Rotate the affected integration's credentials in your secrets backend
4. **Export audit**: `npx duckpipe audit --format json` for forensic analysis
5. **Report**: Open a security issue at [github.com/duckcode-ai/duckpipe](https://github.com/duckcode-ai/duckpipe) (use responsible disclosure for critical vulnerabilities)

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
