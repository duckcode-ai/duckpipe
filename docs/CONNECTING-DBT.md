# Connecting DuckPipe to dbt Cloud

Step-by-step guide to connect DuckPipe to dbt Cloud.

## 1. Generate an API Token

1. Log in to [dbt Cloud](https://cloud.getdbt.com)
2. Click your profile (bottom left) -> Account Settings
3. Go to the "API Access" or "Service Tokens" section
4. Create a new token
5. For Tier 1 (read-only), select scopes: `read:jobs`, `read:runs`, `read:projects`
6. For Tier 2+ (if you use dbt Cloud for writes), add any required write scopes
7. Copy the token; it is shown only once

## 2. Find Account and Project IDs

### Account ID

- In dbt Cloud, the account ID is in the URL: `https://cloud.getdbt.com/#/accounts/<ACCOUNT_ID>/`
- Or in Account Settings -> Overview

### Project ID

- Open your project
- The project ID is in the URL: `https://cloud.getdbt.com/#/accounts/<ACCOUNT_ID>/projects/<PROJECT_ID>/`
- Or in Project Settings

## 3. Add to .env

```bash
DBT_API_TOKEN=dbt_xxxxxxxxxxxxxxxx
DBT_ACCOUNT_ID=12345
DBT_PROJECT_ID=67890
```

## 4. Configure duckpipe.yaml

```yaml
integrations:
  dbt:
    enabled: true
    cloud_url: "https://cloud.getdbt.com"
    api_token: "${DBT_API_TOKEN}"
    account_id: "${DBT_ACCOUNT_ID}"
    project_id: "${DBT_PROJECT_ID}"
```

The default `cloud_url` is `https://cloud.getdbt.com`. For dbt Cloud on a private/self-hosted instance, set the correct base URL.

## 5. Run Verify

```bash
npx duckpipe verify
```

Or for dbt only:

```bash
npx duckpipe verify --integration dbt
```

Expected output:

```
dbt Cloud connected
  Account: 12345
  Project: 67890
```

## 6. Common Errors

### 401 Unauthorized

- Invalid or expired API token
- Regenerate the token in dbt Cloud and update `.env`

### 403 Forbidden

- Token lacks required scopes
- Ensure `read:jobs`, `read:runs`, `read:projects` are granted

### Connection timeout

- dbt Cloud may be unreachable from your network
- Check firewall rules if running in a restricted environment

### Wrong account/project

- Verify account and project IDs in the URL when logged in
- Ensure the token belongs to the correct account
