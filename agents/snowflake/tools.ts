/**
 * Snowflake agent — query monitoring, cost tracking, and optimization.
 * Uses the Snowflake SQL REST API for query execution.
 */

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
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
  };
}

function validateSelectOnly(sql: string): void {
  const normalized = sql.trim().toUpperCase();
  if (
    !normalized.startsWith("SELECT") &&
    !normalized.startsWith("SHOW") &&
    !normalized.startsWith("DESCRIBE") &&
    !normalized.startsWith("WITH") &&
    !normalized.includes("SYSTEM$")
  ) {
    throw new Error(
      "Snowflake agent can only execute SELECT, SHOW, DESCRIBE, or SYSTEM$ queries"
    );
  }

  const dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "MERGE"];
  for (const kw of dangerous) {
    if (normalized.includes(kw) && !normalized.includes(`'${kw}`)) {
      throw new Error(`Query contains forbidden keyword: ${kw}`);
    }
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
  const sql = `
    SELECT query_id, query_text, user_name, warehouse_name,
           credits_used_cloud_services, total_elapsed_time/1000 as seconds
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('minute', -${windowMinutes}, CURRENT_TIMESTAMP())
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

export async function getQueryProfile(
  config: SnowflakeConfig,
  queryId: string
): Promise<Record<string, unknown>> {
  const sql = `
    SELECT *
    FROM TABLE(GET_QUERY_OPERATOR_STATS('${queryId}'))
  `;

  const rows = await executeQuery(config, sql);
  return { queryId, operators: rows };
}
