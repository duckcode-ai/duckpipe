import { startAgentRuntime, type ToolFn } from "../runtime.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

const registry = new Map<string, ToolFn>([
  ["execute_query", wrap(async (p) => ({ rows: await tools.executeQuery(p.config as any, p.sql as string) }))],
  ["get_query_history", wrap(async (p) => tools.getQueryHistory(p.config as any, p.window_minutes as number))],
  ["get_query_profile", wrap(async (p) => tools.getQueryProfile(p.config as any, p.query_id as string))],
  ["cancel_query", wrap(async (p) => tools.cancelQuery(p.config as any, p.query_id as string))],
  ["get_warehouse_usage", wrap(async (p) => ({ warehouses: await tools.getWarehouseUsage(p.config as any) }))],
  ["fetch_schemas", wrap(async (p) => ({ schemas: await tools.fetchSchemas(p.config as any, p.databases as string[]) }))],
]);

startAgentRuntime({ name: "snowflake", busDir: BUS_DIR, tools: registry });
