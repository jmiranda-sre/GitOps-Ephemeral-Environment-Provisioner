import pino from 'pino';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';

let pinoInstance: pino.Logger | null = null;

export function initLogger(config?: AppConfig): pino.Logger {
  const cfg = config ?? loadConfig();
  const isDev = cfg.APP_ENV === 'development';

  pinoInstance = pino({
    level: cfg.APP_LOG_LEVEL,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l' },
      },
    }),
    formatters: {
      level(label) { return { level: label }; },
      bindings(bindings) {
        return { pid: bindings.pid, hostname: bindings.hostname };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  });

  return pinoInstance;
}

export function getLogger(): pino.Logger {
  if (!pinoInstance) initLogger();
  return pinoInstance!;
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => getLogger().debug(ctx ?? {}, msg),
  info: (msg: string, ctx?: Record<string, unknown>) => getLogger().info(ctx ?? {}, msg),
  warn: (msg: string, ctx?: Record<string, unknown>) => getLogger().warn(ctx ?? {}, msg),
  error: (msg: string, ctx?: Record<string, unknown>) => getLogger().error(ctx ?? {}, msg),
  child: (bindings: Record<string, unknown>) => getLogger().child(bindings),
};
