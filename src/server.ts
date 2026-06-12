import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config/index.js';
import { initLogger, logger } from './logger/index.js';
import { correlationIdPlugin } from './middleware/correlation.js';
import { errorHandler } from './middleware/error-handler.js';
import { getQueue, enqueueTask, startWorker, closeQueue } from './queue/index.js';
import { DockerComposeProvider } from './infra/docker/index.js';
import type { InfraProvider } from './infra/provider.js';
import { createSecretProvider } from './secrets/index.js';
import { TraefikRouterProvider } from './router/index.js';
import { createTaskProcessor, getEnvironment, listEnvironments as listEnvRecords } from './lifecycle/index.js';
import { register } from './metrics/index.js';
import { WebhookSignatureError } from './errors/index.js';
import type { EnvironmentListQuery, HealthCheckResponse } from './types/index.js';

const START_TIME = Date.now();

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config);

  logger.info('server.starting', { env: config.APP_ENV, port: config.APP_PORT });

  // ── Initialize providers ──
  const infraProvider: InfraProvider = new DockerComposeProvider(config);
  // Alternate: const infraProvider = new KubernetesProvider({ namespace: 'ephemeral-envs' });
  const secretProvider = createSecretProvider(config);
  const routerProvider = new TraefikRouterProvider(config);

  // ── Fastify server ──
  const app = Fastify({
    requestIdHeader: 'x-correlation-id',
    requestIdLogLabel: 'correlationId',
    disableRequestLogging: false,
    logger: false, // We use our own pino logger
  });

  // ── Security middleware (hardened-shield) ──
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  });

  await app.register(cors, {
    origin: config.APP_ENV === 'production' ? ['https://github.com'] : true,
    methods: ['GET', 'POST'],
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  } as Parameters<typeof rateLimit>[1]);

  // ── Correlation ID middleware ──
  app.addHook('onRequest', correlationIdPlugin);

  // ── Error handler ──
  app.setErrorHandler(errorHandler);

  // ══════════════════════════════════════
  // Routes — /api/v1/
  // ══════════════════════════════════════

  // ── Health Check ──
  app.get('/health', async (_req, reply) => {
    const checks: HealthCheckResponse['checks'] = {};
    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    // Docker check
    const dockerHealth = await infraProvider.healthCheck();
    checks['docker'] = dockerHealth;
    if (dockerHealth.status !== 'healthy') overall = dockerHealth.status === 'degraded' ? 'degraded' : 'unhealthy';

    // Redis check
    try {
      const queue = getQueue(config);
      const start = Date.now();
      await (queue as any).isReady();
      checks['redis'] = { status: 'healthy', latency_ms: Date.now() - start };
    } catch (err) {
      checks['redis'] = { status: 'unhealthy', detail: String(err) };
      overall = 'unhealthy';
    }

    // Secret provider check
    const secretHealth = await secretProvider.healthCheck();
    checks['secrets'] = secretHealth;
    if (secretHealth.status !== 'healthy' && overall === 'healthy') overall = 'degraded';

    // Router check
    const routerHealth = await routerProvider.healthCheck();
    checks['router'] = routerHealth;
    if (routerHealth.status !== 'healthy' && overall === 'healthy') overall = 'degraded';

    const response: HealthCheckResponse = {
      status: overall,
      timestamp: new Date().toISOString(),
      version: config.APP_VERSION,
      uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
      checks,
    };

    const statusCode = overall === 'unhealthy' ? 503 : 200;
    reply.status(statusCode).send(response);
  });

  // ── Webhook endpoint ──
  app.post('/api/v1/webhook/github', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const event = request.headers['x-github-event'] as string;

    // Validate HMAC signature
    const rawBody = JSON.stringify(request.body);
    const { verifyWebhookSignature, parseWebhookEvent, classifyEvent } = await import('./webhook/index.js');

    if (!verifyWebhookSignature(rawBody, signature, config.GITHUB_APP_WEBHOOK_SECRET)) {
      throw new WebhookSignatureError({ event });
    }

    if (event !== 'pull_request') {
      reply.status(200).send({ data: { received: true, message: `Ignoring ${event} event` } });
      return;
    }

    const prEvent = parseWebhookEvent(request.body);
    const action = classifyEvent(prEvent.action);

    if (action === 'ignore') {
      reply.status(200).send({ data: { received: true, message: `Ignoring action: ${prEvent.action}` } });
      return;
    }

    // Enqueue task
    const taskId = await enqueueTask(config, {
      type: action,
      correlationId: request.id,
      prNumber: prEvent.number,
      repository: prEvent.repository.full_name,
      branch: prEvent.pull_request.head.ref,
      sha: prEvent.pull_request.head.sha,
      cloneUrl: prEvent.repository.clone_url,
      installationId: prEvent.installation?.id,
      action: prEvent.action,
    });

    reply.status(202).send({
      data: {
        received: true,
        event,
        action: prEvent.action,
        pr_number: prEvent.number,
        task_type: action,
        task_id: taskId,
      },
    });
  });

  // ── List environments ──
  app.get('/api/v1/environments', async (request, reply) => {
    const query = request.query as EnvironmentListQuery;
    let envs = listEnvRecords();

    if (query.status) envs = envs.filter((e) => e.status === query.status);
    if (query.repository) envs = envs.filter((e) => e.repository === query.repository);

    const page = query.page ?? 1;
    const perPage = query.per_page ?? 20;
    const start = (page - 1) * perPage;
    const paginated = envs.slice(start, start + perPage);

    reply.send({
      data: paginated,
      pagination: {
        total: envs.length,
        page,
        per_page: perPage,
        total_pages: Math.ceil(envs.length / perPage),
        has_next: start + perPage < envs.length,
      },
    });
  });

  // ── Get single environment ──
  app.get<{ Params: { id: string } }>('/api/v1/environments/:id', async (request, reply) => {
    const env = getEnvironment(request.params.id);
    if (!env) {
      reply.status(404).send({ error: { code: 'ENV_NOT_FOUND', message: `Environment '${request.params.id}' not found`, request_id: request.id } });
      return;
    }
    reply.send({ data: env });
  });

  // ── Prometheus metrics ──
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', register.contentType);
    reply.send(await register.metrics());
  });

  // ── Start worker ──
  const processor = createTaskProcessor(config, infraProvider, secretProvider, routerProvider);
  startWorker(config, processor);

  // ── Start server ──
  try {
    await app.listen({ port: config.APP_PORT, host: '0.0.0.0' });
    logger.info('server.started', { port: config.APP_PORT, env: config.APP_ENV });
  } catch (err) {
    logger.error('server.start_failed', { error: String(err) });
    process.exit(1);
  }

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    logger.info('server.shutting_down', { signal });
    await app.close();
    await closeQueue();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
