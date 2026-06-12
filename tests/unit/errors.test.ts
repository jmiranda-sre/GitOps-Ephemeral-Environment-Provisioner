import { describe, it, expect } from 'vitest';
import {
  AppError, ValidationError, WebhookSignatureError, WebhookPayloadError,
  EnvironmentNotFoundError, EnvironmentProvisionError, EnvironmentTeardownError,
  EnvironmentLimitError, DockerConnectionError, GitHubApiError, SecretProviderError,
  RateLimitedError, TimeoutError,
} from '@/errors/index.js';

describe('AppError', () => {
  it('sets properties correctly', () => {
    const err = new AppError('test', 'SYSTEM_INTERNAL_ERROR', 500, false, [], { key: 'val' });
    expect(err.message).toBe('test');
    expect(err.code).toBe('SYSTEM_INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual([]);
    expect(err.context).toEqual({ key: 'val' });
    expect(err.name).toBe('AppError');
  });
});

describe('ValidationError', () => {
  it('has 400 status and non-retryable', () => {
    const err = new ValidationError('Invalid input', [{ field: 'email', message: 'Invalid format' }]);
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toHaveLength(1);
  });
});

describe('WebhookSignatureError', () => {
  it('has 403 status', () => {
    const err = new WebhookSignatureError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });
});

describe('EnvironmentNotFoundError', () => {
  it('has 404 status with env id', () => {
    const err = new EnvironmentNotFoundError('env-123');
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('env-123');
  });
});

describe('EnvironmentProvisionError', () => {
  it('is retryable with 500 status', () => {
    const err = new EnvironmentProvisionError('Docker failed');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(500);
  });
});

describe('EnvironmentTeardownError', () => {
  it('is retryable', () => {
    const err = new EnvironmentTeardownError('Cleanup failed');
    expect(err.retryable).toBe(true);
  });
});

describe('EnvironmentLimitError', () => {
  it('has 429 status with max value', () => {
    const err = new EnvironmentLimitError(10);
    expect(err.statusCode).toBe(429);
    expect(err.message).toContain('10');
  });
});

describe('RateLimitedError', () => {
  it('includes retryAfter in context', () => {
    const err = new RateLimitedError(60);
    expect(err.statusCode).toBe(429);
    expect(err.context.retryAfter).toBe(60);
  });
});

describe('TimeoutError', () => {
  it('is retryable with 504 status', () => {
    const err = new TimeoutError('docker compose up');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(504);
  });
});

describe('GitHubApiError', () => {
  it('is retryable', () => {
    const err = new GitHubApiError('Rate limited');
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('GITHUB_API_ERROR');
  });
});
