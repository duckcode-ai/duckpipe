import { startAgentRuntime, type ToolFn } from "../runtime.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

const registry = new Map<string, ToolFn>([
  ["list_jobs", wrap(async (p) => ({ jobs: await tools.listJobs(p.config as any) }))],
  ["get_run", wrap(async (p) => tools.getRun(p.config as any, p.run_id as number))],
  ["get_manifest", wrap(async (p) => ({ models: await tools.getManifest(p.config as any, p.run_id as number) }))],
  ["list_models", wrap(async (p) => ({ models: await tools.listModels(p.config as any, p.run_id as number) }))],
  ["create_branch", wrap(async (p) => tools.createBranch(p.gh_config as any, p.branch_name as string, p.base_branch as string))],
  ["push_file", wrap(async (p) => tools.pushFile(p.gh_config as any, p.branch as string, p.file_path as string, p.content as string, p.message as string))],
  ["create_pr", wrap(async (p) => tools.createPullRequest(p.gh_config as any, p.title as string, p.body as string, p.head_branch as string, p.base_branch as string))],
  ["find_affected_models", wrap(async (p) => ({ models: tools.findAffectedModels(p.models as any[], p.changed_tables as string[]) }))],
]);

startAgentRuntime({ name: "dbt", busDir: BUS_DIR, tools: registry });
