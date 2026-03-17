import type { Orchestrator } from "../src/orchestrator.js";
import type { DuckpipeConfig, WorkflowResult } from "../src/types.js";
import { getStateDb } from "../src/db.js";

interface TableSchema {
  database: string;
  schema: string;
  table: string;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
}

interface SchemaDiff {
  table: string;
  added: Array<{ name: string; type: string }>;
  dropped: Array<{ name: string; type: string }>;
  typeChanged: Array<{ name: string; from: string; to: string }>;
}

// ── Schema snapshot helpers ───────────────────────────────────────────────

function loadSnapshot(db: ReturnType<typeof getStateDb>): Map<string, string> {
  const rows = db.prepare(
    "SELECT database_name || '.' || schema_name || '.' || table_name AS full_name, columns_json FROM schema_snapshots"
  ).all() as Array<{ full_name: string; columns_json: string }>;

  const map = new Map<string, string>();
  for (const r of rows) map.set(r.full_name, r.columns_json);
  return map;
}

function saveSnapshot(
  db: ReturnType<typeof getStateDb>,
  schemas: TableSchema[]
): void {
  const upsert = db.prepare(`
    INSERT INTO schema_snapshots (id, database_name, schema_name, table_name, columns_json)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  // Use a delete+insert strategy keyed on (database, schema, table)
  const del = db.prepare(
    "DELETE FROM schema_snapshots WHERE database_name=? AND schema_name=? AND table_name=?"
  );
  const ins = db.prepare(`
    INSERT INTO schema_snapshots (id, database_name, schema_name, table_name, columns_json)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
  `);

  const run = db.transaction((schemas: TableSchema[]) => {
    for (const s of schemas) {
      del.run(s.database, s.schema, s.table);
      ins.run(s.database, s.schema, s.table, JSON.stringify(s.columns));
    }
  });
  run(schemas);
}

function diffSchemas(
  current: TableSchema[],
  previousJson: Map<string, string>
): SchemaDiff[] {
  const diffs: SchemaDiff[] = [];

  for (const table of current) {
    const key = `${table.database}.${table.schema}.${table.table}`;
    const prevRaw = previousJson.get(key);
    if (!prevRaw) continue; // New table — not a drift, just first time we see it

    const prev: Array<{ name: string; type: string }> = JSON.parse(prevRaw);
    const prevMap = new Map(prev.map(c => [c.name.toUpperCase(), c.type]));
    const currMap = new Map(table.columns.map(c => [c.name.toUpperCase(), c.type]));

    const added   = table.columns.filter(c => !prevMap.has(c.name.toUpperCase()));
    const dropped = prev.filter(c => !currMap.has(c.name.toUpperCase()));
    const typeChanged = table.columns
      .filter(c => {
        const pt = prevMap.get(c.name.toUpperCase());
        return pt && pt !== c.type;
      })
      .map(c => ({
        name: c.name,
        from: prevMap.get(c.name.toUpperCase())!,
        to: c.type,
      }));

    if (added.length > 0 || dropped.length > 0 || typeChanged.length > 0) {
      diffs.push({
        table: key,
        added: added.map(c => ({ name: c.name, type: c.type })),
        dropped: dropped.map(c => ({ name: c.name, type: c.type })),
        typeChanged,
      });
    }
  }

  return diffs;
}

function buildDriftStory(diffs: SchemaDiff[], affectedModels: unknown[]): string {
  if (diffs.length === 0) return "No schema drift detected.";

  const lines: string[] = [`Schema drift detected across ${diffs.length} table(s):`];

  for (const d of diffs) {
    lines.push(`\n📋 ${d.table}`);
    if (d.dropped.length > 0) {
      lines.push(`  ⛔ Columns DROPPED: ${d.dropped.map(c => `${c.name} (${c.type})`).join(", ")}`);
      lines.push(`     → This WILL break dbt models or pipelines that reference these columns`);
    }
    if (d.typeChanged.length > 0) {
      lines.push(`  ⚠  Type changes: ${d.typeChanged.map(c => `${c.name}: ${c.from} → ${c.to}`).join(", ")}`);
      lines.push(`     → May break downstream casts or tests`);
    }
    if (d.added.length > 0) {
      lines.push(`  ✅ Columns ADDED: ${d.added.map(c => `${c.name} (${c.type})`).join(", ")}`);
    }
  }

  if ((affectedModels as any[]).length > 0) {
    lines.push(`\n🔧 Affected dbt models (${(affectedModels as any[]).length}):`);
    for (const m of (affectedModels as any[]).slice(0, 10)) {
      const reason = (m as any).reason ?? "";
      lines.push(`  • ${(m as any).model?.name ?? (m as any).name}${reason ? ` — ${reason}` : ""}`);
    }
  } else {
    lines.push(`\n✓ No dbt models appear to reference the changed columns`);
  }

  return lines.join("\n");
}

export async function runPipelineWhisperer(
  orchestrator: Orchestrator,
  config: DuckpipeConfig
): Promise<WorkflowResult> {
  const runId = orchestrator.recordWorkflowStart("pipeline-whisperer");
  const startedAt = new Date().toISOString();

  try {
    const db = getStateDb();

    // ── Step 1: Fetch current Snowflake schemas ───────────────────────────
    const databases = config.integrations.snowflake?.watched_databases?.length
      ? config.integrations.snowflake.watched_databases
      : [config.integrations.snowflake?.database ?? ""];

    const schemaResult = await orchestrator.dispatchToAgent(
      "snowflake",
      "pipeline-whisperer",
      "fetch_schemas",
      { databases }
    );

    const currentSchemas = (schemaResult.payload.schemas ?? []) as TableSchema[];

    // ── Step 2: Load previous snapshot and diff ───────────────────────────
    const previousSnapshot = loadSnapshot(db);
    const isFirstRun = previousSnapshot.size === 0;
    const diffs = isFirstRun ? [] : diffSchemas(currentSchemas, previousSnapshot);
    const driftDetected = diffs.length > 0;

    // Always save the current schema as the new snapshot
    saveSnapshot(db, currentSchemas);

    if (isFirstRun) {
      console.log(`[pipeline-whisperer] First run — snapshot stored for ${currentSchemas.length} tables. Drift detection starts next run.`);
      orchestrator.recordWorkflowComplete(runId, "completed", {
        firstRun: true,
        tablesSnapshotted: currentSchemas.length,
      });
      return {
        workflow: "pipeline-whisperer",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { snowflake: { firstRun: true, tablesSnapshotted: currentSchemas.length } },
        auditIds: [],
      };
    }

    if (!driftDetected) {
      console.log(`[pipeline-whisperer] No schema drift across ${currentSchemas.length} tables`);
      orchestrator.recordWorkflowComplete(runId, "completed", { drift: false });
      return {
        workflow: "pipeline-whisperer",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        agentResults: { snowflake: { drift: false, tablesChecked: currentSchemas.length } },
        auditIds: [],
      };
    }

    // ── Step 3: Find affected dbt models ─────────────────────────────────
    const changedTables = diffs.map(d => d.table);
    console.log(`[pipeline-whisperer] Schema drift detected in ${changedTables.length} tables: ${changedTables.join(", ")}`);

    const dbtResult = await orchestrator.dispatchToAgent(
      "dbt",
      "pipeline-whisperer",
      "find_affected_models",
      { changed_tables: changedTables }
    );

    const affectedWithReasons = (dbtResult.payload.affectedWithReasons ?? []) as unknown[];
    const affectedModels      = (dbtResult.payload.models ?? []) as unknown[];

    // ── Step 4: Build the story ───────────────────────────────────────────
    const story = buildDriftStory(diffs, affectedWithReasons);
    console.log(`[pipeline-whisperer] ${story}`);

    // ── Step 5: Post to Slack if enabled ─────────────────────────────────
    if (config.integrations.slack?.enabled) {
      const channel = config.integrations.slack.allowed_channels[0];
      const severity = diffs.some(d => d.dropped.length > 0) ? "🔴" : "🟡";
      await orchestrator.executeWriteAction(
        "comms",
        "pipeline-whisperer",
        "slack_post_message",
        {
          channel,
          text: `${severity} *Schema drift detected in ${changedTables.length} Snowflake table(s)*\n\`\`\`\n${story.slice(0, 2000)}\n\`\`\`\n_Detected by DuckPipe — duckcode.ai_`,
        },
        { channels: [channel] }
      );
    }

    // ── Step 6: Open a dbt fix PR if GitHub is configured ────────────────
    if (
      config.integrations.dbt?.enabled &&
      config.workflows?.pipeline_whisperer?.github_repo &&
      (affectedModels as any[]).length > 0 &&
      config.duckpipe.trust_tier >= 2
    ) {
      const modelNames = (affectedModels as any[]).map((m: any) => m.name ?? m).join(", ");
      await orchestrator.executeWriteAction(
        "dbt",
        "pipeline-whisperer",
        "create_pr",
        {
          title: `[DuckPipe] Schema drift fix — ${changedTables.length} changed tables`,
          body: `## Schema Drift Detected\n\n${story}\n\n## Affected Models\n${modelNames}`,
          head_branch: `duckpipe/${new Date().toISOString().slice(0, 10)}/schema-drift-fix`,
          base_branch: config.workflows?.pipeline_whisperer?.base_branch ?? "main",
        },
        {}
      );
    }

    orchestrator.recordWorkflowComplete(runId, "completed", {
      drift: true,
      changedTables,
      affectedModelCount: (affectedModels as any[]).length,
      story,
    });

    return {
      workflow: "pipeline-whisperer",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {
        snowflake: { drift: true, diffs, changedTables },
        dbt: { affectedModels, affectedWithReasons },
        story,
      },
      auditIds: [],
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestrator.recordWorkflowComplete(runId, "failed", undefined, msg);
    return {
      workflow: "pipeline-whisperer",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      agentResults: {},
      auditIds: [],
      error: msg,
    };
  }
}
