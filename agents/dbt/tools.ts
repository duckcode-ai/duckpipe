/**
 * dbt agent — dbt Cloud API integration and GitHub PR creation.
 * Manages model drift detection and automated fix PRs.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

interface DbtConfig {
  cloudUrl: string;
  apiToken: string;
  accountId: string;
  projectId: string;
}

interface GitHubConfig {
  token: string;
  repo: string;
}

interface DbtJob {
  id: number;
  name: string;
  state: number;
  cronSchedule: string | null;
}

interface DbtRun {
  id: number;
  jobId: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  duration: string;
  gitSha: string;
}

export interface DbtModel {
  uniqueId: string;
  name: string;
  schema: string;
  database: string;
  description: string;
  columns: Array<{
    name: string;
    description: string;
    type: string;
    tests: string[];
  }>;
  dependsOn: string[];
  filePath: string;
}

function dbtHeaders(config: DbtConfig): Record<string, string> {
  return {
    Authorization: `Token ${config.apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function ghHeaders(config: GitHubConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── dbt Cloud API ─────────────────────────────────────

export async function listJobs(config: DbtConfig): Promise<DbtJob[]> {
  const resp = await fetch(
    `${config.cloudUrl}/api/v2/accounts/${config.accountId}/jobs/?project_id=${config.projectId}`,
    { headers: dbtHeaders(config) }
  );
  if (!resp.ok) throw new Error(`dbt API error: ${resp.status}`);

  const data = (await resp.json()) as {
    data: Array<{
      id: number;
      name: string;
      state: number;
      triggers: { schedule: boolean; schedule_cron: string | null };
    }>;
  };

  return data.data.map((j) => ({
    id: j.id,
    name: j.name,
    state: j.state,
    cronSchedule: j.triggers?.schedule_cron ?? null,
  }));
}

export async function getRun(
  config: DbtConfig,
  runId: number
): Promise<DbtRun> {
  const resp = await fetch(
    `${config.cloudUrl}/api/v2/accounts/${config.accountId}/runs/${runId}/`,
    { headers: dbtHeaders(config) }
  );
  if (!resp.ok) throw new Error(`dbt API error: ${resp.status}`);

  const data = (await resp.json()) as {
    data: {
      id: number;
      job_id: number;
      status_humanized: string;
      started_at: string;
      finished_at: string | null;
      duration: string;
      git_sha: string;
    };
  };

  const r = data.data;
  return {
    id: r.id,
    jobId: r.job_id,
    status: r.status_humanized,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    duration: r.duration,
    gitSha: r.git_sha,
  };
}

export async function getManifest(
  config: DbtConfig,
  runId: number
): Promise<DbtModel[]> {
  const resp = await fetch(
    `${config.cloudUrl}/api/v2/accounts/${config.accountId}/runs/${runId}/artifacts/manifest.json`,
    { headers: dbtHeaders(config) }
  );
  if (!resp.ok) throw new Error(`dbt API error: ${resp.status}`);

  const manifest = (await resp.json()) as {
    nodes: Record<
      string,
      {
        unique_id: string;
        name: string;
        schema: string;
        database: string;
        description: string;
        columns: Record<
          string,
          {
            name: string;
            description: string;
            data_type: string;
            tests: Array<{ test_metadata?: { name: string } }>;
          }
        >;
        depends_on: { nodes: string[] };
        path: string;
        resource_type: string;
      }
    >;
  };

  return Object.values(manifest.nodes)
    .filter((n) => n.resource_type === "model")
    .map((n) => ({
      uniqueId: n.unique_id,
      name: n.name,
      schema: n.schema,
      database: n.database,
      description: n.description,
      columns: Object.values(n.columns).map((c) => ({
        name: c.name,
        description: c.description,
        type: c.data_type ?? "",
        tests: (c.tests ?? [])
          .map((t) => t.test_metadata?.name ?? "")
          .filter(Boolean),
      })),
      dependsOn: n.depends_on?.nodes ?? [],
      filePath: n.path,
    }));
}

export async function listModels(
  config: DbtConfig,
  runId: number
): Promise<DbtModel[]> {
  return getManifest(config, runId);
}

// ── GitHub API ────────────────────────────────────────

export async function createBranch(
  config: GitHubConfig,
  branchName: string,
  baseBranch = "main"
): Promise<{ ref: string }> {
  // Get the SHA of the base branch
  const refResp = await fetch(
    `https://api.github.com/repos/${config.repo}/git/ref/heads/${baseBranch}`,
    { headers: ghHeaders(config) }
  );
  if (!refResp.ok) throw new Error(`GitHub API error: ${refResp.status}`);

  const refData = (await refResp.json()) as {
    object: { sha: string };
  };

  const resp = await fetch(
    `https://api.github.com/repos/${config.repo}/git/refs`,
    {
      method: "POST",
      headers: ghHeaders(config),
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: refData.object.sha,
      }),
    }
  );
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  return (await resp.json()) as { ref: string };
}

export async function pushFile(
  config: GitHubConfig,
  branch: string,
  filePath: string,
  content: string,
  message: string
): Promise<{ sha: string }> {
  // Check if file exists
  let existingSha: string | undefined;
  try {
    const getResp = await fetch(
      `https://api.github.com/repos/${config.repo}/contents/${filePath}?ref=${branch}`,
      { headers: ghHeaders(config) }
    );
    if (getResp.ok) {
      const getData = (await getResp.json()) as { sha: string };
      existingSha = getData.sha;
    }
  } catch {
    // File doesn't exist, that's fine
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const resp = await fetch(
    `https://api.github.com/repos/${config.repo}/contents/${filePath}`,
    {
      method: "PUT",
      headers: ghHeaders(config),
      body: JSON.stringify(body),
    }
  );
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  return (await resp.json()) as { sha: string };
}

export async function createPullRequest(
  config: GitHubConfig,
  title: string,
  body: string,
  headBranch: string,
  baseBranch = "main"
): Promise<{ number: number; html_url: string }> {
  const resp = await fetch(
    `https://api.github.com/repos/${config.repo}/pulls`,
    {
      method: "POST",
      headers: ghHeaders(config),
      body: JSON.stringify({
        title,
        body,
        head: headBranch,
        base: baseBranch,
      }),
    }
  );
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  return (await resp.json()) as { number: number; html_url: string };
}

// ── Drift detection helpers ───────────────────────────

export function findAffectedModels(
  models: DbtModel[],
  changedTables: string[]
): DbtModel[] {
  const changedSet = new Set(changedTables.map((t) => t.toLowerCase()));

  return models.filter((m) => {
    for (const dep of m.dependsOn) {
      const parts = dep.split(".");
      const tableName = parts[parts.length - 1];
      if (changedSet.has(tableName.toLowerCase())) return true;
      if (changedSet.has(dep.toLowerCase())) return true;
    }
    return false;
  });
}

export function generateBranchName(description: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  return `duckpipe/${date}/${slug}`;
}

// ── Local manifest.json support ───────────────────────
// Reads a dbt manifest.json from disk — works for local dbt projects
// without needing a dbt Cloud account.

export function loadLocalManifest(manifestPath: string): DbtModel[] {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `dbt manifest.json not found at: ${manifestPath}\n` +
      "Run 'dbt compile' or 'dbt parse' in your dbt project to generate it.\n" +
      "Then set dbt.local_manifest_path in duckpipe.yaml to point to it."
    );
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as {
    nodes: Record<string, {
      unique_id: string;
      name: string;
      schema: string;
      database: string;
      description: string;
      columns: Record<string, {
        name: string;
        description: string;
        data_type?: string;
        tests?: Array<{ test_metadata?: { name: string } }>;
      }>;
      depends_on: { nodes: string[] };
      path: string;
      resource_type: string;
      refs?: Array<{ name: string }>;
      sources?: Array<[string, string]>;
    }>;
    sources?: Record<string, {
      unique_id: string;
      name: string;
      schema: string;
      database: string;
      identifier: string;
      source_name: string;
      resource_type: string;
    }>;
  };

  return Object.values(manifest.nodes)
    .filter((n) => n.resource_type === "model")
    .map((n) => ({
      uniqueId: n.unique_id,
      name: n.name,
      schema: n.schema,
      database: n.database,
      description: n.description,
      columns: Object.values(n.columns ?? {}).map((c) => ({
        name: c.name,
        description: c.description ?? "",
        type: c.data_type ?? "",
        tests: (c.tests ?? []).map((t) => t.test_metadata?.name ?? "").filter(Boolean),
      })),
      dependsOn: n.depends_on?.nodes ?? [],
      filePath: n.path,
      // Also include source refs for better table matching
      sourceRefs: (n.sources ?? []).map(([src, tbl]) => `${src}.${tbl}`),
    }));
}

export interface ManifestSource {
  uniqueId: string;
  sourceName: string;
  schema: string;
  database: string;
  table: string;
}

export function loadLocalManifestSources(manifestPath: string): ManifestSource[] {
  if (!existsSync(manifestPath)) return [];

  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as {
    sources?: Record<string, {
      unique_id: string;
      source_name: string;
      schema: string;
      database: string;
      identifier: string;
      resource_type: string;
    }>;
  };

  return Object.values(manifest.sources ?? {})
    .filter((s) => s.resource_type === "source")
    .map((s) => ({
      uniqueId: s.unique_id,
      sourceName: s.source_name,
      schema: s.schema,
      database: s.database,
      table: s.identifier,
    }));
}

export async function getLatestRunIdForProject(config: DbtConfig): Promise<number | null> {
  const resp = await fetch(
    `${config.cloudUrl}/api/v2/accounts/${config.accountId}/runs/?project_id=${config.projectId}&order_by=-id&limit=1`,
    { headers: dbtHeaders(config) }
  );
  if (!resp.ok) throw new Error(`dbt API error: ${resp.status}`);

  const data = (await resp.json()) as {
    data?: Array<{ id: number }>;
  };
  return data.data?.[0]?.id ?? null;
}

export async function getProjectGraph(config: DbtConfig & { localManifestPath?: string }): Promise<{
  mode: "local" | "cloud";
  models: DbtModel[];
  sources: ManifestSource[];
}> {
  if (config.localManifestPath) {
    return {
      mode: "local",
      models: loadLocalManifest(config.localManifestPath),
      sources: loadLocalManifestSources(config.localManifestPath),
    };
  }

  const latestRunId = await getLatestRunIdForProject(config);
  if (!latestRunId) {
    return { mode: "cloud", models: [], sources: [] };
  }

  const models = await getManifest(config, latestRunId);
  return { mode: "cloud", models, sources: [] };
}

// Find models that depend on specific changed tables.
// Enhanced version: also matches source nodes from manifest.sources.
export function findAffectedModelsWithSources(
  models: (DbtModel & { sourceRefs?: string[] })[],
  sources: ManifestSource[],
  changedTables: string[]   // format: "DATABASE.SCHEMA.TABLE" or just "TABLE"
): { model: DbtModel; reason: string }[] {
  const lower = (s: string) => s.toLowerCase();

  // Build a set of all identifiers for changed tables
  const changedIds = new Set<string>();
  for (const t of changedTables) {
    const parts = t.split(".");
    changedIds.add(lower(t));
    changedIds.add(lower(parts[parts.length - 1])); // just table name
    if (parts.length >= 2) changedIds.add(lower(parts.slice(-2).join("."))); // schema.table
  }

  // Map source unique_ids to their table names for matching depends_on nodes
  const sourceTableMap = new Map<string, string>();
  for (const src of sources) {
    const fullName = `${src.database}.${src.schema}.${src.table}`;
    sourceTableMap.set(lower(src.uniqueId), fullName);
    sourceTableMap.set(lower(`source.${src.sourceName}.${src.table}`), fullName);
  }

  const affected: { model: DbtModel; reason: string }[] = [];

  for (const model of models) {
    for (const dep of model.dependsOn) {
      const depLower = lower(dep);

      // Direct match on table name
      if (changedIds.has(depLower)) {
        affected.push({ model, reason: `directly depends on changed table: ${dep}` });
        break;
      }

      // Source node match — dep is like "source.myproject.orders"
      const sourceFull = sourceTableMap.get(depLower);
      if (sourceFull) {
        const sourceTableOnly = lower(sourceFull.split(".").pop() ?? "");
        const sourceSchemaTable = lower(sourceFull.split(".").slice(-2).join("."));
        if (changedIds.has(lower(sourceFull)) || changedIds.has(sourceTableOnly) || changedIds.has(sourceSchemaTable)) {
          affected.push({ model, reason: `depends on source ${dep} (${sourceFull}) which changed` });
          break;
        }
      }
    }
  }

  return affected;
}

export interface RecentDbtChange {
  type: "model_modified" | "schema_test_added" | "source_modified";
  name: string;
  filePath: string;
  description: string;
}

// Scan the local dbt project directory for recently git-modified files
export function checkRecentDbtChanges(
  projectPath: string,
  lookbackHours = 2
): RecentDbtChange[] {
  try {
    const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
    const output = execSync(
      `git -C "${projectPath}" log --since="${since}" --name-only --pretty=format: --diff-filter=AM`,
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
    );

    const changes: RecentDbtChange[] = [];
    for (const line of output.split("\n")) {
      const f = line.trim();
      if (!f) continue;
      if (f.endsWith(".sql") && (f.includes("/models/") || f.includes("models/"))) {
        const name = f.split("/").pop()?.replace(".sql", "") ?? f;
        changes.push({ type: "model_modified", name, filePath: f, description: `dbt model ${name} was modified in the last ${lookbackHours}h` });
      } else if (f.endsWith(".yml") && (f.includes("/models/") || f.includes("sources"))) {
        changes.push({ type: "schema_test_added", name: f.split("/").pop() ?? f, filePath: f, description: `Schema/test file ${f} was modified` });
      }
    }
    return changes;
  } catch {
    return [];
  }
}
