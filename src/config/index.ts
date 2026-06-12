import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  APP_PORT: z.coerce.number().default(3000),
  APP_VERSION: z.string().default('0.1.0'),
  APP_BASE_DOMAIN: z.string().default('pr.localhost'),
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  GITHUB_APP_ID: z.coerce.number(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(32),
  GITHUB_APP_INSTALLATION_ID: z.coerce.number().optional(),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),

  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_COMPOSE_PATH: z.string().default('docker-compose.yml'),
  DOCKER_NETWORK_PREFIX: z.string().default('eph-'),

  TRAEFIK_API_URL: z.string().default('http://localhost:8080'),
  TRAEFIK_ENTRY_POINT: z.string().default('http'),
  TRAEFIK_CERT_RESOLVER: z.string().optional(),

  SECRET_PROVIDER: z.enum(['env', 'vault']).default('env'),
  VAULT_ADDR: z.string().default('http://localhost:8200'),
  VAULT_TOKEN: z.string().optional(),
  VAULT_SECRET_PATH: z.string().default('ephemeral-env'),

  MAX_CONCURRENT_ENVS: z.coerce.number().default(10),
  ENV_CPU_LIMIT: z.string().default('0.5'),
  ENV_MEMORY_LIMIT: z.string().default('512m'),
  ENV_TTL_SECONDS: z.coerce.number().default(86400),
  ENV_HIBERNATE_AFTER_SECONDS: z.coerce.number().default(3600),

  METRICS_ENABLED: z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
  METRICS_PORT: z.coerce.number().default(9090),
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Config validation failed: ${errors}`);
  }
  cachedConfig = result.data;
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
