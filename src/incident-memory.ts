import { getStateDb } from "./db.js";
import type {
  IncidentWorkspace,
  InvestigationFact,
  InvestigationHypothesis,
  InvestigationResult,
} from "./types.js";

export function getIncidentWorkspace(incidentRunId: string): IncidentWorkspace {
  const db = getStateDb();
  const row = db.prepare(
    `SELECT workspace_json
     FROM incident_workspaces
     WHERE incident_run_id = ?`
  ).get(incidentRunId) as { workspace_json: string } | undefined;

  if (!row) {
    return {
      incidentRunId,
      facts: [],
      hypotheses: [],
      openQuestions: [],
      subAgents: [],
      conversationCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    return JSON.parse(row.workspace_json) as IncidentWorkspace;
  } catch {
    return {
      incidentRunId,
      facts: [],
      hypotheses: [],
      openQuestions: [],
      subAgents: [],
      conversationCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
}

export function updateIncidentWorkspace(
  incidentRunId: string,
  patch: {
    facts?: InvestigationFact[];
    hypotheses?: InvestigationHypothesis[];
    openQuestions?: string[];
    subAgents?: IncidentWorkspace["subAgents"];
    incrementConversation?: boolean;
  },
): IncidentWorkspace {
  const db = getStateDb();
  const existing = getIncidentWorkspace(incidentRunId);

  const facts = mergeFacts(existing.facts, patch.facts ?? []);
  const hypotheses = mergeHypotheses(existing.hypotheses, patch.hypotheses ?? []);
  const openQuestions = uniq([...(existing.openQuestions ?? []), ...(patch.openQuestions ?? [])]).slice(0, 12);
  const subAgents = mergeSubAgents(existing.subAgents, patch.subAgents ?? []);

  const workspace: IncidentWorkspace = {
    incidentRunId,
    facts,
    hypotheses,
    openQuestions,
    subAgents,
    conversationCount: existing.conversationCount + (patch.incrementConversation ? 1 : 0),
    lastUpdated: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO incident_workspaces (incident_run_id, workspace_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(incident_run_id) DO UPDATE SET
       workspace_json = excluded.workspace_json,
       updated_at = excluded.updated_at`
  ).run(incidentRunId, JSON.stringify(workspace), workspace.lastUpdated);

  return workspace;
}

export function workspaceFromInvestigation(
  incidentRunId: string,
  investigation: InvestigationResult,
): IncidentWorkspace["subAgents"] {
  const ranAt = new Date().toISOString();
  return (investigation.subAgents ?? []).map((subAgent) => ({
    ...subAgent,
    ranAt,
  }));
}

function mergeFacts(
  existing: InvestigationFact[],
  incoming: InvestigationFact[],
): InvestigationFact[] {
  const merged = [...existing];
  for (const fact of incoming) {
    if (merged.some((item) => item.id === fact.id || item.summary === fact.summary)) continue;
    merged.push(fact);
  }
  return merged.slice(0, 30);
}

function mergeHypotheses(
  existing: InvestigationHypothesis[],
  incoming: InvestigationHypothesis[],
): InvestigationHypothesis[] {
  const merged = [...existing];
  for (const hypothesis of incoming) {
    const match = merged.find((item) => item.id === hypothesis.id || item.summary === hypothesis.summary);
    if (match) {
      match.status = hypothesis.status;
      match.confidence = hypothesis.confidence;
      continue;
    }
    merged.push(hypothesis);
  }
  return merged.slice(0, 20);
}

function mergeSubAgents(
  existing: IncidentWorkspace["subAgents"],
  incoming: IncidentWorkspace["subAgents"],
): IncidentWorkspace["subAgents"] {
  const merged = [...existing];
  for (const agent of incoming) {
    const index = merged.findIndex((item) => item.name === agent.name && item.focus === agent.focus);
    if (index >= 0) {
      merged[index] = agent;
    } else {
      merged.push(agent);
    }
  }
  return merged.slice(-20);
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean) as T[];
}
