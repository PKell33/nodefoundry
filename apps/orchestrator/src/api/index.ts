import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import authRouter from './routes/auth.js';
import serversRouter from './routes/servers.js';
import appsRouter from './routes/apps.js';
import deploymentsRouter from './routes/deployments.js';
import servicesRouter from './routes/services.js';
import systemRouter from './routes/system.js';
import proxyRouter from './routes/proxy.js';
import auditRouter from './routes/audit.js';
import agentRouter from './routes/agent.js';
import certificateRouter from './routes/certificate.js';
import commandsRouter from './routes/commands.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { devBypassAuth, AuthenticatedRequest } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { config } from '../config.js';
import { authService } from '../services/authService.js';
import { createRequestLogger, apiLogger } from '../lib/logger.js';

export function createApi(): express.Application {
  const app = express();

  // Trust proxy for correct IP detection behind reverse proxy
  app.set('trust proxy', 1);

  // Security headers with helmet
  app.use(helmet({
    contentSecurityPolicy: config.isDevelopment ? false : undefined,
    crossOriginEmbedderPolicy: false, // Allow embedding in iframes for app UIs
  }));

  // Request ID middleware for tracing
  app.use((req: AuthenticatedRequest, _res, next) => {
    req.requestId = req.headers['x-request-id'] as string || randomUUID();
    next();
  });

  // Rate limiting - general API limiter
  const apiLimiter = rateLimit({
    windowMs: config.security.rateLimitWindow,
    max: config.security.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later',
      },
    },
    skip: () => config.isDevelopment, // Skip rate limiting in development
  });

  // Stricter rate limit for auth endpoints
  const authLimiter = rateLimit({
    windowMs: config.security.rateLimitWindow,
    max: config.security.authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts, please try again later',
      },
    },
    skip: () => config.isDevelopment,
  });

  // CORS configuration
  const corsOptions: cors.CorsOptions = {
    origin: config.isDevelopment ? true : config.cors.origin || false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-CSRF-Token'],
  };
  app.use(cors(corsOptions));

  // Body parsing
  app.use(express.json({ limit: '1mb' }));

  // Request logging
  app.use(createRequestLogger());

  // Apply rate limiters
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/setup', authLimiter);
  app.use('/api', apiLimiter);

  // Health check endpoints (unauthenticated)
  // Simple liveness probe
  app.get('/health', async (_req, res) => {
    // Check if server is shutting down
    try {
      const { isServerShuttingDown } = await import('../index.js');
      if (isServerShuttingDown()) {
        res.status(503).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
        return;
      }
    } catch {
      // Ignore import errors during startup
    }
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Comprehensive readiness probe
  app.get('/ready', async (_req, res) => {
    const checks: Record<string, { status: string; message?: string; latency?: number }> = {};
    let allHealthy = true;

    // Check database
    try {
      const start = Date.now();
      const { getDb } = await import('../db/index.js');
      const db = getDb();
      db.prepare('SELECT 1').get();
      checks.database = { status: 'healthy', latency: Date.now() - start };
    } catch (err) {
      checks.database = { status: 'unhealthy', message: err instanceof Error ? err.message : 'Unknown error' };
      allHealthy = false;
    }

    // Check connected agents
    try {
      const { getConnectedAgents } = await import('../websocket/agentHandler.js');
      const connectedAgents = getConnectedAgents();
      const agentCount = connectedAgents.size;
      const agentIds = Array.from(connectedAgents.keys());
      checks.agents = {
        status: 'healthy',
        message: `${agentCount} agent(s) connected: ${agentIds.join(', ') || 'none'}`,
      };
    } catch (err) {
      checks.agents = { status: 'unhealthy', message: err instanceof Error ? err.message : 'Unknown error' };
      allHealthy = false;
    }

    // Check resource usage (mutex maps) for memory leak detection
    try {
      const { mutexManager } = await import('../lib/mutexManager.js');
      const stats = mutexManager.getStats();
      checks.resources = {
        status: 'healthy',
        message: `Mutexes: ${stats.serverMutexes} servers, ${stats.deploymentMutexes} deployments`,
      };
    } catch (err) {
      checks.resources = { status: 'unhealthy', message: err instanceof Error ? err.message : 'Unknown error' };
    }

    const status = allHealthy ? 200 : 503;
    res.status(status).json({
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // Auth routes (some unauthenticated)
  app.use('/api/auth', authRouter);

  // Agent install script (unauthenticated for remote server bootstrap)
  app.use('/agent', agentRouter);

  // Proxy routes (unauthenticated for local Caddy integration)
  app.use('/api/proxy-routes', proxyRouter);

  // Certificate routes (unauthenticated - needed before users can trust the site)
  app.use('/api/certificate', certificateRouter);

  // Protected API routes - use devBypassAuth for development convenience, csrfProtection for CSRF defense
  app.use('/api/servers', devBypassAuth, csrfProtection, serversRouter);
  app.use('/api/apps', devBypassAuth, appsRouter); // Read-only, no CSRF needed
  app.use('/api/deployments', devBypassAuth, csrfProtection, deploymentsRouter);
  app.use('/api/services', devBypassAuth, servicesRouter); // Read-only, no CSRF needed
  app.use('/api/system', devBypassAuth, systemRouter); // Read-only, no CSRF needed
  app.use('/api/audit-logs', devBypassAuth, auditRouter); // Read-only, no CSRF needed
  app.use('/api/commands', devBypassAuth, commandsRouter); // Read-only, no CSRF needed

  // Error handling
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Initialize API services
 */
export async function initializeApi(): Promise<void> {
  // Ensure default user exists in development
  await authService.ensureDefaultUser();
}
