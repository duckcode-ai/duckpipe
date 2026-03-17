import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { Orchestrator } from "../../src/orchestrator.js";
import { FileTransport } from "../../src/bus.js";
import { initAudit } from "../../src/audit.js";
import { loadPolicy } from "../../src/policy.js";
import { getStateDb, closeAll } from "../../src/db.js";
import { runKnowledgeScribe } from "../../workflows/knowledge-scribe.js";
import type { DuckpipeConfig } from "../../src/types.js";

const TEST_DATA_DIR = "./data-test-scribe";
const TEST_BUS_DIR = "./bus-test-scribe";

function makeConfig(): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 2 },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      confluence: {
        enabled: true,
        base_url: "https://test.atlassian.net/wiki",
        email: "test@test.com",
        api_token: "test-token",
        space_key: "DATA",
      },
    },
    workflows: {
      knowledge_scribe: { enabled: true, schedule: "0 2 * * *" },
    },
  } as DuckpipeConfig;
}

beforeEach(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  initAudit(TEST_DATA_DIR);
  getStateDb(TEST_DATA_DIR);
  loadPolicy("nonexistent.yaml");
});

afterEach(() => {
  closeAll();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  rmSync(TEST_BUS_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("knowledge-scribe workflow", () => {
  it("records workflow start and complete", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig());
    orch.start();

    vi.spyOn(orch, "dispatchToAgent").mockResolvedValue({
      id: "test",
      timestamp: new Date().toISOString(),
      source: "dbt",
      target: "orchestrator",
      workflow: "knowledge-scribe",
      type: "result",
      payload: { models: [] },
    });

    const result = await runKnowledgeScribe(orch, makeConfig());

    expect(result.workflow).toBe("knowledge-scribe");
    expect(result.status).toBe("completed");
    await transport.shutdown();
  });

  it("handles errors gracefully", async () => {
    const transport = new FileTransport(TEST_BUS_DIR);
    const orch = new Orchestrator(transport, makeConfig());
    orch.start();

    vi.spyOn(orch, "dispatchToAgent").mockRejectedValue(new Error("dbt API unavailable"));

    const result = await runKnowledgeScribe(orch, makeConfig());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("dbt API unavailable");
    await transport.shutdown();
  });
});
