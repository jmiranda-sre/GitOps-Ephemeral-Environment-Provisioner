import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'node:fs';
import type { AppConfig } from '../config/index.js';
import { GitHubApiError } from '../errors/index.js';
import { logger } from '../logger/index.js';
import { githubApiCalls } from '../metrics/index.js';
import type { EnvironmentStatus } from '../types/index.js';

let octokitInstance: Octokit | null = null;

function readPrivateKey(config: AppConfig): string {
  try {
    return fs.readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
  } catch {
    throw new GitHubApiError('Cannot read GitHub App private key', { path: config.GITHUB_APP_PRIVATE_KEY_PATH });
  }
}

export async function getOctokit(config: AppConfig, installationId?: number): Promise<Octokit> {
  if (octokitInstance && !installationId) return octokitInstance;

  const privateKey = readPrivateKey(config);

  const auth = installationId
    ? { id: config.GITHUB_APP_ID, privateKey, installationId }
    : { id: config.GITHUB_APP_ID, privateKey };

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth,
    request: { timeout: 10000 },
  });

  if (!installationId) octokitInstance = octokit;
  return octokit;
}

export async function createDeployment(
  config: AppConfig,
  owner: string,
  repo: string,
  ref: string,
  environment: string,
): Promise<number> {
  const octokit = await getOctokit(config);

  try {
    const { data } = await octokit.rest.repos.createDeployment({
      owner,
      repo,
      ref,
      environment,
      payload: { ephemeral: true },
      production_environment: false,
      description: `Ephemeral environment for PR`,
    });
    githubApiCalls.inc({ endpoint: 'createDeployment', status: 'success' });
    return (data as { id: number }).id;
  } catch (error) {
    githubApiCalls.inc({ endpoint: 'createDeployment', status: 'error' });
    const msg = error instanceof Error ? error.message : 'Deployment creation failed';
    logger.error('github.create_deployment_failed', { owner, repo, ref, error: msg });
    throw new GitHubApiError(msg, { owner, repo, ref });
  }
}

export async function updateDeploymentStatus(
  config: AppConfig,
  owner: string,
  repo: string,
  deploymentId: number,
  state: 'pending' | 'success' | 'failure' | 'error' | 'inactive',
  environmentUrl?: string,
  logUrl?: string,
): Promise<void> {
  const octokit = await getOctokit(config);

  try {
    await octokit.rest.repos.createDeploymentStatus({
      owner,
      repo,
      deployment_id: deploymentId,
      state,
      environment_url: environmentUrl,
      log_url: logUrl,
      description: `Ephemeral env ${state}`,
    });
    githubApiCalls.inc({ endpoint: 'createDeploymentStatus', status: 'success' });
  } catch (error) {
    githubApiCalls.inc({ endpoint: 'createDeploymentStatus', status: 'error' });
    const msg = error instanceof Error ? error.message : 'Status update failed';
    logger.warn('github.deployment_status_failed', { deploymentId, state, error: msg });
  }
}

export async function postPrComment(
  config: AppConfig,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = await getOctokit(config);

  try {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    githubApiCalls.inc({ endpoint: 'createComment', status: 'success' });
  } catch (error) {
    githubApiCalls.inc({ endpoint: 'createComment', status: 'error' });
    const msg = error instanceof Error ? error.message : 'Comment failed';
    logger.warn('github.post_comment_failed', { owner, repo, prNumber, error: msg });
  }
}

export async function findPreviousComment(
  config: AppConfig,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
): Promise<number | null> {
  const octokit = await getOctokit(config);

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const found = comments.find((c) => c.body?.includes(marker));
    return found ? found.id : null;
  } catch (error) {
    logger.warn('github.find_comment_failed', { prNumber, error: String(error) });
    return null;
  }
}

export async function updatePrComment(
  config: AppConfig,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = await getOctokit(config);

  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    githubApiCalls.inc({ endpoint: 'updateComment', status: 'success' });
  } catch (error) {
    logger.warn('github.update_comment_failed', { commentId, error: String(error) });
  }
}

// ── Comment templates ──
const COMMENT_MARKER = '<!-- eph-env-bot -->';

export function buildProvisionComment(
  prNumber: number,
  status: EnvironmentStatus,
  url: string,
  durationMs: number,
  sha: string,
): string {
  const statusEmoji: Record<string, string> = {
    running: '🟢',
    provisioning: '🟡',
    failed: '🔴',
    hibernated: '💤',
  };
  const emoji = statusEmoji[status] ?? '⚪';
  const duration = (durationMs / 1000).toFixed(1);

  return `${COMMENT_MARKER}
## ${emoji} Ephemeral Environment

| Detail | Value |
|--------|-------|
| **Status** | ${status} |
| **URL** | [${url}](${url}) |
| **PR** | #${prNumber} |
| **SHA** | \`${sha.substring(0, 7)}\` |
| **Provision Time** | ${duration}s |

_This environment will be automatically cleaned up when the PR is closed or merged._
`;
}

export function buildTeardownComment(prNumber: number): string {
  return `${COMMENT_MARKER}
## ⚫ Ephemeral Environment Teardown

Environment for PR #${prNumber} has been fully cleaned up.

_All containers, volumes, and network resources have been removed._
`;
}

export { COMMENT_MARKER };
