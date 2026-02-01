import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { randomUUID } from 'crypto';
import authRouter from './routes/auth.js';
import serversRouter from './routes/servers.js';
import systemRouter from './routes/system.js';
import proxyRouter from './routes/proxy.js';
import agentRouter from './routes/agent.js';
import certificateRouter from './routes/certificate.js';
import commandsRouter from './routes/commands.js';
import mountsRouter from './routes/mounts.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { devBypassAuth, AuthenticatedRequest } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { config } from '../config.js';
import { authService } from '../services/authService.js';
import { createRequestLogger, apiLogger } from '../lib/logger.js';
import { isServerShuttingDown } from '../lib/shutdownState.js';

export function createApi(): express.Application {
  const app = express();

  // Trust proxy for correct IP detection behind reverse proxy
  app.set('trust proxy', 1);

  // Content Security Policy configuration
  const cspDirectives: Record<string, string[] | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for UI components
    imgSrc: ["'self'", 'data:', 'blob:'], // Allow data URIs for icons/images
    fontSrc: ["'self'"],
    connectSrc: ["'self'", 'wss:', 'ws:', ...config.csp.additionalConnectSrc], // WebSocket + custom
    frameSrc: ["'none'"], // Disallow iframes
    objectSrc: ["'none'"], // Disallow plugins
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"], // Only allow embedding from same origin
    upgradeInsecureRequests: config.isDevelopment ? null : [], // Upgrade HTTP to HTTPS in production
  };

  // Add report URI if configured
  if (config.csp.reportUri) {
    cspDirectives.reportUri = [config.csp.reportUri];
  }

  // Security headers with helmet
  app.use(helmet({
    contentSecurityPolicy: {
      directives: cspDirectives,
      reportOnly: config.csp.reportOnly,
    },
    crossOriginEmbedderPolicy: false, // Allow loading resources from different origins
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

  // Stricter rate limit for auth endpoints (login, refresh, TOTP)
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
    skip: (req) => {
      // Skip rate limiting in development
      if (config.isDevelopment) return true;
      // Only rate limit POST requests (login, refresh, totp verify, etc.)
      // GET requests like /status don't need rate limiting
      return req.method !== 'POST';
    },
    // Use IP + username combination to prevent distributed brute force
    keyGenerator: (req) => {
      const username = req.body?.username || 'anonymous';
      // Use the helper for proper IPv6 handling, then append username
      const ipKey = ipKeyGenerator(req.ip || '');
      return `${ipKey}:${username}`;
    },
  });

  // Very strict rate limit for failed login attempts (progressive lockout)
  const loginFailureLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 5, // 5 failed attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'LOGIN_LOCKED',
        message: 'Account temporarily locked due to too many failed attempts. Try again in 1 hour.',
      },
    },
    skip: () => config.isDevelopment,
    // Only count failed attempts (success resets via skipSuccessfulRequests)
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const username = req.body?.username || 'anonymous';
      const ipKey = ipKeyGenerator(req.ip || '');
      return `login:${ipKey}:${username}`;
    },
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

  // Cookie parsing for httpOnly cookie authentication
  app.use(cookieParser());

  // Request logging
  app.use(createRequestLogger());

  // Apply rate limiters
  // Strict limiter for login endpoint (tracks failed attempts)
  app.use('/api/auth/login', loginFailureLimiter, authLimiter);
  // Auth limiter for all auth endpoints (login, setup, refresh, totp)
  app.use('/api/auth', authLimiter);
  // General API limiter for all other endpoints
  app.use('/api', apiLimiter);

  // Health check endpoints (unauthenticated)
  // Simple liveness probe
  app.get('/health', (_req, res) => {
    // Check if server is shutting down
    if (isServerShuttingDown()) {
      res.status(503).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
      return;
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
      // Don't expose internal error details in health check response
      checks.database = { status: 'unhealthy', message: 'Database check failed' };
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
      // Don't expose internal error details in health check response
      checks.agents = { status: 'unhealthy', message: 'Agent check failed' };
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
      // Don't expose internal error details in health check response
      checks.resources = { status: 'unhealthy', message: 'Resource check failed' };
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
  app.use('/api/system', devBypassAuth, systemRouter); // Has both read and write ops, CSRF applied per-route
  app.use('/api/commands', devBypassAuth, commandsRouter); // Read-only, no CSRF needed
  app.use('/api/mounts', devBypassAuth, csrfProtection, mountsRouter);

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
