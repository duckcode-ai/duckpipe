# Contributing to DuckPipe

Thank you for your interest in contributing to DuckPipe. This guide covers the skills model, code style, testing requirements, and PR process.

---

## How DuckPipe Grows: Skills, Not Core PRs

New integrations (Databricks, Great Expectations, BigQuery, etc.) are contributed as **skills**, not as PRs to core. Core stays small and auditable — readable in 30 minutes.

### What is a Skill?

A skill is a self-contained directory in `.duck/skills/<skill-name>/` with a `SKILL.md` file that describes:

1. What the skill adds
2. Step-by-step implementation instructions
3. Required permissions for each trust tier
4. Config schema additions
5. How to wire the agent into the orchestrator and verify command

### Example Skills

- `.duck/skills/add-databricks/SKILL.md`
- `.duck/skills/add-great-expectations/SKILL.md`
- `.duck/skills/add-bigquery/SKILL.md`

To add a new integration, create a new skill directory and follow the pattern of existing skills. The skill file is the contract; implementers follow it when integrating.

---

## Adding a New Integration

Whether via a skill or direct PR:

1. **Agent**: Create `agents/<name>/` with AGENT.md (system prompt), Dockerfile, tools.ts (typed tool wrappers)
2. **MCP config**: Add `integrations/<name>.mcp.json` defining available tools
3. **Config**: Extend `DuckpipeConfigSchema` in `src/types.ts` and `config-examples/duckpipe.example.yaml`
4. **Orchestrator**: Add the agent to `AGENTS` in `src/bus.ts` and ensure workflows can dispatch to it
5. **Verify**: Add a verifier in `src/verify.ts` and register it in `verifySingle`
6. **Documentation**: Add `docs/CONNECTING-<NAME>.md` with step-by-step connection instructions

---

## Development Setup

```bash
git clone https://github.com/duckcode-ai/duckpipe
cd duckpipe
npm install
cp config-examples/.env.example .env
cp config-examples/duckpipe.example.yaml duckpipe.yaml
# Edit .env and duckpipe.yaml with your credentials
npx duckpipe verify
npx duckpipe start
```

For development with hot reload:

```bash
npm run dev start
```

### Prerequisites

- Node.js >= 20.0.0
- Docker (or Podman) for agent container isolation
- SQLite3 (bundled via better-sqlite3)

---

## Code Style

### TypeScript

- Strict mode enabled
- Explicit types for function parameters and return values
- No `any`; use `unknown` and narrow with type guards
- `async/await` over raw Promises
- `const` preferred; avoid mutable globals

### Formatting

- 2-space indentation
- Double quotes for strings
- Trailing commas in multiline objects and arrays
- Run `npx tsc --noEmit` before submitting

### Naming

- `camelCase` for variables and functions
- `PascalCase` for types, interfaces, classes
- `UPPER_SNAKE_CASE` for constants
- `kebab-case.ts` for source files, `kebab-case.test.ts` for tests

---

## Testing

- **Framework**: Vitest exclusively
- **Location**: `tests/`
- **Run**: `npm test` or `npx vitest run`
- **Watch**: `npx vitest` (watch mode)

### Requirements for Workflow Tests

- Use mock transport (`tests/mocks/mock-transport.ts`) — never call real APIs
- Verify audit log receives an entry for every agent action
- Verify policy engine is consulted before write actions
- Verify Tier 1 config cannot trigger any write action
- Run in under 10 seconds

### Test Coverage Areas

| Area | Test Files |
|---|---|
| Audit system | `tests/audit.test.ts` |
| Vault backends | `tests/vault.test.ts` |
| Policy engine | `tests/policy.test.ts` |
| Verify command | `tests/verify.test.ts` |
| Agent runtime | `tests/agent-runtime.test.ts` |
| Docker manager | `tests/docker.test.ts` |
| SQL injection prevention | `tests/snowflake-injection.test.ts` |
| Approval flow | `tests/approval.test.ts` |
| Orchestrator + approval | `tests/orchestrator-approval.test.ts` |
| Slack listener | `tests/slack-listener.test.ts` |
| Server auth | `tests/server-auth.test.ts` |
| Incident Autopilot | `tests/workflows/incident-autopilot.test.ts` |
| Cost Sentinel | `tests/workflows/cost-sentinel.test.ts` |
| Query Sage | `tests/workflows/query-sage.test.ts` |
| Pipeline Whisperer | `tests/workflows/pipeline-whisperer.test.ts` |
| SLA Guardian | `tests/workflows/sla-guardian.test.ts` |
| Knowledge Scribe | `tests/workflows/knowledge-scribe.test.ts` |
| End-to-end integration | `tests/integration/end-to-end.test.ts` |

---

## PR Process

1. **Branch**: Create a feature branch from `main`. Never open a PR targeting `main` directly from a fork's main branch.
2. **Scope**: One logical change per PR. Keep diffs reviewable.
3. **Tests**: Add or update tests for new behavior. Ensure `npm test` passes with zero failures.
4. **TypeScript**: Run `npx tsc --noEmit` — zero errors required.
5. **Docs**: Update documentation for new features or config changes.
6. **Description**: Explain what changed and why. Link related issues.

### What Not to Do

- Do not modify `security/audit-schema.sql`'s immutability triggers
- Do not add configuration that makes Tier 1 capable of write actions
- Do not add dependencies that have not been updated in the last 6 months
- Do not add features that require outbound connections to duckpipe.dev or Duckcode-controlled servers
- Do not add telemetry, analytics, or usage tracking of any kind

---

## Reporting Security Issues

For security vulnerabilities, please follow responsible disclosure:

1. Do **not** open a public GitHub issue
2. Email security@duckcode.ai with a description of the vulnerability
3. Include steps to reproduce if possible
4. We will respond within 48 hours and coordinate a fix

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

---

## License

By contributing to DuckPipe, you agree that your contributions will be licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the full text.

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
