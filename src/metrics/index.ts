import promClient from 'prom-client';

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// ── Custom Metrics ──
export const provisioningDuration = new promClient.Histogram({
  name: 'eph_provisioning_duration_seconds',
  help: 'Duration of environment provisioning',
  labelNames: ['repository', 'provider'] as const,
  buckets: [5, 10, 30, 60, 120, 300],
});
register.registerMetric(provisioningDuration);

export const teardownDuration = new promClient.Histogram({
  name: 'eph_teardown_duration_seconds',
  help: 'Duration of environment teardown',
  labelNames: ['repository', 'provider'] as const,
  buckets: [2, 5, 10, 30, 60],
});
register.registerMetric(teardownDuration);

export const activeEnvironments = new promClient.Gauge({
  name: 'eph_active_environments',
  help: 'Number of active ephemeral environments',
  labelNames: ['status'] as const,
});
register.registerMetric(activeEnvironments);

export const provisioningTotal = new promClient.Counter({
  name: 'eph_provisioning_total',
  help: 'Total number of provisioning attempts',
  labelNames: ['repository', 'result'] as const, // result: success | failure
});
register.registerMetric(provisioningTotal);

export const githubApiCalls = new promClient.Counter({
  name: 'eph_github_api_calls_total',
  help: 'Total GitHub API calls',
  labelNames: ['endpoint', 'status'] as const,
});
register.registerMetric(githubApiCalls);

export const queueSize = new promClient.Gauge({
  name: 'eph_queue_size',
  help: 'Current task queue size',
  labelNames: ['queue', 'status'] as const,
});
register.registerMetric(queueSize);

export { register };
