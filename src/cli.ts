#!/usr/bin/env node

import { mkdirSync, existsSync } from "node:fs";
import { loadConfig, ensureConfig, ensureEnv } from "./config.js";
import { initVault } from "./vault.js";
import { initAudit } from "./audit.js";
import { getStateDb, closeAll } from "./db.js";
import { queryAudit } from "./audit.js";
import { verifyAll, verifySingle } from "./verify.js";
import { startDuckpipe } from "./index.js";
import { startDashboardServer } from "./server.js";
import { printDoctorReport } from "./doctor.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "start":
      await cmdStart();
      break;
    case "dashboard":
      await cmdDashboard();
      break;
    case "verify":
      await cmdVerify();
      break;
    case "setup":
      await cmdSetup();
      break;
    case "audit":
      await cmdAudit();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      if (command) console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

async function cmdStart(): Promise<void> {
  const { shutdown } = await startDuckpipe();

  if (hasFlag("--dashboard")) {
    const port = parseInt(getFlag("--port") ?? "9876", 10);
    const config = loadConfig();
    await startDashboardServer(config, port);
  }

  await new Promise(() => {});
}

async function cmdDashboard(): Promise<void> {
  const port = parseInt(getFlag("--port") ?? "9876", 10);

  mkdirSync("./data", { recursive: true });
  const config = loadConfig();
  initAudit("./data");
  getStateDb("./data");

  console.log("🦆 DuckPipe Dashboard");
  await startDashboardServer(config, port);
  await new Promise(() => {});
}

async function cmdVerify(): Promise<void> {
  const config = loadConfig();
  const vault = initVault(config.secrets.backend, config.duckpipe.trust_tier);

  const integration = args[1] || getFlag("--integration");
  if (integration) {
    await verifySingle(integration, config, vault);
  } else {
    await verifyAll(config, vault);
  }
}

async function cmdSetup(): Promise<void> {
  console.log("🦆 DuckPipe setup\n");

  // 1. Create data directory
  mkdirSync("./data", { recursive: true });
  console.log("✓ Created data directory");

  // 2. Create bus directories
  const agents = ["airflow", "dbt", "snowflake", "comms"];
  for (const agent of agents) {
    mkdirSync(`./bus/agents/${agent}/in`, { recursive: true });
    mkdirSync(`./bus/agents/${agent}/out`, { recursive: true });
  }
  mkdirSync("./bus/orchestrator", { recursive: true });
  console.log("✓ Created bus directories");

  // 3. Copy config if needed
  const configCreated = ensureConfig();
  if (configCreated) {
    console.log("✓ Created duckpipe.yaml from example");
  } else {
    console.log("✓ duckpipe.yaml already exists");
  }

  // 4. Copy .env if needed
  const envCreated = ensureEnv();
  if (envCreated) {
    console.log("✓ Created .env from example");
    console.log(
      "\n  → Edit .env with your API keys, then run: npx duckpipe verify"
    );
  } else {
    console.log("✓ .env already exists");
  }

  // 5. Check Docker
  try {
    const { execSync } = await import("node:child_process");
    execSync("docker info", { stdio: "pipe" });
    console.log("✓ Docker is running");
  } catch {
    console.log(
      "⚠ Docker not detected. Install Docker to run agent containers."
    );
    console.log("  https://docs.docker.com/get-docker/");
  }

  console.log("\n🦆 Setup complete!");
  console.log("   Next: npx duckpipe verify");
}

async function cmdAudit(): Promise<void> {
  mkdirSync("./data", { recursive: true });
  initAudit("./data");

  const limit = parseInt(getFlag("--limit") ?? "50", 10);
  const entries = queryAudit({ limit });

  if (entries.length === 0) {
    console.log("No audit entries found.");
    return;
  }

  // Print table header
  console.log(
    padRight("Timestamp", 20) +
      padRight("Workflow", 22) +
      padRight("Agent", 12) +
      padRight("Tool", 25) +
      padRight("Tier", 6) +
      padRight("Approved", 18) +
      padRight("OK", 4)
  );
  console.log("-".repeat(107));

  for (const e of entries) {
    console.log(
      padRight(e.created_at ?? "", 20) +
        padRight(e.workflow, 22) +
        padRight(e.agent, 12) +
        padRight(e.tool, 25) +
        padRight(String(e.tier), 6) +
        padRight(e.approved_by ?? "-", 18) +
        padRight(e.success ? "✓" : "✗", 4)
    );
  }

  closeAll();
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  printDoctorReport(config);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printHelp(): void {
  console.log(`
DuckPipe 🦆 — Autonomous agents for your data stack

Usage: duckpipe <command> [options]

Commands:
  start [--dashboard]    Start DuckPipe orchestrator and agents
  dashboard [--port N]   Open the observability dashboard (default: 9876)
  verify [integration]   Check connections and permissions
  setup                  Initialize project (directories, config, .env)
  audit [--limit N]      Show recent audit log entries
  doctor                 Run readiness checks for workflows and story generation
  help                   Show this help message

Examples:
  npx duckpipe setup
  npx duckpipe verify
  npx duckpipe verify --integration airflow
  npx duckpipe start
  npx duckpipe start --dashboard
  npx duckpipe dashboard
  npx duckpipe dashboard --port 3000
  npx duckpipe audit --limit 20
  npx duckpipe doctor

Documentation: https://docs.duckpipe.dev
`);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
