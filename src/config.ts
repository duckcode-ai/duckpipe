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

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  return DuckpipeConfigSchema.parse(parsed);
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
