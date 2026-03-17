import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AgentName, PolicyDecision, PolicyRule, TrustTier } from "./types.js";

interface PolicyConfig {
  autonomous: PolicyRule[];
}

let policyConfig: PolicyConfig | null = null;

export function loadPolicy(policyPath = "./policy.yaml"): void {
  if (!existsSync(policyPath)) {
    policyConfig = { autonomous: [] };
    return;
  }

  const raw = readFileSync(policyPath, "utf-8");
  const parsed = parseYaml(raw) as PolicyConfig;
  policyConfig = {
    autonomous: parsed.autonomous ?? [],
  };
}

export function getPolicy(): PolicyConfig {
  if (!policyConfig) {
    throw new Error("Policy not loaded. Call loadPolicy() first.");
  }
  return policyConfig;
}

export function checkPolicy(
  action: string,
  agent: AgentName,
  workflow: string,
  context: Record<string, unknown>,
  tier: TrustTier
): PolicyDecision {
  // Tier 1: all write actions are blocked, no exceptions
  if (tier === 1) {
    return {
      allowed: false,
      reason: `Tier 1 (read-only) — write action '${action}' is not permitted`,
      approvalRequired: false,
    };
  }

  const policy = getPolicy();

  // Tier 3: check if the action matches an autonomous policy rule
  if (tier === 3) {
    const matchingRule = findMatchingRule(policy, action, agent, context);
    if (matchingRule) {
      return {
        allowed: true,
        reason: `Autonomous policy rule matched: "${matchingRule.name}"`,
        approvalRequired: false,
      };
    }
    // No matching rule — fall through to Tier 2 behavior (require approval)
  }

  // Tier 2 (or Tier 3 without matching rule): approval required
  return {
    allowed: true,
    reason: `Tier ${tier} — write action '${action}' requires human approval via Slack`,
    approvalRequired: true,
  };
}

function findMatchingRule(
  policy: PolicyConfig,
  action: string,
  agent: AgentName,
  context: Record<string, unknown>
): PolicyRule | null {
  for (const rule of policy.autonomous) {
    if (rule.agent !== agent) continue;
    if (rule.action !== action) continue;
    if (!matchConditions(rule.conditions, context)) continue;
    return rule;
  }
  return null;
}

function matchConditions(
  conditions: Record<string, unknown>,
  context: Record<string, unknown>
): boolean {
  for (const [key, expected] of Object.entries(conditions)) {
    const actual = context[key];

    if (key.endsWith("_less_than")) {
      const field = key.replace("_less_than", "");
      const actualVal = context[field];
      if (typeof actualVal !== "number" || typeof expected !== "number") return false;
      if (actualVal >= expected) return false;
      continue;
    }

    if (key.endsWith("_greater_than")) {
      const field = key.replace("_greater_than", "");
      const actualVal = context[field];
      if (typeof actualVal !== "number" || typeof expected !== "number") return false;
      if (actualVal <= expected) return false;
      continue;
    }

    if (key.endsWith("_prefix")) {
      const field = key.replace("_prefix", "");
      const actualVal = context[field];
      if (typeof actualVal !== "string" || typeof expected !== "string") return false;
      if (!actualVal.startsWith(expected)) return false;
      continue;
    }

    if (Array.isArray(expected)) {
      if (Array.isArray(actual)) {
        // Check if any of the actual values are in the expected list
        const hasMatch = actual.some((v) =>
          (expected as unknown[]).includes(v)
        );
        if (!hasMatch) return false;
      } else {
        if (!expected.includes(actual as never)) return false;
      }
      continue;
    }

    if (actual !== expected) return false;
  }
  return true;
}
