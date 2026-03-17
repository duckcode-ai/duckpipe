# Contributing to DuckPipe

This document explains how to contribute to DuckPipe: the skills model, adding integrations, code style, and the PR process.

## Skills Model

New integrations (Databricks, Great Expectations, BigQuery, etc.) are contributed as skills, not as PRs to core. Core stays small and auditable.

### Skill Location

Skills live in `.duck/skills/<skill-name>/`. Each skill has a `SKILL.md` file that describes:

1. What the skill adds
2. Step-by-step implementation instructions
3. Required permissions for each trust tier
4. Config schema additions
5. How to wire the agent into the orchestrator and verify command

### Example Skills

- `.duck/skills/add-databricks/SKILL.md`
- `.duck/skills/add-great-expectations/SKILL.md`
- `.duck/skills/add-bigquery/SKILL.md`

To add a new integration, create a new skill directory and follow the pattern of existing skills. The skill file is the contract; implementers (including maintainers) follow it when integrating.

### Skill Structure

A typical skill instructs you to:

1. Create `agents/<name>/` with AGENT.md, Dockerfile, tools.ts
2. Add `integrations/<name>.mcp.json` with tool definitions
3. Add config section to `duckpipe.yaml` schema
4. Wire the agent into the orchestrator
5. Add the integration to the `verify` command

## Adding a New Integration

If you are contributing a new integration (e.g. via a skill or direct PR):

1. **Agent**: Create `agents/<name>/` with AGENT.md (system prompt), Dockerfile, tools.ts (typed MCP tool wrappers)
2. **MCP config**: Add `integrations/<name>.mcp.json` defining the tools the agent can call
3. **Config**: Extend `DuckpipeConfigSchema` in `src/types.ts` and `config-examples/duckpipe.example.yaml`
4. **Orchestrator**: Add the agent to the `AGENTS` array in `src/bus.ts` and ensure workflows can dispatch to it
5. **Verify**: Add a verifier in `src/verify.ts` and register it in `verifySingle`
6. **Documentation**: Add `docs/CONNECTING-<NAME>.md` with step-by-step connection instructions

## Code Style

### TypeScript

- Use TypeScript strict mode
- Prefer explicit types for function parameters and return values
- No `any`; use `unknown` and narrow with type guards when needed
- Use `async/await` over raw Promises
- Prefer `const` and avoid mutable globals

### Formatting

- 2-space indentation
- Double quotes for strings
- Trailing commas in multiline objects and arrays
- Run `npx tsc --noEmit` before submitting; the project has no separate formatter config

### Naming

- `camelCase` for variables and functions
- `PascalCase` for types, interfaces, classes
- `UPPER_SNAKE_CASE` for constants
- File names: `kebab-case.ts` for source, `kebab-case.test.ts` for tests

## Testing

- Use Vitest exclusively
- Tests live in `tests/`
- Every workflow test must:
  - Use a mock transport (never call real APIs)
  - Verify audit log receives an entry for every agent action
  - Verify policy engine is consulted before write actions
  - Run in under 10 seconds
- Required test files: `audit.test.ts`, `vault.test.ts`, `policy.test.ts`, `verify.test.ts`, and workflow tests in `tests/workflows/`
- Run tests: `npm test` or `npx vitest run`

## PR Process

1. **Branch**: Create a feature branch. Never open a PR that merges to `main` or `master` directly.
2. **Scope**: One logical change per PR. Keep diffs reviewable.
3. **Tests**: Add or update tests for new behavior. Ensure `npm test` passes.
4. **Docs**: Update documentation for new features or config changes.
5. **Description**: Explain what changed and why. Link any related issues.

### What Not to Do

- Do not modify `security/audit-schema.sql`'s immutability triggers
- Do not add configuration that makes Tier 1 capable of write actions
- Do not add dependencies that have not been updated in the last 6 months
- Do not add features that require outbound connections to duckpipe.dev or Duckcode-controlled servers

## Running Locally

```bash
git clone https://github.com/duckcodeai/duckpipe
cd duckpipe
npm install
cp config-examples/.env.example .env
cp config-examples/duckpipe.example.yaml duckpipe.yaml
# Edit .env and duckpipe.yaml
npx duckpipe verify
npx duckpipe start
```

For development with hot reload:

```bash
npm run dev start
```

## Questions

Open an issue for questions about architecture, design, or contribution process.
