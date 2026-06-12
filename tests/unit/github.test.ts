import { describe, it, expect } from 'vitest';
import { buildProvisionComment, buildTeardownComment, COMMENT_MARKER } from '@/github/index.js';

describe('buildProvisionComment', () => {
  it('includes marker for idempotent update', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123def456');
    expect(comment).toContain(COMMENT_MARKER);
  });

  it('includes PR number', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123def456');
    expect(comment).toContain('#42');
  });

  it('includes environment URL as link', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123def456');
    expect(comment).toContain('https://pr-42.example.com');
  });

  it('includes short SHA (7 chars)', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123def456789');
    expect(comment).toContain('abc123d');
  });

  it('includes provision time in seconds', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123');
    expect(comment).toContain('5.0s');
  });

  it('shows correct emoji for running status', () => {
    const comment = buildProvisionComment(42, 'running', 'https://pr-42.example.com', 5000, 'abc123');
    expect(comment).toContain('🟢');
  });

  it('shows correct emoji for failed status', () => {
    const comment = buildProvisionComment(42, 'failed', '', 5000, 'abc123');
    expect(comment).toContain('🔴');
  });
});

describe('buildTeardownComment', () => {
  it('includes marker', () => {
    const comment = buildTeardownComment(42);
    expect(comment).toContain(COMMENT_MARKER);
  });

  it('mentions PR number', () => {
    const comment = buildTeardownComment(42);
    expect(comment).toContain('#42');
  });

  it('indicates cleanup completed', () => {
    const comment = buildTeardownComment(42);
    expect(comment.toLowerCase()).toContain('cleaned up');
  });
});
