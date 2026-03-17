import { investigateIncidentQuestion } from "./investigator.js";
import type {
  DuckpipeConfig,
  IncidentContext,
  InvestigationResult,
} from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

export interface SubAgentRun {
  name: string;
  focus: string;
  question: string;
  result: InvestigationResult;
}

export async function runIncidentSubAgents(
  question: string,
  context: IncidentContext,
  config: DuckpipeConfig,
  orchestrator: Orchestrator | null,
): Promise<SubAgentRun[]> {
  const tasks = selectSubAgentTasks(question, context);
  const runs: SubAgentRun[] = [];

  for (const task of tasks) {
    const result = await investigateIncidentQuestion(task.question, context, config, orchestrator);
    runs.push({
      name: task.name,
      focus: task.focus,
      question: task.question,
      result,
    });
  }

  return runs;
}

function selectSubAgentTasks(
  question: string,
  context: IncidentContext,
): Array<{ name: string; focus: string; question: string }> {
  const lower = question.toLowerCase();
  const tasks: Array<{ name: string; focus: string; question: string }> = [];
  const model = context.impact.affectedModels[0] ?? inferModelName(context);
  const table = context.impact.affectedTables[0];
  const dag = context.dag.dagId ?? context.impact.affectedDags[0] ?? "this DAG";

  tasks.push({
    name: "airflow_failure_agent",
    focus: "Failure point and execution path",
    question: `What exactly failed in ${dag}?`,
  });

  if (model) {
    tasks.push({
      name: "dbt_lineage_agent",
      focus: "dbt model lineage and source resolution",
      question: `Show the dbt lineage for ${model}.`,
    });
  }

  if (table || /snowflake|object|permission|table|schema|access/.test(lower) || context.candidateCauses[0]?.category === "upstream_dependency") {
    tasks.push({
      name: "snowflake_access_agent",
      focus: "Snowflake object existence and permission diagnosis",
      question: table
        ? `Is ${table} missing or inaccessible in Snowflake?`
        : "Which Snowflake object is missing or inaccessible?",
    });
  }

  tasks.push({
    name: "history_context_agent",
    focus: "Prior incidents and external operational context",
    question: "Has this happened before and is there existing Slack, Jira, or Confluence context?",
  });

  if (/owner|fix|next|action|who/.test(lower)) {
    tasks.push({
      name: "action_owner_agent",
      focus: "Owner and next action guidance",
      question: "Who should act next, and what is the safest next step?",
    });
  }

  return dedupeTasks(tasks).slice(0, 5);
}

function inferModelName(context: IncidentContext): string | null {
  for (const task of context.dag.failedTasks) {
    const inferred = task.taskId.replace(/\.(run|test|seed|snapshot)$/, "");
    if (inferred && inferred !== task.taskId) return inferred;
  }
  return null;
}

function dedupeTasks(
  tasks: Array<{ name: string; focus: string; question: string }>,
): Array<{ name: string; focus: string; question: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; focus: string; question: string }> = [];
  for (const task of tasks) {
    const key = `${task.name}:${task.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(task);
  }
  return out;
}
