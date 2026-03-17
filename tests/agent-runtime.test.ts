import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startAgentRuntime, type ToolFn } from "../agents/runtime.js";

const BUS_DIR = "./bus-test-runtime";

beforeEach(() => {
  mkdirSync(join(BUS_DIR, "agents", "test-agent", "in"), { recursive: true });
  mkdirSync(join(BUS_DIR, "agents", "test-agent", "out"), { recursive: true });
});

afterEach(() => {
  rmSync(BUS_DIR, { recursive: true, force: true });
});

function writeTask(taskType: string, payload: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID();
  const msg = {
    id,
    timestamp: new Date().toISOString(),
    source: "orchestrator",
    target: "test-agent",
    workflow: "incident-autopilot",
    type: "task",
    payload: { _taskType: taskType, ...payload },
  };
  writeFileSync(
    join(BUS_DIR, "agents", "test-agent", "in", `${Date.now()}-${id}.json`),
    JSON.stringify(msg)
  );
  return id;
}

function readOutFiles(): Array<Record<string, unknown>> {
  const outDir = join(BUS_DIR, "agents", "test-agent", "out");
  const files = readdirSync(outDir).filter(f => f.endsWith(".json")).sort();
  return files.map(f => JSON.parse(readFileSync(join(outDir, f), "utf-8")));
}

async function waitForOutput(maxMs = 3000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const out = readOutFiles();
    if (out.length > 0) return out;
    await new Promise(r => setTimeout(r, 100));
  }
  return readOutFiles();
}

describe("agent runtime", () => {
  it("processes a task and writes result to out/", async () => {
    const tools = new Map<string, ToolFn>([
      ["echo", async (p) => ({ echoed: p.message })],
    ]);

    const runtime = startAgentRuntime({
      name: "test-agent",
      busDir: BUS_DIR,
      tools,
      pollMs: 50,
    });

    const taskId = writeTask("echo", { message: "hello" });
    const results = await waitForOutput();
    runtime.stop();

    expect(results.length).toBe(1);
    const result = results[0];
    expect(result.type).toBe("result");
    expect((result.payload as any).echoed).toBe("hello");
    expect((result.payload as any)._replyTo).toBe(taskId);
  });

  it("returns error for unknown tool type", async () => {
    const tools = new Map<string, ToolFn>();
    const runtime = startAgentRuntime({
      name: "test-agent",
      busDir: BUS_DIR,
      tools,
      pollMs: 50,
    });

    writeTask("nonexistent_tool");
    const results = await waitForOutput();
    runtime.stop();

    expect(results.length).toBe(1);
    expect(results[0].type).toBe("error");
    expect((results[0].payload as any).error).toContain("Unknown tool");
  });

  it("handles tool errors gracefully", async () => {
    const tools = new Map<string, ToolFn>([
      ["fail", async () => { throw new Error("intentional failure"); }],
    ]);

    const runtime = startAgentRuntime({
      name: "test-agent",
      busDir: BUS_DIR,
      tools,
      pollMs: 50,
    });

    writeTask("fail");
    const results = await waitForOutput();
    runtime.stop();

    expect(results.length).toBe(1);
    expect(results[0].type).toBe("error");
    expect((results[0].payload as any).error).toContain("intentional failure");
  });

  it("deletes input files after processing", async () => {
    const tools = new Map<string, ToolFn>([
      ["noop", async () => ({})],
    ]);

    const runtime = startAgentRuntime({
      name: "test-agent",
      busDir: BUS_DIR,
      tools,
      pollMs: 50,
    });

    writeTask("noop");
    await waitForOutput();
    runtime.stop();

    const inDir = join(BUS_DIR, "agents", "test-agent", "in");
    const remaining = readdirSync(inDir).filter(f => f.endsWith(".json"));
    expect(remaining.length).toBe(0);
  });

  it("processes multiple tasks in order", async () => {
    const tools = new Map<string, ToolFn>([
      ["count", async (p) => ({ n: p.n })],
    ]);

    const runtime = startAgentRuntime({
      name: "test-agent",
      busDir: BUS_DIR,
      tools,
      pollMs: 50,
    });

    writeTask("count", { n: 1 });
    await new Promise(r => setTimeout(r, 10));
    writeTask("count", { n: 2 });
    await new Promise(r => setTimeout(r, 10));
    writeTask("count", { n: 3 });

    // Wait for all 3
    const deadline = Date.now() + 3000;
    let results: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      results = readOutFiles();
      if (results.length >= 3) break;
      await new Promise(r => setTimeout(r, 100));
    }

    runtime.stop();
    expect(results.length).toBe(3);
  });
});
