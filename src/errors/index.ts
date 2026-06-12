import type { ErrorCode, FieldError } from '../types/index.js';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly statusCode: number = 500,
    public readonly retryable: boolean = false,
    public readonly details: FieldError[] = [],
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields: FieldError[], context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, false, fields, context);
  }
}

export class WebhookSignatureError extends AppError {
  constructor(context?: Record<string, unknown>) {
    super('Invalid webhook signature', 'WEBHOOK_INVALID_SIGNATURE', 403, false, [], context);
  }
}

export class WebhookPayloadError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'WEBHOOK_INVALID_PAYLOAD', 400, false, [], context);
  }
}

export class EnvironmentNotFoundError extends AppError {
  constructor(id: string, context?: Record<string, unknown>) {
    super(`Environment '${id}' not found`, 'ENV_NOT_FOUND', 404, false, [], context);
  }
}

export class EnvironmentProvisionError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ENV_PROVISION_FAILED', 500, true, [], context);
  }
}

export class EnvironmentTeardownError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ENV_TEARDOWN_FAILED', 500, true, [], context);
  }
}

export class EnvironmentLimitError extends AppError {
  constructor(max: number, context?: Record<string, unknown>) {
    super(`Maximum concurrent environments reached (${max})`, 'ENV_LIMIT_REACHED', 429, false, [], context);
  }
}

export class DockerConnectionError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DOCKER_CONNECTION_ERROR', 502, true, [], context);
  }
}

export class GitHubApiError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'GITHUB_API_ERROR', 502, true, [], context);
  }
}

export class SecretProviderError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SECRET_PROVIDER_ERROR', 502, true, [], context);
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfter: number, context?: Record<string, unknown>) {
    super(`Rate limited. Retry after ${retryAfter}s`, 'RATE_LIMITED', 429, false, [], { ...context, retryAfter });
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, context?: Record<string, unknown>) {
    super(`Operation '${operation}' timed out`, 'SYSTEM_TIMEOUT', 504, true, [], context);
  }
}
