import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { closeAll, getStateDb } from "../src/db.js";
import { getIncidentWorkspace, updateIncidentWorkspace } from "../src/incident-memory.js";

const TEST_DATA_DIR = "./data-test-incident-memory";

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = getStateDb(TEST_DATA_DIR);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow, status, started_at, completed_at)
     VALUES ('run-1', 'incident-autopilot', 'completed', datetime('now', 'utc'), datetime('now', 'utc'))`
  ).run();
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("incident memory", () => {
  it("creates an empty workspace by default", () => {
    const workspace = getIncidentWorkspace("run-1");
    expect(workspace.incidentRunId).toBe("run-1");
    expect(workspace.facts).toEqual([]);
    expect(workspace.conversationCount).toBe(0);
  });

  it("persists merged facts and hypotheses", () => {
    updateIncidentWorkspace("run-1", {
      facts: [{ id: "fact-1", summary: "Fact one", source: "workflow", confidence: "high" }],
      hypotheses: [{ id: "hyp-1", summary: "Hyp one", status: "possible", confidence: "medium" }],
      openQuestions: ["Question one"],
      incrementConversation: true,
    });

    const workspace = updateIncidentWorkspace("run-1", {
      facts: [{ id: "fact-2", summary: "Fact two", source: "workflow", confidence: "medium" }],
      hypotheses: [{ id: "hyp-1", summary: "Hyp one", status: "supported", confidence: "high" }],
      incrementConversation: true,
    });

    expect(workspace.facts).toHaveLength(2);
    expect(workspace.hypotheses[0].status).toBe("supported");
    expect(workspace.conversationCount).toBe(2);
    expect(workspace.openQuestions).toContain("Question one");
  });
});
