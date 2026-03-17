# DuckPipe Architecture

This document describes the DuckPipe architecture for engineers integrating or extending the platform.

## Overview

DuckPipe is an orchestrator that runs specialized AI agents in isolated containers. The orchestrator coordinates workflows, routes events, enforces policy, and manages the message bus. Agents never talk to each other directly; all communication flows through the orchestrator.

## Orchestrator Pattern

The orchestrator (`src/orchestrator.ts`) is the central process. It:

1. Subscribes to the bus for messages from agents
2. Dispatches tasks to agents via the bus
3. Checks policy before every write action
4. Logs every action to the audit system before execution
5. Manages workflow lifecycle (start, complete, fail)
6. Handles deduplication to avoid duplicate workflow runs

The orchestrator does not run inside a container. It runs as the main process and spawns/manages agent containers. It holds the vault reference and config; agents receive only the credentials they need via the bus payload (in memory, never persisted).

## Filesystem IPC Bus

DuckPipe uses filesystem-based inter-process communication. No Redis, RabbitMQ, or Kafka.

### Directory Layout

```
bus/
  orchestrator/          <- agents write results here (orchestrator reads)
  agents/
    airflow/in/          <- orchestrator writes tasks here
    airflow/out/          <- airflow agent writes results here
    dbt/in/
    dbt/out/
    snowflake/in/
    snowflake/out/
    comms/in/
    comms/out/
```

### Message Flow

1. Orchestrator creates a `BusMessage` (JSON) and writes it to `bus/agents/<agent>/in/<timestamp>-<uuid>.json`
2. Agent polls its `in/` directory every 200ms, reads the file, processes it, deletes the file
3. Agent writes the response to `bus/agents/<agent>/out/<timestamp>-<uuid>.json`
4. Orchestrator watches all `out/` directories via chokidar, reads the file, processes it, deletes the file
5. Orchestrator routes the response to the correct workflow handler via `_requestId` or `_replyTo` in the payload

Messages are JSON files. Files are deleted after processing. The bus directory is transient; add `bus/` to `.gitignore`.

## Agent Containers

Each agent runs in its own Docker container (or process, configurable). Agents:

- Receive tasks via their `in/` directory
- Execute MCP tools (Airflow API, Snowflake, dbt Cloud, Slack, etc.)
- Write results to their `out/` directory
- Cannot reach other agents over the network
- Receive only the credentials they need (passed in the task payload, never stored)

Agent images are minimal (e.g. `node:20-slim`). No extra network access beyond what the MCP tools require.

## Policy Engine

The policy engine (`src/policy.ts`) is consulted before every write action. It:

- Blocks all writes when `trust_tier: 1`
- Requires Slack approval for writes when `trust_tier: 2` (or Tier 3 with no matching rule)
- Allows immediate execution when `trust_tier: 3` and the action matches a rule in `policy.yaml`

Policy is loaded at startup and cached. Changes require a restart. See `docs/TRUST-TIERS.md`.

## Scheduler

The scheduler (`src/scheduler.ts`) triggers workflows on a cron or interval basis. It uses the `croner` library. Workflows like incident-autopilot poll every N seconds; knowledge-scribe runs nightly at 2am.

The scheduler invokes workflow handlers registered by the main process. It does not dispatch directly to agents; the workflow logic does that via the orchestrator.

## Data Flow Diagram

```
                    +------------------+
                    |   Scheduler      |
                    |   (cron/interval)|
                    +--------+---------+
                             |
                             v
+----------+    events     +------------------+    tasks     +----------------+
| Webhooks |-------------->|   Orchestrator   |------------->| Agent (airflow)|
| (future) |               |                  |             |   in/  out/     |
+----------+               |  - policy check   |<-------------+----------------+
                           |  - audit log     |    results
                           |  - dedup        |             +----------------+
                           |  - routing      |------------->| Agent (dbt)    |
                           +--------+--------+             |   in/  out/     |
                                    |                     +----------------+
                                    |                     +----------------+
                                    +--------------------->| Agent (snowflake)|
                                                          |   in/  out/     |
                                                          +----------------+
                                                          +----------------+
                                    +--------------------->| Agent (comms)  |
                                    |                     |   in/  out/     |
                                    |                     +----------------+
                                    |
                                    v
                           +------------------+
                           |  Audit Log       |
                           |  (SQLite)        |
                           +------------------+
```

## Transport Interface Abstraction

The bus is implemented as a `Transport` interface (`src/types.ts`):

```typescript
interface Transport {
  send(agent: AgentName | "orchestrator", message: BusMessage): Promise<void>;
  subscribe(
    agent: AgentName | "orchestrator",
    handler: (msg: BusMessage) => void
  ): void;
  shutdown(): Promise<void>;
}
```

The default implementation is `FileTransport` in `src/bus.ts`, which uses the filesystem layout described above. The abstraction allows swapping to a different transport (e.g. in-memory for tests, or a message queue for distributed deployment) without changing the orchestrator or workflows.

Tests use `MockTransport` (`tests/mocks/mock-transport.ts`) to avoid filesystem I/O.

## Key Modules

| Module    | Purpose                                              |
|-----------|------------------------------------------------------|
| `index.ts`| Entry point: init vault, load config, start orchestrator and scheduler |
| `orchestrator.ts` | Agent lifecycle, bus routing, policy check, audit |
| `bus.ts`  | FileTransport implementation, message creation       |
| `policy.ts` | Tier enforcement, policy.yaml parsing, rule matching |
| `audit.ts`| Append-only audit log, export to JSON/CSV             |
| `vault.ts`| Credential resolution (env, file, hashicorp, aws)    |
| `scheduler.ts` | Cron/interval triggers for workflows              |
| `router.ts` | Routes incoming events to correct workflow          |
| `db.ts`   | SQLite state (workflow runs, dedup, schema snapshots)  |
| `verify.ts` | Connection and permission checker for integrations |
