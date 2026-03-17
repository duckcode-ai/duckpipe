# Connecting DuckPipe to Snowflake

Step-by-step guide to connect DuckPipe to Snowflake.

## 1. Create the DUCKPIPE_READER Role (Tier 1)

Run the following as ACCOUNTADMIN or SECURITYADMIN. Replace `<WAREHOUSE>` and `<DATABASE>` with your actual names.

```sql
-- Tier 1: Read-Only (Sandbox)

CREATE ROLE IF NOT EXISTS DUCKPIPE_READER;

GRANT USAGE ON WAREHOUSE <WAREHOUSE> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL TABLES IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;

-- Future grants so new objects are automatically accessible
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE TABLES IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE <DATABASE> TO ROLE DUCKPIPE_READER;

-- Query history access (reads ACCOUNT_USAGE, not your data)
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE DUCKPIPE_READER;

-- Create the service user
CREATE USER IF NOT EXISTS DUCKPIPE_SVC
  PASSWORD = 'CHANGE_ME'
  DEFAULT_ROLE = DUCKPIPE_READER
  DEFAULT_WAREHOUSE = <WAREHOUSE>
  MUST_CHANGE_PASSWORD = FALSE;

GRANT ROLE DUCKPIPE_READER TO USER DUCKPIPE_SVC;
```

A copy of this script is in `scripts/generate-snowflake-grants.sql`.

## 2. Tier 2: DUCKPIPE_OPERATOR (Supervised Writes)

When you enable Tier 2 and need to cancel queries or operate warehouses:

```sql
CREATE ROLE IF NOT EXISTS DUCKPIPE_OPERATOR;
GRANT ROLE DUCKPIPE_READER TO ROLE DUCKPIPE_OPERATOR;

-- Allows: ALTER WAREHOUSE SUSPEND/RESUME, SYSTEM$CANCEL_QUERY()
-- Does NOT allow: CREATE, DROP, ALTER TABLE, INSERT, UPDATE, DELETE
GRANT OPERATE ON WAREHOUSE <WAREHOUSE> TO ROLE DUCKPIPE_OPERATOR;

-- Activate for the user
ALTER USER DUCKPIPE_SVC SET DEFAULT_ROLE = DUCKPIPE_OPERATOR;
GRANT ROLE DUCKPIPE_OPERATOR TO USER DUCKPIPE_SVC;
```

## 3. Authentication: Key-Pair (Recommended)

Key-pair authentication avoids storing passwords and is recommended for production.

### Generate the key pair

```bash
# Generate private key (PEM PKCS#8)
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt

# Extract public key
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

### Register the public key in Snowflake

1. Copy the contents of `rsa_key.pub` (excluding the BEGIN/END lines, one line)
2. In Snowflake:

```sql
ALTER USER DUCKPIPE_SVC SET RSA_PUBLIC_KEY='<paste_public_key_contents>';
```

### Configure DuckPipe

Store the private key path in `.env` (never commit `.env`):

```
SNOWFLAKE_PRIVATE_KEY_PATH=~/.config/duckpipe/rsa_key.p8
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

Do not set `password` when using key-pair auth.

## 4. Authentication: Password

Simpler for development; less secure for production.

```yaml
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

In `.env`:

```
SNOWFLAKE_ACCOUNT=myorg.us-east-1
SNOWFLAKE_USER=DUCKPIPE_SVC
SNOWFLAKE_PASSWORD=your-password
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=ANALYTICS
```

## 5. Network Policy

If your Snowflake account has a network policy (IP allowlist):

- DuckPipe connects from your machine or VPC
- Add the outbound IP of the host running DuckPipe to the allowlist
- For cloud deployments, use the NAT gateway or egress IP of your VPC
- DuckPipe does not use a relay; connections go directly from your infrastructure to Snowflake

## 6. Account Identifier

The account identifier format depends on your Snowflake edition and region:

- Standard: `orgname-accountname` or `accountname.region.cloud`
- Example: `xy12345.us-east-1` or `myorg.us-east-1`

Find it in the Snowflake URL when you log in, or in Admin -> Accounts.

## 7. Run Verify

```bash
npx duckpipe verify
```

Or for Snowflake only:

```bash
npx duckpipe verify --integration snowflake
```

Expected output:

```
Snowflake connected
  Role: DUCKPIPE_READER  Warehouse: COMPUTE_WH
  Permissions: SELECT [ok]  OPERATE [no]  CREATE [no]  DROP [no]
  Query history access: [ok]
```

## 8. Common Errors

### Authentication failed

- Wrong password or key
- Public key not correctly set on the user
- Private key path wrong or file not readable

### Role not granted

- User does not have the role: `GRANT ROLE DUCKPIPE_READER TO USER DUCKPIPE_SVC`
- Default role not set: `ALTER USER DUCKPIPE_SVC SET DEFAULT_ROLE = DUCKPIPE_READER`

### Warehouse/database access denied

- Grant USAGE on warehouse and database to the role
- Check database and schema grants

### Network policy violation

- Add your IP to the Snowflake network policy allowlist
