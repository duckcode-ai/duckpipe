# DuckPipe Architecture

This document describes the complete DuckPipe architecture for engineers integrating, extending, or evaluating the platform for enterprise deployment.

---

## Overview

DuckPipe is an orchestrator that runs specialized AI agents in isolated Docker containers. The orchestrator coordinates workflows, routes events, enforces trust-tier policy, and manages the filesystem message bus. Agents never communicate directly with each other; all interaction flows through the orchestrator.

```
┌──────────────────────────────────────────────────────────┐
│                     Host / K8s Pod                        │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Orchestrator (main process)              │ │
│  │                                                       │ │
│  │  ┌─────────┐ ┌────────┐ ┌────────┐ ┌─────────────┐ │ │
│  │  │ Vault   │ │ Policy │ │ Audit  │ │  Scheduler  │ │ │
│  │  │ Module  │ │ Engine │ │ System │ │  (croner)   │ │ │
│  │  └─────────┘ └────────┘ └────────┘ └─────────────┘ │ │
│  │  ┌──────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐ │ │
│  │  │  Router  │ │  Bus   │ │ Docker  │ │ Dashboard│ │ │
│  │  │          │ │(IPC mgr)│ │ Manager │ │  Server  │ │ │
│  │  └──────────┘ └────────┘ └─────────┘ └──────────┘ │ │
│  └─────────────────────────┬───────────────────────────┘ │
│                            │ Filesystem IPC               │
│       ┌────────────┬───────┴──────┬────────────┐         │
│       ▼            ▼              ▼            ▼         │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐   │
│  │ Airflow │  │   dbt   │  │Snowflake │  │  Comms  │   │
│  │ Agent   │  │  Agent  │  │  Agent   │  │  Agent  │   │
│  │(Docker) │  │(Docker) │  │ (Docker) │  │(Docker) │   │
│  └────┬────┘  └────┬────┘  └────┬─────┘  └────┬────┘   │
│       │            │            │             │          │
└───────┼────────────┼────────────┼─────────────┼──────────┘
        │            │            │             │
        ▼            ▼            ▼             ▼
   Airflow API   dbt Cloud    Snowflake    Slack/Jira/
                 GitHub       (HTTPS)      Confluence
```

---

## Core Components

### Orchestrator (`src/orchestrator.ts`)

The central coordinator. Responsibilities:

1. **Agent lifecycle**: Starts and stops agent containers via Docker Manager
2. **Message routing**: Dispatches tasks to agents via the bus, receives results
3. **Policy enforcement**: Calls the policy engine before every write action
4. **Audit logging**: Writes to the audit system before every action executes
5. **Workflow management**: Tracks workflow state (start, complete, fail)
6. **Event deduplication**: Prevents duplicate workflow runs for the same event
7. **Approval coordination**: For Tier 2, routes write actions through the Slack approval flow

The orchestrator does not run inside a container. It runs as the main Node.js process and manages everything else.

### Vault (`src/vault.ts`)

Resolves credentials from configured backends. The vault exposes a read-only interface:

```typescript
interface VaultBackend {
  get(key: string): Promise<string>;
}
```

No `set()`, no `delete()`. DuckPipe consumes secrets; it never manages them.

**Backends:**
| Backend | Description |
|---|---|
| `env` | Reads from `process.env`. Development default. Warns at Tier 2+. |
| `file` | Age-encrypted file, decrypted into memory at startup. |
| `hashicorp-vault` | KV v2 API with in-memory caching (5-min TTL). |
| `aws-secrets-manager` | AWS SDK with instance role or explicit credentials. |

### Policy Engine (`src/policy.ts`)

Consulted before every write action. Returns:

```typescript
{ allowed: boolean, reason: string, approvalRequired: boolean }
```

| Tier | Behavior |
|---|---|
| 1 | All writes blocked. `allowed: false` always. |
| 2 | Writes require Slack approval. `approvalRequired: true`. |
| 3 | If action matches a rule in `policy.yaml`: `allowed: true`. Otherwise: falls back to Tier 2. |

Policy is loaded at startup and cached. Changes require a restart. This is intentional — policy changes should be deliberate.

### Audit System (`src/audit.ts`)

Append-only SQLite log with immutability enforced by triggers:

- `logAction()` writes an entry **before** the action executes
- If the write fails, the action does not run
- No `updateAction()`, `deleteAction()`, or `clearAudit()` functions exist
- SQLite triggers prevent UPDATE and DELETE at the database engine level

Exports available in JSON and CSV for SIEM integration.

### Filesystem IPC Bus (`src/bus.ts`)

Inter-process communication using JSON files on the local filesystem. No Redis, no RabbitMQ, no Kafka.

```
bus/
  orchestrator/              ← agents write results here
  agents/
    airflow/in/              ← orchestrator writes tasks here
    airflow/out/             ← airflow agent writes results here
    dbt/in/
    dbt/out/
    snowflake/in/
    snowflake/out/
    comms/in/
    comms/out/
```

**Message flow:**
1. Orchestrator writes a JSON task to `bus/agents/<agent>/in/<timestamp>-<uuid>.json`
2. Agent polls `in/` every 200ms, reads the file, processes it, deletes the input file
3. Agent writes the response to `bus/agents/<agent>/out/<timestamp>-<uuid>.json`
4. Orchestrator watches all `out/` directories via chokidar, reads the file, routes the response
5. Files are deleted after processing — the bus is transient state

The bus is implemented as a `Transport` interface, allowing in-memory mocks for testing and potential future transport backends (message queues, etc.) for distributed deployments.

### Scheduler (`src/scheduler.ts`)

Triggers workflows on cron or interval schedules using the `croner` library:

| Workflow | Default Schedule |
|---|---|
| Incident Autopilot | Every 120 seconds |
| Pipeline Whisperer | Every 15 minutes |
| Cost Sentinel | Every 10 minutes |
| SLA Guardian | Every 5 minutes (business hours) |
| Knowledge Scribe | Nightly at 2am |
| Query Sage | Event-driven (Slack @mention) |

The scheduler invokes workflow handlers. It does not dispatch directly to agents; workflow logic handles agent coordination through the orchestrator.

### Router (`src/router.ts`)

Routes incoming events (webhooks, Slack messages, scheduled triggers) to the correct workflow handler. The router normalizes event formats and prevents duplicate processing.

### Docker Manager (`src/docker.ts`)

Manages agent container lifecycle:

- Detects runtime: Docker, Podman, or process (fallback)
- Starts containers with resource limits (memory, CPU, timeout)
- Monitors container health
- Stops containers on shutdown
- Falls back to child processes when containers are unavailable

### Dashboard Server (`src/server.ts`, `src/api.ts`)

Embedded HTTP server providing:

- REST API for audit log, workflow status, agent health, approvals
- Server-Sent Events (SSE) for real-time dashboard updates
- Health endpoints (`/api/health/live`, `/api/health/ready`) for Kubernetes probes
- Bearer token authentication when exposed beyond localhost
- Setup wizard for first-run onboarding

### Slack Listener (`src/slack-listener.ts`)

Connects to Slack via Socket Mode (WebSocket) for real-time event handling:

- Listens for `@duckpipe` mentions in allowed channels
- Filters by configured trigger keyword and channel allowlist
- Dispatches messages to the query-sage workflow
- Handles approval reactions (✅/❌) for Tier 2 write actions

---

## Agent Architecture

### Agent Runtime (`agents/runtime.ts`)

A generic runtime that all agents share:

1. Poll `bus/agents/<name>/in/` for task JSON files
2. Match task `_taskType` to registered tool function
3. Execute the tool function with task parameters
4. Write result to `bus/agents/<name>/out/`
5. Delete the input file

Each agent entry point (`agents/<name>/index.ts`) imports the runtime and registers its tool functions.

### Agent Tool Contracts

Each agent defines typed tools in `tools.ts` with structured output contracts:

**Airflow Agent** — monitors DAGs, detects failures, analyzes task logs
**dbt Agent** — monitors jobs, detects schema drift, proposes model fixes
**Snowflake Agent** — monitors query costs, detects anomalies, suggests optimizations
**Comms Agent** — posts Slack messages, creates Jira tickets, updates Confluence pages

All tools that perform write actions are marked `[WRITE]` and require policy approval before execution.

---

## Workflow Architecture

Workflows orchestrate multi-agent collaboration:

```
Event/Trigger
    │
    ▼
┌────────────────┐
│   Workflow      │
│   Handler       │
└───────┬────────┘
        │
        ├──▶ Agent 1 (parallel)  ──▶ Result 1 ─┐
        ├──▶ Agent 2 (parallel)  ──▶ Result 2 ─┤
        │                                       │
        ◀───────── Aggregate Results ───────────┘
        │
        ├──▶ Policy Check (for writes)
        ├──▶ Approval (Tier 2)
        ├──▶ Comms Agent (Slack/Jira/Confluence)
        │
        ▼
   Audit Log Entry
```

### Workflow Inventory

| Workflow | Trigger | Agents Used | Actions (Tier 1) |
|---|---|---|---|
| Incident Autopilot | Poll (120s) / webhook | airflow, dbt, snowflake, comms | Detect failures, diagnose, alert Slack, run autonomous retro |
| SLA Guardian | Poll (300s) | airflow, comms | Predict SLA breaches, alert Slack |
| Cost Sentinel | Poll (600s) | snowflake, comms | Monitor credit burn, alert on expensive queries |
| Pipeline Whisperer | Poll (900s) | snowflake, dbt, comms | Detect schema drift, report affected models |
| Knowledge Scribe | Nightly cron | dbt, comms | Read dbt manifest for lineage (reporting only) |

### Autonomous Retro Analysis

When Incident Autopilot detects a failure, it triggers an autonomous retrospective analysis:

1. **Retro Runner** (`src/retro-runner.ts`) orchestrates a 5-level investigation (5-whys)
2. Each level asks a progressively deeper question about the incident
3. **Investigator** (`src/investigator.ts`) runs playbook-driven data collection per level
4. **Sub-Agents** (`src/subagents.ts`) fan out parallel agent tool calls (airflow, dbt, snowflake, comms)
5. An LLM synthesizes facts into an answer per level and checks sufficiency
6. Results are persisted to the database after each level for live dashboard updates

Playbooks are dynamically selected based on the question context (e.g., `airflow-failure-trace`, `dbt-lineage-trace`, `missing-object-trace`). Each level has a 45-second timeout to prevent hangs.

---

## Deployment Architecture

### Local / Single Machine

```bash
npx duckpipe start
```

The orchestrator runs as a single Node.js process. Agents run as Docker containers (or child processes). SQLite stores the audit log and state. Dashboard available at `http://localhost:9876`.

### Docker Compose

```bash
docker compose -f config-examples/docker-compose.yaml up -d
```

All components run in containers. Volumes mount for bus IPC and SQLite persistence.

### Kubernetes

Manifests in `config-examples/k8s/`:

| Manifest | Purpose |
|---|---|
| `namespace.yaml` | Dedicated `duckpipe` namespace |
| `secret.yaml` | Kubernetes secrets for credentials |
| `deployment.yaml` | Orchestrator deployment with resource limits |
| `rbac.yaml` | Service account and role bindings |

Health probes:
- Liveness: `GET /api/health/live` (returns 200 if process is running)
- Readiness: `GET /api/health/ready` (returns 200 if all configured integrations are connected)

---

## Data Storage

### SQLite Database (`data/duckpipe.db`)

| Table | Purpose | Mutable |
|---|---|---|
| `audit_log` | Append-only action log | No (triggers prevent UPDATE/DELETE) |
| `workflow_runs` | Workflow execution history | Yes (status updates) |
| `dedup` | Event deduplication cache | Yes (TTL-based cleanup) |
| `schema_snapshots` | Last-known Snowflake schema state | Yes (updated on drift check) |
| `run_history` | Historical DAG run times for SLA prediction | Yes (append + aggregate) |
| `confluence_pages` | Page ID cache for knowledge-scribe | Yes (updated on sync) |

SQLite is configured with WAL (Write-Ahead Logging) mode for concurrent read performance.

### Bus Directory (`bus/`)

Transient. Created fresh on startup. Contains only in-flight messages. Added to `.gitignore`. No persistent data.

---

## Module Reference

| Module | File | Purpose |
|---|---|---|
| Entry point | `src/index.ts` | Init vault → orchestrator → scheduler → listeners → dashboard |
| CLI | `src/cli.ts` | Command parser: start, verify, setup, audit, dashboard |
| Orchestrator | `src/orchestrator.ts` | Agent lifecycle, bus routing, policy check |
| Bus | `src/bus.ts` | FileTransport implementation, message creation |
| Policy | `src/policy.ts` | Tier enforcement (Tier 1: blocks all writes) |
| Audit | `src/audit.ts` | Append-only log, export to JSON/CSV |
| Vault | `src/vault.ts` | Credential resolution (env, file, hashicorp, aws) |
| Scheduler | `src/scheduler.ts` | Cron/interval triggers for workflows |
| Router | `src/router.ts` | Routes events to correct workflow |
| Database | `src/db.ts` | SQLite state (workflow runs, dedup, schema snapshots, incidents, retro reports) |
| Verify | `src/verify.ts` | Connection and permission checker |
| Docker | `src/docker.ts` | Agent container/process lifecycle management |
| Server | `src/server.ts` | Dashboard HTTP server, auth, SSE |
| API | `src/api.ts` | REST endpoints (incidents, retro, health, audit) |
| Retro Runner | `src/retro-runner.ts` | Autonomous 5-level retro analysis (5-whys) with per-level timeouts |
| Investigator | `src/investigator.ts` | Playbook-driven investigation per level (dynamic playbook selection) |
| Sub-Agents | `src/subagents.ts` | Parallel sub-agent fan-out for investigation questions |
| LLM | `src/llm.ts` | OpenAI integration for retro analysis and sufficiency checks |
| Slack | `src/slack-listener.ts` | Socket Mode listener for @duckpipe |
| Approval | `src/approval.ts` | Slack-based approval flow (reserved for future Tier 2) |

---

## Extension Points

### Adding a New Integration (Skill Model)

New integrations are contributed as skills in `.duck/skills/`:

1. Create `agents/<name>/` with AGENT.md, Dockerfile, tools.ts
2. Add `integrations/<name>.mcp.json` with tool definitions
3. Add config section to `DuckpipeConfigSchema` in `src/types.ts`
4. Wire the agent into the orchestrator
5. Add verifier in `src/verify.ts`
6. Add connection docs in `docs/CONNECTING-<NAME>.md`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full guide.

### Adding a New Workflow

1. Create `workflows/<name>.ts` implementing the `WorkflowResult` return type
2. Register in the scheduler with trigger schedule
3. Add config section in `duckpipe.yaml`
4. Add tests in `tests/workflows/<name>.test.ts`

### Custom Transport Backend

Implement the `Transport` interface in `src/types.ts`:

```typescript
interface Transport {
  send(agent: AgentName | "orchestrator", message: BusMessage): Promise<void>;
  subscribe(agent: AgentName | "orchestrator", handler: (msg: BusMessage) => void): void;
  shutdown(): Promise<void>;
}
```

The default `FileTransport` can be swapped for a message queue (Redis, RabbitMQ) for distributed deployments without changing orchestrator or workflow code.

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
