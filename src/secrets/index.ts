import type { AppConfig } from '../config/index.js';
import { SecretProviderError } from '../errors/index.js';

/**
 * Abstract secret provider interface.
 * Concrete: EnvironmentSecretProvider (dev), VaultSecretProvider (production).
 */
export interface SecretProvider {
  readonly name: string;
  getSecret(key: string): Promise<string>;
  getAllSecrets(path: string): Promise<Record<string, string>>;
  healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }>;
}

/**
 * Environment-based secret provider — for development and testing.
 * Reads secrets from prefixed environment variables (EPH_SECRET_*).
 */
export class EnvironmentSecretProvider implements SecretProvider {
  readonly name = 'env';
  private prefix: string;

  constructor(prefix = 'EPH_SECRET_') {
    this.prefix = prefix;
  }

  async getSecret(key: string): Promise<string> {
    const envKey = `${this.prefix}${key.toUpperCase()}`;
    const value = process.env[envKey];
    if (!value) throw new SecretProviderError(`Secret '${envKey}' not found in environment`, { key: envKey });
    return value;
  }

  async getAllSecrets(_path: string): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(this.prefix) && value) {
        const secretKey = key.replace(this.prefix, '').toLowerCase();
        secrets[secretKey] = value;
      }
    }
    return secrets;
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number }> {
    return { status: 'healthy', latency_ms: 0 };
  }
}

/**
 * HashiCorp Vault secret provider — for production.
 * Uses KV v2 secrets engine.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly name = 'vault';
  private addr: string;
  private token: string;
  private basePath: string;
  private cache = new Map<string, { value: Record<string, string>; expires: number }>();
  private cacheTtlMs = 60000; // 60s cache

  constructor(config: { addr: string; token: string; path: string }) {
    this.addr = config.addr;
    this.token = config.token;
    this.basePath = config.path;
  }

  async getSecret(key: string): Promise<string> {
    const all = await this.getAllSecrets(this.basePath);
    const value = all[key];
    if (!value) throw new SecretProviderError(`Secret '${key}' not found in Vault`, { key, path: this.basePath });
    return value;
  }

  async getAllSecrets(path: string): Promise<Record<string, string>> {
    const cached = this.cache.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;

    try {
      const url = `${this.addr}/v1/secret/data/${path}`;
      const response = await fetch(url, {
        headers: { 'X-Vault-Token': this.token, 'X-Vault-Request': 'true' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new SecretProviderError(`Vault returned ${response.status}`, { path, status: response.status });
      }
      const body = (await response.json()) as { data?: { data?: Record<string, string> } };
      const secrets = body.data?.data ?? {};
      this.cache.set(path, { value: secrets, expires: Date.now() + this.cacheTtlMs });
      return secrets;
    } catch (error) {
      if (error instanceof SecretProviderError) throw error;
      const msg = error instanceof Error ? error.message : 'Vault request failed';
      throw new SecretProviderError(msg, { path });
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }> {
    const start = Date.now();
    try {
      const url = `${this.addr}/v1/sys/health`;
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return { status: response.ok ? 'healthy' : 'degraded', latency_ms: Date.now() - start };
    } catch (error) {
      return { status: 'unhealthy', latency_ms: Date.now() - start, detail: String(error) };
    }
  }
}

/**
 * Factory — returns provider based on config.
 */
export function createSecretProvider(config: AppConfig): SecretProvider {
  switch (config.SECRET_PROVIDER) {
    case 'vault':
      if (!config.VAULT_TOKEN) throw new SecretProviderError('VAULT_TOKEN required for vault provider', {});
      return new VaultSecretProvider({
        addr: config.VAULT_ADDR,
        token: config.VAULT_TOKEN,
        path: config.VAULT_SECRET_PATH,
      });
    case 'env':
      return new EnvironmentSecretProvider();
    default:
      throw new SecretProviderError(`Unknown secret provider: ${config.SECRET_PROVIDER}`, {});
  }
}
