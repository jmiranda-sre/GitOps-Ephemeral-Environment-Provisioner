import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WebhookSignatureError, WebhookPayloadError } from '../errors/index.js';
import { logger } from '../logger/index.js';
import type { PullRequestEvent } from '../types/index.js';

const VALID_ACTIONS = ['opened', 'synchronize', 'reopened', 'closed'] as const;

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({
        full_name: z.string(),
        clone_url: z.string(),
        owner: z.object({ login: z.string() }),
      }),
    }),
    base: z.object({
      ref: z.string(),
      repo: z.object({
        full_name: z.string(),
        clone_url: z.string(),
        owner: z.object({ login: z.string() }),
      }),
    }),
    merged: z.boolean().optional(),
    state: z.enum(['open', 'closed']),
  }),
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
    clone_url: z.string(),
  }),
  installation: z.object({ id: z.number() }).optional(),
  sender: z.object({ login: z.string() }),
});

/**
 * Verify HMAC-SHA256 signature of GitHub webhook payload.
 * Prevents forgery and ensures authenticity per OWASP A08.
 */
export function verifyWebhookSignature(payload: string | Buffer, signature: string, secret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const received = signature.replace('sha256=', '');
  // Guard: timingSafeEqual requires equal-length buffers
  if (received.length !== expected.length) return false;
  // Timing-safe comparison to prevent timing attacks (A02)
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

/**
 * Parse and validate a GitHub pull_request webhook event.
 */
export function parseWebhookEvent(raw: unknown): PullRequestEvent {
  const result = pullRequestPayloadSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new WebhookPayloadError(`Invalid webhook payload: ${issues}`, { parseErrors: issues });
  }
  return result.data as PullRequestEvent;
}

/**
 * Determine if the event action requires an action from the provisioner.
 */
export function classifyEvent(action: string): 'provision' | 'teardown' | 'ignore' {
  if (VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    if (action === 'closed') return 'teardown';
    return 'provision';
  }
  return 'ignore';
}

/**
 * Fastify route handler for POST /api/v1/webhook/github
 */
export function createWebhookHandler(secret: string) {
  return async function handleWebhook(request: FastifyRequest, reply: FastifyReply) {
    const signature = request.headers['x-hub-signature-256'] as string;
    const event = request.headers['x-github-event'] as string;
    const correlationId = request.id;

    logger.info('webhook.received', { event, correlationId });

    // ── Step 1: Verify signature (hardened-shield: A08 data integrity) ──
    const rawBody = JSON.stringify(request.body);
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      throw new WebhookSignatureError({ event, correlationId });
    }

    // ── Step 2: Only handle pull_request events ──
    if (event !== 'pull_request') {
      reply.status(200).send({ received: true, message: `Ignoring ${event} event` });
      return;
    }

    // ── Step 3: Parse and validate payload ──
    const prEvent = parseWebhookEvent(request.body);
    const action = classifyEvent(prEvent.action);

    if (action === 'ignore') {
      reply.status(200).send({ received: true, message: `Ignoring action: ${prEvent.action}` });
      return;
    }

    logger.info('webhook.classified', {
      action,
      prNumber: prEvent.number,
      repository: prEvent.repository.full_name,
      correlationId,
    });

    // ── Step 4: Enqueue task (handled by lifecycle orchestrator) ──
    // The queue enqueue is done by the caller (see server.ts route setup)
    reply.status(202).send({
      received: true,
      event,
      action: prEvent.action,
      pr_number: prEvent.number,
      task_type: action,
    });
  };
}
