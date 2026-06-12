import Docker from 'dockerode';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { InfraProvider } from '../provider.js';
import type { EnvironmentConfig, EnvironmentRecord, ProvisionResult, TeardownResult } from '../../types/index.js';
import { EnvironmentProvisionError, EnvironmentTeardownError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import { provisioningDuration, teardownDuration, provisioningTotal, activeEnvironments } from '../../metrics/index.js';
import type { AppConfig } from '../../config/index.js';

const WORKSPACE_BASE = '/tmp/eph-envs';

export class DockerComposeProvider implements InfraProvider {
  readonly name = 'docker-compose';
  private docker: Docker;

  constructor(private config: AppConfig) {
    this.docker = new Docker({ socketPath: config.DOCKER_SOCKET });
  }

  async provision(envConfig: EnvironmentConfig): Promise<ProvisionResult> {
    const start = Date.now();
    const timer = provisioningDuration.startTimer({ repository: envConfig.repository, provider: this.name });

    try {
      logger.info('docker.provision_start', {
        prNumber: envConfig.prNumber,
        repository: envConfig.repository,
        projectName: envConfig.projectName,
      });

      // ── Step 1: Create isolated workspace ──
      const workspaceDir = path.join(WORKSPACE_BASE, envConfig.projectName);
      fs.mkdirSync(workspaceDir, { recursive: true });

      // ── Step 2: Clone repository ──
      const cloneBranch = envConfig.branch;
      const cloneCmd = `git clone --branch ${cloneBranch} --depth 1 ${envConfig.cloneUrl} ${workspaceDir}/repo`;
      try {
        execSync(cloneCmd, { timeout: 60000, stdio: 'pipe' });
      } catch {
        // Fallback: clone all then checkout
        execSync(`git clone --depth 50 ${envConfig.cloneUrl} ${workspaceDir}/repo`, { timeout: 120000, stdio: 'pipe' });
        execSync(`git -C ${workspaceDir}/repo checkout ${cloneBranch}`, { timeout: 10000, stdio: 'pipe' });
      }

      // ── Step 3: Verify docker-compose.yml exists ──
      const composeFile = path.join(workspaceDir, 'repo', envConfig.composeFile);
      if (!fs.existsSync(composeFile)) {
        throw new EnvironmentProvisionError(
          `No ${envConfig.composeFile} found in repository ${envConfig.repository}`,
          { repository: envConfig.repository, composeFile: envConfig.composeFile },
        );
      }

      // ── Step 4: Create isolated Docker network ──
      const networkName = envConfig.networkName;
      try {
        await this.docker.createNetwork({ Name: networkName, Labels: { 'eph-env': 'true', 'eph-pr': String(envConfig.prNumber) } });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('already exists')) throw err;
        logger.warn('docker.network_exists', { networkName });
      }

      // ── Step 5: Write .env file with secrets injected ──
      const envFilePath = path.join(workspaceDir, 'repo', '.env.ephemeral');
      const envContent = Object.entries(envConfig.envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      fs.writeFileSync(envFilePath, envContent, { mode: 0o600 });

      // ── Step 6: Run docker-compose with project name and traefik labels ──
      const composeCmd = [
        'docker compose',
        `-p ${envConfig.projectName}`,
        `--env-file ${envFilePath}`,
        `-f ${composeFile}`,
        'up -d',
        '--remove-orphans',
      ].join(' ');

      const result = spawnSync('sh', ['-c', composeCmd], {
        cwd: path.join(workspaceDir, 'repo'),
        timeout: 300000,
        env: {
          ...process.env,
          PR_NUMBER: String(envConfig.prNumber),
          EPH_ENV_DOMAIN: envConfig.domain,
          TRAEFIK_ROUTER: `${envConfig.projectName}-router`,
          COMPOSE_PROJECT_NAME: envConfig.projectName,
        },
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      if (result.status !== 0) {
        const stderr = result.stderr ?? 'Unknown docker compose error';
        throw new EnvironmentProvisionError(`docker compose up failed: ${stderr}`, {
          prNumber: envConfig.prNumber,
          stderr,
        });
      }

      // ── Step 7: Get container IDs for tracking ──
      const containers = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`com.docker.compose.project=${envConfig.projectName}`] }),
      });
      const containerIds = containers.map((c) => c.Id);

      // ── Step 8: Apply resource limits ──
      for (const containerId of containerIds) {
        try {
          const container = this.docker.getContainer(containerId);
          await container.update({
            Memory: this.parseMemoryLimit(envConfig.resourceLimits.memory),
            NanoCpus: this.parseCpuLimit(envConfig.resourceLimits.cpu),
          });
        } catch (err) {
          logger.warn('docker.resource_limit_failed', { containerId, error: String(err) });
        }
      }

      const environment: EnvironmentRecord = {
        id: uuidv4(),
        prNumber: envConfig.prNumber,
        repository: envConfig.repository,
        branch: envConfig.branch,
        sha: envConfig.sha,
        status: 'running',
        url: `https://${envConfig.domain}`,
        projectName: envConfig.projectName,
        networkName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        containerIds,
        volumeNames: [],
      };

      const durationMs = Date.now() - start;
      timer();
      provisioningTotal.inc({ repository: envConfig.repository, result: 'success' });
      activeEnvironments.inc({ status: 'running' });

      logger.info('docker.provision_success', {
        prNumber: envConfig.prNumber,
        url: environment.url,
        containerCount: containerIds.length,
        durationMs,
      });

      return { success: true, environment, durationMs };
    } catch (error) {
      const durationMs = Date.now() - start;
      timer();
      provisioningTotal.inc({ repository: envConfig.repository, result: 'failure' });
      const msg = error instanceof Error ? error.message : 'Unknown provision error';
      logger.error('docker.provision_failed', { prNumber: envConfig.prNumber, error: msg, durationMs });
      return {
        success: false,
        environment: {
          id: uuidv4(),
          prNumber: envConfig.prNumber,
          repository: envConfig.repository,
          branch: envConfig.branch,
          sha: envConfig.sha,
          status: 'failed',
          url: '',
          projectName: envConfig.projectName,
          networkName: envConfig.networkName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          containerIds: [],
          volumeNames: [],
        },
        error: msg,
        durationMs,
      };
    }
  }

  async teardown(environment: EnvironmentRecord): Promise<TeardownResult> {
    const start = Date.now();
    const timer = teardownDuration.startTimer({ repository: environment.repository, provider: this.name });

    try {
      logger.info('docker.teardown_start', {
        environmentId: environment.id,
        projectName: environment.projectName,
        prNumber: environment.prNumber,
      });

      const workspaceDir = path.join(WORKSPACE_BASE, environment.projectName);

      // ── Step 1: Stop and remove compose project (idempotent) ──
      const composeFile = path.join(workspaceDir, 'repo', this.config.DOCKER_COMPOSE_PATH);
      if (fs.existsSync(composeFile)) {
        const downCmd = [
          'docker compose',
          `-p ${environment.projectName}`,
          `-f ${composeFile}`,
          'down -v --remove-orphans --timeout 30',
        ].join(' ');

        const result = spawnSync('sh', ['-c', downCmd], {
          cwd: path.join(workspaceDir, 'repo'),
          timeout: 120000,
          stdio: 'pipe',
          encoding: 'utf-8',
        });

        if (result.status !== 0) {
          logger.warn('docker.compose_down_warning', { stderr: result.stderr });
        }
      }

      // ── Step 2: Force-remove any orphaned containers ──
      const remainingContainers = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`com.docker.compose.project=${environment.projectName}`] }),
      });
      for (const c of remainingContainers) {
        try {
          const container = this.docker.getContainer(c.Id);
          await container.remove({ force: true });
        } catch { /* best-effort cleanup */ }
      }

      // ── Step 3: Remove Docker network ──
      try {
        const network = this.docker.getNetwork(environment.networkName);
        await network.remove();
      } catch { /* network may not exist */ }

      // ── Step 4: Remove workspace ──
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch { /* best-effort */ }

      // ── Step 5: Remove associated volumes ──
      const volumes = await this.docker.listVolumes({
        filters: JSON.stringify({ label: [`com.docker.compose.project=${environment.projectName}`] }),
      });
      for (const v of (volumes.Volumes ?? [])) {
        try {
          await this.docker.getVolume(v.Name).remove();
        } catch { /* best-effort */ }
      }

      const durationMs = Date.now() - start;
      timer();
      activeEnvironments.dec({ status: 'running' });

      logger.info('docker.teardown_success', {
        environmentId: environment.id,
        prNumber: environment.prNumber,
        durationMs,
      });

      return { success: true, environmentId: environment.id, durationMs };
    } catch (error) {
      const durationMs = Date.now() - start;
      timer();
      const msg = error instanceof Error ? error.message : 'Unknown teardown error';
      logger.error('docker.teardown_failed', {
        environmentId: environment.id,
        error: msg,
        durationMs,
      });
      throw new EnvironmentTeardownError(msg, { environmentId: environment.id, durationMs });
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }> {
    const start = Date.now();
    try {
      await this.docker.ping();
      return { status: 'healthy', latency_ms: Date.now() - start };
    } catch (err) {
      return { status: 'unhealthy', latency_ms: Date.now() - start, detail: String(err) };
    }
  }

  async listEnvironments(): Promise<string[]> {
    const projects = new Set<string>();
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ['eph-env=true'] }),
    });
    for (const c of containers) {
      const project = c.Labels?.['com.docker.compose.project'];
      if (project) projects.add(project);
    }
    return [...projects];
  }

  async getStatus(projectName: string): Promise<'running' | 'stopped' | 'not_found'> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`com.docker.compose.project=${projectName}`] }),
    });
    if (containers.length === 0) return 'not_found';
    const running = containers.some((c) => c.State === 'running');
    return running ? 'running' : 'stopped';
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(m|g|k)?$/i);
    if (!match) return 512 * 1024 * 1024; // default 512m
    const val = parseInt(match[1]!, 10);
    const unit = (match[2] ?? 'm').toLowerCase();
    const multipliers: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
    return val * (multipliers[unit] ?? 1024 * 1024);
  }

  private parseCpuLimit(limit: string): number {
    const cpus = parseFloat(limit);
    return isNaN(cpus) ? 500_000_000 : Math.round(cpus * 1_000_000_000);
  }
}
