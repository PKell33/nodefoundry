import pino from 'pino';
import { config } from '../config.js';

// Create transport options based on environment
const transport = config.isDevelopment
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'HH:MM:ss',
      },
    }
  : undefined;

// Create the base logger
export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isDevelopment ? 'debug' : 'info'),
  transport,
  base: {
    env: config.nodeEnv,
  },
  // Redact sensitive fields
  redact: {
    paths: ['password', 'token', 'accessToken', 'refreshToken', 'authToken', 'secret', 'secretsKey'],
    remove: true,
  },
});

// Create child loggers for different components
export const apiLogger = logger.child({ component: 'api' });
export const wsLogger = logger.child({ component: 'websocket' });
export const dbLogger = logger.child({ component: 'database' });
export const authLogger = logger.child({ component: 'auth' });
export const secretsLogger = logger.child({ component: 'secrets' });

// Request logger middleware
export function createRequestLogger() {
  return (req: any, res: any, next: any) => {
    const start = Date.now();
    const requestId = req.requestId || 'unknown';

    // Log request
    apiLogger.info({
      type: 'request',
      requestId,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Log response on finish
    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      apiLogger[level]({
        type: 'response',
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration,
      });
    });

    next();
  };
}

export default logger;
