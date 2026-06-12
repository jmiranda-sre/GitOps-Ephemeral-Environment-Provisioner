import type { Job } from 'bullmq';
import type { AppConfig } from '../config/index.js';
import type { InfraProvider } from '../infra/provider.js';
import type { SecretProvider } from '../secrets/index.js';
import type { RouterProvider } from '../router/index.js';
import type { EnvironmentConfig, EnvironmentRecord } from '../types/index.js';
import type { TaskPayload } from '../queue/index.js';
import { EnvironmentLimitError } from '../errors/index.js';
import { logger } from '../logger/index.js';
import {
  getOctokit,
  createDeployment,
  updateDeploymentStatus,
  postPrComment,
  findPreviousComment,
  updatePrComment,
  buildProvisionComment,
  buildTeardownComment,
  COMMENT_MARKER,
} from '../github/index.js';
import { buildEnvDomain } from '../router/index.js';

/**
 * In-memory store for environment records. Production: replace with Redis/DB.
 */
const environments = new Map<string, EnvironmentRecord>();

export function getEnvironment(id: string): EnvironmentRecord | undefined {
  return environments.get(id);
}

export function listEnvironments(): EnvironmentRecord[] {
  return [...environments.values()];
}

export function findEnvironmentByPr(prNumber: number, repository: string): EnvironmentRecord | undefined {
  return listEnvironments().find((e) => e.prNumber === prNumber && e.repository === repository);
}

/**
 * Main lifecycle orchestrator.
 * Processes provision and teardown tasks from the queue.
 */
export function createTaskProcessor(
  config: AppConfig,
  infraProvider: InfraProvider,
  secretProvider: SecretProvider,
  routerProvider: RouterProvider,
) {
  return async function processTask(job: Job<TaskPayload>): Promise<void> {
    const { type, correlationId, prNumber, repository, branch, sha, cloneUrl, installationId } = job.data;
    const logCtx = { correlationId, prNumber, repository, type };

    logger.info('lifecycle.task_start', logCtx);

    const parts = repository.split('/');
    const owner = parts[0] ?? '';
    const repo = parts[1] ?? '';

    try {
      if (type === 'provision') {
        await handleProvision(config, infraProvider, secretProvider, routerProvider, {
          prNumber, repository, branch, sha, cloneUrl, installationId, owner, repo, correlationId,
        });
      } else if (type === 'teardown') {
        await handleTeardown(config, infraProvider, routerProvider, {
          prNumber, repository, owner, repo, correlationId,
        });
      }
    } catch (error) {
      logger.error('lifecycle.task_error', { ...logCtx, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}

async function handleProvision(
  config: AppConfig,
  infraProvider: InfraProvider,
  secretProvider: SecretProvider,
  routerProvider: RouterProvider,
  ctx: {
    prNumber: number; repository: string; branch: string; sha: string;
    cloneUrl: string; installationId?: number; owner: string; repo: string; correlationId: string;
  },
): Promise<void> {
  const { prNumber, repository, branch, sha, cloneUrl, owner, repo, installationId, correlationId } = ctx;

  // ── Check concurrent environment limit ──
  const activeCount = listEnvironments().filter((e) => e.status === 'running').length;
  if (activeCount >= config.MAX_CONCURRENT_ENVS) {
    throw new EnvironmentLimitError(config.MAX_CONCURRENT_ENVS, { prNumber, activeCount });
  }

  const domain = buildEnvDomain(prNumber, config.APP_BASE_DOMAIN);
  const projectName = `eph-pr-${prNumber}`;
  const networkName = `${config.DOCKER_NETWORK_PREFIX}pr-${prNumber}`;

  // ── Create GitHub deployment (pending) ──
  await getOctokit(config, installationId);
  let deploymentId: number | undefined;
  try {
    deploymentId = await createDeployment(config, owner, repo, sha, `pr-${prNumber}`);
    await updateDeploymentStatus(config, owner, repo, deploymentId, 'pending', undefined, undefined);
  } catch (err) {
    logger.warn('lifecycle.deployment_create_failed', { error: String(err) });
  }

  // ── Load secrets ──
  const secrets = await secretProvider.getAllSecrets(config.VAULT_SECRET_PATH);
  const envVars: Record<string, string> = {
    ...secrets,
    PR_NUMBER: String(prNumber),
    EPH_ENV_URL: `https://${domain}`,
    EPH_BRANCH: branch,
    EPH_SHA: sha,
  };

  // ── Provision infrastructure ──
  const envConfig: EnvironmentConfig = {
    prNumber,
    repository,
    branch,
    sha,
    cloneUrl,
    projectName,
    domain,
    networkName,
    composeFile: config.DOCKER_COMPOSE_PATH,
    envVars,
    resourceLimits: { cpu: config.ENV_CPU_LIMIT, memory: config.ENV_MEMORY_LIMIT },
  };

  const result = await infraProvider.provision(envConfig);

  if (result.success) {
    result.environment.deploymentId = deploymentId;
    environments.set(result.environment.id, result.environment);

    // ── Register route ──
    await routerProvider.registerRoute(prNumber, projectName, domain, `http://${projectName}-app:80`);

    // ── Update GitHub deployment status ──
    if (deploymentId) {
      await updateDeploymentStatus(config, owner, repo, deploymentId, 'success', `https://${domain}`);
    }

    // ── Post/update PR comment ──
    const comment = buildProvisionComment(prNumber, 'running', `https://${domain}`, result.durationMs, sha);
    const existingComment = await findPreviousComment(config, owner, repo, prNumber, COMMENT_MARKER);
    if (existingComment) {
      await updatePrComment(config, owner, repo, existingComment, comment);
    } else {
      await postPrComment(config, owner, repo, prNumber, comment);
    }

    logger.info('lifecycle.provision_success', { prNumber, url: `https://${domain}`, durationMs: result.durationMs, correlationId });
  } else {
    // ── Update deployment as failed ──
    if (deploymentId) {
      await updateDeploymentStatus(config, owner, repo, deploymentId, 'failure');
    }

    const failComment = buildProvisionComment(prNumber, 'failed', '', result.durationMs ?? 0, sha);
    await postPrComment(config, owner, repo, prNumber, failComment);

    logger.error('lifecycle.provision_failed', { prNumber, error: result.error, correlationId });
  }
}

async function handleTeardown(
  config: AppConfig,
  infraProvider: InfraProvider,
  routerProvider: RouterProvider,
  ctx: {
    prNumber: number; repository: string; owner: string; repo: string; correlationId: string;
  },
): Promise<void> {
  const { prNumber, repository, owner, repo, correlationId } = ctx;

  // ── Find environment record ──
  const env = findEnvironmentByPr(prNumber, repository);
  if (!env) {
    logger.warn('lifecycle.teardown_env_not_found', { prNumber, repository, correlationId });
    return; // Idempotent: no env = nothing to teardown
  }

  env.status = 'tearing_down';
  environments.set(env.id, env);

  // ── Remove route ──
  await routerProvider.removeRoute(prNumber, env.projectName);

  // ── Update GitHub deployment ──
  if (env.deploymentId) {
    await updateDeploymentStatus(config, owner, repo, env.deploymentId, 'inactive');
  }

  // ── Teardown infrastructure ──
  const result = await infraProvider.teardown(env);

  if (result.success) {
    env.status = 'destroyed';
    environments.delete(env.id);
  } else {
    env.status = 'failed';
  }

  // ── Post teardown comment ──
  const comment = buildTeardownComment(prNumber);
  await postPrComment(config, owner, repo, prNumber, comment);

  logger.info('lifecycle.teardown_complete', { prNumber, success: result.success, durationMs: result.durationMs, correlationId });
}
