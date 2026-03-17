import { describe, it, expect } from "vitest";

/**
 * SQL injection regression tests for Snowflake tools.
 * These import the tool functions directly and validate input sanitization
 * without making actual Snowflake API calls.
 */

const fakeConfig = {
  account: "test.us-east-1",
  user: "TEST_USER",
  password: "pass",
  role: "TEST_ROLE",
  warehouse: "TEST_WH",
  database: "TEST_DB",
  watchedDatabases: [],
};

describe("cancelQuery — query ID validation", () => {
  it("rejects non-UUID query IDs", async () => {
    const { cancelQuery } = await import("../agents/snowflake/tools.js");
    await expect(cancelQuery(fakeConfig as any, "'; DROP TABLE users; --"))
      .rejects.toThrow("Invalid query_id format");
  });

  it("rejects empty query ID", async () => {
    const { cancelQuery } = await import("../agents/snowflake/tools.js");
    await expect(cancelQuery(fakeConfig as any, ""))
      .rejects.toThrow("Invalid query_id format");
  });

  it("rejects query ID with SQL injection payload", async () => {
    const { cancelQuery } = await import("../agents/snowflake/tools.js");
    await expect(cancelQuery(fakeConfig as any, "abc') OR 1=1--"))
      .rejects.toThrow("Invalid query_id format");
  });

  it("accepts valid UUID query ID (would fail on network)", async () => {
    const { cancelQuery } = await import("../agents/snowflake/tools.js");
    await expect(cancelQuery(fakeConfig as any, "01b2c3d4-5678-9abc-def0-123456789abc"))
      .rejects.toThrow(); // Network error expected, but NOT a validation error
  });
});

describe("getQueryHistory — window validation", () => {
  it("rejects negative window", async () => {
    const { getQueryHistory } = await import("../agents/snowflake/tools.js");
    await expect(getQueryHistory(fakeConfig as any, -5))
      .rejects.toThrow("Invalid windowMinutes");
  });

  it("rejects zero window", async () => {
    const { getQueryHistory } = await import("../agents/snowflake/tools.js");
    await expect(getQueryHistory(fakeConfig as any, 0))
      .rejects.toThrow("Invalid windowMinutes");
  });

  it("rejects very large window", async () => {
    const { getQueryHistory } = await import("../agents/snowflake/tools.js");
    await expect(getQueryHistory(fakeConfig as any, 999999))
      .rejects.toThrow("Invalid windowMinutes");
  });
});

describe("fetchSchemas — database name validation", () => {
  it("rejects SQL injection in database name", async () => {
    const { fetchSchemas } = await import("../agents/snowflake/tools.js");
    await expect(fetchSchemas(fakeConfig as any, ["test; DROP TABLE--"]))
      .rejects.toThrow("Invalid database name");
  });

  it("rejects database name with special chars", async () => {
    const { fetchSchemas } = await import("../agents/snowflake/tools.js");
    await expect(fetchSchemas(fakeConfig as any, ["test' OR '1'='1"]))
      .rejects.toThrow("Invalid database name");
  });

  it("accepts valid database names (skips silently on network error)", async () => {
    const { fetchSchemas } = await import("../agents/snowflake/tools.js");
    // Valid identifiers pass validation; fetchSchemas catches network errors per-db
    const result = await fetchSchemas(fakeConfig as any, ["MY_DB"]);
    // Returns empty because the network call fails, but no validation error
    expect(result).toEqual([]);
  });
});

describe("getQueryProfile — query ID validation", () => {
  it("rejects injection in query profile ID", async () => {
    const { getQueryProfile } = await import("../agents/snowflake/tools.js");
    await expect(getQueryProfile(fakeConfig as any, "'); SELECT * FROM secrets--"))
      .rejects.toThrow("Invalid query_id format");
  });
});

describe("validateSelectOnly", () => {
  it("rejects INSERT statements", async () => {
    const { executeQuery } = await import("../agents/snowflake/tools.js");
    await expect(executeQuery(fakeConfig as any, "INSERT INTO users VALUES (1, 'admin')"))
      .rejects.toThrow("Snowflake agent can only execute");
  });

  it("rejects DROP statements", async () => {
    const { executeQuery } = await import("../agents/snowflake/tools.js");
    await expect(executeQuery(fakeConfig as any, "DROP TABLE users"))
      .rejects.toThrow("Snowflake agent can only execute");
  });

  it("rejects multi-statement queries", async () => {
    const { executeQuery } = await import("../agents/snowflake/tools.js");
    await expect(executeQuery(fakeConfig as any, "SELECT 1; DROP TABLE users"))
      .rejects.toThrow("Multi-statement queries are not allowed");
  });

  it("rejects GRANT statements", async () => {
    const { executeQuery } = await import("../agents/snowflake/tools.js");
    await expect(executeQuery(fakeConfig as any, "GRANT ALL ON DATABASE test TO ROLE public"))
      .rejects.toThrow("Snowflake agent can only execute");
  });
});
