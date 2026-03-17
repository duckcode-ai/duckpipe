import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  spawn: vi.fn(() => {
    const EventEmitter = require("node:events");
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }),
}));

import type { DuckpipeConfig } from "../src/types.js";

function makeConfig(runtime = "process"): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 1 },
    secrets: { backend: "env" },
    agents: { runtime: runtime as any, memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {},
  } as DuckpipeConfig;
}

describe("docker manager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("getRuntime returns config runtime value", async () => {
    const { getRuntime } = await import("../src/docker.js");
    expect(getRuntime(makeConfig("docker"))).toBe("docker");
    expect(getRuntime(makeConfig("podman"))).toBe("podman");
    expect(getRuntime(makeConfig("process"))).toBe("process");
  });

  it("getRunningAgents returns empty initially", async () => {
    const { getRunningAgents } = await import("../src/docker.js");
    expect(getRunningAgents()).toEqual([]);
  });

  it("isAgentRunning returns false for unstarted agents", async () => {
    const { isAgentRunning } = await import("../src/docker.js");
    expect(isAgentRunning("airflow")).toBe(false);
    expect(isAgentRunning("dbt")).toBe(false);
    expect(isAgentRunning("snowflake")).toBe(false);
    expect(isAgentRunning("comms")).toBe(false);
  });
});
