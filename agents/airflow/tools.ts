/**
 * Airflow agent — typed wrappers around the Airflow REST API.
 * These functions are called by the orchestrator via the bus when the agent
 * receives a task message. Each function maps to one MCP tool.
 */

interface AirflowConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  apiKey?: string;
  allowedDags: string[];
  verifySsl: boolean;
}

interface DagSummary {
  dagId: string;
  isPaused: boolean;
  description: string | null;
  lastRunState: string | null;
  lastRunDate: string | null;
}

interface DagRun {
  dagRunId: string;
  dagId: string;
  state: string;
  executionDate: string;
  startDate: string | null;
  endDate: string | null;
}

interface TaskInstance {
  taskId: string;
  state: string;
  tryNumber: number;
  startDate: string | null;
  endDate: string | null;
  duration: number | null;
}

interface AirflowDiagnosis {
  status: "failure" | "warning" | "healthy";
  affectedDags: string[];
  rootCause: string;
  rootCauseCategory:
    | "timeout"
    | "connection_error"
    | "logic_error"
    | "upstream_dependency"
    | "unknown";
  evidence: string[];
  recommendedAction: string;
  confidence: "high" | "medium" | "low";
  writeActionsNeeded: string[];
  retryCount?: number;
  affectedTables?: string[];
  failedTasks?: Array<{ taskId: string; tryNumber: number; durationSeconds: number | null }>;
  slaBreachImminent?: boolean;
}

function authHeaders(config: AirflowConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  } else if (config.username && config.password) {
    headers["Authorization"] =
      "Basic " +
      Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }
  return headers;
}

function isAllowed(config: AirflowConfig, dagId: string): boolean {
  if (config.allowedDags.length === 0) return true;
  return config.allowedDags.includes(dagId);
}

export async function listDags(config: AirflowConfig): Promise<DagSummary[]> {
  if (!config?.baseUrl) {
    throw new Error("Airflow base_url is not configured");
  }
  const resp = await fetch(`${config.baseUrl}/api/v1/dags?limit=100`, {
    headers: authHeaders(config),
  });
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);

  const data = (await resp.json()) as {
    dags: Array<{
      dag_id: string;
      is_paused: boolean;
      description: string | null;
    }>;
  };

  return data.dags
    .filter((d) => isAllowed(config, d.dag_id))
    .map((d) => ({
      dagId: d.dag_id,
      isPaused: d.is_paused,
      description: d.description,
      lastRunState: null,
      lastRunDate: null,
    }));
}

export async function getDagRuns(
  config: AirflowConfig,
  dagId: string,
  limit = 5
): Promise<DagRun[]> {
  if (!isAllowed(config, dagId)) {
    throw new Error(`DAG ${dagId} is not in the allowed_dags list`);
  }

  const resp = await fetch(
    `${config.baseUrl}/api/v1/dags/${dagId}/dagRuns?limit=${limit}&order_by=-execution_date`,
    { headers: authHeaders(config) }
  );
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);

  const data = (await resp.json()) as {
    dag_runs: Array<{
      dag_run_id: string;
      dag_id: string;
      state: string;
      execution_date: string;
      start_date: string | null;
      end_date: string | null;
    }>;
  };

  return data.dag_runs.map((r) => ({
    dagRunId: r.dag_run_id,
    dagId: r.dag_id,
    state: r.state,
    executionDate: r.execution_date,
    startDate: r.start_date,
    endDate: r.end_date,
  }));
}

export async function getTaskInstances(
  config: AirflowConfig,
  dagId: string,
  dagRunId: string
): Promise<TaskInstance[]> {
  if (!isAllowed(config, dagId)) {
    throw new Error(`DAG ${dagId} is not in the allowed_dags list`);
  }

  const resp = await fetch(
    `${config.baseUrl}/api/v1/dags/${dagId}/dagRuns/${dagRunId}/taskInstances`,
    { headers: authHeaders(config) }
  );
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);

  const data = (await resp.json()) as {
    task_instances: Array<{
      task_id: string;
      state: string;
      try_number: number;
      start_date: string | null;
      end_date: string | null;
      duration: number | null;
    }>;
  };

  return data.task_instances.map((t) => ({
    taskId: t.task_id,
    state: t.state,
    tryNumber: t.try_number,
    startDate: t.start_date,
    endDate: t.end_date,
    duration: t.duration,
  }));
}

export async function getTaskLogs(
  config: AirflowConfig,
  dagId: string,
  dagRunId: string,
  taskId: string,
  tryNumber = 1
): Promise<string> {
  if (!isAllowed(config, dagId)) {
    throw new Error(`DAG ${dagId} is not in the allowed_dags list`);
  }

  const resp = await fetch(
    `${config.baseUrl}/api/v1/dags/${dagId}/dagRuns/${dagRunId}/taskInstances/${taskId}/logs/${tryNumber}`,
    { headers: { ...authHeaders(config), Accept: "text/plain" } }
  );
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);
  return resp.text();
}

export async function triggerDagRun(
  config: AirflowConfig,
  dagId: string,
  conf: Record<string, unknown> = {}
): Promise<DagRun> {
  if (!isAllowed(config, dagId)) {
    throw new Error(`DAG ${dagId} is not in the allowed_dags list`);
  }

  const resp = await fetch(
    `${config.baseUrl}/api/v1/dags/${dagId}/dagRuns`,
    {
      method: "POST",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conf }),
    }
  );
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);

  const data = (await resp.json()) as {
    dag_run_id: string;
    dag_id: string;
    state: string;
    execution_date: string;
    start_date: string | null;
    end_date: string | null;
  };

  return {
    dagRunId: data.dag_run_id,
    dagId: data.dag_id,
    state: data.state,
    executionDate: data.execution_date,
    startDate: data.start_date,
    endDate: data.end_date,
  };
}

export async function clearTask(
  config: AirflowConfig,
  dagId: string,
  dagRunId: string,
  taskId: string
): Promise<void> {
  if (!isAllowed(config, dagId)) {
    throw new Error(`DAG ${dagId} is not in the allowed_dags list`);
  }

  const resp = await fetch(
    `${config.baseUrl}/api/v1/dags/${dagId}/clearTaskInstances`,
    {
      method: "POST",
      headers: {
        ...authHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dry_run: false,
        task_ids: [taskId],
        dag_run_id: dagRunId,
      }),
    }
  );
  if (!resp.ok) throw new Error(`Airflow API error: ${resp.status}`);
}

export async function checkFailures(
  config: AirflowConfig
): Promise<AirflowDiagnosis & { unreachable?: boolean }> {
  if (!config?.baseUrl) {
    return {
      status: "healthy",
      unreachable: true,
      affectedDags: [],
      rootCause: "Airflow unreachable: base_url is not configured",
      rootCauseCategory: "connection_error",
      evidence: [],
      recommendedAction: "Set integrations.airflow.base_url in duckpipe.yaml or .env",
      confidence: "high",
      writeActionsNeeded: [],
    };
  }
  let dags;
  try {
    dags = await listDags(config);
  } catch (err) {
    // Airflow is down or credentials are wrong — this is not a pipeline incident.
    // Return a structured "unreachable" response so the orchestrator can skip cleanly.
    return {
      status: "healthy",
      unreachable: true,
      affectedDags: [],
      rootCause: `Airflow unreachable: ${err instanceof Error ? err.message : String(err)}`,
      rootCauseCategory: "connection_error",
      evidence: [],
      recommendedAction: "Check that Airflow is running and credentials in .env are correct",
      confidence: "high",
      writeActionsNeeded: [],
    };
  }
  const failedDags: string[] = [];
  const evidence: string[] = [];
  const affectedTables = new Set<string>();
  const failedTaskSummaries: Array<{ taskId: string; tryNumber: number; durationSeconds: number | null }> = [];
  let rootCause = "";
  let rootCauseCategory: AirflowDiagnosis["rootCauseCategory"] = "unknown";
  let retryCount = 0;
  let slaBreachImminent = false;

  for (const dag of dags) {
    const runs = await getDagRuns(config, dag.dagId, 1);
    if (runs.length === 0) continue;

    const latestRun = runs[0];
    if (latestRun.state !== "failed") continue;

    failedDags.push(dag.dagId);

    const tasks = await getTaskInstances(
      config,
      dag.dagId,
      latestRun.dagRunId
    );
    const failedTasks = tasks.filter((t) => t.state === "failed");

    for (const task of failedTasks.slice(0, 3)) {
      retryCount = Math.max(retryCount, Math.max(0, task.tryNumber - 1));
      if ((task.duration ?? 0) > 3600) slaBreachImminent = true;
      failedTaskSummaries.push({ taskId: task.taskId, tryNumber: task.tryNumber, durationSeconds: task.duration });
      try {
        const logs = await getTaskLogs(
          config,
          dag.dagId,
          latestRun.dagRunId,
          task.taskId,
          task.tryNumber
        );
        const snippet = logs.slice(-200);
        evidence.push(snippet);
        for (const table of extractTableRefs(logs)) {
          affectedTables.add(table);
        }

        const { cause, category } = classifyFromLogs(logs);
        rootCause = cause;
        rootCauseCategory = category;
      } catch {
        evidence.push(`Failed to fetch logs for ${task.taskId}`);
      }
    }
  }

  if (failedDags.length === 0) {
    return {
      status: "healthy",
      affectedDags: [],
      rootCause: "All DAGs are healthy",
      rootCauseCategory: "unknown",
      evidence: [],
      recommendedAction: "No action needed",
      confidence: "high",
      writeActionsNeeded: [],
    };
  }

  return {
    status: "failure",
    affectedDags: failedDags,
    rootCause: rootCause || "Could not determine root cause",
    rootCauseCategory,
    evidence: evidence.slice(0, 3),
    recommendedAction: getRecommendation(rootCauseCategory),
    confidence: rootCause ? "high" : "low",
    retryCount,
    affectedTables: [...affectedTables],
    failedTasks: failedTaskSummaries,
    slaBreachImminent,
    writeActionsNeeded:
      rootCauseCategory === "timeout" || rootCauseCategory === "connection_error"
        ? ["trigger_dag_run"]
        : [],
  };
}

export async function getRunningDags(
  config: AirflowConfig,
  monitoredDags: string[] = []
): Promise<Array<{
  dagId: string;
  elapsedSeconds: number;
  historicalP95Seconds: number;
  slaDeadline: string;
}>> {
  const dags = await listDags(config);
  const selected = monitoredDags.length > 0
    ? dags.filter((dag) => monitoredDags.includes(dag.dagId))
    : dags;

  const runningDags: Array<{
    dagId: string;
    elapsedSeconds: number;
    historicalP95Seconds: number;
    slaDeadline: string;
  }> = [];

  for (const dag of selected.slice(0, 50)) {
    try {
      const runs = await getDagRuns(config, dag.dagId, 5);
      const activeRun = runs.find((run) => run.state === "running" || run.state === "queued");
      if (!activeRun) continue;

      const startedAt = activeRun.startDate ? new Date(activeRun.startDate).getTime() : new Date(activeRun.executionDate).getTime();
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const historicalP95Seconds = 3600;
      const slaDeadline = new Date(startedAt + historicalP95Seconds * 1000).toISOString();

      runningDags.push({
        dagId: dag.dagId,
        elapsedSeconds,
        historicalP95Seconds,
        slaDeadline,
      });
    } catch {
      // Ignore per-DAG lookup failures so the rest of the check can continue.
    }
  }

  return runningDags;
}

function extractTableRefs(logs: string): string[] {
  const matches = logs.match(/\b(?:[A-Za-z_][A-Za-z0-9_]*\.){1,2}[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  return [...new Set(matches)].slice(0, 10);
}

export function classifyFromLogs(
  logs: string
): { cause: string; category: AirflowDiagnosis["rootCauseCategory"] } {
  const lower = logs.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      cause: "API or database connection timed out",
      category: "timeout",
    };
  }
  if (
    lower.includes("connectionerror") ||
    lower.includes("connection refused") ||
    lower.includes("connecttimeout")
  ) {
    return {
      cause: "Connection to upstream service failed",
      category: "connection_error",
    };
  }
  if (
    lower.includes("keyerror") ||
    lower.includes("typeerror") ||
    lower.includes("valueerror") ||
    lower.includes("assertionerror")
  ) {
    return {
      cause: "Logic error in task code",
      category: "logic_error",
    };
  }
  if (
    lower.includes("sql compilation error") ||
    lower.includes("object does not exist") ||
    lower.includes("does not exist, or operation cannot be performed") ||
    lower.includes("not authorized") ||
    lower.includes("insufficient privileges")
  ) {
    return {
      cause: "Referenced Snowflake object is missing or inaccessible",
      category: "upstream_dependency",
    };
  }
  if (
    lower.includes("upstream") ||
    lower.includes("dependency") ||
    lower.includes("sensor")
  ) {
    return {
      cause: "Upstream dependency not met",
      category: "upstream_dependency",
    };
  }
  return { cause: "Unknown failure — manual investigation needed", category: "unknown" };
}

function getRecommendation(
  category: AirflowDiagnosis["rootCauseCategory"]
): string {
  switch (category) {
    case "timeout":
      return "Retry after checking upstream service health";
    case "connection_error":
      return "Check network connectivity and service availability";
    case "logic_error":
      return "Review task code for bugs — do not auto-retry";
    case "upstream_dependency":
      return "Check upstream DAG status and data freshness";
    default:
      return "Investigate manually — root cause unclear";
  }
}
