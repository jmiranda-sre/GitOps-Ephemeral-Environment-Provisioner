import { describe, it, expect } from 'vitest';
import { buildEnvDomain } from '@/router/index.js';

describe('buildEnvDomain', () => {
  it('builds domain with pr prefix', () => {
    expect(buildEnvDomain(123, 'pr.example.com')).toBe('pr-123.pr.example.com');
  });

  it('handles PR number 1', () => {
    expect(buildEnvDomain(1, 'eph.dev')).toBe('pr-1.eph.dev');
  });

  it('handles large PR numbers', () => {
    expect(buildEnvDomain(99999, 'test.local')).toBe('pr-99999.test.local');
  });
});
