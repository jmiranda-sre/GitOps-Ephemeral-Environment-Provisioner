import { describe, it, expect, beforeEach } from 'vitest';
import { getEnvironment, listEnvironments, findEnvironmentByPr } from '@/lifecycle/index.js';
import type { EnvironmentRecord } from '@/types/pr.js';

// The lifecycle module uses an in-memory Map — we test the helpers directly.
// Full orchestrator is tested in integration tests.

describe('environment store helpers', () => {
  // Since the store is module-scoped and mutable, we verify basic behavior.
  // Full isolation would require dependency injection.

  it('listEnvironments returns array', () => {
    const result = listEnvironments();
    expect(Array.isArray(result)).toBe(true);
  });

  it('findEnvironmentByPr returns undefined for nonexistent PR', () => {
    const result = findEnvironmentByPr(999999, 'nonexistent/repo');
    expect(result).toBeUndefined();
  });

  it('getEnvironment returns undefined for unknown id', () => {
    const result = getEnvironment('nonexistent-id');
    expect(result).toBeUndefined();
  });
});
