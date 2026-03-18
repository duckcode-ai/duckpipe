# DuckPipe Installation Guide

Complete installation and deployment guide for DuckPipe. Covers local development, Docker Compose, and Kubernetes production deployments.

---

## System Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | 20.0.0 | 20 LTS (latest) |
| Docker | 20.10+ | 24+ |
| Memory | 512 MB | 2 GB |
| Disk | 100 MB (plus audit log growth) | 1 GB |
| OS | macOS, Linux, Windows (WSL2) | Linux (production) |

---

## Quick Install

```bash
git clone https://github.com/duckcode-ai/duckpipe
cd duckpipe
npm install
cp config-examples/.env.example .env
cp config-examples/duckpipe.example.yaml duckpipe.yaml
```

Edit `.env` with your API credentials, then:

```bash
npx duckpipe verify    # test all connections
npx duckpipe start     # start DuckPipe
```

---

## Step-by-Step Installation

### 1. Clone the Repository

```bash
git clone https://github.com/duckcode-ai/duckpipe
cd duckpipe
```

### 2. Install Dependencies

```bash
npm install
```

This installs 6 runtime dependencies and development tooling. The `better-sqlite3` package requires a C++ compiler (included in Xcode CLI tools on macOS, `build-essential` on Ubuntu).

If `better-sqlite3` fails to build:

```bash
# macOS
xcode-select --install

# Ubuntu / Debian
sudo apt-get install -y build-essential python3

# Alpine
apk add --no-cache build-base python3
```

### 3. Configure Environment Variables

```bash
cp config-examples/.env.example .env
```

Edit `.env` with your credentials. Required variables depend on which integrations you enable:

| Variable | Required For | Example |
|---|---|---|
| `AIRFLOW_BASE_URL` | Airflow monitoring | `https://airflow.company.com` |
| `AIRFLOW_USERNAME` | Airflow monitoring | `duckpipe` |
| `AIRFLOW_PASSWORD` | Airflow monitoring | `(strong password)` |
| `SNOWFLAKE_ACCOUNT` | Snowflake monitoring | `myorg.us-east-1` |
| `SNOWFLAKE_USER` | Snowflake monitoring | `DUCKPIPE_SVC` |
| `SNOWFLAKE_PASSWORD` | Snowflake (password auth) | `(strong password)` |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | Snowflake (key-pair auth) | `/path/to/rsa_key.p8` |
| `SNOWFLAKE_WAREHOUSE` | Snowflake monitoring | `COMPUTE_WH` |
| `SNOWFLAKE_DATABASE` | Snowflake monitoring | `ANALYTICS` |
| `SLACK_BOT_TOKEN` | Slack alerts | `xoxb-...` |
| `SLACK_APP_TOKEN` | Slack Socket Mode listener | `xapp-...` |
| `DBT_API_TOKEN` | dbt Cloud monitoring | `dbtc_...` |
| `DBT_ACCOUNT_ID` | dbt Cloud monitoring | `12345` |
| `DBT_PROJECT_ID` | dbt Cloud monitoring | `67890` |

Optional variables:

| Variable | Required For | Example |
|---|---|---|
| `JIRA_BASE_URL` | Jira ticket creation | `https://company.atlassian.net` |
| `JIRA_EMAIL` | Jira ticket creation | `duckpipe@company.com` |
| `JIRA_API_TOKEN` | Jira ticket creation | `(API token)` |
| `CONFLUENCE_BASE_URL` | Confluence docs | `https://company.atlassian.net/wiki` |
| `CONFLUENCE_EMAIL` | Confluence docs | `duckpipe@company.com` |
| `CONFLUENCE_API_TOKEN` | Confluence docs | `(API token)` |
| `DUCKPIPE_DASHBOARD_TOKEN` | Remote dashboard access | `(strong random string)` |
| `VAULT_ADDR` | HashiCorp Vault | `https://vault.internal:8200` |
| `VAULT_TOKEN` | HashiCorp Vault | `hvs.xxx` |

### 4. Configure DuckPipe

```bash
cp config-examples/duckpipe.example.yaml duckpipe.yaml
```

Key settings to review:

```yaml
duckpipe:
  team_name: "my-data-team"
  trust_tier: 1                    # read-only (the only supported tier)

secrets:
  backend: "env"                   # use "hashicorp-vault" for production

agents:
  runtime: "process"               # or "docker" / "podman"
  timeout_seconds: 120

integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"
    username: "${AIRFLOW_USERNAME}"
    password: "${AIRFLOW_PASSWORD}"
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    password: "${SNOWFLAKE_PASSWORD}"
    role: "DUCKPIPE_READER"
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
  slack:
    enabled: true
    bot_token: "${SLACK_BOT_TOKEN}"
    allowed_channels:
      - "#data-incidents"
      - "#data-engineering"

llm:
  provider: "openai"
  model: "gpt-4o-mini"
  api_key: "${OPENAI_API_KEY}"

workflows:
  incident_autopilot:
    enabled: true
    poll_interval_seconds: 120
```

### 5. Verify Connections

```bash
npx duckpipe verify
```

This connects to each enabled integration, tests permissions, and reports what DuckPipe can and cannot do. Fix any failures before proceeding.

### 6. Start DuckPipe

```bash
npx duckpipe start
```

Dashboard available at `http://localhost:9876`.

---

## Docker Compose Deployment

For a containerized deployment with all components:

```bash
cp config-examples/.env.example .env
# Edit .env with your credentials

docker compose -f config-examples/docker-compose.yaml up -d
```

### Volumes

| Volume | Purpose |
|---|---|
| `./data/` | SQLite database (audit log, state) |
| `./bus/` | Filesystem IPC (transient) |
| `./duckpipe.yaml` | Configuration |
| `./.env` | Credentials |

### Stopping

```bash
docker compose -f config-examples/docker-compose.yaml down
```

---

## Kubernetes Deployment

Production manifests are in `config-examples/k8s/`.

### 1. Create Namespace

```bash
kubectl apply -f config-examples/k8s/namespace.yaml
```

### 2. Create Secrets

Edit `config-examples/k8s/secret.yaml` with your base64-encoded credentials:

```bash
echo -n "your-value" | base64
```

```bash
kubectl apply -f config-examples/k8s/secret.yaml
```

For production, use an external secrets operator (e.g., External Secrets Operator with HashiCorp Vault or AWS Secrets Manager).

### 3. Deploy

```bash
kubectl apply -f config-examples/k8s/rbac.yaml
kubectl apply -f config-examples/k8s/deployment.yaml
```

### 4. Verify

```bash
kubectl -n duckpipe get pods
kubectl -n duckpipe logs deployment/duckpipe-orchestrator
```

### Health Probes

The deployment manifest includes:

- **Liveness**: `GET /api/health/live` — returns 200 if the process is running
- **Readiness**: `GET /api/health/ready` — returns 200 if all configured integrations are connected

### Persistent Storage

The audit log and state database require persistent storage:

```yaml
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: duckpipe-data
```

Ensure the PVC is backed by a storage class that supports ReadWriteOnce access.

---

## Production Checklist

Before deploying to production:

- [ ] Use key-pair authentication for Snowflake (not password)
- [ ] Use a service token for dbt Cloud (not personal token)
- [ ] Use HashiCorp Vault or AWS Secrets Manager for credentials (not `.env`)
- [ ] Set `DUCKPIPE_DASHBOARD_TOKEN` if the dashboard will be accessible remotely
- [ ] Deploy behind a reverse proxy (nginx, traefik) with TLS termination
- [ ] Confirm `trust_tier: 1` (read-only — the only supported tier)
- [ ] Run `npx duckpipe verify` and review all permissions
- [ ] Configure `allowed_dags` and `watched_databases` to scope access
- [ ] Set up audit log exports to your SIEM
- [ ] Review `docs/SECURITY.md` and `docs/SLC-REVIEW.md` with your security team

---

## Upgrading

```bash
cd duckpipe
git pull origin main
npm install
npx tsc                  # rebuild TypeScript
npx duckpipe verify      # verify connections still work
npx duckpipe start       # restart with new version
```

For Docker deployments:

```bash
docker compose -f config-examples/docker-compose.yaml pull
docker compose -f config-examples/docker-compose.yaml up -d
```

The audit log schema is forward-compatible. Existing audit data is preserved across upgrades.

---

## Uninstalling

```bash
# Stop DuckPipe
npx duckpipe stop        # or Ctrl+C if running in foreground

# Remove data (optional — preserves audit log if you skip this)
rm -rf data/ bus/

# Remove the project
cd ..
rm -rf duckpipe
```

For Kubernetes:

```bash
kubectl delete namespace duckpipe
```

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
