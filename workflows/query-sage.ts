import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, SlackMessage, WorkflowResult } from "../src/types.js";

export async function runQuerySage(
  orchestrator: Orchestrator,
  config: DuckpipeConfig,
  slackMessage?: SlackMessage
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("query-sage");
  const startedAt = new Date().toISOString();

  try {
    if (!slackMessage) {
      orchestrator.recordWorkflowComplete(runId, "completed");
      return {
        workflow: "query-sage",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: {},
        auditIds: [],
      };
    }

    // Step 1: Extract model/table name from Slack message
    const extractResult = await orchestrator.dispatchToAgent(
      "comms",
      "query-sage",
      "extract_entity_from_message",
      { text: slackMessage.text }
    );

    const entityName = extractResult.payload.entity as string;
    if (!entityName) {
      orchestrator.recordWorkflowComplete(runId, "completed", {
        reason: "no entity found",
      });
      return {
        workflow: "query-sage",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: {},
        auditIds: [],
      };
    }

    // Step 2: Fetch execution plans from Snowflake
    const plansResult = await orchestrator.dispatchToAgent(
      "snowflake",
      "query-sage",
      "get_query_plans",
      { entity: entityName, limit: 10 }
    );

    // Step 3: Identify optimization opportunities
    const analysisResult = await orchestrator.dispatchToAgent(
      "snowflake",
      "query-sage",
      "analyze_query_performance",
      {
        entity: entityName,
        plans: plansResult.payload.plans,
      }
    );

    // Step 4: Post reply in Slack thread
    if (config.integrations.slack?.enabled) {
      const replyText = [
        `📊 *Query Analysis — ${entityName}*`,
        analysisResult.payload.explanation as string ?? "",
        analysisResult.payload.rewrittenSql ? `\`\`\`sql\n${analysisResult.payload.rewrittenSql}\n\`\`\`` : "",
        analysisResult.payload.estimatedSavings ? `Estimated savings: ${analysisResult.payload.estimatedSavings} credits` : "",
        "_Analyzed by DuckPipe — duckcode.ai_",
      ].filter(Boolean).join("\n");

      await orchestrator.executeWriteAction(
        "comms",
        "query-sage",
        "slack_post_thread_reply",
        {
          channel: slackMessage.channel,
          thread_ts: slackMessage.ts,
          text: replyText,
        },
        { channels: [slackMessage.channel] }
      );
    }

    orchestrator.recordWorkflowComplete(runId, "completed");

    return {
      workflow: "query-sage",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {
        snowflake: analysisResult.payload,
      },
      auditIds: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "query-sage",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
