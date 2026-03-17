import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import {
  getStateDb,
  getAuditDb,
  generateDedupKey,
  isDuplicate,
  markSeen,
  closeAll,
} from "../src/db.js";

const TEST_DATA_DIR = "./data-test-db";

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("getStateDb", () => {
  it("creates state database with WAL mode", () => {
    const db = getStateDb(TEST_DATA_DIR);
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("creates required tables", () => {
    const db = getStateDb(TEST_DATA_DIR);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("workflow_runs");
    expect(names).toContain("dedup");
    expect(names).toContain("schema_snapshots");
    expect(names).toContain("run_history");
    expect(names).toContain("confluence_pages");
  });

  it("returns same instance on repeated calls", () => {
    const db1 = getStateDb(TEST_DATA_DIR);
    const db2 = getStateDb(TEST_DATA_DIR);
    expect(db1).toBe(db2);
  });
});

describe("getAuditDb", () => {
  it("creates audit database with immutability triggers", () => {
    const db = getAuditDb(TEST_DATA_DIR);
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain("prevent_audit_update");
    expect(names).toContain("prevent_audit_delete");
  });

  it("blocks UPDATE on audit_log", () => {
    const db = getAuditDb(TEST_DATA_DIR);
    db.prepare(
      `INSERT INTO audit_log (workflow, agent, tool, tier, input_json, write_action, success)
       VALUES ('test', 'airflow', 'list_dags', 1, '{}', 0, 1)`
    ).run();

    expect(() => {
      db.prepare("UPDATE audit_log SET workflow = 'hacked'").run();
    }).toThrow(/immutable/);
  });

  it("blocks DELETE on audit_log", () => {
    const db = getAuditDb(TEST_DATA_DIR);
    db.prepare(
      `INSERT INTO audit_log (workflow, agent, tool, tier, input_json, write_action, success)
       VALUES ('test', 'airflow', 'list_dags', 1, '{}', 0, 1)`
    ).run();

    expect(() => {
      db.prepare("DELETE FROM audit_log").run();
    }).toThrow(/immutable/);
  });
});

describe("deduplication", () => {
  it("generates deterministic dedup keys", () => {
    const key1 = generateDedupKey("incident-autopilot", "airflow", "dag_123");
    const key2 = generateDedupKey("incident-autopilot", "airflow", "dag_123");
    expect(key1).toBe(key2);
  });

  it("generates different keys for different inputs", () => {
    const key1 = generateDedupKey("incident-autopilot", "airflow", "dag_123");
    const key2 = generateDedupKey("incident-autopilot", "airflow", "dag_456");
    expect(key1).not.toBe(key2);
  });

  it("detects duplicate events within window", () => {
    const db = getStateDb(TEST_DATA_DIR);
    const key = generateDedupKey("incident-autopilot", "airflow", "dag_123");

    expect(isDuplicate(db, key)).toBe(false);
    markSeen(db, key, "incident-autopilot", "dag_123", 5);
    expect(isDuplicate(db, key)).toBe(true);
  });

  it("allows events after dedup window expires", () => {
    const db = getStateDb(TEST_DATA_DIR);
    const key = generateDedupKey("test", "airflow", "dag_123");

    // Insert with an already-expired timestamp using SQLite datetime format
    db.prepare(
      "INSERT OR REPLACE INTO dedup (dedup_key, workflow, entity_id, expires_at) VALUES (?, ?, ?, datetime('now', 'utc', '-1 minutes'))"
    ).run(key, "test", "dag_123");

    expect(isDuplicate(db, key)).toBe(false);
  });
});
