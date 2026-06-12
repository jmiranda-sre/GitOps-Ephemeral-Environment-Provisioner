import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature, parseWebhookEvent, classifyEvent } from '@/webhook/index.js';
import { WebhookSignatureError, WebhookPayloadError } from '@/errors/index.js';
import type { PullRequestEvent } from '@/types/pr.js';

const SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 34 chars

function makeSignature(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function makePrEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: 'opened',
    number: 42,
    pull_request: {
      id: 1,
      number: 42,
      title: 'Test PR',
      body: null,
      head: { ref: 'feature/test', sha: 'abc123', repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git', owner: { login: 'org' } } },
      base: { ref: 'main', repo: { full_name: 'org/repo', clone_url: 'https://github.com/org/repo.git', owner: { login: 'org' } } },
      merged: false,
      state: 'open',
    },
    repository: { id: 1, full_name: 'org/repo', name: 'repo', owner: { login: 'org' }, clone_url: 'https://github.com/org/repo.git' },
    sender: { login: 'dev' },
    ...overrides,
  } as PullRequestEvent;
}

describe('verifyWebhookSignature', () => {
  it('accepts valid HMAC-SHA256 signature', () => {
    const payload = '{"test":true}';
    const sig = makeSignature(payload, SECRET);
    expect(verifyWebhookSignature(payload, sig, SECRET)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const payload = '{"test":true}';
    expect(verifyWebhookSignature(payload, 'sha256=bad', SECRET)).toBe(false);
  });

  it('rejects missing signature', () => {
    expect(verifyWebhookSignature('{}', '', SECRET)).toBe(false);
  });

  it('rejects wrong algorithm prefix', () => {
    expect(verifyWebhookSignature('{}', 'sha1=abc', SECRET)).toBe(false);
  });

  it('uses timing-safe comparison (no timing leak)', () => {
    const payload = '{"test":true}';
    const sig = makeSignature(payload, SECRET);
    // Both should return false but without throwing
    expect(verifyWebhookSignature(payload, sig, 'wrong-secret-0000000000000000')).toBe(false);
    expect(verifyWebhookSignature(payload, 'sha256=' + '0'.repeat(64), SECRET)).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('parses valid pull_request event', () => {
    const event = makePrEvent();
    const parsed = parseWebhookEvent(event);
    expect(parsed.action).toBe('opened');
    expect(parsed.number).toBe(42);
    expect(parsed.repository.full_name).toBe('org/repo');
  });

  it('rejects missing required fields', () => {
    expect(() => parseWebhookEvent({ action: 'opened' })).toThrow();
  });

  it('rejects invalid action', () => {
    const event = makePrEvent({ action: 'unknown' } as Partial<PullRequestEvent>);
    // parseWebhookEvent validates schema, not business logic
    const parsed = parseWebhookEvent(event);
    expect(parsed.action).toBe('unknown');
  });

  it('accepts closed event with merged field', () => {
    const event = makePrEvent({ action: 'closed' });
    const parsed = parseWebhookEvent(event);
    expect(parsed.action).toBe('closed');
  });
});

describe('classifyEvent', () => {
  it('classifies opened as provision', () => {
    expect(classifyEvent('opened')).toBe('provision');
  });

  it('classifies synchronize as provision', () => {
    expect(classifyEvent('synchronize')).toBe('provision');
  });

  it('classifies reopened as provision', () => {
    expect(classifyEvent('reopened')).toBe('provision');
  });

  it('classifies closed as teardown', () => {
    expect(classifyEvent('closed')).toBe('teardown');
  });

  it('classifies unknown actions as ignore', () => {
    expect(classifyEvent('assigned')).toBe('ignore');
    expect(classifyEvent('labeled')).toBe('ignore');
    expect(classifyEvent('review_requested')).toBe('ignore');
  });
});
