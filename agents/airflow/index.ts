import { startAgentRuntime, type ToolFn } from "../runtime.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

const registry = new Map<string, ToolFn>([
  ["check_failures", wrap(async (p) => tools.checkFailures(p.config as any))],
  ["list_dags", wrap(async (p) => ({ dags: await tools.listDags(p.config as any) }))],
  ["get_dag_runs", wrap(async (p) => ({ runs: await tools.getDagRuns(p.config as any, p.dag_id as string, p.limit as number) }))],
  ["get_task_instances", wrap(async (p) => ({ tasks: await tools.getTaskInstances(p.config as any, p.dag_id as string, p.dag_run_id as string) }))],
  ["get_task_logs", wrap(async (p) => ({ logs: await tools.getTaskLogs(p.config as any, p.dag_id as string, p.dag_run_id as string, p.task_id as string, p.try_number as number) }))],
  ["trigger_dag_run", wrap(async (p) => tools.triggerDagRun(p.config as any, p.dag_id as string, (p.conf ?? {}) as Record<string, unknown>))],
  ["clear_task", wrap(async (p) => { await tools.clearTask(p.config as any, p.dag_id as string, p.dag_run_id as string, p.task_id as string); return { cleared: true }; })],
]);

startAgentRuntime({ name: "airflow", busDir: BUS_DIR, tools: registry });
