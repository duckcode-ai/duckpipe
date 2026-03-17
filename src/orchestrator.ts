import { v4 as uuid } from "uuid";
import type {
  AgentName,
  BusMessage,
  DuckpipeConfig,
  PolicyDecision,
  Transport,
  TrustTier,
  WorkflowName,
  WorkflowResult,
  WorkflowStatus,
} from "./types.js";
import { logAction, updateActionOutput } from "./audit.js";
import { checkPolicy } from "./policy.js";
import { getStateDb, generateDedupKey, isDuplicate, markSeen } from "./db.js";
import { createBusMessage } from "./bus.js";

interface WorkflowRun {
  id: string;
  workflow: WorkflowName;
  status: WorkflowStatus;
  startedAt: string;
  pendingResponses: Map<string, (msg: BusMessage) => void>;
}

export class Orchestrator {
  private transport: Transport;
  private config: DuckpipeConfig;
  private activeRuns: Map<string, WorkflowRun> = new Map();
  private messageHandlers: Map<string, (msg: BusMessage) => void> = new Map();

  constructor(transport: Transport, config: DuckpipeConfig) {
    this.transport = transport;
    this.config = config;
  }

  start(): void {
    this.transport.subscribe("orchestrator", (msg) =>
      this.handleMessage(msg)
    );
  }

  get tier(): TrustTier {
    return this.config.duckpipe.trust_tier;
  }

  async dispatchToAgent(
    agent: AgentName,
    workflow: WorkflowName,
    taskType: string,
    payload: Record<string, unknown>
  ): Promise<BusMessage> {
    const auditId = logAction({
      workflow,
      agent,
      tool: taskType,
      tier: this.tier,
      input_json: JSON.stringify(payload),
      write_action: false,
      success: true,
    });

    const msg = createBusMessage("orchestrator", agent, workflow, "task", {
      ...payload,
      _taskType: taskType,
      _auditId: auditId,
    });

    return new Promise<BusMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageHandlers.delete(msg.id);
        reject(new Error(`Agent ${agent} timed out after ${this.config.agents.timeout_seconds}s`));
      }, this.config.agents.timeout_seconds * 1000);

      this.messageHandlers.set(msg.id, (response) => {
        clearTimeout(timer);
        this.messageHandlers.delete(msg.id);

        updateActionOutput(
          auditId,
          JSON.stringify(response.payload),
          0,
          response.type !== "error",
          response.type === "error"
            ? (response.payload.error as string)
            : undefined
        );

        resolve(response);
      });

      this.transport.send(agent, msg).catch(reject);
    });
  }

  async executeWriteAction(
    agent: AgentName,
    workflow: WorkflowName,
    action: string,
    payload: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ decision: PolicyDecision; result?: BusMessage }> {
    const decision = checkPolicy(action, agent, workflow, context, this.tier);

    const auditId = logAction({
      workflow,
      agent,
      tool: action,
      tier: this.tier,
      input_json: JSON.stringify(payload),
      write_action: true,
      approved_by: decision.allowed && !decision.approvalRequired
        ? `policy:auto`
        : undefined,
      success: decision.allowed,
      error_message: !decision.allowed ? decision.reason : undefined,
    });

    if (!decision.allowed) {
      return { decision };
    }

    if (decision.approvalRequired) {
      // In a full implementation, this would post to Slack and wait for approval
      return { decision };
    }

    const msg = createBusMessage("orchestrator", agent, workflow, "task", {
      ...payload,
      _taskType: action,
      _auditId: auditId,
    });

    const result = await new Promise<BusMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageHandlers.delete(msg.id);
        reject(new Error(`Agent ${agent} timed out`));
      }, this.config.agents.timeout_seconds * 1000);

      this.messageHandlers.set(msg.id, (response) => {
        clearTimeout(timer);
        this.messageHandlers.delete(msg.id);
        resolve(response);
      });

      this.transport.send(agent, msg).catch(reject);
    });

    updateActionOutput(
      auditId,
      JSON.stringify(result.payload),
      0,
      result.type !== "error",
      result.type === "error" ? (result.payload.error as string) : undefined
    );

    return { decision, result };
  }

  checkDedup(
    workflow: WorkflowName,
    triggerSource: string,
    entityId: string,
    windowMinutes = 5
  ): boolean {
    const db = getStateDb();
    const key = generateDedupKey(workflow, triggerSource, entityId);
    if (isDuplicate(db, key)) return true;
    markSeen(db, key, workflow, entityId, windowMinutes);
    return false;
  }

  recordWorkflowStart(workflow: WorkflowName): string {
    const id = uuid();
    const run: WorkflowRun = {
      id,
      workflow,
      status: "running",
      startedAt: new Date().toISOString(),
      pendingResponses: new Map(),
    };
    this.activeRuns.set(id, run);

    const db = getStateDb();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow, status, started_at)
       VALUES (?, ?, 'running', datetime('now', 'utc'))`
    ).run(id, workflow);

    return id;
  }

  recordWorkflowComplete(
    runId: string,
    status: "completed" | "failed",
    result?: Record<string, unknown>,
    error?: string
  ): void {
    this.activeRuns.delete(runId);

    const db = getStateDb();
    db.prepare(
      `UPDATE workflow_runs
       SET status = ?, completed_at = datetime('now', 'utc'),
           result_json = ?, error_message = ?
       WHERE id = ?`
    ).run(status, result ? JSON.stringify(result) : null, error ?? null, runId);
  }

  private handleMessage(msg: BusMessage): void {
    const requestId = msg.payload._requestId as string | undefined;
    if (requestId && this.messageHandlers.has(requestId)) {
      this.messageHandlers.get(requestId)!(msg);
      return;
    }

    // Check if any handler matches by source message pattern
    for (const [handlerId, handler] of this.messageHandlers) {
      if (msg.payload._replyTo === handlerId) {
        handler(msg);
        return;
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.transport.shutdown();
    this.activeRuns.clear();
    this.messageHandlers.clear();
  }
}
