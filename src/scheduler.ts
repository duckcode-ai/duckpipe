import { Cron } from "croner";
import type { DuckpipeConfig, WorkflowName } from "./types.js";

interface ScheduledJob {
  name: WorkflowName;
  cron: Cron;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];

  schedule(
    workflow: WorkflowName,
    cronExpression: string,
    handler: () => Promise<void>
  ): void {
    const cron = new Cron(cronExpression, { protect: true }, async () => {
      try {
        await handler();
      } catch (err) {
        console.error(`[scheduler] ${workflow} failed:`, err);
      }
    });

    this.jobs.push({ name: workflow, cron });
  }

  scheduleInterval(
    workflow: WorkflowName,
    intervalSeconds: number,
    handler: () => Promise<void>
  ): void {
    // Convert interval to "every N seconds" cron expression
    // For intervals, we use croner's built-in interval support
    const cronExpr =
      intervalSeconds >= 60
        ? `*/${Math.floor(intervalSeconds / 60)} * * * *`
        : `*/${intervalSeconds} * * * * *`;

    this.schedule(workflow, cronExpr, handler);
  }

  setupFromConfig(
    config: DuckpipeConfig,
    handlers: Partial<Record<WorkflowName, () => Promise<void>>>
  ): void {
    const workflows = config.workflows;
    if (!workflows) return;

    if (workflows.incident_autopilot?.enabled && handlers["incident-autopilot"]) {
      this.scheduleInterval(
        "incident-autopilot",
        workflows.incident_autopilot.poll_interval_seconds,
        handlers["incident-autopilot"]
      );
    }

    if (workflows.pipeline_whisperer?.enabled && handlers["pipeline-whisperer"]) {
      this.scheduleInterval(
        "pipeline-whisperer",
        (workflows.pipeline_whisperer.poll_interval_minutes ?? 15) * 60,
        handlers["pipeline-whisperer"]
      );
    }

    if (workflows.cost_sentinel?.enabled && handlers["cost-sentinel"]) {
      this.scheduleInterval(
        "cost-sentinel",
        (workflows.cost_sentinel.poll_interval_minutes ?? 10) * 60,
        handlers["cost-sentinel"]
      );
    }

    if (workflows.sla_guardian?.enabled && handlers["sla-guardian"]) {
      this.scheduleInterval(
        "sla-guardian",
        (workflows.sla_guardian.poll_interval_minutes ?? 5) * 60,
        handlers["sla-guardian"]
      );
    }

    if (workflows.knowledge_scribe?.enabled && handlers["knowledge-scribe"]) {
      this.schedule(
        "knowledge-scribe",
        workflows.knowledge_scribe.schedule ?? "0 2 * * *",
        handlers["knowledge-scribe"]
      );
    }
  }

  stop(): void {
    for (const job of this.jobs) {
      job.cron.stop();
    }
    this.jobs = [];
  }

  getActiveJobs(): WorkflowName[] {
    return this.jobs.filter((j) => j.cron.isRunning()).map((j) => j.name);
  }
}
