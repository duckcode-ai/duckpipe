# Connecting DuckPipe to dbt Cloud

Step-by-step guide to connect DuckPipe to dbt Cloud. Covers API token creation, account/project identification, and GitHub integration for Pipeline Whisperer.

---

## Prerequisites

- DuckPipe installed (`npm install` completed)
- A dbt Cloud account with at least one project
- Network access from DuckPipe host to `https://cloud.getdbt.com` (or your self-hosted dbt Cloud instance)

---

## 1. Generate an API Token

### Service Token (Recommended for Production)

1. Log in to [dbt Cloud](https://cloud.getdbt.com)
2. Navigate to **Account Settings → Service Tokens**
3. Click **+ New Token**
4. Name: `DuckPipe Service Token`
5. Select permission sets:

| Required Permissions |
|---|
| `Job Admin` (read access to jobs and runs), `Member` (read access to projects) |

These are read-only scopes. DuckPipe does not trigger dbt runs via the API.

6. Click **Save**
7. Copy the token immediately — it is shown only once

### Personal Token (Development Only)

1. Click your profile icon → **Account Settings → API Access**
2. Copy your personal API token
3. This token has the same permissions as your user account — use service tokens for production

---

## 2. Find Account and Project IDs

### Account ID

The account ID appears in your dbt Cloud URL:

```
https://cloud.getdbt.com/#/accounts/12345/...
                                    ^^^^^
                                    Account ID
```

Or navigate to **Account Settings → Overview**.

### Project ID

Open your project in dbt Cloud. The project ID appears in the URL:

```
https://cloud.getdbt.com/#/accounts/12345/projects/67890/...
                                                   ^^^^^
                                                   Project ID
```

Or navigate to **Project Settings**.

### Multiple Projects

If you have multiple dbt projects, configure the primary project in `duckpipe.yaml`. DuckPipe monitors one project per configuration. For multiple projects, run separate DuckPipe instances or list the primary project.

---

## 3. Configure DuckPipe

### Environment Variables (`.env`)

```bash
DBT_API_TOKEN=dbtc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DBT_ACCOUNT_ID=12345
DBT_PROJECT_ID=67890
```

### Configuration (`duckpipe.yaml`)

```yaml
integrations:
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"   # or your self-hosted URL
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
```

### Self-Hosted dbt Cloud

If you run dbt Cloud on-premises or use a custom domain:

```yaml
integrations:
  dbt:
    cloud_url: "https://dbt.internal.company.com"
```

---

## 4. GitHub Integration (for Pipeline Whisperer)

The Pipeline Whisperer workflow creates pull requests when schema drift is detected. This requires a GitHub token.

### Create a Fine-Grained Personal Access Token

1. Go to [GitHub Settings → Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Name: `DuckPipe Pipeline Whisperer`
4. Expiration: Set to your organization's policy (recommended: 90 days, with rotation)
5. Repository access: **Only select repositories** → select your dbt repository
6. Permissions:
   - **Contents**: Read and Write (for pushing branches)
   - **Pull requests**: Read and Write (for creating PRs)
7. Click **Generate token**

### Branch Protection

Ensure your repository has branch protection rules on `main`/`master`:

- Require pull request reviews before merging
- Require status checks to pass

DuckPipe will **never** push directly to main/master. It always creates a feature branch named `duckpipe/{date}/{description}`.

### Configure GitHub in `.env`

```bash
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
GITHUB_REPO=your-org/your-dbt-repo
```

### Configure in `duckpipe.yaml`

```yaml
workflows:
  pipeline_whisperer:
    enabled: true
    poll_interval_minutes: 15
    github_repo: "${GITHUB_REPO}"
    base_branch: "main"
```

---

## 5. Test the Connection

### Manual API Test

```bash
export DBT_TOKEN="dbtc_your_token_here"
export ACCOUNT_ID="12345"

# List projects
curl -s -H "Authorization: Token $DBT_TOKEN" \
  "https://cloud.getdbt.com/api/v2/accounts/$ACCOUNT_ID/projects/" | python3 -m json.tool

# List jobs
curl -s -H "Authorization: Token $DBT_TOKEN" \
  "https://cloud.getdbt.com/api/v2/accounts/$ACCOUNT_ID/jobs/" | python3 -m json.tool
```

**Expected**: JSON response with project/job listings.

---

## 6. Run Verify

```bash
npx duckpipe verify
```

Or verify only dbt:

```bash
npx duckpipe verify --integration dbt
```

### Expected Output

```
✓ dbt Cloud connected (account: 12345)
  Projects: 3  Jobs: 18  Last run: 2 min ago
```

---

## 7. Troubleshooting

### 401 Unauthorized

- Invalid or expired API token
- **Fix**: Regenerate the token in dbt Cloud. Service tokens don't expire unless revoked. Personal tokens may have an expiration date.

### 403 Forbidden

- Token lacks required permission sets
- **Fix**: Ensure the service token has `Job Admin` and `Member` permissions

### Connection Timeout

- dbt Cloud unreachable from your network
- Corporate firewall blocking `cloud.getdbt.com`
- **Fix**: Test connectivity with `curl` from the DuckPipe host. Add `cloud.getdbt.com` to your firewall allowlist if needed.

### Wrong Account or Project

- Token belongs to a different account
- Project ID does not exist under the specified account
- **Fix**: Verify the IDs by checking the URL in dbt Cloud when navigating to your project

### No Jobs Found

- The project has no jobs configured
- **Fix**: Create at least one dbt job in the project for DuckPipe to monitor

### GitHub PR Creation Fails

- Token lacks Contents or Pull requests permissions
- Branch protection prevents the push
- **Fix**: Verify GitHub token permissions. Ensure the token has access to the specific repository.

---

## What DuckPipe Reads from dbt Cloud

| Data | Purpose | API Endpoint |
|---|---|---|
| Job list | Monitor job health | `GET /api/v2/accounts/{id}/jobs/` |
| Run details | Detect failures, get error logs | `GET /api/v2/accounts/{id}/runs/{id}/` |
| Manifest | Model lineage, column definitions | `GET /api/v2/accounts/{id}/jobs/{id}/artifacts/manifest.json` |
| Run artifacts | Test results, compilation errors | `GET /api/v2/accounts/{id}/runs/{id}/artifacts/` |

DuckPipe does not trigger dbt runs via the API. Schema fixes are proposed through GitHub PRs, which then trigger dbt Cloud CI jobs via your existing GitHub integration.

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
