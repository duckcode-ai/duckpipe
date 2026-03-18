# Connecting DuckPipe to Apache Airflow

Step-by-step guide to connect DuckPipe to your Apache Airflow instance. Covers managed services (Cloud Composer, MWAA, Astronomer) and self-hosted deployments.

---

## Prerequisites

- DuckPipe installed (`npm install` completed)
- Network access from DuckPipe host to your Airflow REST API endpoint
- An Airflow user account with Viewer role (read-only)

---

## 1. Find Your API Endpoint

DuckPipe connects to the Airflow REST API (v1). The base URL depends on your deployment platform.

### Google Cloud Composer

1. Open the Cloud Console → Composer → Environments
2. Note the **Airflow webserver URL** (e.g. `https://xxxxx-dot-us-central1.composer.googleusercontent.com`)
3. The REST API is enabled by default at the same host
4. Authentication: Use a service account with the `Composer User` IAM role, or configure the Airflow `basic_auth` backend

### AWS MWAA (Managed Workflows for Apache Airflow)

1. Open the MWAA Console → Environments
2. Note the **Airflow UI URL** (e.g. `https://xxxxx.vpce-xxx.us-east-1.airflow.amazonaws.com`)
3. The REST API is at the same host
4. Ensure the VPC endpoint allows access from where DuckPipe runs
5. Authentication: MWAA uses AWS IAM for API access. Generate a web login token using the AWS CLI:

```bash
aws mwaa create-web-login-token --name your-environment-name
```

### Astronomer (Astro)

1. Open the Astronomer Cloud UI → Deployments
2. Note the deployment URL (e.g. `https://your-deployment.astronomer.run`)
3. The REST API is at the same host
4. Authentication: Create an API key in the Astronomer UI or use Deployment API keys

### Self-Hosted Airflow

1. Use your Airflow webserver URL (e.g. `https://airflow.internal.company.com`)
2. Ensure the REST API is enabled in `airflow.cfg`:

```ini
[api]
auth_backends = airflow.api.auth.backend.basic_auth
```

3. Restart the webserver after configuration changes
4. If behind a reverse proxy, ensure the proxy forwards to the correct port (default: 8080)

---

## 2. Create the DuckPipe User and Role

### Tier 1 (Read-Only) — Viewer Role

For read-only monitoring, the built-in `Viewer` role is sufficient. Create a dedicated service user:

1. In the Airflow UI: **Admin → Users → + Add**
2. Username: `duckpipe`
3. Role: `Viewer`
4. Set a strong, unique password
5. Save

If you need a custom role with minimum permissions:

1. **Admin → Roles → + Add**
2. Name: `duckpipe_viewer`
3. Add permissions:
   - `can read on DAGs`
   - `can read on DAG Runs`
   - `can read on Task Instances`
   - `can read on Task Logs`
4. Assign this role to the `duckpipe` user

---

## 3. Generate Credentials

### Option A: Username and Password (Basic Auth)

Use the username and password created in Step 2. This is the simplest method and works with all Airflow deployments.

### Option B: API Key (Airflow 2.2+)

1. Log in as the `duckpipe` user
2. Click your username (top right) → **Security → API Keys**
3. Create a new key
4. Copy the key immediately — it is shown only once
5. Use the API key as the password with the username for Basic Auth

---

## 4. Test the Connection Manually

Before configuring DuckPipe, verify the connection works:

```bash
export AIRFLOW_URL="https://your-airflow.example.com"
export AIRFLOW_USER="duckpipe"
export AIRFLOW_PASS="your-password-or-api-key"

# Health check
curl -s -u "$AIRFLOW_USER:$AIRFLOW_PASS" "$AIRFLOW_URL/api/v1/health" | python3 -m json.tool

# List DAGs (limit 3)
curl -s -u "$AIRFLOW_USER:$AIRFLOW_PASS" "$AIRFLOW_URL/api/v1/dags?limit=3" | python3 -m json.tool
```

**Expected**: JSON response with DAG list. If you get 401 or 403, check credentials and role.

---

## 5. Configure DuckPipe

### Environment Variables (`.env`)

```bash
AIRFLOW_BASE_URL=https://your-airflow.example.com
AIRFLOW_USERNAME=duckpipe
AIRFLOW_PASSWORD=your-password-or-api-key
```

### Configuration (`duckpipe.yaml`)

```yaml
integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"
    username: "${AIRFLOW_USERNAME}"
    password: "${AIRFLOW_PASSWORD}"
    allowed_dags: []               # empty = all DAGs; list specific DAG IDs to scope access
    verify_ssl: true               # set false only for self-signed certs in development
```

### Production Recommendations

- Store credentials in HashiCorp Vault or AWS Secrets Manager instead of `.env`
- Use API keys instead of passwords when available
- Set `allowed_dags` to scope access to only the DAGs DuckPipe should monitor
- Keep `verify_ssl: true` in production — add your CA cert to the trust store if needed

---

## 6. Run Verify

```bash
npx duckpipe verify
```

Or verify only the Airflow integration:

```bash
npx duckpipe verify --integration airflow
```

### Expected Output (Tier 1)

```
DuckPipe connection verify — checking your integrations...

✓ Airflow connected (version 2.8.1)
  Permissions: GET /dags ✓  GET /dagRuns ✓  POST /dagRuns ✗ (Tier 1 read-only)
  DAGs visible: 47
```

---

## 7. Troubleshooting

### 401 Unauthorized

- Wrong username or password
- API key not configured correctly or expired
- User account is disabled in Airflow
- **Fix**: Verify credentials with the `curl` test in Step 4

### 403 Forbidden

- User role lacks required permissions
- For Tier 1: ensure `Viewer` role
- For Tier 2: ensure `Op` role
- **Fix**: Check Admin → Users → (user) → Roles in Airflow UI

### Connection Refused / ECONNREFUSED

- Airflow host unreachable from DuckPipe's network
- Wrong port (default: 443 for HTTPS, 8080 for local Airflow)
- Firewall, security group, or VPC configuration blocking the connection
- **Fix**: Test with `curl` or `telnet <host> <port>` from the DuckPipe host

### SSL Certificate Errors

- Self-signed certificate in development
- **Fix**: Set `verify_ssl: false` for development only. For production, add your CA certificate to the Node.js trust store:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/your/ca-cert.pem
```

### Empty DAG List

- User has no DAG-level access
- DAGs are paused and filtered (check your Airflow configuration)
- **Fix**: Log into Airflow UI as the DuckPipe user and verify DAGs are visible

### Timeout on Large Installations

- If you have 500+ DAGs, the initial verify may take longer
- Airflow API pagination limits may apply
- **Fix**: This is normal for large installations. DuckPipe handles pagination automatically.

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
