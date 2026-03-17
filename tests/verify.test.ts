import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyAll, verifySingle, type VerifyResult } from "../src/verify.js";
import type { DuckpipeConfig, VaultBackend } from "../src/types.js";

const mockVault: VaultBackend = {
  async get(key: string) {
    const secrets: Record<string, string> = {
      AIRFLOW_BASE_URL: "https://airflow.test.local",
      AIRFLOW_USERNAME: "admin",
      AIRFLOW_PASSWORD: "admin",
      SNOWFLAKE_ACCOUNT: "testorg.us-east-1",
      SNOWFLAKE_USER: "DUCKPIPE_SVC",
      SNOWFLAKE_PASSWORD: "test",
      SNOWFLAKE_WAREHOUSE: "COMPUTE_WH",
      DBT_API_TOKEN: "dbt-token-123",
      DBT_ACCOUNT_ID: "12345",
      SLACK_BOT_TOKEN: "xoxb-test",
    };
    const val = secrets[key];
    if (!val) throw new Error(`Not set: ${key}`);
    return val;
  },
};

function makeConfig(overrides: Partial<DuckpipeConfig> = {}): DuckpipeConfig {
  return {
    duckpipe: { version: "1", name: "test", trust_tier: 1 },
    secrets: { backend: "env" },
    agents: { runtime: "process", memory_limit_mb: 512, cpu_limit: 0.5, timeout_seconds: 120 },
    integrations: {
      airflow: {
        enabled: true,
        base_url: "${AIRFLOW_BASE_URL}",
        username: "${AIRFLOW_USERNAME}",
        password: "${AIRFLOW_PASSWORD}",
        allowed_dags: [],
        verify_ssl: true,
      },
      snowflake: {
        enabled: true,
        account: "${SNOWFLAKE_ACCOUNT}",
        user: "${SNOWFLAKE_USER}",
        password: "${SNOWFLAKE_PASSWORD}",
        role: "DUCKPIPE_READER",
        warehouse: "${SNOWFLAKE_WAREHOUSE}",
        database: "ANALYTICS",
        watched_databases: [],
      },
    },
    ...overrides,
  };
}

describe("verifyAll", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns results for all integrations", async () => {
    // Mock fetch to simulate Airflow success
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/v1/health")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      if (url.includes("/api/v1/dags")) {
        return Promise.resolve(
          new Response(JSON.stringify({ total_entries: 47 }), { status: 200 })
        );
      }
      if (url.includes("/api/v1/version")) {
        return Promise.resolve(
          new Response(JSON.stringify({ version: "2.8.1" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    try {
      const results = await verifyAll(makeConfig(), mockVault);
      expect(results.length).toBeGreaterThanOrEqual(2);

      const airflow = results.find((r) => r.integration === "Airflow");
      expect(airflow?.status).toBe("connected");
      expect(airflow?.version).toBe("2.8.1");
      expect(airflow?.counts?.dags).toBe(47);

      const snowflake = results.find((r) => r.integration === "Snowflake");
      expect(snowflake?.status).toBe("connected");

      const dbt = results.find((r) => r.integration === "dbt Cloud");
      expect(dbt?.status).toBe("not_configured");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("marks disabled integrations as not_configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const config = makeConfig({
      integrations: {},
    });

    const results = await verifyAll(config, mockVault);
    for (const r of results) {
      expect(r.status).toBe("not_configured");
    }
  });
});

describe("verifySingle", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns error for unknown integration", async () => {
    const result = await verifySingle("databricks", makeConfig(), mockVault);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Supported");
  });

  it("verifies snowflake individually", async () => {
    const result = await verifySingle("snowflake", makeConfig(), mockVault);
    expect(result.integration).toBe("Snowflake");
    expect(result.status).toBe("connected");
  });
});
