import { describe, it, expect } from "vitest";
import { hasVisibleStoryContent } from "../src/api.js";

describe("hasVisibleStoryContent", () => {
  it("shows incident stories even when the cause is still unknown", () => {
    const visible = hasVisibleStoryContent({
      story: "P3 incident for dbt_dag. Investigation is in progress.",
      severity: "P3",
      rootCauseCategory: "unknown",
      storyOutput: {
        oncallSummary: "dbt_dag failed. Root cause still under investigation.",
        topEvidence: ["Task stg_tpch_orders failed with Snowflake compilation error."],
      },
      incidentContext: {
        evidence: [{ id: "log-1", summary: "Snowflake compilation error" }],
        impact: {
          affectedDags: ["dbt_dag"],
          blastRadius: [{ kind: "dag", name: "dbt_dag" }],
        },
      },
    }, "incident-autopilot");

    expect(visible).toBe(true);
  });

  it("still hides empty incident payloads", () => {
    const visible = hasVisibleStoryContent({
      story: "too short",
      rootCauseCategory: "unknown",
    }, "incident-autopilot");

    expect(visible).toBe(false);
  });
});
