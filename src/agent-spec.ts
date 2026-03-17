import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentName } from "./types.js";

const AGENT_SPEC_PATHS: Record<AgentName, string> = {
  airflow: join(process.cwd(), "agents", "airflow", "AGENT.md"),
  dbt: join(process.cwd(), "agents", "dbt", "AGENT.md"),
  snowflake: join(process.cwd(), "agents", "snowflake", "AGENT.md"),
  comms: join(process.cwd(), "agents", "comms", "AGENT.md"),
};

export function loadAgentSpec(agent: AgentName): string {
  const file = AGENT_SPEC_PATHS[agent];
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf-8");
}
