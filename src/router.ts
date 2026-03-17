import type {
  AirflowFailureEvent,
  SlackMessage,
  WorkflowName,
} from "./types.js";

export interface IncomingEvent {
  source: "airflow_webhook" | "airflow_poll" | "slack_message" | "schedule";
  data: Record<string, unknown>;
}

export interface RouteDecision {
  workflow: WorkflowName;
  event: Record<string, unknown>;
}

const QUERY_SAGE_PATTERN =
  /@duckpipe\s+(why|explain|optimize|fix).*(slow|expensive|query)/i;

export function routeEvent(event: IncomingEvent): RouteDecision | null {
  switch (event.source) {
    case "airflow_webhook":
    case "airflow_poll":
      return routeAirflowEvent(event.data);
    case "slack_message":
      return routeSlackMessage(event.data as unknown as SlackMessage);
    case "schedule":
      return {
        workflow: event.data.workflow as WorkflowName,
        event: event.data,
      };
    default:
      return null;
  }
}

function routeAirflowEvent(
  data: Record<string, unknown>
): RouteDecision | null {
  const dagId = data.dag_id as string | undefined;
  const status = data.status as string | undefined;

  if (!dagId) return null;

  if (status === "failed" || data.failure_type) {
    const event: AirflowFailureEvent = {
      dag_id: dagId,
      run_id: String(data.run_id ?? ""),
      task_id: data.task_id != null ? String(data.task_id) : undefined,
      execution_date: String(data.execution_date ?? ""),
      failure_type: data.failure_type != null ? String(data.failure_type) : undefined,
    };
    return { workflow: "incident-autopilot", event: event as unknown as Record<string, unknown> };
  }

  return null;
}

function routeSlackMessage(message: SlackMessage): RouteDecision | null {
  if (QUERY_SAGE_PATTERN.test(message.text)) {
    return {
      workflow: "query-sage",
      event: message as unknown as Record<string, unknown>,
    };
  }

  return null;
}
