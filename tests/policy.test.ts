import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadPolicy, checkPolicy } from "../src/policy.js";

const TEST_POLICY_DIR = "./test-policy-tmp";
const TEST_POLICY_PATH = `${TEST_POLICY_DIR}/policy.yaml`;

beforeEach(() => {
  mkdirSync(TEST_POLICY_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_POLICY_DIR, { recursive: true, force: true });
});

function writePolicyFile(content: string): void {
  writeFileSync(TEST_POLICY_PATH, content);
}

describe("tier enforcement", () => {
  it("tier 1 blocks all write actions", () => {
    loadPolicy("nonexistent.yaml");
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {},
      1
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Tier 1");
    expect(decision.approvalRequired).toBe(false);
  });

  it("tier 2 requires approval for write actions", () => {
    loadPolicy("nonexistent.yaml");
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {},
      2
    );
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(true);
  });

  it("tier 3 without matching rule falls back to approval", () => {
    writePolicyFile("autonomous: []");
    loadPolicy(TEST_POLICY_PATH);
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {},
      3
    );
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(true);
  });
});

describe("autonomous policy rules", () => {
  const policyContent = `
autonomous:
  - name: "Retry ingestion tasks"
    agent: airflow
    action: trigger_dag_run
    conditions:
      dag_id_prefix: "ingestion_"
      retry_count_less_than: 2
      failure_type: ["timeout", "connection_error"]

  - name: "Kill expensive queries"
    agent: snowflake
    action: cancel_query
    conditions:
      credits_consumed_greater_than: 50
      warehouse: ["COMPUTE_WH"]

  - name: "Post Slack alerts"
    agent: comms
    action: slack_post_message
    conditions:
      channels: ["#data-incidents", "#data-alerts"]
`;

  beforeEach(() => {
    writePolicyFile(policyContent);
    loadPolicy(TEST_POLICY_PATH);
  });

  it("matches rule with prefix condition", () => {
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {
        dag_id: "ingestion_stripe",
        retry_count: 1,
        failure_type: "timeout",
      },
      3
    );
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(false);
    expect(decision.reason).toContain("Retry ingestion tasks");
  });

  it("rejects when prefix doesn't match", () => {
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {
        dag_id: "analytics_daily",
        retry_count: 1,
        failure_type: "timeout",
      },
      3
    );
    expect(decision.approvalRequired).toBe(true);
  });

  it("rejects when retry count exceeds threshold", () => {
    const decision = checkPolicy(
      "trigger_dag_run",
      "airflow",
      "incident-autopilot",
      {
        dag_id: "ingestion_stripe",
        retry_count: 3,
        failure_type: "timeout",
      },
      3
    );
    expect(decision.approvalRequired).toBe(true);
  });

  it("matches snowflake cancel_query rule", () => {
    const decision = checkPolicy(
      "cancel_query",
      "snowflake",
      "cost-sentinel",
      {
        credits_consumed: 100,
        warehouse: "COMPUTE_WH",
      },
      3
    );
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(false);
  });

  it("rejects when credits below threshold", () => {
    const decision = checkPolicy(
      "cancel_query",
      "snowflake",
      "cost-sentinel",
      {
        credits_consumed: 30,
        warehouse: "COMPUTE_WH",
      },
      3
    );
    expect(decision.approvalRequired).toBe(true);
  });

  it("matches comms agent array condition", () => {
    const decision = checkPolicy(
      "slack_post_message",
      "comms",
      "incident-autopilot",
      {
        channels: ["#data-incidents"],
      },
      3
    );
    expect(decision.allowed).toBe(true);
    expect(decision.approvalRequired).toBe(false);
  });

  it("wrong agent never matches", () => {
    const decision = checkPolicy(
      "trigger_dag_run",
      "snowflake",
      "incident-autopilot",
      {},
      3
    );
    expect(decision.approvalRequired).toBe(true);
  });
});

describe("loadPolicy", () => {
  it("handles missing policy file gracefully", () => {
    loadPolicy("definitely-nonexistent.yaml");
    const decision = checkPolicy("any_action", "airflow", "test", {}, 3);
    expect(decision.approvalRequired).toBe(true);
  });
});
