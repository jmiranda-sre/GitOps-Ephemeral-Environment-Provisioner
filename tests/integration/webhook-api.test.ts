import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { correlationIdPlugin } from '@/middleware/correlation.js';
import { errorHandler } from '@/middleware/error-handler.js';

const SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 34 chars

function makeSignature(payload: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
}

function makePrPayload(action = 'opened', prNumber = 42) {
  return {
    action,
    number: prNumber,
    pull_request: {
      id: 1,
      number: prNumber,
      title: 'Test PR',
      body: null,
      head: { ref: 'feature/test', sha: 'abc123def456', repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git', owner: { login: 'org' } } },
      base: { ref: 'main', repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git', owner: { login: 'org' } } },
      merged: false,
      state: 'open',
    },
    repository: { id: 1, full_name: 'org/repo', name: 'repo', owner: { login: 'org' }, clone_url: 'https://github.com/org/repo.git' },
    sender: { login: 'dev' },
  };
}

describe('Webhook API Integration', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ requestIdHeader: 'x-correlation-id' });
    app.addHook('onRequest', correlationIdPlugin);
    app.setErrorHandler(errorHandler);

    app.post('/api/v1/webhook/github', async (request, reply) => {
      const signature = request.headers['x-hub-signature-256'] as string;
      const event = request.headers['x-github-event'] as string;
      const rawBody = JSON.stringify(request.body);

      const { verifyWebhookSignature, parseWebhookEvent, classifyEvent } = await import('@/webhook/index.js');

      if (!verifyWebhookSignature(rawBody, signature, SECRET)) {
        return reply.status(403).send({ error: { code: 'WEBHOOK_INVALID_SIGNATURE', message: 'Invalid signature', request_id: request.id } });
      }

      if (event !== 'pull_request') {
        return reply.status(200).send({ data: { received: true, message: `Ignoring ${event} event` } });
      }

      const prEvent = parseWebhookEvent(request.body);
      const action = classifyEvent(prEvent.action);

      if (action === 'ignore') {
        return reply.status(200).send({ data: { received: true, message: `Ignoring action: ${prEvent.action}` } });
      }

      return reply.status(202).send({
        data: { received: true, event, action: prEvent.action, pr_number: prEvent.number, task_type: action },
      });
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts valid pull_request opened webhook', async () => {
    const payload = makePrPayload('opened');
    const body = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': makeSignature(body),
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(response.statusCode).toBe(202);
    const data = response.json();
    expect(data.data.task_type).toBe('provision');
    expect(data.data.pr_number).toBe(42);
  });

  it('accepts valid pull_request closed webhook', async () => {
    const payload = makePrPayload('closed');
    const body = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': makeSignature(body),
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(response.statusCode).toBe(202);
    const data = response.json();
    expect(data.data.task_type).toBe('teardown');
  });

  it('rejects invalid HMAC signature with 403', async () => {
    const payload = makePrPayload('opened');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': 'sha256=invalid_signature_here',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(response.statusCode).toBe(403);
  });

  it('ignores non-pull_request events with 200', async () => {
    const payload = { action: 'created', issue: { number: 1 } };
    const body = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': makeSignature(body),
        'x-github-event': 'issues',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it('ignores unsupported PR actions (assigned, labeled)', async () => {
    const payload = { ...makePrPayload('assigned') };
    const body = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': makeSignature(body),
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns correlation ID header', async () => {
    const payload = makePrPayload('opened');
    const body = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhook/github',
      headers: {
        'x-hub-signature-256': makeSignature(body),
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
        'x-correlation-id': 'test-corr-123',
      },
      payload,
    });
    expect(response.headers['x-correlation-id']).toBe('test-corr-123');
  });
});
