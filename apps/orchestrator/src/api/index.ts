import express from 'express';
import cors from 'cors';
import serversRouter from './routes/servers.js';
import appsRouter from './routes/apps.js';
import systemRouter from './routes/system.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { optionalAuth } from './middleware/auth.js';

export function createApi(): express.Application {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(optionalAuth);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes
  app.use('/api/servers', serversRouter);
  app.use('/api/apps', appsRouter);
  app.use('/api/system', systemRouter);

  // Error handling
  app.use('/api/*', notFoundHandler);
  app.use(errorHandler);

  return app;
}
