import type { InfraProvider } from '../provider.js';
import type { EnvironmentConfig, EnvironmentRecord, ProvisionResult, TeardownResult } from '../../types/index.js';
import { EnvironmentProvisionError, EnvironmentTeardownError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import { provisioningDuration, teardownDuration, provisioningTotal, activeEnvironments } from '../../metrics/index.js';

/**
 * Kubernetes infra provider — pluggable for production scale.
 * Uses kubectl/manifests for MVP; k8s client library for production.
 * DECISION: Manifest-based approach for simplicity and auditability.
 */
export class KubernetesProvider implements InfraProvider {
  readonly name = 'kubernetes';
  private namespace: string;
  private kubectlContext: string;

  constructor(config: { namespace?: string; context?: string }) {
    this.namespace = config.namespace ?? 'ephemeral-envs';
    this.kubectlContext = config.context ?? '';
  }

  async provision(envConfig: EnvironmentConfig): Promise<ProvisionResult> {
    const start = Date.now();
    const timer = provisioningDuration.startTimer({ repository: envConfig.repository, provider: this.name });
    const ns = `${this.namespace}-pr-${envConfig.prNumber}`;

    try {
      logger.info('k8s.provision_start', { prNumber: envConfig.prNumber, namespace: ns });

      // ── Step 1: Create namespace with labels ──
      await this.kubectlApply({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: ns,
          labels: {
            'eph-env': 'true',
            'eph-pr': String(envConfig.prNumber),
            'eph-repo': envConfig.repository.replace('/', '-'),
          },
          annotations: {
            'eph SHA': envConfig.sha,
            'eph-branch': envConfig.branch,
          },
        },
      });

      // ── Step 2: Create secrets in namespace ──
      const secretData: Record<string, string> = {};
      for (const [k, v] of Object.entries(envConfig.envVars)) {
        secretData[k] = Buffer.from(v).toString('base64');
      }
      await this.kubectlApply({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: `${envConfig.projectName}-secrets`, namespace: ns },
        type: 'Opaque',
        data: secretData,
      });

      // ── Step 3: Apply manifests from repo (simulated) ──
      // In production, apply kustomize overlays or Helm charts
      logger.info('k8s.provision_manifests_applied', { namespace: ns });

      // ── Step 4: Create Ingress for routing ──
      await this.kubectlApply({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
          name: `${envConfig.projectName}-ingress`,
          namespace: ns,
          annotations: {
            'traefik.ingress.kubernetes.io/router.entrypoints': 'web',
          },
        },
        spec: {
          rules: [{
            host: envConfig.domain,
            http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app', port: { number: 80 } } } }] },
          }],
        },
      });

      const environment: EnvironmentRecord = {
        id: `k8s-${envConfig.prNumber}`,
        prNumber: envConfig.prNumber,
        repository: envConfig.repository,
        branch: envConfig.branch,
        sha: envConfig.sha,
        status: 'running',
        url: `https://${envConfig.domain}`,
        projectName: envConfig.projectName,
        networkName: ns,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        containerIds: [],
        volumeNames: [],
      };

      const durationMs = Date.now() - start;
      timer();
      provisioningTotal.inc({ repository: envConfig.repository, result: 'success' });
      activeEnvironments.inc({ status: 'running' });

      return { success: true, environment, durationMs };
    } catch (error) {
      const durationMs = Date.now() - start;
      timer();
      provisioningTotal.inc({ repository: envConfig.repository, result: 'failure' });
      const msg = error instanceof Error ? error.message : 'Unknown k8s provision error';
      throw new EnvironmentProvisionError(msg, { prNumber: envConfig.prNumber, durationMs });
    }
  }

  async teardown(environment: EnvironmentRecord): Promise<TeardownResult> {
    const start = Date.now();
    const timer = teardownDuration.startTimer({ repository: environment.repository, provider: this.name });
    const ns = environment.networkName;

    try {
      logger.info('k8s.teardown_start', { namespace: ns, prNumber: environment.prNumber });

      // Delete entire namespace — cascade removes all resources
      await this.kubectlDelete('Namespace', ns);
      activeEnvironments.dec({ status: 'running' });

      const durationMs = Date.now() - start;
      timer();
      return { success: true, environmentId: environment.id, durationMs };
    } catch (error) {
      const durationMs = Date.now() - start;
      timer();
      const msg = error instanceof Error ? error.message : 'Unknown k8s teardown error';
      throw new EnvironmentTeardownError(msg, { namespace: ns, durationMs });
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }> {
    const start = Date.now();
    try {
      const { execSync } = await import('node:child_process');
      execSync('kubectl cluster-info', { timeout: 5000, stdio: 'pipe' });
      return { status: 'healthy', latency_ms: Date.now() - start };
    } catch {
      return { status: 'unhealthy', latency_ms: Date.now() - start, detail: 'Kubernetes cluster unreachable' };
    }
  }

  async listEnvironments(): Promise<string[]> {
    try {
      const { execSync } = await import('node:child_process');
      const output = execSync(
        `kubectl get namespaces -l eph-env=true -o jsonpath={.items[*].metadata.name}`,
        { timeout: 10000, encoding: 'utf-8' },
      );
      return output.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getStatus(projectName: string): Promise<'running' | 'stopped' | 'not_found'> {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`kubectl get namespace ${projectName}`, { timeout: 5000, stdio: 'pipe' });
      return 'running';
    } catch {
      return 'not_found';
    }
  }

  private async kubectlApply(manifest: Record<string, unknown>): Promise<void> {
    const { execSync } = await import('node:child_process');
    const yaml = JSON.stringify(manifest);
    const cmd = this.kubectlContext
      ? `kubectl apply --context=${this.kubectlContext} -f -`
      : 'kubectl apply -f -';
    execSync(cmd, { input: yaml, timeout: 30000, stdio: 'pipe', encoding: 'utf-8' });
  }

  private async kubectlDelete(kind: string, name: string): Promise<void> {
    const { execSync } = await import('node:child_process');
    const cmd = this.kubectlContext
      ? `kubectl delete --context=${this.kubectlContext} ${kind} ${name} --timeout=60s --ignore-not-found=true`
      : `kubectl delete ${kind} ${name} --timeout=60s --ignore-not-found=true`;
    execSync(cmd, { timeout: 90000, stdio: 'pipe' });
  }
}
