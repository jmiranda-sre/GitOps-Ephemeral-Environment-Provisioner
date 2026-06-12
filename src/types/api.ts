import type { EnvironmentStatus } from './pr.js';

// ── API Envelope ──
export interface ApiResponse<T> {
  data: T;
}

export interface ApiListResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
    has_next: boolean;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: FieldError[];
    request_id: string;
    documentation_url?: string;
  };
}

export interface FieldError {
  field: string;
  message: string;
}

// ── Error Codes (DOMAIN_TYPE_DETAIL format) ──
export type ErrorCode =
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_INVALID_PAYLOAD'
  | 'WEBHOOK_UNSUPPORTED_EVENT'
  | 'ENV_NOT_FOUND'
  | 'ENV_PROVISION_FAILED'
  | 'ENV_TEARDOWN_FAILED'
  | 'ENV_ALREADY_EXISTS'
  | 'ENV_LIMIT_REACHED'
  | 'QUEUE_CONNECTION_ERROR'
  | 'DOCKER_CONNECTION_ERROR'
  | 'GITHUB_API_ERROR'
  | 'SECRET_PROVIDER_ERROR'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'SYSTEM_INTERNAL_ERROR'
  | 'SYSTEM_TIMEOUT'
  | 'SYSTEM_EXTERNAL_ERROR';

// ── API Route Types ──
export interface WebhookResponse {
  received: boolean;
  event: string;
  action: string;
  pr_number: number;
  task_id: string;
}

export interface EnvironmentListQuery {
  page?: number;
  per_page?: number;
  status?: EnvironmentStatus;
  repository?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime_seconds: number;
  checks: Record<string, HealthCheckDetail>;
}

export interface HealthCheckDetail {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency_ms?: number;
  detail?: string;
}

export interface MetricsResponse {
  environments: {
    total: number;
    by_status: Record<EnvironmentStatus, number>;
  };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  };
}
