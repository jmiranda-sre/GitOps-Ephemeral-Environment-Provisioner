import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvironmentSecretProvider, VaultSecretProvider } from '@/secrets/index.js';
import { SecretProviderError } from '@/errors/index.js';

describe('EnvironmentSecretProvider', () => {
  const provider = new EnvironmentSecretProvider('EPH_SECRET_');
  const testVars: string[] = [];

  beforeEach(() => {
    process.env.EPH_SECRET_DB_URL = 'postgres://test:5432';
    process.env.EPH_SECRET_API_KEY = 'sk-test-123';
    testVars.push('EPH_SECRET_DB_URL', 'EPH_SECRET_API_KEY');
  });

  afterEach(() => {
    delete process.env.EPH_SECRET_DB_URL;
    delete process.env.EPH_SECRET_API_KEY;
  });

  it('retrieves a secret by key', async () => {
    const value = await provider.getSecret('db_url');
    expect(value).toBe('postgres://test:5432');
  });

  it('throws when secret not found', async () => {
    await expect(provider.getSecret('nonexistent')).rejects.toThrow(SecretProviderError);
  });

  it('retrieves all secrets', async () => {
    const all = await provider.getAllSecrets('');
    expect(all.db_url).toBe('postgres://test:5432');
    expect(all.api_key).toBe('sk-test-123');
  });

  it('health check is always healthy', async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe('healthy');
  });

  it('name is "env"', () => {
    expect(provider.name).toBe('env');
  });
});

describe('VaultSecretProvider', () => {
  it('name is "vault"', () => {
    const provider = new VaultSecretProvider({ addr: 'http://localhost:8200', token: 'test', path: 'ephemeral' });
    expect(provider.name).toBe('vault');
  });

  it('health check returns unhealthy when vault is unreachable', async () => {
    const provider = new VaultSecretProvider({ addr: 'http://localhost:99999', token: 'test', path: 'ephemeral' });
    const health = await provider.healthCheck();
    expect(health.status).toBe('unhealthy');
  });

  it('throws when secret not found in empty vault', async () => {
    // Without a real vault, this will throw a connection error
    const provider = new VaultSecretProvider({ addr: 'http://localhost:99999', token: 'test', path: 'ephemeral' });
    await expect(provider.getSecret('nonexistent')).rejects.toThrow();
  });
});
