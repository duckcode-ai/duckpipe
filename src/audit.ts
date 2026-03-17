import type Database from "better-sqlite3";
import type { AuditEntry, AuditFilters, DateRange } from "./types.js";
import { getAuditDb } from "./db.js";

let db: Database.Database | null = null;

export function initAudit(dataDir = "./data"): void {
  db = getAuditDb(dataDir);
}

function ensureDb(): Database.Database {
  if (!db) throw new Error("Audit not initialized. Call initAudit() first.");
  return db;
}

export function logAction(entry: AuditEntry): string {
  const d = ensureDb();
  const stmt = d.prepare(`
    INSERT INTO audit_log (workflow, agent, tool, tier, input_json, output_json,
      write_action, approved_by, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    entry.workflow,
    entry.agent,
    entry.tool,
    entry.tier,
    entry.input_json,
    entry.output_json ?? null,
    entry.write_action ? 1 : 0,
    entry.approved_by ?? null,
    entry.duration_ms ?? null,
    entry.success ? 1 : 0,
    entry.error_message ?? null
  );

  const row = d
    .prepare("SELECT id FROM audit_log WHERE rowid = ?")
    .get(result.lastInsertRowid) as { id: string } | undefined;

  if (!row) throw new Error("Failed to retrieve audit log entry id");
  return row.id;
}

export function updateActionOutput(
  id: string,
  outputJson: string,
  durationMs: number,
  success: boolean,
  errorMessage?: string
): void {
  /*
   * The audit_log table has an UPDATE trigger that prevents modifications.
   * We use a companion table to store post-execution results, keeping the
   * original pre-execution record immutable.
   */
  const d = ensureDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS audit_results (
      audit_id TEXT PRIMARY KEY REFERENCES audit_log(id),
      output_json TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL,
      error_message TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    )
  `);

  d.prepare(`
    INSERT OR REPLACE INTO audit_results (audit_id, output_json, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, outputJson, durationMs, success ? 1 : 0, errorMessage ?? null);
}

export function queryAudit(filters: AuditFilters): AuditEntry[] {
  const d = ensureDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.workflow) {
    conditions.push("a.workflow = ?");
    params.push(filters.workflow);
  }
  if (filters.agent) {
    conditions.push("a.agent = ?");
    params.push(filters.agent);
  }
  if (filters.from) {
    conditions.push("a.created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("a.created_at <= ?");
    params.push(filters.to);
  }
  if (filters.write_only) {
    conditions.push("a.write_action = 1");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;

  const rows = d
    .prepare(
      `SELECT a.id, a.created_at, a.workflow, a.agent, a.tool, a.tier,
              a.input_json, a.output_json, a.write_action, a.approved_by,
              a.duration_ms, a.success, a.error_message
       FROM audit_log a ${where}
       ORDER BY a.created_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToAuditEntry);
}

export function exportAuditJSON(dateRange: DateRange): string {
  const entries = queryAudit({
    from: dateRange.from,
    to: dateRange.to,
    limit: 100_000,
  });
  return JSON.stringify(entries, null, 2);
}

export function exportAuditCSV(dateRange: DateRange): string {
  const entries = queryAudit({
    from: dateRange.from,
    to: dateRange.to,
    limit: 100_000,
  });

  const headers = [
    "id", "created_at", "workflow", "agent", "tool", "tier",
    "write_action", "approved_by", "duration_ms", "success", "error_message",
  ];
  const lines = [headers.join(",")];

  for (const e of entries) {
    lines.push(
      [
        e.id, e.created_at, e.workflow, e.agent, e.tool, e.tier,
        e.write_action, e.approved_by ?? "", e.duration_ms ?? "",
        e.success, e.error_message ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  return lines.join("\n");
}

function rowToAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as string,
    created_at: row.created_at as string,
    workflow: row.workflow as string,
    agent: row.agent as string,
    tool: row.tool as string,
    tier: row.tier as 1 | 2 | 3,
    input_json: row.input_json as string,
    output_json: (row.output_json as string) ?? undefined,
    write_action: (row.write_action as number) === 1,
    approved_by: (row.approved_by as string) ?? undefined,
    duration_ms: (row.duration_ms as number) ?? undefined,
    success: (row.success as number) === 1,
    error_message: (row.error_message as string) ?? undefined,
  };
}
