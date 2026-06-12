import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { AppConfig } from '../config/index.js';
import { logger } from '../logger/index.js';
import { queueSize } from '../metrics/index.js';

export type TaskType = 'provision' | 'teardown';

export interface TaskPayload {
  type: TaskType;
  correlationId: string;
  prNumber: number;
  repository: string;
  branch: string;
  sha: string;
  cloneUrl: string;
  installationId?: number;
  action: string;
}

let connection: IORedis | null = null;
let taskQueue: Queue<TaskPayload> | null = null;
let worker: Worker<TaskPayload> | null = null;

function getConnection(config: AppConfig): ConnectionOptions {
  if (!connection) {
    connection = new IORedis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
      db: config.REDIS_DB,
      maxRetriesPerRequest: null,
    });
    connection.on('error', (err) => logger.error('redis.connection_error', { error: err.message }));
  }
  return connection as unknown as ConnectionOptions;
}

export function getQueue(config: AppConfig): Queue<TaskPayload> {
  if (!taskQueue) {
    const conn = getConnection(config);
    taskQueue = new Queue<TaskPayload>('ephemeral-env-tasks', { connection: conn });
    logger.info('queue.initialized', { host: config.REDIS_HOST, port: config.REDIS_PORT });
  }
  return taskQueue!;
}

export async function enqueueTask(config: AppConfig, payload: TaskPayload): Promise<string> {
  const queue = getQueue(config);
  const jobId = `pr-${payload.prNumber}-${payload.type}-${Date.now()}`;
  const job = await queue.add(jobId, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
    jobId,
  });
  logger.info('task.enqueued', { jobId, type: payload.type, prNumber: payload.prNumber, correlationId: payload.correlationId });
  return job.id ?? jobId;
}

export function startWorker(
  config: AppConfig,
  processor: (job: Job<TaskPayload>) => Promise<void>,
): Worker<TaskPayload> {
  const conn = getConnection(config);
  worker = new Worker<TaskPayload>('ephemeral-env-tasks', processor, {
    connection: conn,
    concurrency: config.MAX_CONCURRENT_ENVS,
    limiter: { max: 5, duration: 10000 },
  });

  worker.on('completed', (job) => {
    logger.info('task.completed', { jobId: job.id, correlationId: job.data.correlationId });
    updateQueueMetrics(config);
  });

  worker.on('failed', (job, err) => {
    logger.error('task.failed', {
      jobId: job?.id,
      error: err.message,
      correlationId: job?.data?.correlationId,
    });
    updateQueueMetrics(config);
  });

  return worker;
}

async function updateQueueMetrics(config: AppConfig): Promise<void> {
  try {
    const queue = getQueue(config);
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    queueSize.set({ queue: 'ephemeral-env-tasks', status: 'waiting' }, waiting);
    queueSize.set({ queue: 'ephemeral-env-tasks', status: 'active' }, active);
    queueSize.set({ queue: 'ephemeral-env-tasks', status: 'completed' }, completed);
    queueSize.set({ queue: 'ephemeral-env-tasks', status: 'failed' }, failed);
  } catch { /* metric update is best-effort */ }
}

export async function closeQueue(): Promise<void> {
  if (worker) await worker.close();
  if (taskQueue) await taskQueue.close();
  if (connection) await connection.quit();
  worker = null;
  taskQueue = null;
  connection = null;
}
