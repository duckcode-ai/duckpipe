import { startAgentRuntime, type ToolFn } from "../runtime.js";
import { loadConfig } from "../../src/config.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

async function main() {
  const config = loadConfig();
  const sf = config.integrations?.snowflake;

  const sfCfg = sf ? {
    account:         sf.account,
    user:            sf.user,
    password:        sf.password,
    privateKeyPath:  sf.private_key_path,
    role:            sf.role ?? "DUCKPIPE_READER",
    warehouse:       sf.warehouse,
    database:        sf.database,
    watchedDatabases: sf.watched_databases ?? [],
  } : null;

  if (!sfCfg) {
    console.warn("[snowflake] No snowflake integration configured — tools will return empty results");
  }

  const registry = new Map<string, ToolFn>([
    ["execute_query",      wrap(async (p) => {
      if (!sfCfg) return { rows: [] };
      return { rows: await tools.executeQuery(sfCfg, p.sql as string) };
    })],
    ["get_query_history",  wrap(async (p) => {
      if (!sfCfg) return { expensiveQueries: [], totalCredits24h: 0, anomalyDetected: false, anomalyDescription: null, killCandidates: [] };
      return tools.getQueryHistory(sfCfg, (p.window_minutes as number) ?? 1440);
    })],
    ["get_query_profile",  wrap(async (p) => {
      if (!sfCfg) return {};
      return tools.getQueryProfile(sfCfg, p.query_id as string);
    })],
    ["cancel_query",       wrap(async (p) => {
      if (!sfCfg) throw new Error("Snowflake not configured");
      return tools.cancelQuery(sfCfg, p.query_id as string);
    })],
    ["get_warehouse_usage", wrap(async (_p) => {
      if (!sfCfg) return { warehouses: [] };
      return { warehouses: await tools.getWarehouseUsage(sfCfg) };
    })],
    ["fetch_schemas",      wrap(async (p) => {
      if (!sfCfg) return { schemas: [] };
      return { schemas: await tools.fetchSchemas(sfCfg, (p.databases as string[]) ?? [sfCfg.database]) };
    })],
    ["check_source_anomalies", wrap(async (p) => {
      if (!sfCfg) return { anomalies: [] };
      const anomalies = await tools.checkSourceAnomalies(sfCfg, (p.tables as string[]) ?? []);
      return { anomalies };
    })],
    ["get_query_plans", wrap(async (p) => {
      if (!sfCfg) return { plans: [] };
      const plans = await tools.getQueryPlans(sfCfg, p.entity as string, (p.limit as number) ?? 10);
      return { plans };
    })],
    ["analyze_query_performance", wrap(async (p) => {
      if (!sfCfg) return { explanation: "Snowflake not configured", rewrittenSql: "", estimatedSavings: 0 };
      return tools.analyzeQueryPerformance(sfCfg, p.entity as string, (p.plans as Record<string, unknown>[]) ?? []);
    })],
  ]);

  startAgentRuntime({ name: "snowflake", busDir: BUS_DIR, tools: registry });
}

main().catch(console.error);
