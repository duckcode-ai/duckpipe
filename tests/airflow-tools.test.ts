import { describe, it, expect } from "vitest";
import { classifyFromLogs } from "../agents/airflow/tools.js";

describe("classifyFromLogs", () => {
  it("detects missing Snowflake objects as upstream dependency issues", () => {
    const result = classifyFromLogs(`
      Database Error in model stg_tpch_orders
      SQL compilation error:
      Object does not exist, or operation cannot be performed.
    `);

    expect(result.category).toBe("upstream_dependency");
    expect(result.cause).toContain("Snowflake object");
  });
});
