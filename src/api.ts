import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { getStateDb, getAuditDb } from "./db.js";
import { queryAudit, exportAuditJSON, exportAuditCSV } from "./audit.js";
import { getRunningAgents, isAgentRunning } from "./docker.js";
import { setCorsHeaders } from "./server.js";
import type { DuckpipeConfig } from "./types.js";

let config: DuckpipeConfig | null = null;
let startTime = Date.now();

export const apiEvents = new EventEmitter();
apiEvents.setMaxListeners(100);

export function setApiConfig(cfg: DuckpipeConfig): void {
  config = cfg;
  startTime = Date.now();
}

export function emitDashboardEvent(type: string, data: Record<string, unknown>): void {
  apiEvents.emit("sse", { type, data, timestamp: new Date().toISOString() });
}

export function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (!path.startsWith("/api/")) return false;

  setCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");

  try {
    if (path === "/api/health") return sendJson(res, getHealth());
    if (path === "/api/health/live") return sendJson(res, { status: "ok" });
    if (path === "/api/health/ready") return sendJson(res, getReadiness());
    if (path === "/api/workflows") return sendJson(res, getWorkflows(url));
    if (path.match(/^\/api\/workflows\/[^/]+\/runs$/)) {
      const name = path.split("/")[3];
      return sendJson(res, getWorkflowRuns(name, url));
    }
    if (path === "/api/incidents") return sendJson(res, getIncidents(url));
    if (path === "/api/costs") return sendJson(res, getCosts(url));
    if (path === "/api/pipelines") return sendJson(res, getPipelines(url));
    if (path === "/api/audit") return sendJson(res, getAuditData(url));
    if (path === "/api/audit/export") return handleAuditExport(url, res);
    if (path === "/api/config") return sendJson(res, getConfigSafe());
    if (path === "/api/approvals") return sendJson(res, getApprovals(url));
    if (path === "/api/agents") return sendJson(res, getAgentStatus());
    if (path === "/api/events") return handleSSE(req, res);

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
  return true;
}

function sendJson(res: ServerResponse, data: unknown): boolean {
  res.writeHead(200);
  res.end(JSON.stringify(data));
  return true;
}

function getDays(url: URL): number {
  return parseInt(url.searchParams.get("days") ?? "7", 10);
}

function getHealth() {
  const stateDb = getStateDb();
  const auditDb = getAuditDb();
  const uptimeMs = Date.now() - startTime;

  const activeWorkflows = stateDb
    .prepare("SELECT DISTINCT workflow FROM workflow_runs WHERE status = 'running'")
    .all() as Array<{ workflow: string }>;

  const todayIncidents = stateDb
    .prepare(
      `SELECT COUNT(*) as count FROM workflow_runs
       WHERE workflow = 'incident-autopilot'
       AND started_at >= date('now')
       AND result_json LIKE '%failure%'`
    )
    .get() as { count: number };

  const totalActions = auditDb
    .prepare("SELECT COUNT(*) as count FROM audit_log")
    .get() as { count: number };

  const recentRuns = stateDb
    .prepare(
      `SELECT workflow, status, started_at, completed_at
       FROM workflow_runs ORDER BY started_at DESC LIMIT 20`
    )
    .all();

  const integrations: Record<string, boolean> = {};
  if (config) {
    for (const [key, val] of Object.entries(config.integrations)) {
      integrations[key] = !!(val as { enabled?: boolean } | undefined)?.enabled;
    }
  }

  return {
    uptime_ms: uptimeMs,
    uptime_human: formatUptime(uptimeMs),
    trust_tier: config?.duckpipe.trust_tier ?? 1,
    team_name: config?.duckpipe.name ?? "unknown",
    active_workflows: activeWorkflows.map((w) => w.workflow),
    incidents_today: todayIncidents.count,
    total_audit_actions: totalActions.count,
    integrations,
    recent_runs: recentRuns,
  };
}

function getWorkflows(url: URL) {
  const days = getDays(url);
  const stateDb = getStateDb();

  const workflows = [
    "incident-autopilot", "cost-sentinel", "sla-guardian",
    "pipeline-whisperer", "knowledge-scribe", "query-sage",
  ];

  return workflows.map((wf) => {
    const runs = stateDb
      .prepare(
        `SELECT id, status, started_at, completed_at, error_message
         FROM workflow_runs
         WHERE workflow = ? AND started_at >= datetime('now', '-' || ? || ' days')
         ORDER BY started_at DESC LIMIT 50`
      )
      .all(wf, days) as Array<Record<string, unknown>>;

    const lastRun = runs[0];
    const successCount = runs.filter((r) => r.status === "completed").length;
    const failCount = runs.filter((r) => r.status === "failed").length;

    const enabled = config?.workflows
      ? !!(config.workflows as Record<string, { enabled?: boolean }>)[wf.replace(/-/g, "_")]?.enabled
      : false;

    return {
      name: wf,
      enabled,
      last_run: lastRun
        ? { status: lastRun.status, started_at: lastRun.started_at, completed_at: lastRun.completed_at }
        : null,
      total_runs: runs.length,
      success_count: successCount,
      fail_count: failCount,
      runs: runs.slice(0, 10),
    };
  });
}

function getWorkflowRuns(name: string, url: URL) {
  const days = getDays(url);
  const stateDb = getStateDb();

  const runs = stateDb
    .prepare(
      `SELECT id, workflow, status, started_at, completed_at, result_json, error_message
       FROM workflow_runs
       WHERE workflow = ? AND started_at >= datetime('now', '-' || ? || ' days')
       ORDER BY started_at DESC LIMIT 200`
    )
    .all(name, days);

  return { workflow: name, days, runs };
}

function getIncidents(url: URL) {
  const days = getDays(url);
  const stateDb = getStateDb();
  const auditDb = getAuditDb();

  const runs = stateDb
    .prepare(
      `SELECT id, status, started_at, completed_at, result_json, error_message
       FROM workflow_runs
       WHERE workflow = 'incident-autopilot'
       AND started_at >= datetime('now', '-' || ? || ' days')
       ORDER BY started_at DESC LIMIT 200`
    )
    .all(days) as Array<Record<string, unknown>>;

  const incidents = runs.map((r) => {
    let result: Record<string, unknown> = {};
    try {
      result = r.result_json ? JSON.parse(r.result_json as string) : {};
    } catch { /* empty */ }
    return { ...r, parsed_result: result };
  });

  // Daily counts for chart
  const dailyCounts = stateDb
    .prepare(
      `SELECT date(started_at) as day, COUNT(*) as count
       FROM workflow_runs
       WHERE workflow = 'incident-autopilot'
       AND started_at >= datetime('now', '-' || ? || ' days')
       GROUP BY date(started_at) ORDER BY day`
    )
    .all(days);

  // Actions by agent
  const agentActions = auditDb
    .prepare(
      `SELECT agent, COUNT(*) as count
       FROM audit_log
       WHERE workflow = 'incident-autopilot'
       AND created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY agent`
    )
    .all(days);

  return { incidents, daily_counts: dailyCounts, agent_actions: agentActions, days };
}

function getCosts(url: URL) {
  const days = getDays(url);
  const stateDb = getStateDb();
  const auditDb = getAuditDb();

  const runs = stateDb
    .prepare(
      `SELECT id, status, started_at, completed_at, result_json
       FROM workflow_runs
       WHERE workflow = 'cost-sentinel'
       AND started_at >= datetime('now', '-' || ? || ' days')
       ORDER BY started_at DESC LIMIT 200`
    )
    .all(days) as Array<Record<string, unknown>>;

  const costData = runs.map((r) => {
    let result: Record<string, unknown> = {};
    try { result = r.result_json ? JSON.parse(r.result_json as string) : {}; } catch { /* empty */ }
    return { ...r, parsed_result: result };
  });

  const dailyCounts = stateDb
    .prepare(
      `SELECT date(started_at) as day, COUNT(*) as count
       FROM workflow_runs
       WHERE workflow = 'cost-sentinel'
       AND started_at >= datetime('now', '-' || ? || ' days')
       GROUP BY date(started_at) ORDER BY day`
    )
    .all(days);

  const killActions = auditDb
    .prepare(
      `SELECT * FROM audit_log
       WHERE workflow = 'cost-sentinel' AND write_action = 1
       AND created_at >= datetime('now', '-' || ? || ' days')
       ORDER BY created_at DESC`
    )
    .all(days);

  return { cost_runs: costData, daily_counts: dailyCounts, kill_actions: killActions, days };
}

function getPipelines(url: URL) {
  const days = getDays(url);
  const stateDb = getStateDb();

  const runHistory = stateDb
    .prepare(
      `SELECT dag_id, run_id, duration_seconds, status, recorded_at
       FROM run_history
       WHERE recorded_at >= datetime('now', '-' || ? || ' days')
       ORDER BY recorded_at DESC LIMIT 500`
    )
    .all(days);

  const schemaChanges = stateDb
    .prepare(
      `SELECT database_name, schema_name, table_name, captured_at
       FROM schema_snapshots
       WHERE captured_at >= datetime('now', '-' || ? || ' days')
       ORDER BY captured_at DESC LIMIT 100`
    )
    .all(days);

  const slaRuns = stateDb
    .prepare(
      `SELECT id, status, started_at, completed_at, result_json
       FROM workflow_runs
       WHERE workflow = 'sla-guardian'
       AND started_at >= datetime('now', '-' || ? || ' days')
       ORDER BY started_at DESC LIMIT 100`
    )
    .all(days) as Array<Record<string, unknown>>;

  const whisperRuns = stateDb
    .prepare(
      `SELECT id, status, started_at, completed_at, result_json
       FROM workflow_runs
       WHERE workflow = 'pipeline-whisperer'
       AND started_at >= datetime('now', '-' || ? || ' days')
       ORDER BY started_at DESC LIMIT 100`
    )
    .all(days);

  return {
    run_history: runHistory,
    schema_changes: schemaChanges,
    sla_runs: slaRuns,
    whisperer_runs: whisperRuns,
    days,
  };
}

function getAuditData(url: URL) {
  const days = getDays(url);
  const workflow = url.searchParams.get("workflow") || undefined;
  const agent = url.searchParams.get("agent") || undefined;
  const writeOnly = url.searchParams.get("write_only") === "true";
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);

  const from = new Date(Date.now() - days * 86400000).toISOString();
  const entries = queryAudit({ workflow, agent, from, write_only: writeOnly, limit });

  const auditDb = getAuditDb();
  const workflowCounts = auditDb
    .prepare(
      `SELECT workflow, COUNT(*) as count FROM audit_log
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY workflow ORDER BY count DESC`
    )
    .all(days);

  const agentCounts = auditDb
    .prepare(
      `SELECT agent, COUNT(*) as count FROM audit_log
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY agent ORDER BY count DESC`
    )
    .all(days);

  return { entries, workflow_counts: workflowCounts, agent_counts: agentCounts, days };
}

function handleAuditExport(url: URL, res: ServerResponse): boolean {
  const format = url.searchParams.get("format") ?? "json";
  const days = getDays(url);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date().toISOString();

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=duckpipe-audit.csv");
    res.writeHead(200);
    res.end(exportAuditCSV({ from, to }));
  } else {
    res.writeHead(200);
    res.end(exportAuditJSON({ from, to }));
  }
  return true;
}

function getConfigSafe() {
  if (!config) return { error: "Config not loaded" };

  const safe = JSON.parse(JSON.stringify(config));
  // Redact secrets
  const redact = (obj: Record<string, unknown>) => {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string" && (obj[key] as string).startsWith("${")) {
        obj[key] = "••••••";
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        redact(obj[key] as Record<string, unknown>);
      }
    }
  };
  redact(safe);
  return safe;
}

function getReadiness() {
  try {
    const stateDb = getStateDb();
    stateDb.prepare("SELECT 1").get();
    const agents = getRunningAgents();
    return {
      status: agents.length > 0 ? "ready" : "degraded",
      agents_running: agents,
      db: "ok",
    };
  } catch {
    return { status: "not_ready", agents_running: [], db: "error" };
  }
}

function getAgentStatus() {
  const agents = ["airflow", "dbt", "snowflake", "comms"] as const;
  return agents.map(name => ({
    name,
    running: isAgentRunning(name),
  }));
}

function getApprovals(url: URL) {
  const days = getDays(url);
  const auditDb = getAuditDb();

  const approvals = auditDb
    .prepare(
      `SELECT id, created_at, workflow, agent, tool, tier, input_json,
              approved_by, success, error_message
       FROM audit_log
       WHERE write_action = 1
       AND created_at >= datetime('now', '-' || ? || ' days')
       ORDER BY created_at DESC LIMIT 200`
    )
    .all(days) as Array<Record<string, unknown>>;

  const pending = approvals.filter(a => !a.approved_by);
  const completed = approvals.filter(a => !!a.approved_by);

  return { pending, completed, total: approvals.length, days };
}

function handleSSE(req: IncomingMessage, res: ServerResponse): boolean {
  setCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write("data: {\"type\":\"connected\"}\n\n");

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  const onEvent = (event: { type: string; data: unknown; timestamp: string }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  apiEvents.on("sse", onEvent);

  req.on("close", () => {
    clearInterval(heartbeat);
    apiEvents.off("sse", onEvent);
  });

  return true;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
