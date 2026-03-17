import { v4 as uuid } from "uuid";
import type { AgentName, BusMessage, Transport } from "../../src/types.js";

type AgentHandler = (msg: BusMessage) => BusMessage | Promise<BusMessage>;

/**
 * In-memory transport for testing. Agent responses are provided by registered
 * mock handlers instead of real Docker containers.
 */
export class MockTransport implements Transport {
  private handlers: Map<string, AgentHandler> = new Map();
  private subscriptions: Map<string, (msg: BusMessage) => void> = new Map();
  public sentMessages: BusMessage[] = [];

  registerAgentHandler(agent: AgentName, handler: AgentHandler): void {
    this.handlers.set(agent, handler);
  }

  async send(
    target: AgentName | "orchestrator",
    message: BusMessage
  ): Promise<void> {
    this.sentMessages.push(message);

    if (target === "orchestrator") {
      const sub = this.subscriptions.get("orchestrator");
      if (sub) sub(message);
      return;
    }

    // If there's a mock agent handler, simulate a response
    const handler = this.handlers.get(target);
    if (handler) {
      const response = await handler(message);
      response.payload._replyTo = message.id;
      const orchSub = this.subscriptions.get("orchestrator");
      if (orchSub) orchSub(response);
    }
  }

  subscribe(
    listener: AgentName | "orchestrator",
    handler: (msg: BusMessage) => void
  ): void {
    this.subscriptions.set(listener, handler);
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
    this.subscriptions.clear();
  }

  getMessagesSentTo(agent: AgentName): BusMessage[] {
    return this.sentMessages.filter((m) => m.target === agent);
  }

  static createResponse(
    request: BusMessage,
    payload: Record<string, unknown>
  ): BusMessage {
    return {
      id: uuid(),
      timestamp: new Date().toISOString(),
      source: request.target as AgentName,
      target: "orchestrator",
      workflow: request.workflow,
      type: "result",
      payload: { ...payload, _replyTo: request.id },
    };
  }
}
