import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '@/config/index.js';

const VALID_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/key.pem',
  GITHUB_APP_WEBHOOK_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

beforeEach(() => {
  resetConfig();
  // Clean env
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('APP_') || key.startsWith('GITHUB_') || key.startsWith('REDIS_') || key.startsWith('DOCKER_') || key.startsWith('TRAEFIK_') || key.startsWith('SECRET_') || key.startsWith('VAULT_') || key.startsWith('MAX_') || key.startsWith('ENV_') || key.startsWith('METRICS_')) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  resetConfig();
  // Clean up
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('APP_') || key.startsWith('GITHUB_') || key.startsWith('REDIS_') || key.startsWith('DOCKER_') || key.startsWith('TRAEFIK_') || key.startsWith('SECRET_') || key.startsWith('VAULT_') || key.startsWith('MAX_') || key.startsWith('ENV_') || key.startsWith('METRICS_')) {
      delete process.env[key];
    }
  }
});

describe('loadConfig', () => {
  it('loads valid config with required fields', () => {
    Object.assign(process.env, { ...VALID_ENV, APP_ENV: 'development' });
    const config = loadConfig();
    expect(config.GITHUB_APP_ID).toBe(12345);
    expect(config.APP_ENV).toBe('development');
    expect(config.APP_PORT).toBe(3000);
  });

  it('applies defaults for optional fields', () => {
    Object.assign(process.env, VALID_ENV);
    const config = loadConfig();
    expect(config.REDIS_HOST).toBe('127.0.0.1');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.DOCKER_NETWORK_PREFIX).toBe('eph-');
    expect(config.MAX_CONCURRENT_ENVS).toBe(10);
    expect(config.ENV_CPU_LIMIT).toBe('0.5');
    expect(config.ENV_MEMORY_LIMIT).toBe('512m');
  });

  it('throws on missing required field GITHUB_APP_ID', () => {
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/tmp/key.pem';
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => loadConfig()).toThrow(/GITHUB_APP_ID/);
  });

  it('throws on short webhook secret', () => {
    Object.assign(process.env, { ...VALID_ENV, GITHUB_APP_WEBHOOK_SECRET: 'short' });
    expect(() => loadConfig()).toThrow(/GITHUB_APP_WEBHOOK_SECRET/);
  });

  it('rejects invalid APP_ENV value', () => {
    Object.assign(process.env, { ...VALID_ENV, APP_ENV: 'invalid' });
    expect(() => loadConfig()).toThrow(/APP_ENV/);
  });

  it('parses numeric fields correctly', () => {
    Object.assign(process.env, { ...VALID_ENV, APP_PORT: '8080', REDIS_PORT: '6380', MAX_CONCURRENT_ENVS: '20' });
    const config = loadConfig();
    expect(config.APP_PORT).toBe(8080);
    expect(config.REDIS_PORT).toBe(6380);
    expect(config.MAX_CONCURRENT_ENVS).toBe(20);
  });
});
