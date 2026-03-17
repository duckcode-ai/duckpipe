import type { Orchestrator } from "./orchestrator.js";

let activeOrchestrator: Orchestrator | null = null;

export function setActiveOrchestrator(orchestrator: Orchestrator | null): void {
  activeOrchestrator = orchestrator;
}

export function getActiveOrchestrator(): Orchestrator | null {
  return activeOrchestrator;
}
