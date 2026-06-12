import type { EnvironmentConfig, EnvironmentRecord, ProvisionResult, TeardownResult } from '../types/index.js';

/**
 * Abstract interface for infrastructure providers.
 * Pluggable design: Docker Compose (MVP) or Kubernetes (future).
 */
export interface InfraProvider {
  readonly name: string;

  /**
   * Provision a full isolated environment for a PR.
   * Must be idempotent — subsequent calls with same config should reconcile, not duplicate.
   */
  provision(config: EnvironmentConfig): Promise<ProvisionResult>;

  /**
   * Tear down an environment completely.
   * Must be idempotent — calling on already-destroyed env returns success.
   */
  teardown(environment: EnvironmentRecord): Promise<TeardownResult>;

  /**
   * Check health/connectivity of the provider.
   */
  healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }>;

  /**
   * List running environments managed by this provider.
   */
  listEnvironments(): Promise<string[]>;

  /**
   * Get status of a specific environment.
   */
  getStatus(projectName: string): Promise<'running' | 'stopped' | 'not_found'>;
}
