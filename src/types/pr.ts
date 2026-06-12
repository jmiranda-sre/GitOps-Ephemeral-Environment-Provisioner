export interface PullRequestEvent {
  action: 'opened' | 'synchronize' | 'reopened' | 'closed';
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    head: {
      ref: string;
      sha: string;
      repo: { full_name: string; clone_url: string; owner: { login: string } };
    };
    base: {
      ref: string;
      repo: { full_name: string; clone_url: string; owner: { login: string } };
    };
    merged: boolean;
    state: 'open' | 'closed';
  };
  repository: {
    id: number;
    full_name: string;
    name: string;
    owner: { login: string };
    clone_url: string;
  };
  installation?: { id: number };
  sender: { login: string };
}

export interface EnvironmentConfig {
  prNumber: number;
  repository: string;
  branch: string;
  sha: string;
  cloneUrl: string;
  projectName: string;
  domain: string;
  networkName: string;
  composeFile: string;
  envVars: Record<string, string>;
  resourceLimits: ResourceLimits;
}

export interface ResourceLimits {
  cpu: string;
  memory: string;
}

export type EnvironmentStatus = 'pending' | 'provisioning' | 'running' | 'failed' | 'hibernated' | 'tearing_down' | 'destroyed';

export interface EnvironmentRecord {
  id: string;
  prNumber: number;
  repository: string;
  branch: string;
  sha: string;
  status: EnvironmentStatus;
  url: string;
  projectName: string;
  networkName: string;
  createdAt: string;
  updatedAt: string;
  deploymentId?: number;
  containerIds: string[];
  volumeNames: string[];
}

export interface ProvisionResult {
  success: boolean;
  environment: EnvironmentRecord;
  error?: string;
  durationMs: number;
}

export interface TeardownResult {
  success: boolean;
  environmentId: string;
  error?: string;
  durationMs: number;
}
