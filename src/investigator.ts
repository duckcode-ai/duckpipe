import { getStateDb } from "./db.js";
import type {
  DuckpipeConfig,
  IncidentContext,
  InvestigationFact,
  InvestigationHypothesis,
  InvestigationResult,
  InvestigationStep,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

interface DbtGraphPayload {
  mode?: string;
  models?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
}

interface ProbeResult {
  objectName: string;
  status: "exists" | "missing" | "inaccessible" | "unknown";
  detail: string;
}

interface InvestigatorState {
  facts: InvestigationFact[];
  hypotheses: InvestigationHypothesis[];
  unknowns: string[];
  nextChecks: string[];
  sources: Set<string>;
  evidenceIds: Set<string>;
  steps: InvestigationStep[];
  usedLiveData: boolean;
  airflowLogSnippet?: string;
  dbtGraph?: DbtGraphPayload | null;
  dbtRecentChanges?: Array<{ description?: string; name?: string; filePath?: string }>;
  dbtImpactedModels?: string[];
  dbtResolvedSources?: string[];
  dbtModelPaths?: string[];
  dbtModelSchemas?: string[];
  snowflakeAnomalies?: Array<Record<string, unknown>>;
  snowflakeSchemas?: Array<Record<string, unknown>>;
  objectChecks: ProbeResult[];
  priorIncidents: Array<{ incidentRunId: string; startedAt: string; severity?: string; rootCause?: string }>;
  slackMentions: Array<{ channel: string; ts: string; text: string }>;
  jiraIssues: Array<{ key: string; summary: string; status?: string }>;
  confluencePages: Array<{ id: string; title: string }>;
}

export async function investigateIncidentQuestion(
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<InvestigationResult> {
  const playbook = selectPlaybook(question, context);
  const state = createState(context);

  for (const step of getPlaybookSteps(playbook)) {
    await step(question, context, config, orchestrator, state);
  }

  finalizeInvestigation(playbook, question, context, state);

  return {
    playbook,
    summary: buildSummary(playbook, context, state),
    facts: state.facts.slice(0, 8),
    hypotheses: state.hypotheses.slice(0, 5),
    unknowns: uniq(state.unknowns).slice(0, 5),
    nextChecks: uniq(state.nextChecks).slice(0, 5),
    sources: [...state.sources],
    evidenceIds: [...state.evidenceIds],
    usedLiveData: state.usedLiveData,
    steps: state.steps,
    objectChecks: state.objectChecks.slice(0, 6),
    lineage: {
      failingModels: state.dbtImpactedModels ?? inferModelNames(context),
      upstreamSources: state.dbtResolvedSources ?? [],
      modelPaths: state.dbtModelPaths ?? [],
      modelSchemas: state.dbtModelSchemas ?? [],
    },
    priorIncidents: state.priorIncidents.slice(0, 5),
    externalContext: {
      slackMentions: state.slackMentions.slice(0, 5),
      jiraIssues: state.jiraIssues.slice(0, 5),
      confluencePages: state.confluencePages.slice(0, 5),
    },
  };
}

type PlaybookStep = (
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
) => Promise<void>;

function createState(context: IncidentContext): InvestigatorState {
  const sources = new Set<string>();
  if (context.dag.dagId) sources.add(`airflow:${context.dag.dagId}`);
  for (const model of context.impact.affectedModels.slice(0, 3)) sources.add(`dbt:${model}`);
  for (const table of context.impact.affectedTables.slice(0, 3)) sources.add(`snowflake:${table}`);

  return {
    facts: context.evidence.slice(0, 3).map((item, index) => ({
      id: `context-${index + 1}`,
      summary: item.summary,
      source: item.source,
      confidence: item.confidence,
    })),
    hypotheses: context.candidateCauses.slice(0, 3).map((item, index) => ({
      id: `context-hypothesis-${index + 1}`,
      summary: item.summary,
      status: index === 0 ? "supported" : "possible",
      confidence: item.confidence,
    })),
    unknowns: [],
    nextChecks: context.recommendedActions.map((item) => item.summary),
    sources,
    evidenceIds: new Set(context.evidence.slice(0, 4).map((item) => item.id)),
    steps: [],
    usedLiveData: false,
    objectChecks: [],
    priorIncidents: [],
    slackMentions: [],
    jiraIssues: [],
    confluencePages: [],
  };
}

function selectPlaybook(question: string, context: IncidentContext): string {
  const lower = question.toLowerCase();
  const primaryCategory = context.candidateCauses[0]?.category ?? "unknown";

  if (/slow|performance|query|warehouse|credits/.test(lower)) return "performance-deep-dive";
  if (/lineage|dbt|model|manifest|source|upstream|schema/.test(lower)) return "dbt-lineage-trace";
  if (/snowflake|object|permission|schema|table|exist|access/.test(lower)) return "missing-object-trace";
  if (/owner|who|next|fix|do now|check next/.test(lower)) return "ownership-and-action";
  if (/history|before|past|similar|previous|jira|slack|confluence/.test(lower)) return "prior-incident-trace";
  if (/airflow|task|log|retry|dag/.test(lower)) return "airflow-failure-trace";
  if (primaryCategory === "upstream_dependency") return "missing-object-trace";
  if (primaryCategory === "timeout" || primaryCategory === "connection_error") return "airflow-failure-trace";
  return "generic-investigation";
}

function getPlaybookSteps(playbook: string): PlaybookStep[] {
  switch (playbook) {
    case "missing-object-trace":
      return [collectAirflowLogsStep, collectDbtGraphStep, collectSnowflakeStateStep, probeSnowflakeObjectsStep, collectPriorIncidentsStep, collectExternalContextStep, deriveMissingObjectHypothesesStep];
    case "dbt-lineage-trace":
      return [collectDbtGraphStep, collectDbtChangesStep, collectSnowflakeStateStep, probeSnowflakeObjectsStep, collectPriorIncidentsStep, collectExternalContextStep, deriveDbtLineageHypothesesStep];
    case "performance-deep-dive":
      return [collectSnowflakePerformanceStep, collectDbtGraphStep, collectPriorIncidentsStep, collectExternalContextStep, derivePerformanceHypothesesStep];
    case "ownership-and-action":
      return [collectAirflowLogsStep, collectDbtGraphStep, collectSnowflakeStateStep, probeSnowflakeObjectsStep, collectPriorIncidentsStep, collectExternalContextStep, deriveOwnershipStep];
    case "prior-incident-trace":
      return [collectPriorIncidentsStep, collectExternalContextStep, collectDbtGraphStep, derivePriorIncidentHypothesesStep];
    case "airflow-failure-trace":
      return [collectAirflowLogsStep, collectDbtGraphStep, collectPriorIncidentsStep, collectExternalContextStep, deriveAirflowHypothesesStep];
    default:
      return [collectAirflowLogsStep, collectDbtGraphStep, collectSnowflakeStateStep, probeSnowflakeObjectsStep, collectPriorIncidentsStep, collectExternalContextStep, deriveGenericHypothesesStep];
  }
}

async function collectAirflowLogsStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const task = context.dag.failedTasks[0];
  if (!orchestrator || !context.dag.dagId || !context.dag.runId || !task?.taskId) {
    state.steps.push({ id: "airflow-logs", title: "Airflow failure context", outcome: "Used existing incident context because live Airflow lookup was not available.", usedLiveData: false });
    return;
  }

  try {
    const response = await orchestrator.dispatchToAgent("airflow", "incident-autopilot", "get_task_logs", {
      dag_id: context.dag.dagId,
      dag_run_id: context.dag.runId,
      task_id: task.taskId,
      try_number: task.tryNumber ?? 1,
    });

    const logText = String(response.payload.logs ?? "");
    state.airflowLogSnippet = logText.slice(-1500);
    state.usedLiveData = true;
    state.sources.add(`airflow:${context.dag.dagId}`);
    addFact(state, { id: "airflow-log-live", summary: `Fetched live Airflow logs for ${task.taskId}.`, source: "airflow", confidence: "high" });

    if (/sql compilation error|object does not exist|insufficient privileges|not authorized/i.test(logText)) {
      addFact(state, { id: "airflow-log-snowflake-object", summary: "Airflow logs point to a Snowflake object access or existence problem during dbt execution.", source: "airflow", confidence: "high" });
    }

    state.steps.push({ id: "airflow-logs", title: "Airflow failure context", outcome: `Pulled live logs for ${task.taskId} and extracted execution evidence.`, usedLiveData: true });
  } catch (err) {
    state.unknowns.push(`Could not fetch live Airflow logs: ${err instanceof Error ? err.message : String(err)}`);
    state.steps.push({ id: "airflow-logs", title: "Airflow failure context", outcome: "Live Airflow log lookup failed; investigation fell back to stored incident evidence.", usedLiveData: false });
  }
}

async function collectDbtGraphStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (!orchestrator) {
    state.steps.push({ id: "dbt-graph", title: "dbt graph resolution", outcome: "Used impacted models from incident context because live dbt graph lookup was not available.", usedLiveData: false });
    return;
  }

  try {
    const graph = await orchestrator.dispatchToAgent("dbt", "incident-autopilot", "get_project_graph", {});
    state.dbtGraph = graph.payload as DbtGraphPayload;
    state.sources.add(`dbt:${state.dbtGraph.mode ?? "project"}`);
    state.usedLiveData = true;

    const inferredModels = inferModelNames(context);
    const models = (state.dbtGraph.models ?? []).filter((model) => inferredModels.includes(String(model.name ?? "")));
    state.dbtImpactedModels = models.map((model) => String(model.name ?? ""));
    state.dbtModelPaths = models.map((model) => String(model.filePath ?? "")).filter(Boolean);
    state.dbtModelSchemas = models.map((model) => `${String(model.database ?? "")}.${String(model.schema ?? "")}`).filter((v) => v !== ".");

    const sourceRefs = models.flatMap((model) => Array.isArray(model.sourceRefs) ? model.sourceRefs.map(String) : []);
    const sourceMatches = (state.dbtGraph.sources ?? []).filter((source) => sourceRefs.includes(`${source.sourceName}.${source.table}`));
    state.dbtResolvedSources = sourceMatches.map((source) => `${source.database}.${source.schema}.${source.table}`);

    addFact(state, { id: "dbt-graph-live", summary: `Resolved dbt project graph in ${state.dbtGraph.mode ?? "unknown"} mode.`, source: "dbt", confidence: "high" });
    if (state.dbtImpactedModels.length > 0) addFact(state, { id: "dbt-impacted-models", summary: `Closest impacted dbt models: ${state.dbtImpactedModels.join(", ")}.`, source: "dbt", confidence: "high" });
    if ((state.dbtResolvedSources ?? []).length > 0) addFact(state, { id: "dbt-upstream-sources", summary: `dbt lineage resolves upstream sources: ${state.dbtResolvedSources?.join(", ")}.`, source: "dbt", confidence: "medium" });
    if ((state.dbtModelPaths ?? []).length > 0) addFact(state, { id: "dbt-model-paths", summary: `Failing model files: ${state.dbtModelPaths?.join(", ")}.`, source: "dbt", confidence: "medium" });

    state.steps.push({ id: "dbt-graph", title: "dbt graph resolution", outcome: `Loaded the dbt graph and mapped impacted models to upstream sources.`, usedLiveData: true });
  } catch (err) {
    state.unknowns.push(`Could not load live dbt project graph: ${err instanceof Error ? err.message : String(err)}`);
    state.steps.push({ id: "dbt-graph", title: "dbt graph resolution", outcome: "Live dbt graph lookup failed; using affected models from stored incident context.", usedLiveData: false });
  }
}

async function collectDbtChangesStep(
  _question: string,
  _context: IncidentContext,
  _config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (!orchestrator) return;
  try {
    const changes = await orchestrator.dispatchToAgent("dbt", "incident-autopilot", "check_recent_changes", { lookback_hours: 24 });
    state.dbtRecentChanges = ((changes.payload.changes ?? []) as Array<{ description?: string; name?: string; filePath?: string }>);
    state.usedLiveData = true;
    if (state.dbtRecentChanges.length > 0) addFact(state, { id: "dbt-recent-changes", summary: `Found ${state.dbtRecentChanges.length} dbt change(s) in the last 24 hours.`, source: "dbt", confidence: "medium" });
    state.steps.push({ id: "dbt-changes", title: "dbt recent changes", outcome: state.dbtRecentChanges.length > 0 ? `Pulled recent dbt changes for comparison against the incident window.` : "No recent dbt changes were found in the configured project path.", usedLiveData: true });
  } catch (err) {
    state.unknowns.push(`Could not inspect recent dbt changes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function collectSnowflakeStateStep(
  _question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const candidateTables = uniq([...context.impact.affectedTables, ...(state.dbtResolvedSources ?? [])]).slice(0, 5);

  if (!orchestrator) {
    state.steps.push({ id: "snowflake-state", title: "Snowflake object checks", outcome: "Used incident context only because live Snowflake lookup was not available.", usedLiveData: false });
    return;
  }

  try {
    if (candidateTables.length > 0) {
      const anomalies = await orchestrator.dispatchToAgent("snowflake", "incident-autopilot", "check_source_anomalies", { tables: candidateTables });
      state.snowflakeAnomalies = (anomalies.payload.anomalies ?? []) as Array<Record<string, unknown>>;
      state.usedLiveData = true;
    }

    const watchedDatabases = uniq([
      config.integrations.snowflake?.database,
      ...(config.integrations.snowflake?.watched_databases ?? []),
      ...candidateTables.map((table) => table.split(".")[0]),
    ].filter((value): value is string => Boolean(value))).slice(0, 3);

    if (watchedDatabases.length > 0) {
      const schemas = await orchestrator.dispatchToAgent("snowflake", "incident-autopilot", "fetch_schemas", { databases: watchedDatabases });
      state.snowflakeSchemas = (schemas.payload.schemas ?? []) as Array<Record<string, unknown>>;
      state.usedLiveData = true;
    }

    const anomaly = state.snowflakeAnomalies?.find((item) => Boolean(item.anomalyDetected));
    if (anomaly) addFact(state, { id: "snowflake-anomaly", summary: `Snowflake anomaly check flagged ${String(anomaly.table ?? "a table")}: ${String(anomaly.anomalyDescription ?? "anomaly detected")}.`, source: "snowflake", confidence: "high" });
    const coverage = state.snowflakeSchemas?.length ?? 0;
    if (coverage > 0) addFact(state, { id: "snowflake-schema-coverage", summary: `Snowflake schema scan covered ${coverage} table definitions across the configured databases.`, source: "snowflake", confidence: "medium" });

    state.steps.push({ id: "snowflake-state", title: "Snowflake object checks", outcome: candidateTables.length > 0 ? `Checked Snowflake state for ${candidateTables.join(", ")}.` : "Checked configured Snowflake databases for schema context.", usedLiveData: true });
  } catch (err) {
    state.unknowns.push(`Could not collect Snowflake state: ${err instanceof Error ? err.message : String(err)}`);
    state.steps.push({ id: "snowflake-state", title: "Snowflake object checks", outcome: "Live Snowflake checks failed during investigation.", usedLiveData: false });
  }
}

async function probeSnowflakeObjectsStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const candidateTables = uniq([...(state.dbtResolvedSources ?? []), ...context.impact.affectedTables]).slice(0, 4);
  if (!orchestrator || candidateTables.length === 0) {
    return;
  }

  for (const tableName of candidateTables) {
    try {
      const response = await orchestrator.dispatchToAgent("snowflake", "incident-autopilot", "execute_query", {
        sql: `SELECT 1 AS OK FROM ${tableName} LIMIT 1`,
      });
      if (response.type === "error") {
        const detail = String(response.payload.error ?? "Unknown error");
        state.objectChecks.push({ objectName: tableName, status: classifyProbeStatus(detail), detail });
      } else {
        state.objectChecks.push({ objectName: tableName, status: "exists", detail: "Read probe succeeded for this object." });
      }
      state.usedLiveData = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      state.objectChecks.push({ objectName: tableName, status: classifyProbeStatus(detail), detail });
    }
  }

  for (const probe of state.objectChecks) {
    if (probe.status === "missing") addFact(state, { id: `probe-${probe.objectName}`, summary: `${probe.objectName} appears to be missing in the current Snowflake target.`, source: "snowflake", confidence: "high" });
    if (probe.status === "inaccessible") addFact(state, { id: `probe-${probe.objectName}`, summary: `${probe.objectName} exists in the investigation path but looks inaccessible to the configured role or target.`, source: "snowflake", confidence: "high" });
  }

  state.steps.push({ id: "snowflake-probes", title: "Exact Snowflake object probes", outcome: `Executed read probes against ${candidateTables.length} candidate object(s) to distinguish missing objects from access problems.`, usedLiveData: true });
}

async function collectSnowflakePerformanceStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (!orchestrator) return;
  const entity = inferModelNames(context)[0] ?? context.impact.affectedTables[0];
  if (!entity) return;

  try {
    const plans = await orchestrator.dispatchToAgent("snowflake", "incident-autopilot", "get_query_plans", { entity, limit: 5 });
    const planList = (plans.payload.plans ?? []) as Array<Record<string, unknown>>;
    state.usedLiveData = true;
    if (planList.length > 0) addFact(state, { id: "snowflake-query-plans", summary: `Found ${planList.length} recent Snowflake query plan(s) touching ${entity}.`, source: "snowflake", confidence: "medium" });
    else state.unknowns.push(`No recent Snowflake query plans were found for ${entity}.`);
    state.steps.push({ id: "snowflake-performance", title: "Snowflake performance scan", outcome: `Scanned recent Snowflake query history for ${entity}.`, usedLiveData: true });
  } catch (err) {
    state.unknowns.push(`Could not inspect Snowflake query performance: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function collectPriorIncidentsStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const db = getStateDb();
  const dagId = context.dag.dagId ?? context.impact.affectedDags[0] ?? "";
  const currentRunId = context.incidentId.replace(/^incident-/, "");
  const rows = db.prepare(
    `SELECT id, started_at, result_json
     FROM workflow_runs
     WHERE workflow = 'incident-autopilot'
       AND status = 'completed'
       AND id != ?
     ORDER BY started_at DESC
     LIMIT 20`
  ).all(currentRunId) as Array<{ id: string; started_at: string; result_json: string | null }>;

  for (const row of rows) {
    const result = row.result_json ? safeJson(row.result_json) : {};
    const severity = typeof result.severity === "string" ? result.severity : undefined;
    const rootCause = typeof result.rootCause === "string" ? result.rootCause : undefined;
    const priorContext = result.incidentContext as IncidentContext | undefined;
    const sameDag = Boolean(dagId && priorContext?.impact?.affectedDags?.includes(dagId));
    const sameCategory = result.rootCauseCategory === context.candidateCauses[0]?.category;
    if (!sameDag && !sameCategory) continue;
    state.priorIncidents.push({ incidentRunId: row.id, startedAt: row.started_at, severity, rootCause });
  }

  if (state.priorIncidents.length > 0) {
    addFact(state, { id: "prior-incidents", summary: `Found ${state.priorIncidents.length} similar prior incident(s) for this DAG or failure category.`, source: "workflow", confidence: "medium" });
  }

  state.steps.push({ id: "prior-incidents", title: "Prior incident context", outcome: state.priorIncidents.length > 0 ? `Matched ${state.priorIncidents.length} prior incident(s) with similar scope.` : "No strongly similar prior incidents were found in local DuckPipe history.", usedLiveData: false });
}

async function collectExternalContextStep(
  _question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (!orchestrator) {
    state.steps.push({ id: "external-context", title: "Slack / Jira / Confluence context", outcome: "External collaboration context was not fetched because the live orchestrator was unavailable.", usedLiveData: false });
    return;
  }

  const keywords = uniq([
    context.dag.dagId,
    ...inferModelNames(context),
    ...context.impact.affectedTables.flatMap((value) => [value, value.split(".").slice(-1)[0]]),
  ].filter((value): value is string => Boolean(value))).slice(0, 5);

  try {
    const channels = config.integrations.slack?.allowed_channels ?? [];
    for (const channel of channels.slice(0, 2)) {
      try {
        const history = await orchestrator.dispatchToAgent("comms", "incident-autopilot", "slack_get_channel_history", {
          channel,
          limit: 50,
        });
        const messages = (history.payload.messages ?? []) as Array<{ text?: string; ts?: string }>;
        const matches = messages.filter((message) => keywords.some((keyword) => String(message.text ?? "").toLowerCase().includes(keyword.toLowerCase())));
        for (const message of matches.slice(0, 5)) {
          state.slackMentions.push({ channel, ts: String(message.ts ?? ""), text: String(message.text ?? "") });
        }
      } catch {
        // ignore per-channel slack failures
      }
    }

    if (config.integrations.jira?.enabled && keywords.length > 0) {
      const project = config.integrations.jira.default_project;
      const searchTerms = keywords.slice(0, 3).map((keyword) => `summary ~ \"${keyword.replace(/"/g, '\\"')}\"`).join(" OR ");
      const jql = `project = ${project} AND (${searchTerms}) ORDER BY updated DESC`;
      try {
        const issues = await orchestrator.dispatchToAgent("comms", "incident-autopilot", "jira_search_issues", {
          jql,
          limit: 5,
        });
        const items = (issues.payload.issues ?? []) as Array<Record<string, unknown>>;
        state.jiraIssues = items.map((item) => ({
          key: String(item.key ?? ""),
          summary: String((item.fields as Record<string, unknown> | undefined)?.summary ?? ""),
          status: String((((item.fields as Record<string, unknown> | undefined)?.status as Record<string, unknown> | undefined)?.name) ?? ""),
        })).filter((item) => item.key || item.summary);
      } catch {
        // ignore jira search failures
      }
    }

    if (config.integrations.confluence?.enabled && keywords.length > 0) {
      const titles = uniq([context.dag.dagId, ...inferModelNames(context)].filter((value): value is string => Boolean(value))).slice(0, 3);
      for (const title of titles) {
        try {
          const page = await orchestrator.dispatchToAgent("comms", "incident-autopilot", "confluence_find_page", { title });
          const found = page.payload.page as { id?: string; title?: string } | null | undefined;
          if (found?.id && found?.title) {
            state.confluencePages.push({ id: String(found.id), title: String(found.title) });
            continue;
          }
          const pages = await orchestrator.dispatchToAgent("comms", "incident-autopilot", "confluence_search_pages", {
            query: title,
            limit: 3,
          });
          const foundPages = (pages.payload.pages ?? []) as Array<{ id?: string; title?: string }>;
          for (const foundPage of foundPages) {
            if (foundPage.id && foundPage.title) {
              state.confluencePages.push({ id: String(foundPage.id), title: String(foundPage.title) });
            }
          }
        } catch {
          // ignore confluence failures
        }
      }
    }

    state.usedLiveData = state.usedLiveData || state.slackMentions.length > 0 || state.jiraIssues.length > 0 || state.confluencePages.length > 0;
    if (state.slackMentions.length > 0) addFact(state, { id: "slack-context", summary: `Found ${state.slackMentions.length} Slack message(s) mentioning the incident scope.`, source: "system", confidence: "medium" });
    if (state.jiraIssues.length > 0) addFact(state, { id: "jira-context", summary: `Found ${state.jiraIssues.length} Jira issue(s) related to the affected DAG, model, or table.`, source: "system", confidence: "medium" });
    if (state.confluencePages.length > 0) addFact(state, { id: "confluence-context", summary: `Found ${state.confluencePages.length} Confluence page(s) matching the incident scope.`, source: "system", confidence: "medium" });

    state.steps.push({
      id: "external-context",
      title: "Slack / Jira / Confluence context",
      outcome: `Collected external collaboration context: ${state.slackMentions.length} Slack mention(s), ${state.jiraIssues.length} Jira issue(s), ${state.confluencePages.length} Confluence page(s).`,
      usedLiveData: state.usedLiveData,
    });
  } catch (err) {
    state.unknowns.push(`Could not collect external collaboration context: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deriveMissingObjectHypothesesStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const missingProbes = state.objectChecks.filter((item) => item.status === "missing");
  const inaccessibleProbes = state.objectChecks.filter((item) => item.status === "inaccessible");
  const candidateTables = uniq([...context.impact.affectedTables, ...(state.dbtResolvedSources ?? [])]);
  const existingTables = new Set((state.snowflakeSchemas ?? []).map((item) => canonicalTableName(item)).filter(Boolean));
  const missingTables = candidateTables.filter((table) => !matchesAnyTable(table, existingTables));

  if (missingProbes.length > 0 || missingTables.length > 0) {
    upsertHypothesis(state, {
      id: "missing-object",
      summary: `At least one upstream Snowflake object appears missing: ${uniq([...missingProbes.map((item) => item.objectName), ...missingTables]).join(", ")}.`,
      status: "supported",
      confidence: "high",
    });
    state.nextChecks.unshift(`Confirm whether ${missingProbes[0]?.objectName ?? missingTables[0]} should exist in the current Snowflake environment and dbt target.`);
  }

  if (inaccessibleProbes.length > 0) {
    upsertHypothesis(state, {
      id: "privilege-issue",
      summary: `One or more referenced objects look inaccessible to the current Snowflake role or target: ${inaccessibleProbes.map((item) => item.objectName).join(", ")}.`,
      status: "supported",
      confidence: "high",
    });
    state.nextChecks.unshift(`Compare the configured Snowflake role and dbt target against ${inaccessibleProbes[0].objectName} access requirements.`);
  }

  if (state.jiraIssues.length > 0) {
    upsertHypothesis(state, {
      id: "known-operational-issue",
      summary: `Existing Jira issue(s) may already track this data or environment problem.`,
      status: "possible",
      confidence: "medium",
    });
  }

  if (missingProbes.length === 0 && inaccessibleProbes.length === 0 && candidateTables.length > 0) {
    upsertHypothesis(state, {
      id: "permission-or-target",
      summary: `The referenced objects may exist, but the configured role, database, schema, or dbt target may not match the intended environment.`,
      status: "possible",
      confidence: "medium",
    });
  }

  state.steps.push({
    id: "derive-missing-object",
    title: "Missing object diagnosis",
    outcome: missingProbes.length > 0
      ? `The investigation found likely missing source objects: ${missingProbes.map((item) => item.objectName).join(", ")}.`
      : inaccessibleProbes.length > 0
        ? `The investigation found object access problems: ${inaccessibleProbes.map((item) => item.objectName).join(", ")}.`
        : "The investigation could not prove a missing object, so target/role mismatch remain possible.",
    usedLiveData: state.usedLiveData,
  });
}

async function deriveDbtLineageHypothesesStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if ((state.dbtResolvedSources ?? []).length > 0) {
    upsertHypothesis(state, {
      id: "dbt-lineage-source",
      summary: `The failing dbt model ${inferModelNames(context)[0] ?? "unknown"} depends on ${state.dbtResolvedSources?.join(", ")}.`,
      status: "supported",
      confidence: "high",
    });
  }

  if ((state.dbtRecentChanges ?? []).length > 0) {
    upsertHypothesis(state, {
      id: "recent-dbt-change",
      summary: `Recent dbt changes overlapped with the incident window and could have changed model SQL, source definitions, or environment assumptions.`,
      status: "possible",
      confidence: "medium",
    });
  }

  if ((state.objectChecks ?? []).some((item) => item.status === "missing" || item.status === "inaccessible")) {
    upsertHypothesis(state, {
      id: "lineage-object-diagnosis",
      summary: `The dbt lineage points to upstream objects that are either missing or inaccessible in Snowflake for this target.`,
      status: "supported",
      confidence: "high",
    });
  }

  if (state.confluencePages.length > 0) {
    addFact(state, { id: "confluence-lineage-context", summary: `Confluence contains documentation pages for this DAG/model scope.`, source: "system", confidence: "medium" });
  }

  state.nextChecks.unshift("Open the failing model SQL and compare its source references, schema, and target against the current Snowflake environment.");
  state.steps.push({ id: "derive-dbt-lineage", title: "dbt lineage diagnosis", outcome: "Connected the failing model to its upstream lineage, source objects, recent changes, and related documentation.", usedLiveData: state.usedLiveData });
}

async function deriveAirflowHypothesesStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  const taskId = context.dag.failedTasks[0]?.taskId ?? "unknown";
  upsertHypothesis(state, { id: "airflow-task-failure", summary: `The immediate failure point is Airflow task ${taskId} in DAG ${context.dag.dagId ?? context.impact.affectedDags[0] ?? "unknown"}.`, status: "supported", confidence: "high" });
  if (state.airflowLogSnippet && /dbt/i.test(state.airflowLogSnippet)) addFact(state, { id: "airflow-dbt-invocation", summary: "Airflow logs confirm the failing task was invoking dbt when the error occurred.", source: "airflow", confidence: "high" });
  if (state.slackMentions.length > 0) addFact(state, { id: "airflow-slack-mentions", summary: `Slack already has discussion threads about this DAG or task scope.`, source: "system", confidence: "medium" });
  state.nextChecks.unshift(`Review the failing task ${taskId} and verify the exact dbt command target/profile it used.`);
  state.steps.push({ id: "derive-airflow", title: "Airflow failure diagnosis", outcome: `Mapped the incident back to failing Airflow task ${taskId}.`, usedLiveData: state.usedLiveData });
}

async function derivePerformanceHypothesesStep(
  _question: string,
  _context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  upsertHypothesis(state, { id: "performance-scan", summary: "Performance investigation requires recent Snowflake query plans and warehouse telemetry for the impacted entity.", status: "possible", confidence: state.usedLiveData ? "medium" : "low" });
  state.nextChecks.unshift("Narrow the investigation to a specific slow model or query text if performance remains the primary concern.");
  state.steps.push({ id: "derive-performance", title: "Performance diagnosis", outcome: "Assessed whether the incident should be treated as a query/warehouse performance issue.", usedLiveData: state.usedLiveData });
}

async function deriveOwnershipStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (context.impact.likelyOwner) addFact(state, { id: "ownership", summary: `Likely owner is ${context.impact.likelyOwner}.`, source: "workflow", confidence: "high" });
  if (context.impact.runbook) addFact(state, { id: "runbook", summary: `Runbook available: ${context.impact.runbook}.`, source: "workflow", confidence: "medium" });
  if (state.priorIncidents.length > 0) addFact(state, { id: "ownership-prior-incidents", summary: `There are ${state.priorIncidents.length} similar prior incidents, which may help the owner compare previous fixes.`, source: "workflow", confidence: "medium" });
  if (state.jiraIssues.length > 0) addFact(state, { id: "ownership-jira", summary: `Relevant Jira issues already exist for this incident scope.`, source: "system", confidence: "medium" });
  state.nextChecks.unshift(...context.recommendedActions.map((item) => item.summary));
  state.steps.push({ id: "derive-ownership", title: "Ownership and next action", outcome: "Collected likely owner, runbook, recommended follow-up actions, and collaboration context.", usedLiveData: false });
}

async function derivePriorIncidentHypothesesStep(
  _question: string,
  _context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  if (state.priorIncidents.length > 0) {
    upsertHypothesis(state, { id: "prior-incident-pattern", summary: `This looks similar to ${state.priorIncidents.length} earlier incident(s) in DuckPipe history.`, status: "supported", confidence: "medium" });
    state.nextChecks.unshift("Compare the current failure against the most recent similar incident to see whether the same object or target mismatch recurred.");
  } else {
    state.unknowns.push("No similar prior incidents were found in DuckPipe history for this DAG or cause category.");
  }

  if (state.slackMentions.length > 0 || state.jiraIssues.length > 0 || state.confluencePages.length > 0) {
    addFact(state, {
      id: "external-history-context",
      summary: `External tools contain relevant context: ${state.slackMentions.length} Slack mention(s), ${state.jiraIssues.length} Jira issue(s), ${state.confluencePages.length} Confluence page(s).`,
      source: "system",
      confidence: "medium",
    });
  }

  state.steps.push({ id: "derive-prior-incidents", title: "Historical comparison", outcome: state.priorIncidents.length > 0 ? `Compared the incident to ${state.priorIncidents.length} prior occurrence(s).` : "No similar prior incidents were found for comparison.", usedLiveData: false });
}

async function deriveGenericHypothesesStep(
  _question: string,
  context: IncidentContext,
  _config: DuckpipeConfig,
  _orchestrator: Orchestrator | null,
  state: InvestigatorState,
): Promise<void> {
  upsertHypothesis(state, { id: "generic-primary-cause", summary: context.candidateCauses[0]?.summary ?? "The incident still needs deeper evidence collection.", status: "possible", confidence: context.candidateCauses[0]?.confidence ?? "low" });
  state.steps.push({ id: "derive-generic", title: "Generic diagnosis", outcome: "Combined Airflow, dbt, Snowflake, prior incident, and collaboration evidence into a ranked set of likely causes.", usedLiveData: state.usedLiveData });
}

function finalizeInvestigation(
  playbook: string,
  _question: string,
  context: IncidentContext,
  state: InvestigatorState,
): void {
  if (state.hypotheses.length === 0) {
    upsertHypothesis(state, { id: "fallback-primary", summary: context.candidateCauses[0]?.summary ?? "Cause remains unclear after initial investigation.", status: "possible", confidence: context.candidateCauses[0]?.confidence ?? "low" });
  }

  if (playbook === "missing-object-trace" && !(state.dbtResolvedSources?.length || context.impact.affectedTables.length)) {
    state.unknowns.push("No explicit upstream table references were resolved from the incident context or dbt graph.");
  }

  if (state.nextChecks.length === 0) {
    state.nextChecks.push("Review the failing task logs and confirm the exact dbt target, source object, and Snowflake role used during execution.");
  }
}

function buildSummary(playbook: string, context: IncidentContext, state: InvestigatorState): string {
  const topHypothesis = state.hypotheses[0]?.summary ?? context.candidateCauses[0]?.summary ?? "Cause remains unclear.";
  const topFacts = state.facts.slice(0, 2).map((fact) => fact.summary);
  const firstNext = state.nextChecks[0] ?? "Continue collecting evidence.";
  const probeSummary = state.objectChecks.length > 0
    ? `Object probes: ${state.objectChecks.map((item) => `${item.objectName}=${item.status}`).join(", ")}.`
    : null;
  const externalSummary = (state.slackMentions.length + state.jiraIssues.length + state.confluencePages.length) > 0
    ? `External context: ${state.slackMentions.length} Slack, ${state.jiraIssues.length} Jira, ${state.confluencePages.length} Confluence.`
    : null;

  return [
    `Playbook: ${playbook}.`,
    `Best current explanation: ${topHypothesis}`,
    topFacts.length > 0 ? `Supporting facts: ${topFacts.join(" | ")}` : null,
    probeSummary,
    externalSummary,
    `Next check: ${firstNext}`,
  ].filter(Boolean).join(" ");
}

function addFact(state: InvestigatorState, fact: InvestigationFact): void {
  if (state.facts.some((item) => item.id === fact.id || item.summary === fact.summary)) return;
  state.facts.push(fact);
}

function upsertHypothesis(state: InvestigatorState, hypothesis: InvestigationHypothesis): void {
  const existing = state.hypotheses.find((item) => item.id === hypothesis.id || item.summary === hypothesis.summary);
  if (existing) {
    existing.status = hypothesis.status;
    existing.confidence = hypothesis.confidence;
    return;
  }
  state.hypotheses.push(hypothesis);
}

function inferModelNames(context: IncidentContext): string[] {
  const names = new Set<string>(context.impact.affectedModels ?? []);
  for (const task of context.dag.failedTasks) {
    const inferred = task.taskId.replace(/\.(run|test|seed|snapshot)$/, "");
    if (inferred && inferred !== task.taskId) names.add(inferred);
  }
  return [...names].filter(Boolean);
}

function canonicalTableName(record: Record<string, unknown>): string {
  const database = String(record.database ?? record.DATABASE ?? "");
  const schema = String(record.schema ?? record.SCHEMA ?? "");
  const table = String(record.table ?? record.TABLE ?? record.name ?? "");
  return [database, schema, table].filter(Boolean).join(".").toUpperCase();
}

function matchesAnyTable(candidate: string, existingTables: Set<string>): boolean {
  const upper = candidate.toUpperCase();
  if (existingTables.has(upper)) return true;
  const suffix = upper.split(".").slice(-2).join(".");
  for (const table of existingTables) {
    if (table.endsWith(upper) || table.endsWith(suffix)) return true;
  }
  return false;
}

function classifyProbeStatus(detail: string): ProbeResult["status"] {
  const lower = detail.toLowerCase();
  if (lower.includes("does not exist") || lower.includes("not found")) return "missing";
  if (lower.includes("not authorized") || lower.includes("insufficient privilege") || lower.includes("permission") || lower.includes("access denied")) return "inaccessible";
  return "unknown";
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)].filter(Boolean) as T[];
}
