# DuckPipe Security

This document describes DuckPipe's security model for senior data engineers evaluating the platform for production use.

## Design Principles

### Credentials Never Touch Disk

Credentials flow: `.env` or secrets backend -> vault module (memory only) -> agent container (memory only) -> HTTPS to the target API. They are never written to disk, never appear in logs, and never leave your machine or VPC.

The vault module implements a read-only interface. There is no `set()` or `delete()` method. DuckPipe never writes secrets anywhere.

### Agent Container Isolation

Each agent (airflow, dbt, snowflake, comms) runs in its own Docker container. Containers cannot reach each other over the network. They communicate only through filesystem IPC managed by the orchestrator. A compromised dbt agent cannot access Snowflake credentials because it never receives them; only the Snowflake agent does.

### Audit Before Action

Every agent action is written to the immutable audit log **before** it executes. If the audit write fails, the action does not run. The audit log cannot be updated or deleted; it is append-only, enforced at the SQLite trigger level.

### Three Trust Tiers

Users start with Tier 1 (read-only). Tier 2 adds supervised writes with Slack approval. Tier 3 allows pre-approved autonomous actions defined in `policy.yaml`. The tier is set in `duckpipe.yaml`, not hardcoded. See `docs/TRUST-TIERS.md` for details.

### No Cloud Relay

DuckPipe runs entirely inside your network. No telemetry, no callbacks to duckpipe.dev, no SaaS relay. All API calls go directly from your infrastructure to Airflow, Snowflake, dbt Cloud, Slack, Jira, and Confluence.

### No Telemetry

DuckPipe does not send usage data, error reports, or analytics to any external service.

---

## Vault Backends

Secrets are resolved via the vault module. Four backends are supported, selected by `secrets.backend` in `duckpipe.yaml`.

### env (Development Default)

Reads from `process.env`. Values are loaded when the process starts; the vault never writes them anywhere.

**Warning:** When using `trust_tier: 2` or higher with the env backend, DuckPipe prints a warning. For production with write capabilities, use a dedicated secrets backend.

### file (age encryption)

Uses [age](https://age-encryption.org) for encryption. The encrypted file (`secrets.age`) can be committed to git; it is safe because it is encrypted. The age private key is kept outside the repo (e.g. `~/.config/duckpipe/age.key`).

On startup, the vault decrypts the file into memory. Plaintext is never written to disk. The vault caches decrypted values in memory for the process lifetime.

Configuration:
```yaml
secrets:
  backend: "file"
  age_key_file: "~/.config/duckpipe/age.key"
  encrypted_secrets_file: "./secrets.age"
```

Note: The file backend implementation may be in progress. Check the codebase for current status.

### hashicorp-vault

Connects to HashiCorp Vault KV v2 via the HTTP API. Uses a Vault token or AppRole for authentication. The vault renews the lease automatically before expiry.

Configuration:
```yaml
secrets:
  backend: "hashicorp-vault"
  vault_addr: "https://vault.internal:8200"
  vault_token: "${VAULT_TOKEN}"
  vault_path: "secret/data/duckpipe"
```

Note: The HashiCorp backend implementation may be in progress. Check the codebase for current status.

### aws-secrets-manager

Uses the AWS SDK with instance role or explicit credentials. Caches secrets in memory with a configurable TTL and refreshes automatically.

Note: The AWS backend implementation may be in progress. Check the codebase for current status.

---

## Audit Log Immutability

The audit log is stored in SQLite (`data/audit.db`). The schema is defined in `security/audit-schema.sql`.

### Triggers

Two triggers enforce immutability:

```sql
CREATE TRIGGER prevent_audit_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no updates permitted'); END;

CREATE TRIGGER prevent_audit_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no deletes permitted'); END;
```

Any attempt to UPDATE or DELETE rows in `audit_log` raises an error and aborts the transaction. The database engine enforces this; application code cannot bypass it.

### Pre-Execution Logging

The orchestrator calls `logAction()` before dispatching any agent task. The audit entry records workflow, agent, tool, tier, input payload, and whether it is a write action. If `logAction()` fails (e.g. disk full), the action is not executed.

### Post-Execution Results

Execution results (output, duration, success, error) are stored in a companion table `audit_results`, which references `audit_log` by ID. This keeps the original pre-execution record immutable while allowing result capture. The `audit_log` row itself is never updated.

---

## Hard Rules

DuckPipe enforces these rules in code and design:

- Never log any value fetched from the vault, even at debug level
- Never write a secret to disk, even temporarily
- Never allow an agent to call any URL not declared in its MCP server config
- Never skip the audit log write; if it fails, the action must not execute
- Never implement features that require outbound connections to duckpipe.dev or any Duckcode-controlled server
- Never add a configuration option that makes Tier 1 capable of write actions
