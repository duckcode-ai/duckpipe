CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  workflow TEXT NOT NULL,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  tier INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  write_action INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_workflow ON audit_log(workflow);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent);

CREATE TRIGGER IF NOT EXISTS prevent_audit_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no updates permitted'); END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable — no deletes permitted'); END;
