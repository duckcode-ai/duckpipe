/**
 * dbt agent — dbt Cloud API integration and GitHub PR creation.
 * Manages model drift detection and automated fix PRs.
 */

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

interface DbtModel {
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
