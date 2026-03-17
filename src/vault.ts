import type { VaultBackend, TrustTier } from "./types.js";

class EnvVaultBackend implements VaultBackend {
  async get(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Environment variable ${key} is not set`);
    }
    return value;
  }
}

class FileVaultBackend implements VaultBackend {
  private secrets: Map<string, string> | null = null;

  constructor(
    private ageKeyFile: string,
    private encryptedSecretsFile: string
  ) {}

  async get(key: string): Promise<string> {
    if (!this.secrets) {
      this.secrets = await this.decrypt();
    }
    const value = this.secrets.get(key);
    if (value === undefined) {
      throw new Error(`Secret ${key} not found in encrypted secrets file`);
    }
    return value;
  }

  private async decrypt(): Promise<Map<string, string>> {
    throw new Error(
      "File vault backend (age encryption) is not yet implemented. " +
        "Set secrets.backend to 'env' in duckpipe.yaml for now."
    );
  }
}

class HashiCorpVaultBackend implements VaultBackend {
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private allSecrets: Map<string, string> | null = null;
  private lastFetchMs = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    private vaultAddr: string,
    private vaultToken: string,
    private vaultPath: string
  ) {
    if (!vaultAddr) throw new Error("vault_addr is required for hashicorp-vault backend");
    if (!vaultToken) throw new Error("vault_token is required for hashicorp-vault backend");
    if (!vaultPath) throw new Error("vault_path is required for hashicorp-vault backend");
  }

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    await this.fetchAllSecrets();

    const value = this.allSecrets?.get(key);
    if (value === undefined) {
      throw new Error(`Secret ${key} not found in Vault at ${this.vaultPath}`);
    }
    return value;
  }

  private async fetchAllSecrets(): Promise<void> {
    if (this.allSecrets && (Date.now() - this.lastFetchMs) < this.cacheTtlMs) {
      return;
    }

    const addr = this.vaultAddr.replace(/\/$/, "");
    const url = `${addr}/v1/${this.vaultPath}`;

    const resp = await fetch(url, {
      headers: {
        "X-Vault-Token": this.vaultToken,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Vault HTTP ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as {
      data?: {
        data?: Record<string, string>;
        metadata?: { version: number };
      };
    };

    // KV v2 wraps in data.data; KV v1 just has data
    const secrets = json.data?.data ?? (json.data as Record<string, string> | undefined) ?? {};

    this.allSecrets = new Map(Object.entries(secrets));
    this.lastFetchMs = Date.now();

    const now = Date.now();
    for (const [k, v] of this.allSecrets) {
      this.cache.set(k, { value: v, expiresAt: now + this.cacheTtlMs });
    }
  }
}

class AwsSecretsManagerBackend implements VaultBackend {
  async get(key: string): Promise<string> {
    throw new Error(
      "AWS Secrets Manager backend is not yet implemented. " +
        "Set secrets.backend to 'env' in duckpipe.yaml for now."
    );
  }
}

let vaultInstance: VaultBackend | null = null;

export function createVault(
  backend: string,
  options: Record<string, string> = {}
): VaultBackend {
  switch (backend) {
    case "env":
      return new EnvVaultBackend();
    case "file":
      return new FileVaultBackend(
        options.age_key_file ?? "",
        options.encrypted_secrets_file ?? ""
      );
    case "hashicorp-vault":
      return new HashiCorpVaultBackend(
        options.vault_addr ?? "",
        options.vault_token ?? "",
        options.vault_path ?? ""
      );
    case "aws-secrets-manager":
      return new AwsSecretsManagerBackend();
    default:
      throw new Error(`Unknown vault backend: ${backend}`);
  }
}

export function initVault(
  backend: string,
  tier: TrustTier,
  options: Record<string, string> = {}
): VaultBackend {
  if (backend === "env" && tier > 1) {
    console.warn(
      "⚠  WARNING: You are using environment variables for secrets with Tier 2+ trust.\n" +
        "   Consider using a secrets backend for production. See docs/SECURITY.md"
    );
  }
  vaultInstance = createVault(backend, options);
  return vaultInstance;
}

export function getVault(): VaultBackend {
  if (!vaultInstance) {
    throw new Error("Vault not initialized. Call initVault() first.");
  }
  return vaultInstance;
}

/**
 * Resolve a config value that may contain ${ENV_VAR} references.
 * Returns the resolved string with env vars expanded via the vault.
 */
export async function resolveConfigValue(
  vault: VaultBackend,
  value: string
): Promise<string> {
  const pattern = /\$\{([^}]+)\}/g;
  let result = value;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const envVar = match[1];
    try {
      const resolved = await vault.get(envVar);
      result = result.replace(match[0], resolved);
    } catch {
      // Leave unresolved if the env var is not set
    }
  }
  return result;
}
