import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileTransport, createBusMessage } from "../src/bus.js";
import type { BusMessage } from "../src/types.js";

const TEST_BUS_DIR = "./bus-test-tmp";

let transport: FileTransport;

beforeEach(() => {
  transport = new FileTransport(TEST_BUS_DIR);
});

afterEach(async () => {
  await transport.shutdown();
  rmSync(TEST_BUS_DIR, { recursive: true, force: true });
});

describe("FileTransport", () => {
  it("creates directory structure on init", () => {
    const agents = ["airflow", "dbt", "snowflake", "comms"];
    for (const agent of agents) {
      const inDir = join(TEST_BUS_DIR, "agents", agent, "in");
      const outDir = join(TEST_BUS_DIR, "agents", agent, "out");
      expect(readdirSync(inDir)).toBeDefined();
      expect(readdirSync(outDir)).toBeDefined();
    }
    expect(readdirSync(join(TEST_BUS_DIR, "orchestrator"))).toBeDefined();
  });

  it("sends a message to an agent inbox as JSON file", async () => {
    const msg = createBusMessage(
      "orchestrator",
      "airflow",
      "incident-autopilot",
      "task",
      { dag_id: "test_dag" }
    );

    await transport.send("airflow", msg);

    const inDir = join(TEST_BUS_DIR, "agents", "airflow", "in");
    const files = readdirSync(inDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);

    const content = JSON.parse(readFileSync(join(inDir, files[0]), "utf-8"));
    expect(content.source).toBe("orchestrator");
    expect(content.target).toBe("airflow");
    expect(content.workflow).toBe("incident-autopilot");
    expect(content.payload.dag_id).toBe("test_dag");
  });

  it("sends a message to orchestrator directory", async () => {
    const msg = createBusMessage(
      "airflow",
      "orchestrator",
      "incident-autopilot",
      "result",
      { status: "healthy" }
    );

    await transport.send("orchestrator", msg);

    const orchDir = join(TEST_BUS_DIR, "orchestrator");
    const files = readdirSync(orchDir);
    expect(files.length).toBe(1);
  });

  it("reset clears and recreates directories", async () => {
    const msg = createBusMessage(
      "orchestrator",
      "airflow",
      "incident-autopilot",
      "task",
      {}
    );
    await transport.send("airflow", msg);

    transport.reset();

    const inDir = join(TEST_BUS_DIR, "agents", "airflow", "in");
    const files = readdirSync(inDir);
    expect(files.length).toBe(0);
  });
});

describe("createBusMessage", () => {
  it("produces a valid BusMessage", () => {
    const msg = createBusMessage(
      "orchestrator",
      "snowflake",
      "cost-sentinel",
      "task",
      { query_id: "abc123" }
    );

    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
    expect(msg.source).toBe("orchestrator");
    expect(msg.target).toBe("snowflake");
    expect(msg.workflow).toBe("cost-sentinel");
    expect(msg.type).toBe("task");
    expect(msg.payload.query_id).toBe("abc123");
  });

  it("generates unique ids", () => {
    const msg1 = createBusMessage("orchestrator", "airflow", "incident-autopilot", "task", {});
    const msg2 = createBusMessage("orchestrator", "airflow", "incident-autopilot", "task", {});
    expect(msg1.id).not.toBe(msg2.id);
  });
});

describe("subscribe and process", () => {
  it("agent subscription picks up messages from inbox via polling", async () => {
    const received: BusMessage[] = [];
    transport.subscribe("airflow", (msg) => received.push(msg));

    const msg = createBusMessage(
      "orchestrator",
      "airflow",
      "incident-autopilot",
      "task",
      { test: true }
    );
    await transport.send("airflow", msg);

    // Wait for polling interval (200ms) + processing time
    await new Promise((r) => setTimeout(r, 500));

    expect(received.length).toBe(1);
    expect(received[0].payload.test).toBe(true);
  });

  it("message file is deleted after processing", async () => {
    const received: BusMessage[] = [];
    transport.subscribe("airflow", (msg) => received.push(msg));

    await transport.send(
      "airflow",
      createBusMessage("orchestrator", "airflow", "incident-autopilot", "task", {})
    );

    await new Promise((r) => setTimeout(r, 500));

    const inDir = join(TEST_BUS_DIR, "agents", "airflow", "in");
    const files = readdirSync(inDir);
    expect(files.length).toBe(0);
  });
});
