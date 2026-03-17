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
): Promise<AirflowDiagnosis> {
  const dags = await listDags(config);
  const failedDags: string[] = [];
  const evidence: string[] = [];
  let rootCause = "";
  let rootCauseCategory: AirflowDiagnosis["rootCauseCategory"] = "unknown";

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
    writeActionsNeeded:
      rootCauseCategory === "timeout" || rootCauseCategory === "connection_error"
        ? ["trigger_dag_run"]
        : [],
  };
}

function classifyFromLogs(
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
