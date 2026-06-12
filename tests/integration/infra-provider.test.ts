import { describe, it, expect } from 'vitest';
import type { InfraProvider } from '@/infra/provider.js';
import type { EnvironmentConfig, EnvironmentRecord } from '@/types/pr.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Mock infra provider for testing the interface contract.
 * Validates that the provider abstraction works correctly.
 */
class MockInfraProvider implements InfraProvider {
  readonly name = 'mock';
  private envs = new Map<string, EnvironmentRecord>();

  async provision(config: EnvironmentConfig) {
    const env: EnvironmentRecord = {
      id: uuidv4(),
      prNumber: config.prNumber,
      repository: config.repository,
      branch: config.branch,
      sha: config.sha,
      status: 'running',
      url: `https://${config.domain}`,
      projectName: config.projectName,
      networkName: config.networkName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      containerIds: [],
      volumeNames: [],
    };
    this.envs.set(config.projectName, env);
    return { success: true, environment: env, durationMs: 100 };
  }

  async teardown(environment: EnvironmentRecord) {
    this.envs.delete(environment.projectName);
    return { success: true, environmentId: environment.id, durationMs: 50 };
  }

  async healthCheck() {
    return { status: 'healthy' as const, latency_ms: 1 };
  }

  async listEnvironments() {
    return [...this.envs.keys()];
  }

  async getStatus(projectName: string) {
    return this.envs.has(projectName) ? 'running' as const : 'not_found' as const;
  }
}

describe('InfraProvider interface contract', () => {
  const provider = new MockInfraProvider();

  const makeConfig = (prNumber: number): EnvironmentConfig => ({
    prNumber,
    repository: 'org/repo',
    branch: 'feature/test',
    sha: 'abc123',
    cloneUrl: 'https://github.com/org/repo.git',
    projectName: `eph-pr-${prNumber}`,
    domain: `pr-${prNumber}.eph.local`,
    networkName: `eph-pr-${prNumber}`,
    composeFile: 'docker-compose.yml',
    envVars: { DB_URL: 'postgres://test' },
    resourceLimits: { cpu: '0.5', memory: '512m' },
  });

  it('provisions an environment', async () => {
    const config = makeConfig(1);
    const result = await provider.provision(config);
    expect(result.success).toBe(true);
    expect(result.environment.status).toBe('running');
    expect(result.environment.url).toContain('pr-1.eph.local');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('tracks provisioned environments', async () => {
    await provider.provision(makeConfig(2));
    await provider.provision(makeConfig(3));
    const envs = await provider.listEnvironments();
    expect(envs.length).toBeGreaterThanOrEqual(2);
  });

  it('reports running status for provisioned env', async () => {
    await provider.provision(makeConfig(4));
    const status = await provider.getStatus('eph-pr-4');
    expect(status).toBe('running');
  });

  it('reports not_found for unknown env', async () => {
    const status = await provider.getStatus('nonexistent');
    expect(status).toBe('not_found');
  });

  it('tears down an environment', async () => {
    const config = makeConfig(5);
    const { environment } = await provider.provision(config);
    const result = await provider.teardown(environment);
    expect(result.success).toBe(true);
    expect(result.environmentId).toBe(environment.id);
    const status = await provider.getStatus('eph-pr-5');
    expect(status).toBe('not_found');
  });

  it('teardown is idempotent (no error on missing env)', async () => {
    const env: EnvironmentRecord = {
      id: uuidv4(),
      prNumber: 99,
      repository: 'org/repo',
      branch: 'main',
      sha: '000',
      status: 'destroyed',
      url: '',
      projectName: 'eph-pr-99',
      networkName: 'eph-pr-99',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      containerIds: [],
      volumeNames: [],
    };
    // No error when tearing down nonexistent env
    const result = await provider.teardown(env);
    expect(result.success).toBe(true);
  });

  it('health check returns healthy', async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
