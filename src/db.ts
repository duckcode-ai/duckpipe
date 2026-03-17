import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

let stateDb: Database.Database | null = null;
let auditDb: Database.Database | null = null;

const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_source TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  completed_at TEXT,
  result_json TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE IF NOT EXISTS dedup (
  dedup_key TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dedup_expires ON dedup(expires_at);

CREATE TABLE IF NOT EXISTS schema_snapshots (
  id TEXT PRIMARY KEY,
  database_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_schema_snapshots_table
  ON schema_snapshots(database_name, schema_name, table_name);

CREATE TABLE IF NOT EXISTS run_history (
  id TEXT PRIMARY KEY,
  dag_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  status TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_run_history_dag ON run_history(dag_id);

CREATE TABLE IF NOT EXISTS confluence_pages (
  model_name TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  last_written_at TEXT NOT NULL,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS incident_chat_messages (
  id TEXT PRIMARY KEY,
  incident_run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  FOREIGN KEY (incident_run_id) REFERENCES workflow_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_incident_chat_messages_run
  ON incident_chat_messages(incident_run_id, created_at);

CREATE TABLE IF NOT EXISTS incident_workspaces (
  incident_run_id TEXT PRIMARY KEY,
  workspace_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  FOREIGN KEY (incident_run_id) REFERENCES workflow_runs(id)
);
`;

export function getStateDb(dataDir = "./data"): Database.Database {
  if (stateDb) return stateDb;

  stateDb = new Database(join(dataDir, "state.db"));
  stateDb.pragma("journal_mode = WAL");
  stateDb.pragma("busy_timeout = 5000");
  stateDb.pragma("synchronous = NORMAL");
  stateDb.exec(STATE_SCHEMA);
  return stateDb;
}

export function getAuditDb(dataDir = "./data"): Database.Database {
  if (auditDb) return auditDb;

  auditDb = new Database(join(dataDir, "audit.db"));
  auditDb.pragma("journal_mode = WAL");
  auditDb.pragma("busy_timeout = 5000");
  auditDb.pragma("synchronous = NORMAL");

  const auditSchema = readFileSync(resolveAuditSchemaPath(), "utf-8");
  auditDb.exec(auditSchema);
  return auditDb;
}

function resolveAuditSchemaPath(): string {
  const candidates = [
    join(__dirname, "..", "security", "audit-schema.sql"),
    join(__dirname, "..", "..", "security", "audit-schema.sql"),
    join(process.cwd(), "security", "audit-schema.sql"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not locate audit-schema.sql. Checked: ${candidates.join(", ")}`);
}

export function generateDedupKey(
  workflow: string,
  triggerSource: string,
  entityId: string
): string {
  const raw = `${workflow}:${triggerSource}:${entityId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function isDuplicate(
  db: Database.Database,
  dedupKey: string
): boolean {
  cleanExpiredDedup(db);
  const row = db
    .prepare("SELECT 1 FROM dedup WHERE dedup_key = ?")
    .get(dedupKey);
  return row !== undefined;
}

export function markSeen(
  db: Database.Database,
  dedupKey: string,
  workflow: string,
  entityId: string,
  windowMinutes = 5
): void {
  db.prepare(
    `INSERT OR REPLACE INTO dedup (dedup_key, workflow, entity_id, expires_at)
     VALUES (?, ?, ?, datetime('now', 'utc', '+' || ? || ' minutes'))`
  ).run(dedupKey, workflow, entityId, windowMinutes);
}

function cleanExpiredDedup(db: Database.Database): void {
  db.prepare("DELETE FROM dedup WHERE expires_at < datetime('now', 'utc')").run();
}

export function closeAll(): void {
  if (stateDb) {
    stateDb.close();
    stateDb = null;
  }
  if (auditDb) {
    auditDb.close();
    auditDb = null;
  }
}
