# Connecting DuckPipe to Airflow

Step-by-step guide to connect DuckPipe to your Apache Airflow instance.

## 1. Find the API Endpoint

DuckPipe uses the Airflow REST API. The base URL format is typically `https://<host>/api/v1` or just `https://<host>` if the API is at the root.

### Google Cloud Composer

- In the Cloud Console, open your Composer environment
- Note the "Airflow URI" (e.g. `https://xxxxx-dot-us-central1.composer.googleusercontent.com`)
- The REST API is enabled by default at the same host

### AWS MWAA (Managed Workflows for Apache Airflow)

- In the MWAA console, open your environment
- Note the "Airflow UI" URL (e.g. `https://xxxxx.vpce-xxx.us-east-1.airflow.amazonaws.com`)
- The REST API is at the same host; ensure the VPC endpoint allows access from where DuckPipe runs

### Astronomer

- In the Astronomer UI, open your deployment
- The Airflow URL is shown (e.g. `https://your-deployment.astronomer.run`)
- The REST API is at the same host

### Self-Hosted Airflow

- Use your Airflow host (e.g. `https://airflow.internal.company.com`)
- Ensure the REST API is enabled. In `airflow.cfg`, verify:
  - `[api] auth_backends` includes the auth method you use
  - The webserver is running and accessible

If the REST API is disabled, enable it in your Airflow configuration and restart the webserver.

## 2. Create the Viewer Role (Tier 1)

For read-only access, use the `Viewer` role. Airflow 2.x includes this role by default.

If you need a custom role with minimal permissions:

1. In Airflow UI: Admin -> Roles
2. Create a role (e.g. `duckpipe_viewer`) with permissions:
   - `can read on DAGs`
   - `can read on DAG Runs`
   - `can read on Task Instances`
   - `can read on Task Logs`

For Tier 2, you will need the `Op` role or equivalent (trigger DAG runs, clear tasks).

## 3. Generate an API Key or Use Username/Password

### Username and Password

Create a dedicated user for DuckPipe:

1. Admin -> Users -> Add user
2. Username: e.g. `duckpipe`
3. Role: `Viewer` (Tier 1) or `Op` (Tier 2)
4. Set a strong password

### API Key (Airflow 2.2+)

1. Log in as the DuckPipe user
2. Click your username (top right) -> Security -> API Keys
3. Create a new key
4. Store the key securely; it is shown only once

Note: DuckPipe's verify and integration currently use Basic auth (username:password). If using API keys, you may need to pass the key as the password with username, or check the integration implementation for API key support.

## 4. Test the Connection Manually

```bash
# Replace with your values
export AIRFLOW_URL="https://your-airflow.example.com"
export AIRFLOW_USER="duckpipe"
export AIRFLOW_PASS="your-password"

# Health check
curl -u "$AIRFLOW_USER:$AIRFLOW_PASS" "$AIRFLOW_URL/api/v1/health"

# List DAGs (limit 1)
curl -u "$AIRFLOW_USER:$AIRFLOW_PASS" "$AIRFLOW_URL/api/v1/dags?limit=1"
```

A successful response returns JSON. If you get 401 or 403, check credentials and role.

## 5. Add to .env

```bash
AIRFLOW_BASE_URL=https://your-airflow.example.com
AIRFLOW_USERNAME=duckpipe
AIRFLOW_PASSWORD=your-password
```

Or use `${VAR}` references if your secrets are in a vault:

```yaml
# duckpipe.yaml
integrations:
  airflow:
    enabled: true
    base_url: "${AIRFLOW_BASE_URL}"
    username: "${AIRFLOW_USERNAME}"
    password: "${AIRFLOW_PASSWORD}"
```

## 6. Run Verify

```bash
npx duckpipe verify
```

Or for Airflow only:

```bash
npx duckpipe verify --integration airflow
```

Expected output:

```
DuckPipe connection verify — checking your integrations...

Airflow connected (version 2.x.x)
  Permissions: GET /dags [ok]  GET /dagRuns [ok]  POST /dagRuns [no] (Tier 1 read-only)
  DAGs visible: N
```

## 7. Common Errors

### 401 Unauthorized

- Wrong username or password
- API key not configured correctly
- User does not exist or is disabled

### 403 Forbidden

- User role lacks required permissions
- For Tier 1, ensure Viewer role. For Tier 2, ensure Op role

### Connection refused / ECONNREFUSED

- Airflow host unreachable from DuckPipe's network
- Wrong port (default 443 for HTTPS, 80 for HTTP)
- Firewall or security group blocking the connection

### SSL certificate errors

- Self-signed certificate: set `verify_ssl: false` in `duckpipe.yaml` for the Airflow integration (only for internal/development)
- For production, use a valid certificate or add the CA to your trust store

### CORS errors

- Usually from browser; DuckPipe uses server-side fetch. If you see CORS in logs, the issue may be a redirect or wrong URL

### Empty DAG list

- User has no access to any DAGs
- Check role permissions and DAG-level access if applicable
