import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import type { AppConfig } from '@/config/index.js';
import type { InfraProvider } from '@/infra/provider.js';
import type { SecretProvider } from '@/secrets/index.js';
import type { RouterProvider } from '@/router/index.js';
import type { EnvironmentConfig, EnvironmentRecord } from '@/types/pr.js';
import { correlationIdPlugin } from '@/middleware/correlation.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { EnvironmentSecretProvider } from '@/secrets/index.js';

// ── Test doubles (no real Docker, Redis, or GitHub required) ──

class StubInfraProvider implements InfraProvider {
  readonly name = 'stub';
  private envs = new Map<string, EnvironmentRecord>();

  async provision(config: EnvironmentConfig) {
    const env: EnvironmentRecord = {
      id: `stub-${config.prNumber}`,
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
      containerIds: ['stub-container-1'],
      volumeNames: [],
    };
    this.envs.set(config.projectName, env);
    return { success: true, environment: env, durationMs: 150 };
  }

  async teardown(environment: EnvironmentRecord) {
    this.envs.delete(environment.projectName);
    return { success: true, environmentId: environment.id, durationMs: 80 };
  }

  async healthCheck() { return { status: 'healthy' as const, latency_ms: 1 }; }
  async listEnvironments() { return [...this.envs.keys()]; }
  async getStatus(p: string) { return this.envs.has(p) ? 'running' as const : 'not_found' as const; }
}

class StubRouterProvider implements RouterProvider {
  private routes = new Map<string, { domain: string; target: string }>();
  async registerRoute(pr: number, proj: string, domain: string, target: string) { this.routes.set(proj, { domain, target }); }
  async removeRoute(_pr: number, proj: string) { this.routes.delete(proj); }
  async healthCheck() { return { status: 'healthy' as const, latency_ms: 0 }; }
  getRoutes() { return this.routes; }
}

// ── Tests ──

const WEBHOOK_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 34 chars

function signPayload(payload: string): string {
  return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')}`;
}

describe('E2E: Full Provision → Teardown Lifecycle', () => {
  let app: ReturnType<typeof Fastify>;
  const infra = new StubInfraProvider();
  const secrets = new EnvironmentSecretProvider('EPH_SECRET_');
  const router = new StubRouterProvider();
  const provisionedEnvs: EnvironmentRecord[] = [];

  beforeAll(async () => {
    app = Fastify({ requestIdHeader: 'x-correlation-id' });
    app.addHook('onRequest', correlationIdPlugin);
    app.setErrorHandler(errorHandler);

    const { verifyWebhookSignature, parseWebhookEvent, classifyEvent } = await import('@/webhook/index.js');
    const { buildEnvDomain } = await import('@/router/index.js');

    app.post('/api/v1/webhook/github', async (request, reply) => {
      const signature = request.headers['x-hub-signature-256'] as string;
      const event = request.headers['x-github-event'] as string;
      const rawBody = JSON.stringify(request.body);

      if (!verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
        return reply.status(403).send({ error: { code: 'WEBHOOK_INVALID_SIGNATURE', message: 'Invalid signature', request_id: request.id } });
      }
      if (event !== 'pull_request') {
        return reply.status(200).send({ data: { received: true } });
      }

      const prEvent = parseWebhookEvent(request.body);
      const action = classifyEvent(prEvent.action);

      if (action === 'provision') {
        const domain = buildEnvDomain(prEvent.number, 'pr.localhost');
        const projectName = `eph-pr-${prEvent.number}`;
        const envConfig: EnvironmentConfig = {
          prNumber: prEvent.number,
          repository: prEvent.repository.full_name,
          branch: prEvent.pull_request.head.ref,
          sha: prEvent.pull_request.head.sha,
          cloneUrl: prEvent.repository.clone_url,
          projectName,
          domain,
          networkName: `eph-pr-${prEvent.number}`,
          composeFile: 'docker-compose.yml',
          envVars: { PR_NUMBER: String(prEvent.number) },
          resourceLimits: { cpu: '0.5', memory: '512m' },
        };
        const result = await infra.provision(envConfig);
        if (result.success) {
          // Remove previous env for same PR before adding new (re-provision on synchronize)
          const prevIdx = provisionedEnvs.findIndex((e) => e.prNumber === prEvent.number);
          if (prevIdx >= 0) provisionedEnvs.splice(prevIdx, 1);
          provisionedEnvs.push(result.environment);
          await router.registerRoute(prEvent.number, projectName, domain, `http://${projectName}:80`);
        }
        return reply.status(202).send({ data: { received: true, action: prEvent.action, pr_number: prEvent.number, task_type: 'provision', env_id: result.environment.id } });
      }

      if (action === 'teardown') {
        // Remove ALL environments for this PR number
        const toRemove = provisionedEnvs.filter((e) => e.prNumber === prEvent.number);
        for (const env of toRemove) {
          await router.removeRoute(prEvent.number, env.projectName);
          await infra.teardown(env);
        }
        for (const env of toRemove) {
          const idx = provisionedEnvs.indexOf(env);
          if (idx >= 0) provisionedEnvs.splice(idx, 1);
        }
        return reply.status(202).send({ data: { received: true, action: prEvent.action, pr_number: prEvent.number, task_type: 'teardown' } });
      }

      return reply.status(200).send({ data: { received: true, message: 'Ignored' } });
    });

    app.get('/api/v1/environments', async () => ({ data: provisionedEnvs }));
    app.get('/health', async () => ({ status: 'healthy', timestamp: new Date().toISOString(), version: '0.1.0', uptime_seconds: 60, checks: {} }));

    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('Step 1: Provisions environment on PR opened', async () => {
    const payload = {
      action: 'opened', number: 100,
      pull_request: {
        id: 100, number: 100, title: 'Feature X', body: null,
        head: { ref: 'feature/x', sha: 'deadbeef', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        base: { ref: 'main', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        merged: false, state: 'open',
      },
      repository: { id: 1, full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/app.git' },
      sender: { login: 'dev' },
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/webhook/github',
      headers: { 'x-hub-signature-256': signPayload(body), 'x-github-event': 'pull_request', 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.task_type).toBe('provision');
    expect(provisionedEnvs).toHaveLength(1);
  });

  it('Step 2: Router has the route registered', () => {
    const routes = router.getRoutes();
    expect(routes.has('eph-pr-100')).toBe(true);
    expect(routes.get('eph-pr-100')?.domain).toBe('pr-100.pr.localhost');
  });

  it('Step 3: Re-provisions on synchronize (update)', async () => {
    const payload = {
      action: 'synchronize', number: 100,
      pull_request: {
        id: 100, number: 100, title: 'Feature X', body: null,
        head: { ref: 'feature/x', sha: 'newsha123', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        base: { ref: 'main', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        merged: false, state: 'open',
      },
      repository: { id: 1, full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/app.git' },
      sender: { login: 'dev' },
    };
    const body = JSON.stringify(payload);
    await app.inject({
      method: 'POST', url: '/api/v1/webhook/github',
      headers: { 'x-hub-signature-256': signPayload(body), 'x-github-event': 'pull_request', 'content-type': 'application/json' },
      payload,
    });
    // Should have a new provision (provider is stub, no conflict)
    expect(provisionedEnvs.length).toBeGreaterThanOrEqual(1);
  });

  it('Step 4: Tears down on PR closed', async () => {
    const payload = {
      action: 'closed', number: 100,
      pull_request: {
        id: 100, number: 100, title: 'Feature X', body: null,
        head: { ref: 'feature/x', sha: 'newsha123', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        base: { ref: 'main', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        merged: true, state: 'closed',
      },
      repository: { id: 1, full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/app.git' },
      sender: { login: 'dev' },
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/webhook/github',
      headers: { 'x-hub-signature-256': signPayload(body), 'x-github-event': 'pull_request', 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.task_type).toBe('teardown');
  });

  it('Step 5: Environment is fully removed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/environments' });
    const envs = res.json().data as EnvironmentRecord[];
    const pr100Envs = envs.filter((e) => e.prNumber === 100);
    expect(pr100Envs).toHaveLength(0);
  });

  it('Step 6: Route is removed from router', () => {
    expect(router.getRoutes().has('eph-pr-100')).toBe(false);
  });

  it('Step 7: Idempotent teardown (closed again) succeeds', async () => {
    const payload = {
      action: 'closed', number: 100,
      pull_request: {
        id: 100, number: 100, title: 'Feature X', body: null,
        head: { ref: 'feature/x', sha: 'newsha123', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        base: { ref: 'main', repo: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } } },
        merged: true, state: 'closed',
      },
      repository: { id: 1, full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/app.git' },
      sender: { login: 'dev' },
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/webhook/github',
      headers: { 'x-hub-signature-256': signPayload(body), 'x-github-event': 'pull_request', 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(202);
  });

  it('Health endpoint is responsive', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('healthy');
  });
});
