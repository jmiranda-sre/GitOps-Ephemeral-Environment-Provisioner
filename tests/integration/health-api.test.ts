import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { correlationIdPlugin } from '@/middleware/correlation.js';
import { errorHandler } from '@/middleware/error-handler.js';

describe('Health API Integration', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ requestIdHeader: 'x-correlation-id' });
    app.addHook('onRequest', correlationIdPlugin);
    app.setErrorHandler(errorHandler);

    app.get('/health', async (_req, reply) => {
      const checks: Record<string, { status: string; latency_ms: number; detail?: string }> = {
        docker: { status: 'healthy', latency_ms: 5 },
        redis: { status: 'healthy', latency_ms: 1 },
      };
      reply.send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        uptime_seconds: 60,
        checks,
      });
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with healthy status', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('healthy');
    expect(body.checks.docker.status).toBe('healthy');
    expect(body.checks.redis.status).toBe('healthy');
  });

  it('includes version and uptime', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json();
    expect(body.version).toBe('0.1.0');
    expect(typeof body.uptime_seconds).toBe('number');
  });

  it('returns correlation ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'health-check-1' },
    });
    expect(response.headers['x-correlation-id']).toBe('health-check-1');
  });
});
