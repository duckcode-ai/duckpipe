/**
 * Snowflake agent — query monitoring, cost tracking, and optimization.
 * Uses the Snowflake SQL REST API for query execution.
 * Supports password auth and RSA key-pair JWT auth.
 */

import { createSign, createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

interface SnowflakeConfig {
  account: string;
  user: string;
  password?: string;
  privateKeyPath?: string;
  role: string;
  warehouse: string;
  database: string;
  watchedDatabases: string[];
}

let cachedJwt: { token: string; expiresAt: number } | null = null;

interface ExpensiveQuery {
  queryId: string;
  user: string;
  warehouse: string;
  creditsConsumed: number;
  runtimeSeconds: number;
  queryPreview: string;
  optimizationSuggestion: string;
  estimatedCreditSavings: number;
}

interface QueryHistoryResult {
  expensiveQueries: ExpensiveQuery[];
  totalCredits24h: number;
  anomalyDetected: boolean;
  anomalyDescription: string | null;
  killCandidates: string[];
}

interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
}

interface TableSchema {
  database: string;
  schema: string;
  table: string;
  columns: SchemaColumn[];
}

function getApiUrl(config: SnowflakeConfig): string {
  return `https://${config.account}.snowflakecomputing.com/api/v2`;
}

function getAuthHeaders(config: SnowflakeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (config.privateKeyPath) {
    headers["Authorization"] = `Bearer ${generateJwt(config)}`;
    headers["X-Snowflake-Authorization-Token-Type"] = "KEYPAIR_JWT";
  } else if (config.password) {
    headers["Authorization"] = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`;
  }

  return headers;
}

function generateJwt(config: SnowflakeConfig): string {
  if (cachedJwt && cachedJwt.expiresAt > Date.now() + 60_000) {
    return cachedJwt.token;
  }

  const privateKeyPem = readFileSync(config.privateKeyPath!, "utf-8");
  const accountUpper = config.account.toUpperCase().replace(/\..*/, "");
  const userUpper = config.user.toUpperCase();
  const qualifiedUsername = `${accountUpper}.${userUpper}`;

  // SHA-256 fingerprint of the public key (DER-encoded)
  const sign = createSign("SHA256");
  const pubKeyDer = extractPublicKeyDer(privateKeyPem);
  const fingerprint = createHash("sha256").update(pubKeyDer).digest("base64");
  const issuer = `${qualifiedUsername}.SHA256:${fingerprint}`;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresSeconds = nowSeconds + 3600;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    sub: qualifiedUsername,
    iat: nowSeconds,
    exp: expiresSeconds,
  }));

  sign.update(`${header}.${payload}`);
  sign.end();
  const signature = base64url(sign.sign(privateKeyPem));

  const token = `${header}.${payload}.${signature}`;
  cachedJwt = { token, expiresAt: expiresSeconds * 1000 };
  return token;
}

function base64url(input: string | Buffer): string {
  const b64 = Buffer.from(input).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function extractPublicKeyDer(privatePem: string): Buffer {
  const pubKey = createPublicKey(privatePem);
  return pubKey.export({ type: "spki", format: "der" }) as Buffer;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$.]*$/;
const SAFE_QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" — only alphanumeric, underscore, dot, and dollar allowed`);
  }
}

function validateQueryId(value: string): void {
  if (!SAFE_QUERY_ID.test(value)) {
    throw new Error(`Invalid query_id format: "${value}" — expected UUID`);
  }
}

function validatePositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 10080) {
    throw new Error(`Invalid ${label}: must be a positive integer <= 10080`);
  }
}

function validateSelectOnly(sql: string): void {
  const normalized = sql.trim().toUpperCase();
  const firstWord = normalized.split(/\s+/)[0];

  const allowedStarts = ["SELECT", "SHOW", "DESCRIBE", "WITH"];
  if (!allowedStarts.includes(firstWord) && !normalized.startsWith("SELECT SYSTEM$")) {
    throw new Error(
      "Snowflake agent can only execute SELECT, SHOW, DESCRIBE, or WITH queries"
    );
  }

  if (normalized.includes(";")) {
    throw new Error("Multi-statement queries are not allowed");
  }

  const dangerousPattern = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|EXECUTE)\b/;
  if (dangerousPattern.test(normalized)) {
    const match = normalized.match(dangerousPattern);
    throw new Error(`Query contains forbidden keyword: ${match?.[1]}`);
  }
}

export async function executeQuery(
  config: SnowflakeConfig,
  sql: string
): Promise<Record<string, unknown>[]> {
  validateSelectOnly(sql);

  const resp = await fetch(`${getApiUrl(config)}/statements`, {
    method: "POST",
    headers: getAuthHeaders(config),
    body: JSON.stringify({
      statement: sql,
      timeout: 60,
      database: config.database,
      schema: "PUBLIC",
      warehouse: config.warehouse,
      role: config.role,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Snowflake API error: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    data: unknown[][];
    resultSetMetaData: {
      rowType: Array<{ name: string; type: string }>;
    };
  };

  const columns = data.resultSetMetaData?.rowType ?? [];
  return (data.data ?? []).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj;
  });
}

export async function getQueryHistory(
  config: SnowflakeConfig,
  windowMinutes = 10
): Promise<QueryHistoryResult> {
  validatePositiveInt(windowMinutes, "windowMinutes");

  const sql = `
    SELECT query_id, query_text, user_name, warehouse_name,
           credits_used_cloud_services, total_elapsed_time/1000 as seconds
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('minute', -${Number(windowMinutes)}, CURRENT_TIMESTAMP())
    ORDER BY credits_used_cloud_services DESC NULLS LAST
    LIMIT 20
  `;

  try {
    const rows = await executeQuery(config, sql);

    const expensiveQueries: ExpensiveQuery[] = rows.map((r) => ({
      queryId: String(r.QUERY_ID ?? ""),
      user: String(r.USER_NAME ?? ""),
      warehouse: String(r.WAREHOUSE_NAME ?? ""),
      creditsConsumed: Number(r.CREDITS_USED_CLOUD_SERVICES ?? 0),
      runtimeSeconds: Number(r.SECONDS ?? 0),
      queryPreview: String(r.QUERY_TEXT ?? "").slice(0, 200),
      optimizationSuggestion: "",
      estimatedCreditSavings: 0,
    }));

    const totalCredits = expensiveQueries.reduce(
      (sum, q) => sum + q.creditsConsumed,
      0
    );

    return {
      expensiveQueries,
      totalCredits24h: totalCredits,
      anomalyDetected: false,
      anomalyDescription: null,
      killCandidates: [],
    };
  } catch (err) {
    return {
      expensiveQueries: [],
      totalCredits24h: 0,
      anomalyDetected: false,
      anomalyDescription: null,
      killCandidates: [],
    };
  }
}

export async function cancelQuery(
  config: SnowflakeConfig,
  queryId: string
): Promise<{ cancelled: boolean; queryId: string }> {
  validateQueryId(queryId);
  const sql = `SELECT SYSTEM$CANCEL_QUERY('${queryId}')`;
  await executeQuery(config, sql);
  return { cancelled: true, queryId };
}

export async function getWarehouseUsage(
  config: SnowflakeConfig
): Promise<Array<{ warehouse: string; credits: number }>> {
  const sql = `
    SELECT warehouse_name, SUM(credits_used) as total_credits
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
    WHERE start_time >= DATEADD('day', -7, CURRENT_TIMESTAMP())
    GROUP BY warehouse_name
    ORDER BY total_credits DESC
  `;

  const rows = await executeQuery(config, sql);
  return rows.map((r) => ({
    warehouse: String(r.WAREHOUSE_NAME ?? ""),
    credits: Number(r.TOTAL_CREDITS ?? 0),
  }));
}

export async function fetchSchemas(
  config: SnowflakeConfig,
  databases: string[]
): Promise<TableSchema[]> {
  const schemas: TableSchema[] = [];

  for (const db of databases) {
    validateIdentifier(db, "database name");

    const sql = `
      SELECT table_catalog, table_schema, table_name,
             column_name, data_type, is_nullable
      FROM ${db}.INFORMATION_SCHEMA.COLUMNS
      ORDER BY table_schema, table_name, ordinal_position
    `;

    try {
      const rows = await executeQuery(config, sql);
      const grouped = new Map<string, SchemaColumn[]>();

      for (const r of rows) {
        const key = `${r.TABLE_CATALOG}.${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push({
          name: String(r.COLUMN_NAME),
          type: String(r.DATA_TYPE),
          nullable: r.IS_NULLABLE === "YES",
        });
      }

      for (const [key, columns] of grouped) {
        const [database, schema, table] = key.split(".");
        schemas.push({ database, schema, table, columns });
      }
    } catch {
      // Skip databases we can't access
    }
  }

  return schemas;
}

export interface TableAnomalyResult {
  table: string;
  rowCount: number;
  prevRowCount: number | null;
  pctChange: number | null;
  anomalyDetected: boolean;
  anomalyDescription: string | null;
}

export interface QueryPlanSummary {
  queryId: string;
  queryText: string;
  warehouse: string;
  runtimeSeconds: number;
  creditsConsumed: number;
}

// Check row counts and basic stats for specified tables to detect data anomalies.
// Called by incident-autopilot to cross-reference Airflow failures with data issues.
export async function checkSourceAnomalies(
  config: SnowflakeConfig,
  tables: string[]  // "SCHEMA.TABLE" or "DATABASE.SCHEMA.TABLE"
): Promise<TableAnomalyResult[]> {
  if (tables.length === 0) {
    // If no tables specified, check the configured database for recently modified tables
    const recentSql = `
      SELECT table_schema || '.' || table_name as full_table
      FROM ${config.database}.INFORMATION_SCHEMA.TABLES
      WHERE last_altered >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
        AND table_type = 'BASE TABLE'
      LIMIT 10
    `;
    try {
      const rows = await executeQuery(config, recentSql);
      tables = rows.map(r => `${config.database}.${String(r.FULL_TABLE)}`);
    } catch {
      return [];
    }
  }

  const results: TableAnomalyResult[] = [];

  for (const tableRef of tables.slice(0, 10)) {
    const parts = tableRef.split(".");
    const db     = parts.length === 3 ? parts[0] : config.database;
    const schema = parts.length === 3 ? parts[1] : parts[0];
    const table  = parts[parts.length - 1];

    try {
      validateIdentifier(db, "database");
      validateIdentifier(schema, "schema");
      validateIdentifier(table, "table");

      const countSql = `SELECT COUNT(*) AS ROW_COUNT FROM ${db}.${schema}.${table}`;
      const rows = await executeQuery(config, countSql);
      const rowCount = Number(rows[0]?.ROW_COUNT ?? 0);

      results.push({
        table: `${db}.${schema}.${table}`,
        rowCount,
        prevRowCount: null,
        pctChange: null,
        anomalyDetected: rowCount === 0,
        anomalyDescription: rowCount === 0 ? `Table ${table} has 0 rows — may indicate a load failure` : null,
      });
    } catch (err) {
      results.push({
        table: tableRef,
        rowCount: -1,
        prevRowCount: null,
        pctChange: null,
        anomalyDetected: false,
        anomalyDescription: `Could not query: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}

export async function getQueryProfile(
  config: SnowflakeConfig,
  queryId: string
): Promise<Record<string, unknown>> {
  validateQueryId(queryId);

  const sql = `
    SELECT *
    FROM TABLE(GET_QUERY_OPERATOR_STATS('${queryId}'))
  `;

  const rows = await executeQuery(config, sql);
  return { queryId, operators: rows };
}

export async function getQueryPlans(
  config: SnowflakeConfig,
  entity: string,
  limit = 10
): Promise<QueryPlanSummary[]> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const escapedEntity = entity.replace(/'/g, "''");
  const sql = `
    SELECT query_id, query_text, warehouse_name,
           total_elapsed_time/1000 AS runtime_seconds,
           credits_used_cloud_services AS credits_consumed
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('day', -7, CURRENT_TIMESTAMP())
      AND query_text ILIKE '%${escapedEntity}%'
    ORDER BY total_elapsed_time DESC
    LIMIT ${safeLimit}
  `;

  try {
    const rows = await executeQuery(config, sql);
    return rows.map((row) => ({
      queryId: String(row.QUERY_ID ?? ""),
      queryText: String(row.QUERY_TEXT ?? ""),
      warehouse: String(row.WAREHOUSE_NAME ?? ""),
      runtimeSeconds: Number(row.RUNTIME_SECONDS ?? 0),
      creditsConsumed: Number(row.CREDITS_CONSUMED ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function analyzeQueryPerformance(
  _config: SnowflakeConfig,
  entity: string,
  plans: Array<QueryPlanSummary | Record<string, unknown>>
): Promise<{ explanation: string; rewrittenSql: string; estimatedSavings: number }> {
  const summaries = plans.map((plan) => ({
    queryId: String((plan as QueryPlanSummary).queryId ?? (plan as Record<string, unknown>).queryId ?? ""),
    queryText: String((plan as QueryPlanSummary).queryText ?? (plan as Record<string, unknown>).queryText ?? ""),
    runtimeSeconds: Number((plan as QueryPlanSummary).runtimeSeconds ?? (plan as Record<string, unknown>).runtimeSeconds ?? 0),
    creditsConsumed: Number((plan as QueryPlanSummary).creditsConsumed ?? (plan as Record<string, unknown>).creditsConsumed ?? 0),
  }));

  const slowest = summaries.sort((left, right) => right.runtimeSeconds - left.runtimeSeconds)[0];
  const explanation = slowest
    ? `Queries touching ${entity} appear dominated by long-running scans. The slowest query (${slowest.queryId || "unknown"}) ran for ${Math.round(slowest.runtimeSeconds)}s and consumed ${slowest.creditsConsumed.toFixed(2)} credits.`
    : `No recent query plans were found for ${entity}. Query performance should be investigated with a narrower time window or a more specific entity name.`;

  const rewrittenSql = slowest?.queryText
    ? `${slowest.queryText.trim()}\n-- Suggested optimization: project only needed columns and add a selective predicate before joins.`
    : `SELECT *\nFROM ${entity}\nWHERE /* add a selective predicate */ 1 = 1;`;

  const estimatedSavings = slowest ? Math.max(1, Math.round(slowest.creditsConsumed * 0.25)) : 0;
  return { explanation, rewrittenSql, estimatedSavings };
}
