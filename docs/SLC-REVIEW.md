# DuckPipe — Enterprise SLC Security Review Package

This document is designed for enterprise security teams performing a Software Lifecycle (SLC) review of DuckPipe before production deployment. It consolidates the security controls, risk assessment, and approval checklist into a single package.

**Version**: 0.2.0
**Review Date**: March 2026
**License**: Apache 2.0

---

## 1. Application Overview

| Field | Value |
|---|---|
| **Name** | DuckPipe |
| **Vendor** | Duckcode.ai (open source) |
| **Repository** | https://github.com/duckcode-ai/duckpipe |
| **License** | Apache License 2.0 |
| **Language** | TypeScript (Node.js 20+) |
| **Deployment** | Self-hosted (Docker, Kubernetes, or bare process) |
| **External dependencies** | 6 npm packages (runtime) |
| **Purpose** | Autonomous monitoring and management of Airflow, dbt, and Snowflake data infrastructure |

---

## 2. Risk Classification

### Initial Assessment

| Dimension | Rating | Justification |
|---|---|---|
| **Data sensitivity** | Medium | Accesses query metadata, DAG configurations, and run logs. Does not read business data tables. |
| **Credential exposure** | High | Holds API credentials for Airflow, Snowflake, dbt, Slack, Jira, Confluence |
| **Write capability** | Configurable | Tier 1: none. Tier 2: human-approved. Tier 3: policy-bounded. |
| **Network exposure** | Low | No inbound ports required. Dashboard is localhost-only by default. |
| **Supply chain risk** | Low | 6 runtime deps, all well-maintained, locked versions |

### Recommended Risk Rating

- **Tier 1 deployment**: Low risk
- **Tier 2 deployment**: Medium risk (mitigated by human approval)
- **Tier 3 deployment**: Medium-High risk (mitigated by policy rules and audit)

---

## 3. Data Flow Summary

```
[Your Infrastructure]
       │
       ├─ Airflow REST API ◀──── DuckPipe Airflow Agent (read DAGs, logs)
       ├─ Snowflake API ◀─────── DuckPipe Snowflake Agent (read query history)
       ├─ dbt Cloud API ◀─────── DuckPipe dbt Agent (read jobs, manifest)
       ├─ Slack API ◀────────── DuckPipe Comms Agent (post alerts)
       ├─ Jira API ◀─────────── DuckPipe Comms Agent (create tickets)
       └─ Confluence API ◀───── DuckPipe Comms Agent (create/update pages)

       ▲
       │
   [DuckPipe Orchestrator]
       │
       ├─ SQLite Audit Log (local, immutable)
       ├─ Vault (memory-only credential cache)
       └─ Dashboard (localhost:9876)

   No outbound connections to vendor servers.
   No telemetry, analytics, or usage reporting.
```

### Data Categories

| Data Type | Where It Flows | Storage |
|---|---|---|
| Integration credentials | Vault → Agent (memory) → HTTPS API | Memory only (never disk) |
| DAG metadata | Airflow → Agent → Orchestrator | Transient (bus files deleted) |
| Query history | Snowflake → Agent → Orchestrator | Transient |
| dbt manifest | dbt Cloud → Agent → Orchestrator | Transient |
| Audit entries | Orchestrator → SQLite | Persistent (immutable) |
| Slack messages | Orchestrator → Comms Agent → Slack | Transient |

---

## 4. Security Control Inventory

### 4.1 Credential Management

| Control | Status | Evidence |
|---|---|---|
| Secrets stored in memory only | Implemented | `src/vault.ts` — VaultBackend interface has no `set()` or `delete()` |
| Credentials never logged | Implemented | No `console.log` calls with vault values; audit log sanitizes input_json |
| Credentials never written to disk | Implemented | Bus files deleted after read; no temp files |
| HashiCorp Vault integration | Implemented | `src/vault.ts` — HashiCorpVaultBackend with KV v2 |
| Snowflake key-pair JWT auth | Implemented | `agents/snowflake/tools.ts` — generateJwt() |
| Credential rotation support | Supported | Vault backends refresh on TTL; process restart picks up new env values |

### 4.2 Agent Isolation

| Control | Status | Evidence |
|---|---|---|
| Container isolation per agent | Implemented | `src/docker.ts` — each agent runs in separate Docker container |
| No inter-container networking | Implemented | Docker network mode configuration |
| Credential scoping (agent receives only its own creds) | Implemented | Orchestrator passes integration-specific creds only |
| Resource limits (memory, CPU) | Configurable | `agents.memory_limit_mb`, `agents.cpu_limit` in config |
| Execution timeout | Configurable | `agents.timeout_seconds` (default: 120s) |

### 4.3 Audit System

| Control | Status | Evidence |
|---|---|---|
| Pre-execution logging | Implemented | `src/audit.ts` — logAction() called before dispatch |
| Immutability triggers | Implemented | `security/audit-schema.sql` — SQLite triggers prevent UPDATE/DELETE |
| Action attribution | Implemented | audit_log records workflow, agent, tool, tier, approved_by |
| Export to JSON/CSV | Implemented | `npx duckpipe audit --format json/csv` |

### 4.4 Input Validation

| Control | Status | Evidence |
|---|---|---|
| SQL injection prevention | Implemented | `agents/snowflake/tools.ts` — regex validation on identifiers |
| SELECT-only enforcement | Implemented | Application-level check + Snowflake role grants |
| Configuration validation | Implemented | Zod schema validation at startup |
| Bus message validation | Implemented | Zod schema validation on message processing |

### 4.5 Network Security

| Control | Status | Evidence |
|---|---|---|
| HTTPS for all API calls | Implemented | All integration clients use HTTPS |
| No cloud relay / phone-home | Verified | No outbound connections to vendor domains in codebase |
| No telemetry | Verified | No analytics, crash reporting, or usage tracking code |
| Dashboard localhost binding | Implemented | `src/server.ts` — binds 127.0.0.1 by default |
| Bearer token auth for remote dashboard | Implemented | `DUCKPIPE_DASHBOARD_TOKEN` environment variable |
| CORS restrictions | Implemented | Restricted to localhost unless auth token set |

### 4.6 Trust Tier Enforcement

| Control | Status | Evidence |
|---|---|---|
| Tier 1 blocks all writes | Implemented | `src/policy.ts` — returns allowed: false for all writes at Tier 1 |
| Tier 2 requires Slack approval | Implemented | `src/orchestrator.ts` — ApprovalManager integration |
| Tier 3 checks policy rules | Implemented | `src/policy.ts` — matches action against policy.yaml rules |
| Tier change requires restart | Implemented | Config loaded at boot, not hot-reloaded |
| Automated tests verify tier enforcement | Implemented | `tests/policy.test.ts`, `tests/orchestrator-approval.test.ts` |

---

## 5. Dependency Analysis

### Runtime Dependencies

| Package | Version | License | Purpose | Last Updated |
|---|---|---|---|---|
| better-sqlite3 | ^11.7.0 | MIT | Audit log, state database | Active |
| chokidar | ^4.0.0 | MIT | Filesystem watching | Active |
| croner | ^9.0.0 | MIT | Cron scheduling | Active |
| uuid | ^11.1.0 | MIT | Unique identifiers | Active |
| yaml | ^2.7.0 | ISC | Configuration parsing | Active |
| zod | ^3.24.0 | MIT | Schema validation | Active |

### Known Vulnerabilities

Run `npm audit` in the project directory to check for current advisories. As of the latest release, no known vulnerabilities in the dependency tree.

### Native Code

`better-sqlite3` includes a compiled C++ SQLite binding. This is the only native module. It is widely used (20M+ weekly downloads) and actively maintained.

---

## 6. Compliance Alignment

### SOC 2 Type II

| Control Area | DuckPipe Alignment |
|---|---|
| CC6.1 Logical Access | Trust tier model; role-based integration access; policy engine |
| CC6.2 Credential Management | Memory-only vault; no disk persistence; rotation support |
| CC6.3 Encryption in Transit | HTTPS for all API calls |
| CC7.1 Monitoring | Immutable audit log; real-time dashboard |
| CC7.2 Incident Detection | Automated incident detection via workflows |
| CC8.1 Change Management | Policy changes require restart; full audit trail |

### GDPR

DuckPipe accesses infrastructure metadata (query plans, DAG status, run logs). It does not process personal data. Configure `watched_databases` to exclude databases containing PII.

### HIPAA

DuckPipe does not process PHI. Snowflake query history may contain query text referencing PHI — scope database access to exclude PHI-containing databases.

### PCI DSS

DuckPipe does not process cardholder data. Scope Snowflake access to exclude databases containing cardholder data.

---

## 7. Penetration Test Scope

### Recommended Test Areas

| Area | Priority | Test Cases |
|---|---|---|
| Dashboard API | High | Auth bypass, IDOR, XSS via SSE |
| Snowflake Agent | High | SQL injection via bus message, query validation bypass |
| Bus IPC | Medium | Message injection via filesystem, race conditions |
| Configuration | Medium | Tier escalation, policy bypass via malformed YAML |
| Audit Log | Medium | Attempt UPDATE/DELETE, trigger bypass |
| Container Escape | High | Host filesystem access beyond bus mount |

### Accepted Risks

| Finding | Accepted | Reason |
|---|---|---|
| No TLS on dashboard | Yes | Localhost-only; use reverse proxy for TLS in production |
| Bus files briefly exist on disk | Yes | Transient; deleted after read; contain task payloads not raw creds |
| Process mode lacks isolation | Yes | Documented as dev-only; Docker required for production |

---

## 8. Approval Checklist

### For Security Review Board

- [ ] **Architecture review**: Credential flow is memory-only, no disk persistence
- [ ] **Agent isolation**: Docker containers with no inter-container networking
- [ ] **Audit immutability**: SQLite triggers verified (run `SELECT * FROM sqlite_master WHERE type='trigger'`)
- [ ] **Trust tier enforcement**: Tier 1 cannot execute writes (verified by test suite)
- [ ] **No vendor callbacks**: No outbound connections to duckpipe.dev or duckcode.ai
- [ ] **No telemetry**: No analytics, crash reporting, or usage tracking
- [ ] **Dependency audit**: `npm audit` returns no critical vulnerabilities
- [ ] **Input validation**: SQL injection regression tests pass
- [ ] **Network exposure**: Dashboard binds localhost by default; token required for remote access
- [ ] **Credential management**: Production uses HashiCorp Vault or AWS Secrets Manager

### For Infrastructure Team

- [ ] Docker or Podman available on the deployment host
- [ ] Network ACLs allow outbound HTTPS to Airflow, Snowflake, dbt Cloud, Slack, Jira, Confluence
- [ ] No inbound ports required (Slack uses outbound Socket Mode WebSocket)
- [ ] Persistent storage provisioned for audit log (`data/` directory)
- [ ] Monitoring configured for `/api/health/live` and `/api/health/ready` endpoints
- [ ] Log aggregation configured for stdout/stderr

### For Data Engineering Team

- [ ] Snowflake roles created (DUCKPIPE_READER and/or DUCKPIPE_OPERATOR)
- [ ] Airflow service user created with appropriate role
- [ ] dbt Cloud service token generated
- [ ] Slack bot created and added to required channels
- [ ] `npx duckpipe verify` passes for all enabled integrations
- [ ] Trust tier agreed upon with security team
- [ ] Policy.yaml reviewed and approved (for Tier 3)

---

## 9. Contact and Support

| Channel | Details |
|---|---|
| GitHub Issues | https://github.com/duckcode-ai/duckpipe/issues |
| Security Issues | security@duckcode.ai (responsible disclosure) |
| Documentation | https://github.com/duckcode-ai/duckpipe/tree/main/docs |

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
