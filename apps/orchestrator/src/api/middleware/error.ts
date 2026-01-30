import type { Request, Response, NextFunction } from 'express';
import logger from '../../lib/logger.js';

const apiLogger = logger.child({ component: 'api-error' });

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;

  // Log at appropriate level based on status code
  if (statusCode >= 500) {
    apiLogger.error({ err, statusCode }, 'API error');
  } else {
    apiLogger.warn({ err, statusCode }, 'API client error');
  }

  const message = err.message || 'Internal server error';
  const code = err.code || 'INTERNAL_ERROR';

  res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found',
    },
  });
}

export function createError(message: string, statusCode: number, code?: string): ApiError {
  const error: ApiError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
