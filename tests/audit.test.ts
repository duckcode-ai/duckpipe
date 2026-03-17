import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import {
  initAudit,
  logAction,
  queryAudit,
  exportAuditJSON,
  exportAuditCSV,
  updateActionOutput,
} from "../src/audit.js";
import { closeAll, getAuditDb } from "../src/db.js";
import type { AuditEntry } from "../src/types.js";

const TEST_DATA_DIR = "./data-test-audit";

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    workflow: "incident-autopilot",
    agent: "airflow",
    tool: "airflow_list_dags",
    tier: 1,
    input_json: JSON.stringify({ dag_id: "test_dag" }),
    write_action: false,
    success: true,
    ...overrides,
  };
}

describe("logAction", () => {
  it("inserts an audit entry and returns its id", () => {
    const id = logAction(makeEntry());
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(32);
  });

  it("logs write actions correctly", () => {
    const id = logAction(
      makeEntry({
        tool: "airflow_trigger_dag_run",
        write_action: true,
        approved_by: "slack:alice",
      })
    );

    const entries = queryAudit({ write_only: true });
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].write_action).toBe(true);
    expect(entries[0].approved_by).toBe("slack:alice");
  });
});

describe("queryAudit", () => {
  it("filters by workflow", () => {
    logAction(makeEntry({ workflow: "incident-autopilot" }));
    logAction(makeEntry({ workflow: "cost-sentinel" }));

    const results = queryAudit({ workflow: "cost-sentinel" });
    expect(results.length).toBe(1);
    expect(results[0].workflow).toBe("cost-sentinel");
  });

  it("filters by agent", () => {
    logAction(makeEntry({ agent: "airflow" }));
    logAction(makeEntry({ agent: "snowflake" }));

    const results = queryAudit({ agent: "snowflake" });
    expect(results.length).toBe(1);
    expect(results[0].agent).toBe("snowflake");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      logAction(makeEntry());
    }
    const results = queryAudit({ limit: 3 });
    expect(results.length).toBe(3);
  });

  it("returns entries in descending time order", () => {
    logAction(makeEntry({ tool: "first" }));
    logAction(makeEntry({ tool: "second" }));

    const results = queryAudit({});
    expect(results[0].tool).toBe("second");
    expect(results[1].tool).toBe("first");
  });
});

describe("immutability", () => {
  it("prevents direct UPDATE on audit_log", () => {
    const db = getAuditDb(TEST_DATA_DIR);
    logAction(makeEntry());

    expect(() => {
      db.prepare("UPDATE audit_log SET workflow = 'hacked'").run();
    }).toThrow(/immutable/);
  });

  it("prevents direct DELETE on audit_log", () => {
    const db = getAuditDb(TEST_DATA_DIR);
    logAction(makeEntry());

    expect(() => {
      db.prepare("DELETE FROM audit_log").run();
    }).toThrow(/immutable/);
  });
});

describe("updateActionOutput", () => {
  it("stores post-execution results in companion table", () => {
    const id = logAction(makeEntry());
    updateActionOutput(id, '{"result": "ok"}', 150, true);

    const db = getAuditDb(TEST_DATA_DIR);
    const row = db
      .prepare("SELECT * FROM audit_results WHERE audit_id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.output_json).toBe('{"result": "ok"}');
    expect(row.duration_ms).toBe(150);
    expect(row.success).toBe(1);
  });
});

describe("exportAuditJSON", () => {
  it("exports as valid JSON", () => {
    logAction(makeEntry());
    const json = exportAuditJSON({
      from: "2020-01-01",
      to: "2099-12-31",
    });
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });
});

describe("exportAuditCSV", () => {
  it("exports with headers and data rows", () => {
    logAction(makeEntry());
    const csv = exportAuditCSV({
      from: "2020-01-01",
      to: "2099-12-31",
    });
    const lines = csv.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("workflow");
  });
});
