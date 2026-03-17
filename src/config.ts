import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { DuckpipeConfigSchema, type DuckpipeConfig } from "./types.js";

export function loadConfig(path = "./duckpipe.yaml"): DuckpipeConfig {
  if (!existsSync(path)) {
    throw new Error(
      `Config file not found: ${path}\n` +
        "Run: cp config-examples/duckpipe.example.yaml duckpipe.yaml"
    );
  }

  loadDotEnv();

  const raw = readFileSync(path, "utf-8");
  const resolved = resolveEnvVars(raw);
  const parsed = parseYaml(resolved);
  return DuckpipeConfigSchema.parse(parsed);
}

function loadDotEnv(envPath = "./.env"): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function resolveEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? "";
  });
}

export function ensureConfig(
  configPath = "./duckpipe.yaml",
  examplePath = "./config-examples/duckpipe.example.yaml"
): boolean {
  if (existsSync(configPath)) return false;
  if (!existsSync(examplePath)) {
    throw new Error(`Example config not found: ${examplePath}`);
  }
  copyFileSync(examplePath, configPath);
  return true;
}

export function ensureEnv(
  envPath = "./.env",
  examplePath = "./config-examples/.env.example"
): boolean {
  if (existsSync(envPath)) return false;
  if (!existsSync(examplePath)) return false;
  copyFileSync(examplePath, envPath);
  return true;
}
