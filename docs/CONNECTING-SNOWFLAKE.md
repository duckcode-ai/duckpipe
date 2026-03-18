# Connecting DuckPipe to Snowflake

Step-by-step guide to connect DuckPipe to your Snowflake account. Covers role creation, authentication methods (password and key-pair), network policy, and troubleshooting.

---

## Prerequisites

- DuckPipe installed (`npm install` completed)
- Snowflake account with ACCOUNTADMIN or SECURITYADMIN access (for initial role setup)
- Network access from DuckPipe host to your Snowflake account endpoint

---

## 1. Create Roles and Service User

### Tier 1: DUCKPIPE_READER (Read-Only)

Run the following as ACCOUNTADMIN or SECURITYADMIN. Replace `<WAREHOUSE>` and `<DATABASE>` with your actual names.

```sql
-- Create the read-only role
CREATE ROLE IF NOT EXISTS DUCKPIPE_READER;

-- Warehouse access (for running queries)
GRANT USAGE ON WAREHOUSE <WAREHOUSE> TO ROLE DUCKPIPE_READER;

-- Database and schema access
GRANT USAGE ON DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;

-- Read access to all tables and views
GRANT SELECT ON ALL TABLES IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;

-- Future grants (new objects automatically accessible)
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE TABLES IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;

-- Query history access (reads ACCOUNT_USAGE metadata, not your business data)
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE DUCKPIPE_READER;

-- Create the service user
CREATE USER IF NOT EXISTS DUCKPIPE_SVC
  PASSWORD = 'CHANGE_ME_TO_A_STRONG_PASSWORD'
  DEFAULT_ROLE = DUCKPIPE_READER
  DEFAULT_WAREHOUSE = <WAREHOUSE>
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Service account for DuckPipe autonomous data agent';

GRANT ROLE DUCKPIPE_READER TO USER DUCKPIPE_SVC;
```

A copy of this script is available at `scripts/generate-snowflake-grants.sql`.

### Multiple Databases

If DuckPipe needs to monitor multiple databases:

```sql
-- Repeat for each database
GRANT USAGE ON DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL TABLES IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE TABLES IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE <ADDITIONAL_DB> TO ROLE DUCKPIPE_READER;
```

Then set `watched_databases` in `duckpipe.yaml`:

```yaml
integrations:
  snowflake:
    database: "ANALYTICS"
    watched_databases: ["ANALYTICS", "RAW", "STAGING"]
```

---

## 2. Authentication: Key-Pair (Recommended for Production)

Key-pair authentication eliminates the need to store passwords and is the recommended method for production deployments.

### Generate the RSA Key Pair

```bash
# Generate private key (PKCS#8 format, no passphrase)
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt

# Extract public key
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub

# Verify the key pair
openssl rsa -in rsa_key.p8 -check -noout
```

### Register the Public Key in Snowflake

1. Open `rsa_key.pub` and copy the contents (exclude the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` lines)
2. Run in Snowflake:

```sql
ALTER USER DUCKPIPE_SVC SET RSA_PUBLIC_KEY='MIIBIjANBgkqhki...paste_full_key_here...';
```

3. Verify:

```sql
DESC USER DUCKPIPE_SVC;
-- Look for RSA_PUBLIC_KEY_FP (fingerprint)
```

### Configure DuckPipe for Key-Pair Auth

Store the private key path in `.env` (never commit the private key to git):

```bash
SNOWFLAKE_ACCOUNT=myorg.us-east-1
SNOWFLAKE_USER=DUCKPIPE_SVC
SNOWFLAKE_PRIVATE_KEY_PATH=/secure/path/rsa_key.p8
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=ANALYTICS
```

In `duckpipe.yaml`:

```yaml
integrations:
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    private_key_path: "${SNOWFLAKE_PRIVATE_KEY_PATH}"
    role: "DUCKPIPE_READER"
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
```

Do **not** set `password` when using key-pair authentication.

### Private Key Storage Best Practices

| Environment | Recommendation |
|---|---|
| Development | Store in `~/.config/duckpipe/rsa_key.p8` with `chmod 600` |
| Production (VM) | Store outside the application directory, owned by the service user |
| Production (K8s) | Mount as a Kubernetes secret volume |
| Production (Vault) | Store the private key content in HashiCorp Vault; load via vault backend |

---

## 3. Authentication: Password (Development)

Simpler for development; not recommended for production.

```bash
# .env
SNOWFLAKE_ACCOUNT=myorg.us-east-1
SNOWFLAKE_USER=DUCKPIPE_SVC
SNOWFLAKE_PASSWORD=your-strong-password
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=ANALYTICS
```

```yaml
# duckpipe.yaml
integrations:
  snowflake:
    enabled: true
    account: "${SNOWFLAKE_ACCOUNT}"
    user: "${SNOWFLAKE_USER}"
    password: "${SNOWFLAKE_PASSWORD}"
    role: "DUCKPIPE_READER"
    warehouse: "${SNOWFLAKE_WAREHOUSE}"
    database: "${SNOWFLAKE_DATABASE}"
```

---

## 4. Network Policy

If your Snowflake account has a network policy (IP allowlist):

- DuckPipe connects **directly** from your host machine or VPC to Snowflake
- There is no cloud relay — the connection originates from your infrastructure
- Add the outbound IP of the DuckPipe host to the allowlist

### Finding Your Outbound IP

```bash
# From the DuckPipe host
curl -s https://ifconfig.me
```

### For Cloud Deployments

- **AWS**: Use the NAT gateway or elastic IP of your VPC
- **GCP**: Use the Cloud NAT IP or VM external IP
- **Azure**: Use the NAT gateway or public IP of the VNET

### Updating the Snowflake Network Policy

```sql
-- Add DuckPipe host IP to the allowlist
ALTER NETWORK POLICY <POLICY_NAME> SET ALLOWED_IP_LIST = ('existing_ip', 'duckpipe_host_ip');
```

---

## 5. Account Identifier

The Snowflake account identifier depends on your edition and region:

| Format | Example |
|---|---|
| `orgname-accountname` | `myorg-account1` |
| `accountname.region.cloud` | `xy12345.us-east-1` |
| `orgname.accountname` | `myorg.account1` |

Find yours in:
- The Snowflake URL when you log in: `https://<account>.snowflakecomputing.com`
- Admin → Accounts in the Snowflake UI
- `SELECT CURRENT_ACCOUNT();` in a worksheet

---

## 6. Run Verify

```bash
npx duckpipe verify
```

Or verify only Snowflake:

```bash
npx duckpipe verify --integration snowflake
```

### Expected Output (Tier 1)

```
✓ Snowflake connected (account: myorg.us-east-1)
  Role: DUCKPIPE_READER  Warehouse: COMPUTE_WH
  Permissions: SELECT ✓  OPERATE ✗  CREATE ✗  DROP ✗
  Query history access: ✓
  Tables visible: 312
```

---

## 7. Troubleshooting

### Authentication Failed (password)

- Wrong password
- User does not exist or is locked
- **Fix**: Try logging in via the Snowflake web UI with the same credentials

### Authentication Failed (key-pair)

- Public key not correctly set on the user
- Private key file path wrong or not readable
- Private key format incorrect (must be PKCS#8)
- **Fix**: Verify the key fingerprint matches:

```sql
DESC USER DUCKPIPE_SVC;
-- Compare RSA_PUBLIC_KEY_FP with:
```

```bash
openssl rsa -in rsa_key.p8 -pubout -outform DER | openssl dgst -sha256 -binary | openssl enc -base64
```

### Role Not Granted

- User does not have the role assigned
- **Fix**:

```sql
GRANT ROLE DUCKPIPE_READER TO USER DUCKPIPE_SVC;
ALTER USER DUCKPIPE_SVC SET DEFAULT_ROLE = DUCKPIPE_READER;
```

### Warehouse / Database Access Denied

- Missing USAGE grant on warehouse or database
- **Fix**: Re-run the grant statements from Step 1

### Network Policy Violation

- DuckPipe host IP not in the allowlist
- **Fix**: Add the IP to the Snowflake network policy (see Step 4)

### Query History Not Accessible

- Missing `IMPORTED PRIVILEGES` on the `SNOWFLAKE` database
- **Fix**:

```sql
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE DUCKPIPE_READER;
```

### Timeout on Initial Connection

- Snowflake account may be suspended (auto-resume takes a few seconds)
- Large warehouse resume time
- **Fix**: This is normal on first connection. Subsequent connections will be faster.

---

## Security Notes

- DuckPipe's Snowflake agent executes only SELECT queries — enforced at both the application level (SQL validation) and the database level (role grants)
- The agent validates all identifiers with strict regex to prevent SQL injection
- Query results are used for cost/performance analysis and are not persisted to disk
- The DUCKPIPE_READER role cannot access other users' credentials or modify any database objects

---

*Copyright 2026 Duckcode.ai · Licensed under Apache 2.0*
