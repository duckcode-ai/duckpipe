import { watch, type FSWatcher } from "chokidar";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import type { AgentName, BusMessage, Transport } from "./types.js";

const AGENTS: AgentName[] = ["airflow", "dbt", "snowflake", "comms"];

export class FileTransport implements Transport {
  private busDir: string;
  private watchers: FSWatcher[] = [];
  private pollIntervals: NodeJS.Timeout[] = [];

  constructor(busDir = "./bus") {
    this.busDir = busDir;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    mkdirSync(join(this.busDir, "orchestrator"), { recursive: true });
    for (const agent of AGENTS) {
      mkdirSync(join(this.busDir, "agents", agent, "in"), { recursive: true });
      mkdirSync(join(this.busDir, "agents", agent, "out"), { recursive: true });
    }
  }

  async send(
    target: AgentName | "orchestrator",
    message: BusMessage
  ): Promise<void> {
    const dir =
      target === "orchestrator"
        ? join(this.busDir, "orchestrator")
        : join(this.busDir, "agents", target, "in");

    const ts = Date.now();
    const filename = `${ts}-${uuid()}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(message, null, 2));
  }

  subscribe(
    listener: AgentName | "orchestrator",
    handler: (msg: BusMessage) => void
  ): void {
    if (listener === "orchestrator") {
      this.watchOrchestratorInbox(handler);
    } else {
      this.watchAgentOutbox(listener, handler);
    }
  }

  private watchOrchestratorInbox(handler: (msg: BusMessage) => void): void {
    // Watch all agent out/ directories + orchestrator/ directory
    for (const agent of AGENTS) {
      const outDir = join(this.busDir, "agents", agent, "out");
      this.watchDirectory(outDir, handler);
    }

    const orchDir = join(this.busDir, "orchestrator");
    this.watchDirectory(orchDir, handler);
  }

  private watchAgentOutbox(
    agent: AgentName,
    handler: (msg: BusMessage) => void
  ): void {
    const inDir = join(this.busDir, "agents", agent, "in");
    this.pollDirectory(inDir, handler);
  }

  private watchDirectory(
    dir: string,
    handler: (msg: BusMessage) => void
  ): void {
    const watcher = watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher.on("add", (filePath) => {
      if (!filePath.endsWith(".json")) return;
      this.processFile(filePath, handler);
    });

    this.watchers.push(watcher);
  }

  private pollDirectory(
    dir: string,
    handler: (msg: BusMessage) => void
  ): void {
    const interval = setInterval(() => {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        return;
      }

      files.sort();
      for (const file of files) {
        this.processFile(join(dir, file), handler);
      }
    }, 200);

    this.pollIntervals.push(interval);
  }

  private processFile(
    filePath: string,
    handler: (msg: BusMessage) => void
  ): void {
    try {
      const content = readFileSync(filePath, "utf-8");
      const message = JSON.parse(content) as BusMessage;
      unlinkSync(filePath);
      handler(message);
    } catch {
      // File may have been processed by another watcher or was invalid
    }
  }

  async shutdown(): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];

    for (const interval of this.pollIntervals) {
      clearInterval(interval);
    }
    this.pollIntervals = [];
  }

  /**
   * Remove and recreate the bus directory (transient state, not persistent).
   */
  reset(): void {
    rmSync(this.busDir, { recursive: true, force: true });
    this.ensureDirectories();
  }
}

export function createBusMessage(
  source: AgentName | "orchestrator",
  target: AgentName | "orchestrator",
  workflow: BusMessage["workflow"],
  type: BusMessage["type"],
  payload: Record<string, unknown>
): BusMessage {
  return {
    id: uuid(),
    timestamp: new Date().toISOString(),
    source,
    target,
    workflow,
    type,
    payload,
  };
}
