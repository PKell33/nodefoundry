import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Pino logger configuration for the agent.
 * Matches orchestrator logging format for consistency.
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'agent',
    serverId: process.env.SERVER_ID || 'unknown',
  },
});

export default logger;
