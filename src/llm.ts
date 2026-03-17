/**
 * LLM provider abstraction for DuckPipe agents.
 *
 * Provider selection order:
 *   1. Config file  →  llm.provider in duckpipe.yaml
 *   2. Auto-detect  →  first key present in .env: Anthropic → OpenAI → Gemini
 *
 * Model selection order (most specific wins):
 *   1. Per-agent override  →  llm.agents.<name> in duckpipe.yaml
 *   2. Global model        →  llm.model in duckpipe.yaml
 *   3. Provider default    →  hardcoded sensible default below
 *
 * To add a new model: just set it in duckpipe.yaml — no code changes needed.
 */

import type { DuckpipeConfig } from "./types.js";
import type { AgentName } from "./types.js";

export type LlmProviderName = "anthropic" | "openai" | "gemini";

export interface LlmProvider {
  name: LlmProviderName;
  model: string;
  complete(prompt: string, systemPrompt?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Well-known models — displayed in the dashboard picker.
// Add new models here as providers release them; users can also type any name.
// ---------------------------------------------------------------------------
export const KNOWN_MODELS: Record<LlmProviderName, Array<{ id: string; label: string; tier: "fast" | "balanced" | "powerful" }>> = {
  anthropic: [
    { id: "claude-3-5-haiku-20241022",    label: "Claude 3.5 Haiku (fast · cheap)",          tier: "fast" },
    { id: "claude-3-5-sonnet-20241022",   label: "Claude 3.5 Sonnet (balanced)",              tier: "balanced" },
    { id: "claude-3-7-sonnet-20250219",   label: "Claude 3.7 Sonnet (powerful · latest)",     tier: "powerful" },
    { id: "claude-opus-4-5",              label: "Claude Opus 4.5 (most capable)",            tier: "powerful" },
  ],
  openai: [
    { id: "gpt-4o-mini",                  label: "GPT-4o mini (fast · cheap)",                tier: "fast" },
    { id: "gpt-4o",                       label: "GPT-4o (balanced)",                         tier: "balanced" },
    { id: "gpt-4.1",                      label: "GPT-4.1 (powerful · latest)",               tier: "powerful" },
    { id: "o3-mini",                      label: "o3-mini (reasoning · fast)",                tier: "fast" },
    { id: "o3",                           label: "o3 (reasoning · powerful)",                 tier: "powerful" },
  ],
  gemini: [
    { id: "gemini-2.0-flash",             label: "Gemini 2.0 Flash (fast · cheap)",           tier: "fast" },
    { id: "gemini-2.0-flash-thinking-exp",label: "Gemini 2.0 Flash Thinking (reasoning)",    tier: "balanced" },
    { id: "gemini-2.5-pro-exp-03-25",     label: "Gemini 2.5 Pro (powerful · latest)",       tier: "powerful" },
  ],
};

// Default model used when none is configured
const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  anthropic: "claude-3-5-haiku-20241022",
  openai:    "gpt-4o-mini",
  gemini:    "gemini-2.0-flash",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the active LLM provider, optionally for a specific agent.
 * Pass the loaded config so per-agent and global overrides are respected.
 */
export function getLlmProvider(
  config?: DuckpipeConfig,
  agentName?: AgentName
): LlmProvider {
  const providerName = resolveProviderName(config);
  const model = resolveModel(providerName, config, agentName);
  return buildProvider(providerName, model);
}

/** Returns the active provider name for UI display, without throwing. */
export function getActiveLlmProviderName(config?: DuckpipeConfig): LlmProviderName | null {
  try {
    return resolveProviderName(config);
  } catch {
    return null;
  }
}

/** Returns active provider + model for the /api/health endpoint. */
export function getActiveLlmInfo(config?: DuckpipeConfig): { provider: LlmProviderName; model: string } | null {
  try {
    const provider = resolveProviderName(config);
    const model = resolveModel(provider, config);
    return { provider, model };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function resolveProviderName(config?: DuckpipeConfig): LlmProviderName {
  const configured = config?.llm?.provider;

  if (configured && configured !== "auto") {
    // User explicitly selected a provider — honour it even if the key looks wrong
    return configured as LlmProviderName;
  }

  // Auto-detect: first env var present wins
  if (hasKey("ANTHROPIC_API_KEY")) return "anthropic";
  if (hasKey("OPENAI_API_KEY"))    return "openai";
  if (hasKey("GEMINI_API_KEY"))    return "gemini";

  throw new Error(
    "No LLM provider configured.\n" +
    "Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in .env\n" +
    "Or set llm.provider in duckpipe.yaml"
  );
}

function resolveModel(
  provider: LlmProviderName,
  config?: DuckpipeConfig,
  agentName?: AgentName
): string {
  // 1. Per-agent override (most specific)
  if (agentName && config?.llm?.agents) {
    const agentModel = config.llm.agents[agentName];
    if (agentModel && agentModel.trim()) return agentModel.trim();
  }

  // 2. Global model override
  const globalModel = config?.llm?.model;
  if (globalModel && globalModel.trim()) return globalModel.trim();

  // 3. Provider default
  return DEFAULT_MODELS[provider];
}

function hasKey(envVar: string): boolean {
  const val = process.env[envVar];
  return !!val && !isPlaceholder(val);
}

function isPlaceholder(value: string): boolean {
  return (
    value.startsWith("sk-ant-your") ||
    value.startsWith("sk-your-") ||
    value.startsWith("your-") ||
    value.length < 10
  );
}

// ---------------------------------------------------------------------------
// Provider builders
// ---------------------------------------------------------------------------

function buildProvider(name: LlmProviderName, model: string): LlmProvider {
  switch (name) {
    case "anthropic":
      return { name, model, complete: (p, s) => anthropicComplete(model, p, s) };
    case "openai":
      return { name, model, complete: (p, s) => openaiComplete(model, p, s) };
    case "gemini":
      return { name, model, complete: (p, s) => geminiComplete(model, p, s) };
  }
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function anthropicComplete(model: string, prompt: string, systemPrompt?: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find(b => b.type === "text")?.text ?? "";
}

async function openaiComplete(model: string, prompt: string, systemPrompt?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

async function geminiComplete(model: string, prompt: string, systemPrompt?: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const parts: Array<{ text: string }> = [];
  if (systemPrompt) parts.push({ text: systemPrompt + "\n\n" });
  parts.push({ text: prompt });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 4096 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates[0]?.content.parts.map(p => p.text).join("") ?? "";
}
