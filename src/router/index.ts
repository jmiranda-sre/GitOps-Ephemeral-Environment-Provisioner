import type { AppConfig } from '../config/index.js';
import { logger } from '../logger/index.js';

export interface RouterProvider {
  registerRoute(prNumber: number, projectName: string, domain: string, targetUrl: string): Promise<void>;
  removeRoute(prNumber: number, projectName: string): Promise<void>;
  healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }>;
}

/**
 * Traefik dynamic configuration provider via API.
 * Leverages Traefik's file provider or API for dynamic route registration.
 */
export class TraefikRouterProvider implements RouterProvider {
  private apiUrl: string;
  private entryPoint: string;
  private certResolver?: string;

  constructor(config: AppConfig) {
    this.apiUrl = config.TRAEFIK_API_URL;
    this.entryPoint = config.TRAEFIK_ENTRY_POINT;
    this.certResolver = config.TRAEFIK_CERT_RESOLVER;
  }

  async registerRoute(prNumber: number, projectName: string, domain: string, targetUrl: string): Promise<void> {
    logger.info('router.register_route', { prNumber, projectName, domain, targetUrl });

    const config = {
      http: {
        routers: {
          [`${projectName}-router`]: {
            rule: `Host(\`${domain}\`)`,
            service: `${projectName}-service`,
            entryPoints: [this.entryPoint],
            ...(this.certResolver && { tls: { certResolver: this.certResolver } }),
          },
        },
        services: {
          [`${projectName}-service`]: {
            loadBalancer: { servers: [{ url: targetUrl }] },
          },
        },
      },
    };

    // Push dynamic config to Traefik via API
    try {
      const response = await fetch(`${this.apiUrl}/api/http/routers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        logger.warn('router.traefik_api_warning', { status: response.status, projectName });
      }
    } catch (error) {
      logger.warn('router.traefik_register_failed', { projectName, error: String(error) });
    }

    // Fallback: write dynamic config file for Traefik file provider
    const configDir = '/etc/traefik/dynamic';
    try {
      const fs = await import('node:fs');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(`${configDir}/${projectName}.json`, JSON.stringify(config, null, 2));
    } catch {
      logger.warn('router.traefik_file_write_failed', { projectName });
    }
  }

  async removeRoute(_prNumber: number, projectName: string): Promise<void> {
    logger.info('router.remove_route', { projectName });

    // Remove via API
    try {
      await fetch(`${this.apiUrl}/api/http/routers/${projectName}-router`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best-effort */ }

    // Remove config file
    const configDir = '/etc/traefik/dynamic';
    try {
      const fs = await import('node:fs');
      fs.unlinkSync(`${configDir}/${projectName}.json`);
    } catch { /* best-effort */ }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; latency_ms: number; detail?: string }> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.apiUrl}/api/overview`, { signal: AbortSignal.timeout(3000) });
      return { status: response.ok ? 'healthy' : 'degraded', latency_ms: Date.now() - start };
    } catch {
      return { status: 'degraded', latency_ms: Date.now() - start, detail: 'Traefik API unreachable' };
    }
  }
}

/**
 * Build ephemeral environment domain from PR number and base domain.
 */
export function buildEnvDomain(prNumber: number, baseDomain: string): string {
  return `pr-${prNumber}.${baseDomain}`;
}
