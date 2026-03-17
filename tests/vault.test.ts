import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createVault, initVault, getVault, resolveConfigValue } from "../src/vault.js";

describe("EnvVaultBackend", () => {
  it("reads from process.env", async () => {
    process.env.TEST_DUCKPIPE_SECRET = "my-secret-value";
    const vault = createVault("env");
    const value = await vault.get("TEST_DUCKPIPE_SECRET");
    expect(value).toBe("my-secret-value");
    delete process.env.TEST_DUCKPIPE_SECRET;
  });

  it("throws on missing env var", async () => {
    delete process.env.MISSING_VAR_XYZ;
    const vault = createVault("env");
    await expect(vault.get("MISSING_VAR_XYZ")).rejects.toThrow(
      "Environment variable MISSING_VAR_XYZ is not set"
    );
  });
});

describe("initVault / getVault", () => {
  afterEach(() => {
    // Reset by reinitializing
  });

  it("initializes and retrieves vault instance", () => {
    const vault = initVault("env", 1);
    expect(getVault()).toBe(vault);
  });

  it("warns on env backend with tier > 1", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    initVault("env", 2);
    console.warn = origWarn;
    expect(warnings.some((w) => w.includes("Tier 2+"))).toBe(true);
  });
});

describe("resolveConfigValue", () => {
  it("resolves ${VAR} references from vault", async () => {
    process.env.MY_HOST = "airflow.internal";
    process.env.MY_PORT = "8080";
    const vault = createVault("env");
    const result = await resolveConfigValue(
      vault,
      "https://${MY_HOST}:${MY_PORT}/api"
    );
    expect(result).toBe("https://airflow.internal:8080/api");
    delete process.env.MY_HOST;
    delete process.env.MY_PORT;
  });

  it("leaves unresolvable vars as-is", async () => {
    const vault = createVault("env");
    const result = await resolveConfigValue(vault, "prefix-${NONEXISTENT_12345}");
    expect(result).toBe("prefix-${NONEXISTENT_12345}");
  });

  it("returns plain strings unchanged", async () => {
    const vault = createVault("env");
    const result = await resolveConfigValue(vault, "no-vars-here");
    expect(result).toBe("no-vars-here");
  });
});

describe("unsupported backends", () => {
  it("throws on unknown backend", () => {
    expect(() => createVault("redis")).toThrow("Unknown vault backend: redis");
  });

  it("file backend throws not-implemented", async () => {
    const vault = createVault("file", {
      age_key_file: "/tmp/fake",
      encrypted_secrets_file: "/tmp/fake",
    });
    await expect(vault.get("any")).rejects.toThrow("not yet implemented");
  });

  it("hashicorp backend throws not-implemented", async () => {
    const vault = createVault("hashicorp-vault", {
      vault_addr: "http://localhost:8200",
      vault_token: "fake",
      vault_path: "secret/data/test",
    });
    await expect(vault.get("any")).rejects.toThrow("not yet implemented");
  });

  it("aws backend throws not-implemented", async () => {
    const vault = createVault("aws-secrets-manager");
    await expect(vault.get("any")).rejects.toThrow("not yet implemented");
  });
});
