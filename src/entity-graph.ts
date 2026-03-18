import type {
  AssetRef,
  CauseAssessment,
  EntityGraph,
  EntityGraphEdge,
  EntityGraphNode,
  IncidentContext,
} from "./types.js";

export function enrichIncidentContext(context: IncidentContext): IncidentContext {
  // Filter out filenames / non-table artifacts that extractTableRefs may have captured
  const JUNK_TABLE = /\.(py|pyc|js|ts|sh|yaml|yml|json|xml|cfg|conf|ini|log|txt|md|rst|csv|msgpack|pickle|parquet|lock|toml|sql|html|css|whl|egg|gz|zip|tar|com|org|net|io|dev|app|cloud)$/i;
  const JUNK_PREFIX = /^(self|cls|result|status|error|sys|os|re)\./i;
  const cleanTables = context.impact.affectedTables.filter((t) => !JUNK_TABLE.test(t) && !JUNK_PREFIX.test(t) && !t.includes("__") && t.length > 3);

  const blastRadius = dedupeAssets([
    ...context.impact.blastRadius.filter((a) => a.kind !== "table" || !JUNK_TABLE.test(a.name)),
    ...context.impactedAssets.filter((a) => a.kind !== "table" || !JUNK_TABLE.test(a.name)),
    ...cleanTables.map((name) => ({ kind: "table" as const, name })),
    ...context.impact.affectedModels.map((name) => ({ kind: "model" as const, name })),
    ...context.impact.affectedDags.map((name) => ({ kind: "dag" as const, name })),
  ]);

  const likelyOwner = inferLikelyOwner(context.candidateCauses, blastRadius);
  const runbook = inferRunbook(context.candidateCauses);

  return {
    ...context,
    impactedAssets: blastRadius,
    impact: {
      ...context.impact,
      blastRadius,
      likelyOwner: context.impact.likelyOwner ?? likelyOwner,
      runbook: context.impact.runbook ?? runbook,
    },
    entityGraph: buildEntityGraph({
      ...context,
      impactedAssets: blastRadius,
      impact: {
        ...context.impact,
        blastRadius,
        likelyOwner: context.impact.likelyOwner ?? likelyOwner,
        runbook: context.impact.runbook ?? runbook,
      },
    }),
  };
}

export function buildEntityGraph(context: IncidentContext): EntityGraph {
  const nodes = new Map<string, EntityGraphNode>();
  const edges: EntityGraphEdge[] = [];

  const addNode = (asset: AssetRef): string => {
    const id = `${asset.kind}:${asset.name}`;
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: asset.kind, name: asset.name });
    }
    return id;
  };

  const dagIds = context.impact.affectedDags.map((name) => addNode({ kind: "dag", name }));
  const taskIds = context.dag.failedTasks.map((task) => addNode({ kind: "task", name: task.taskId }));
  const tableIds = context.impact.affectedTables.map((name) => addNode({ kind: "table", name }));
  const modelIds = context.impact.affectedModels.map((name) => addNode({ kind: "model", name }));

  for (const dagId of dagIds) {
    for (const taskId of taskIds) {
      edges.push({ from: dagId, to: taskId, relation: "contains" });
    }
  }

  for (const taskId of taskIds) {
    for (const tableId of tableIds) {
      edges.push({ from: taskId, to: tableId, relation: "reads" });
    }
  }

  for (const tableId of tableIds) {
    for (const modelId of modelIds) {
      edges.push({ from: tableId, to: modelId, relation: "depends_on" });
    }
  }

  const owner = context.impact.likelyOwner;
  if (owner) {
    const ownerId = addNode({ kind: "owner", name: owner });
    for (const dagId of dagIds) edges.push({ from: ownerId, to: dagId, relation: "owns" });
    for (const modelId of modelIds) edges.push({ from: ownerId, to: modelId, relation: "owns" });
  }

  const runbook = context.impact.runbook;
  if (runbook) {
    const runbookId = addNode({ kind: "runbook", name: runbook });
    for (const dagId of dagIds) edges.push({ from: dagId, to: runbookId, relation: "references" });
  }

  return {
    nodes: [...nodes.values()],
    edges: dedupeEdges(edges),
  };
}

function inferLikelyOwner(causes: CauseAssessment[], blastRadius: AssetRef[]): string {
  const categories = new Set(causes.map((cause) => cause.category));
  if (categories.has("schema_drift") || blastRadius.some((asset) => asset.kind === "model")) {
    return "Analytics engineering owner";
  }
  if (categories.has("data_anomaly") || blastRadius.some((asset) => asset.kind === "table")) {
    return "Data platform owner";
  }
  return "Data engineering on-call";
}

function inferRunbook(causes: CauseAssessment[]): string {
  const categories = causes.map((cause) => cause.category);
  if (categories.includes("timeout") || categories.includes("connection_error")) {
    return "Airflow upstream connectivity runbook";
  }
  if (categories.includes("data_anomaly")) {
    return "Source data freshness runbook";
  }
  if (categories.includes("schema_drift")) {
    return "Schema drift response runbook";
  }
  if (categories.includes("logic_error")) {
    return "Pipeline logic error triage runbook";
  }
  return "General incident triage runbook";
}

function dedupeAssets(assets: AssetRef[]): AssetRef[] {
  const seen = new Set<string>();
  const deduped: AssetRef[] = [];
  for (const asset of assets) {
    const key = `${asset.kind}:${asset.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(asset);
  }
  return deduped;
}

function dedupeEdges(edges: EntityGraphEdge[]): EntityGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
