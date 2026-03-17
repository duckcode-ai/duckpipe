/**
 * Docker container lifecycle manager for DuckPipe agents.
 * Supports docker, podman, and process (dev fallback) runtimes.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { AgentName, DuckpipeConfig } from "./types.js";

const AGENTS: AgentName[] = ["airflow", "dbt", "snowflake", "comms"];

interface RunningAgent {
  name: AgentName;
  runtime: "docker" | "podman" | "process";
  containerId?: string;
  process?: ChildProcess;
}

const runningAgents = new Map<AgentName, RunningAgent>();

export function getRuntime(config: DuckpipeConfig): "docker" | "podman" | "process" {
  return (config.agents.runtime ?? "docker") as "docker" | "podman" | "process";
}

export async function ensureAgentsRunning(config: DuckpipeConfig): Promise<void> {
  const runtime = getRuntime(config);

  if (runtime === "docker" || runtime === "podman") {
    if (!isDockerAvailable(runtime)) {
      console.warn(`⚠  ${runtime} not available — falling back to process mode`);
      await startAllAsProcesses(config);
      return;
    }
    await startAllAsContainers(config, runtime);
  } else {
    await startAllAsProcesses(config);
  }
}

function isDockerAvailable(runtime: "docker" | "podman"): boolean {
  try {
    execSync(`${runtime} info`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function startAllAsContainers(
  config: DuckpipeConfig,
  runtime: "docker" | "podman"
): Promise<void> {
  const prefix = config.agents.image_prefix ?? "duckpipe";
  const memoryMb = config.agents.memory_limit_mb ?? 512;
  const cpuLimit = config.agents.cpu_limit ?? 0.5;
  const busDir = resolve("./bus");

  for (const agent of AGENTS) {
    if (isAgentRunning(agent)) continue;

    const containerName = `duckpipe-${agent}`;
    stopContainer(runtime, containerName);

    const networkFlag = agent === "comms" ? "--network=host" : "--network=none";

    const args = [
      "run", "-d", "--rm",
      "--name", containerName,
      `--memory=${memoryMb}m`,
      `--cpus=${cpuLimit}`,
      networkFlag,
      "-v", `${busDir}/agents/${agent}/in:/app/bus/agents/${agent}/in`,
      "-v", `${busDir}/agents/${agent}/out:/app/bus/agents/${agent}/out`,
      "-e", `DUCKPIPE_BUS_DIR=/app/bus`,
      `${prefix}-${agent}:latest`,
    ];

    try {
      const containerId = execSync(`${runtime} ${args.join(" ")}`, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();

      runningAgents.set(agent, { name: agent, runtime, containerId });
      console.log(`  ✓ ${agent} agent started (container ${containerId.slice(0, 12)})`);
    } catch (err) {
      console.error(`  ✗ ${agent} agent failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function startAllAsProcesses(config: DuckpipeConfig): Promise<void> {
  for (const agent of AGENTS) {
    if (isAgentRunning(agent)) continue;

    const projectRoot = resolve(".");
    const busDir      = resolve("./bus");

    // In dev (tsx / ts entrypoint): run TS source directly even if dist/ exists,
    // so agents stay in sync with the current workspace edits.
    const distEntry = resolve(`./dist/agents/${agent}/index.js`);
    const srcEntry  = resolve(`./agents/${agent}/index.ts`);
    const { existsSync } = await import("node:fs");
    const runningFromTsEntry = process.argv[1]?.endsWith(".ts") || process.execArgv.some((arg) => arg.includes("tsx"));
    const useCompiled = existsSync(distEntry) && !runningFromTsEntry;
    const cmd  = "node";
    const args = useCompiled ? [distEntry] : ["--import", "tsx", srcEntry];

    try {
      const child = spawn(cmd, args, {
        cwd: projectRoot,
        env: { ...process.env, DUCKPIPE_BUS_DIR: busDir },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      child.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.log(`  [${agent}] ${line}`);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.error(`  [${agent}] ${line}`);
        }
      });

      child.on("exit", (code) => {
        runningAgents.delete(agent);
        if (code !== 0 && code !== null) {
          console.error(`  [${agent}] Agent exited with code ${code}`);
        }
      });

      runningAgents.set(agent, { name: agent, runtime: "process", process: child });
      console.log(`  ✓ ${agent} agent started (process ${child.pid})`);
    } catch (err) {
      console.error(`  ✗ ${agent} agent failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function stopContainer(runtime: string, name: string): void {
  try {
    execSync(`${runtime} rm -f ${name}`, { stdio: "pipe", timeout: 10000 });
  } catch {
    // Container didn't exist
  }
}

export function isAgentRunning(agent: AgentName): boolean {
  return runningAgents.has(agent);
}

export function getRunningAgents(): AgentName[] {
  return [...runningAgents.keys()];
}

export async function stopAllAgents(): Promise<void> {
  for (const [agent, info] of runningAgents) {
    try {
      if (info.runtime === "process" && info.process) {
        info.process.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            info.process?.kill("SIGKILL");
            resolve();
          }, 5000);
          info.process?.on("exit", () => { clearTimeout(timer); resolve(); });
        });
      } else if (info.containerId) {
        const rt = info.runtime === "podman" ? "podman" : "docker";
        execSync(`${rt} stop ${info.containerId}`, { stdio: "pipe", timeout: 10000 });
      }
      console.log(`  ✓ ${agent} agent stopped`);
    } catch {
      console.error(`  ✗ ${agent} agent failed to stop cleanly`);
    }
    runningAgents.delete(agent);
  }
}
