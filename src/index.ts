import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { initVault } from "./vault.js";
import { getStateDb } from "./db.js";
import { initAudit } from "./audit.js";
import { FileTransport } from "./bus.js";
import { loadPolicy } from "./policy.js";
import { Orchestrator } from "./orchestrator.js";
import { Scheduler } from "./scheduler.js";
import { verifyAll } from "./verify.js";
import type { DuckpipeConfig } from "./types.js";

export async function startDuckpipe(configPath = "./duckpipe.yaml"): Promise<{
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  shutdown: () => Promise<void>;
}> {
  const config = loadConfig(configPath);
  const tier = config.duckpipe.trust_tier;
  const name = config.duckpipe.name;

  console.log(
    `[${timestamp()}] 🦆 DuckPipe starting — trust tier ${tier} (${tierLabel(tier)})`
  );

  // Initialize subsystems
  mkdirSync("./data", { recursive: true });

  const vault = initVault(config.secrets.backend, tier);
  getStateDb("./data");
  initAudit("./data");
  loadPolicy("./policy.yaml");

  const transport = new FileTransport("./bus");
  const orchestrator = new Orchestrator(transport, config);
  orchestrator.start();

  const scheduler = new Scheduler();
  setupWorkflows(scheduler, orchestrator, config);

  const activeJobs = scheduler.getActiveJobs();
  if (activeJobs.length > 0) {
    console.log(`[${timestamp()}] Scheduled workflows: ${activeJobs.join(", ")}`);
  }

  console.log(`[${timestamp()}] 🦆 DuckPipe started — ${name}`);

  const shutdown = async () => {
    console.log(`\n[${timestamp()}] Shutting down DuckPipe...`);
    scheduler.stop();
    await orchestrator.shutdown();
    console.log(`[${timestamp()}] Goodbye.`);
  };

  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0));
  });

  return { orchestrator, scheduler, shutdown };
}

function setupWorkflows(
  scheduler: Scheduler,
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): void {
  // Workflow handlers are lazy-imported to avoid loading all dependencies at startup.
  // Each handler is a thin wrapper that delegates to the workflow module.
  scheduler.setupFromConfig(config, {
    "incident-autopilot": async () => {
      const { runIncidentAutopilot } = await import(
        "../workflows/incident-autopilot.js"
      );
      await runIncidentAutopilot(orchestrator, config);
    },
    "cost-sentinel": async () => {
      const { runCostSentinel } = await import("../workflows/cost-sentinel.js");
      await runCostSentinel(orchestrator, config);
    },
    "sla-guardian": async () => {
      const { runSlaGuardian } = await import("../workflows/sla-guardian.js");
      await runSlaGuardian(orchestrator, config);
    },
    "pipeline-whisperer": async () => {
      const { runPipelineWhisperer } = await import(
        "../workflows/pipeline-whisperer.js"
      );
      await runPipelineWhisperer(orchestrator, config);
    },
    "knowledge-scribe": async () => {
      const { runKnowledgeScribe } = await import(
        "../workflows/knowledge-scribe.js"
      );
      await runKnowledgeScribe(orchestrator, config);
    },
  });
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function tierLabel(tier: number): string {
  return tier === 1 ? "read-only" : tier === 2 ? "supervised" : "autonomous";
}
