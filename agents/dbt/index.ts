import { startAgentRuntime, type ToolFn } from "../runtime.js";
import { loadConfig } from "../../src/config.js";
import * as tools from "./tools.js";

const BUS_DIR = process.env.DUCKPIPE_BUS_DIR ?? "./bus";

const wrap = (fn: (p: Record<string, unknown>) => Promise<unknown>): ToolFn =>
  async (p) => JSON.parse(JSON.stringify(await fn(p)));

async function main() {
  const config = loadConfig();
  const dbt = config.integrations?.dbt;

  const dbtCfg = dbt ? {
    cloudUrl:          dbt.cloud_url ?? "https://cloud.getdbt.com",
    apiToken:          dbt.api_token ?? "",
    accountId:         dbt.account_id ?? "",
    projectId:         dbt.project_id ?? "",
    localManifestPath: dbt.local_manifest_path ?? "",
    projectPath:       dbt.local_manifest_path
      ? (await import("node:path")).dirname(dbt.local_manifest_path)
      : ".",
  } : null;

  const ghCfg = {
    token:    process.env.GITHUB_TOKEN ?? "",
    repo:     process.env.GITHUB_REPO ?? "",
    baseBranch: config.workflows?.pipeline_whisperer?.base_branch ?? "main",
  };

  if (!dbtCfg) {
    console.warn("[dbt] No dbt Cloud integration configured — read tools will return empty results");
  }

  const registry = new Map<string, ToolFn>([
    ["list_jobs",           wrap(async (_p) => {
      if (!dbtCfg) return { jobs: [] };
      return { jobs: await tools.listJobs(dbtCfg) };
    })],
    ["get_run",             wrap(async (p) => {
      if (!dbtCfg) return {};
      return tools.getRun(dbtCfg, p.run_id as number);
    })],
    ["get_manifest",        wrap(async (p) => {
      if (!dbtCfg) return { models: [] };
      return { models: await tools.getManifest(dbtCfg, p.run_id as number) };
    })],
    ["list_models",         wrap(async (p) => {
      if (!dbtCfg) return { models: [] };
      return { models: await tools.listModels(dbtCfg, p.run_id as number) };
    })],
    ["create_branch",       wrap(async (p) => tools.createBranch(
      ghCfg,
      p.branch_name as string,
      (p.base_branch as string) ?? ghCfg.baseBranch,
    ))],
    ["push_file",           wrap(async (p) => tools.pushFile(
      ghCfg,
      p.branch as string,
      p.file_path as string,
      p.content as string,
      p.message as string,
    ))],
    ["create_pr",           wrap(async (p) => tools.createPullRequest(
      ghCfg,
      p.title as string,
      p.body as string,
      p.head_branch as string,
      (p.base_branch as string) ?? ghCfg.baseBranch,
    ))],
    ["find_affected_models", wrap(async (p) => {
      // Prefer local manifest if available
      let models = p.models as tools.DbtModel[] | undefined;
      if (!models && dbtCfg?.localManifestPath) {
        models = tools.loadLocalManifest(dbtCfg.localManifestPath);
      }
      if (!models) return { models: [], affectedWithReasons: [] };
      const sources = dbtCfg?.localManifestPath ? tools.loadLocalManifestSources(dbtCfg.localManifestPath) : [];
      const changedTables = (p.changed_tables ?? p.changedTables ?? []) as string[];
      const affectedWithReasons = tools.findAffectedModelsWithSources(models as any[], sources, changedTables);
      return {
        models: affectedWithReasons.map(a => a.model),
        affectedWithReasons,
      };
    })],
    ["load_local_manifest",  wrap(async (_p) => {
      if (!dbtCfg?.localManifestPath) return { models: [], sources: [], error: "dbt.local_manifest_path not set in duckpipe.yaml" };
      const models  = tools.loadLocalManifest(dbtCfg.localManifestPath);
      const sources = tools.loadLocalManifestSources(dbtCfg.localManifestPath);
      return { models, sources, model_count: models.length, source_count: sources.length };
    })],
    ["check_recent_changes", wrap(async (p) => {
      const projectPath = (p.project_path as string) ?? dbtCfg?.projectPath ?? ".";
      const hours = (p.lookback_hours as number) ?? 2;
      const changes = tools.checkRecentDbtChanges(projectPath, hours);
      return { changes, count: changes.length };
    })],
    ["get_project_graph", wrap(async (_p) => {
      if (!dbtCfg) return { mode: "cloud", models: [], sources: [] };
      return tools.getProjectGraph(dbtCfg);
    })],
  ]);

  startAgentRuntime({ name: "dbt", busDir: BUS_DIR, tools: registry });
}

main().catch(console.error);
