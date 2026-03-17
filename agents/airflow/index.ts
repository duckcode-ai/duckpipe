import { startAgentRuntime, type ToolFn } from "../runtime.js";
import { loadConfig } from "../../src/config.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

async function main() {
  const config = loadConfig();
  const af = config.integrations?.airflow;

  // Build the config the tools need — injected at startup, not per-message
  const airflowCfg = af ? {
    baseUrl:     af.base_url,
    username:    af.username,
    password:    af.password,
    apiKey:      af.api_key,
    allowedDags: af.allowed_dags ?? [],
    verifySsl:   af.verify_ssl ?? true,
  } : null;

  if (!airflowCfg) {
    console.warn("[airflow] No airflow integration configured — read tools will return empty results");
  }

  const registry = new Map<string, ToolFn>([
    ["check_failures",    wrap(async (_p) => {
      if (!airflowCfg) return { status: "healthy", affectedDags: [], rootCause: "Airflow not configured", rootCauseCategory: "unknown", evidence: [], recommendedAction: "Configure airflow in duckpipe.yaml", confidence: "high", writeActionsNeeded: [] };
      return tools.checkFailures(airflowCfg);
    })],
    ["list_dags",         wrap(async (_p) => {
      if (!airflowCfg) return { dags: [] };
      return { dags: await tools.listDags(airflowCfg) };
    })],
    ["get_dag_runs",      wrap(async (p) => {
      if (!airflowCfg) return { runs: [] };
      return { runs: await tools.getDagRuns(airflowCfg, p.dag_id as string, (p.limit as number) ?? 5) };
    })],
    ["get_running_dags",   wrap(async (p) => {
      if (!airflowCfg) return { runningDags: [] };
      return { runningDags: await tools.getRunningDags(airflowCfg, (p.monitored_dags as string[]) ?? []) };
    })],
    ["get_task_instances", wrap(async (p) => {
      if (!airflowCfg) return { tasks: [] };
      return { tasks: await tools.getTaskInstances(airflowCfg, p.dag_id as string, p.dag_run_id as string) };
    })],
    ["get_task_logs",     wrap(async (p) => {
      if (!airflowCfg) return { logs: "" };
      return { logs: await tools.getTaskLogs(airflowCfg, p.dag_id as string, p.dag_run_id as string, p.task_id as string, (p.try_number as number) ?? 1) };
    })],
    ["trigger_dag_run",   wrap(async (p) => {
      if (!airflowCfg) throw new Error("Airflow not configured");
      return tools.triggerDagRun(airflowCfg, p.dag_id as string, (p.conf ?? {}) as Record<string, unknown>);
    })],
    ["clear_task",        wrap(async (p) => {
      if (!airflowCfg) throw new Error("Airflow not configured");
      await tools.clearTask(airflowCfg, p.dag_id as string, p.dag_run_id as string, p.task_id as string);
      return { cleared: true };
    })],
  ]);

  startAgentRuntime({ name: "airflow", busDir: BUS_DIR, tools: registry });
}

main().catch(console.error);
