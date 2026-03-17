/**
 * Generic agent runtime — the entry point every agent container runs.
 * Polls bus/agents/<name>/in/ for task messages, dispatches to the
 * registered tool function, writes result to bus/agents/<name>/out/.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type ToolFn = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface AgentRuntimeOptions {
  name: string;
  busDir: string;
  tools: Map<string, ToolFn>;
  pollMs?: number;
}

export function startAgentRuntime(opts: AgentRuntimeOptions): { stop: () => void } {
  const { name, busDir, tools, pollMs = 200 } = opts;
  const inDir = join(busDir, "agents", name, "in");
  const outDir = join(busDir, "agents", name, "out");

  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`[${name}] Agent runtime started — polling ${inDir}`);
  console.log(`[${name}] Registered tools: ${[...tools.keys()].join(", ")}`);

  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const files = readdirSync(inDir)
          .filter(f => f.endsWith(".json"))
          .sort();

        for (const file of files) {
          const filePath = join(inDir, file);
          let raw: string;
          try {
            raw = readFileSync(filePath, "utf-8");
            unlinkSync(filePath);
          } catch {
            continue;
          }

          let message: Record<string, unknown>;
          try {
            message = JSON.parse(raw);
          } catch {
            console.error(`[${name}] Invalid JSON in ${file}`);
            continue;
          }

          const payload = (message.payload ?? {}) as Record<string, unknown>;
          const taskType = payload._taskType as string | undefined;
          const messageId = message.id as string;

          if (!taskType) {
            console.error(`[${name}] Message ${messageId} missing _taskType`);
            continue;
          }

          const toolFn = tools.get(taskType);
          if (!toolFn) {
            console.error(`[${name}] Unknown tool: ${taskType}`);
            writeResponse(outDir, message, "error", { error: `Unknown tool: ${taskType}` });
            continue;
          }

          console.log(`[${name}] Executing ${taskType}`);
          const startMs = Date.now();

          try {
            const result = await toolFn(payload);
            const durationMs = Date.now() - startMs;
            console.log(`[${name}] ${taskType} completed in ${durationMs}ms`);
            writeResponse(outDir, message, "result", { ...result, _durationMs: durationMs });
          } catch (err) {
            const durationMs = Date.now() - startMs;
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[${name}] ${taskType} failed: ${errorMsg}`);
            writeResponse(outDir, message, "error", { error: errorMsg, _durationMs: durationMs });
          }
        }
      } catch {
        // Directory read failed, retry next tick
      }

      await sleep(pollMs);
    }
  };

  poll();

  return {
    stop() {
      running = false;
      console.log(`[${name}] Agent runtime stopped`);
    },
  };
}

function writeResponse(
  outDir: string,
  originalMessage: Record<string, unknown>,
  type: "result" | "error",
  payload: Record<string, unknown>
): void {
  const response = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: originalMessage.target,
    target: originalMessage.source,
    workflow: originalMessage.workflow,
    type,
    payload: {
      ...payload,
      _replyTo: originalMessage.id,
    },
  };

  const filename = `${Date.now()}-${response.id}.json`;
  writeFileSync(join(outDir, filename), JSON.stringify(response, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
