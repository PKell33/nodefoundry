import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';

/**
 * Middleware factory for validating request body with Zod schemas
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: err.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        });
        return;
      }
      next(err);
    }
  };
}

/**
 * Middleware factory for validating request params with Zod schemas
 */
export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params) as typeof req.params;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request parameters',
            details: err.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        });
        return;
      }
      next(err);
    }
  };
}

/**
 * Middleware factory for validating query parameters with Zod schemas
 */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query) as typeof req.query;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: err.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        });
        return;
      }
      next(err);
    }
  };
}

// ===============================
// Common Validation Schemas
// ===============================

// UUID pattern for IDs
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const schemas = {
  // Common ID param
  idParam: z.object({
    id: z.string().regex(uuidPattern, 'Invalid ID format'),
  }),

  // Server name param
  serverNameParam: z.object({
    id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Server ID must be lowercase alphanumeric with hyphens'),
  }),

  // App name param
  appNameParam: z.object({
    name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'App name must be lowercase alphanumeric with hyphens'),
  }),

  // Auth schemas
  auth: {
    login: z.object({
      username: z.string().min(1, 'Username is required').max(50),
      password: z.string().min(1, 'Password is required'),
    }),

    setup: z.object({
      username: z.string()
        .min(3, 'Username must be at least 3 characters')
        .max(50)
        .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
      password: z.string()
        .min(8, 'Password must be at least 8 characters')
        .max(100),
    }),

    changePassword: z.object({
      oldPassword: z.string().min(1, 'Old password is required'),
      newPassword: z.string()
        .min(8, 'New password must be at least 8 characters')
        .max(100),
    }),

    refresh: z.object({
      refreshToken: z.string().min(1, 'Refresh token is required'),
    }),

    createUser: z.object({
      username: z.string()
        .min(3, 'Username must be at least 3 characters')
        .max(50)
        .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
      password: z.string()
        .min(8, 'Password must be at least 8 characters')
        .max(100),
      role: z.enum(['admin', 'viewer']).optional().default('viewer'),
    }),
  },

  // Server schemas
  servers: {
    create: z.object({
      name: z.string()
        .min(1, 'Name is required')
        .max(50)
        .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens'),
      host: z.string()
        .min(1, 'Host is required')
        .max(255)
        .regex(/^[a-zA-Z0-9.-]+$/, 'Invalid host format'),
    }),

    update: z.object({
      name: z.string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens')
        .optional(),
      host: z.string()
        .min(1)
        .max(255)
        .regex(/^[a-zA-Z0-9.-]+$/, 'Invalid host format')
        .optional(),
    }),
  },

  // Deployment schemas
  deployments: {
    create: z.object({
      serverId: z.string().min(1, 'Server ID is required'),
      appName: z.string()
        .min(1, 'App name is required')
        .regex(/^[a-z0-9-]+$/, 'App name must be lowercase alphanumeric with hyphens'),
      config: z.record(z.unknown()).optional().default({}),
      version: z.string().optional(),
    }),

    update: z.object({
      config: z.record(z.unknown()),
    }),

    validate: z.object({
      serverId: z.string().min(1, 'Server ID is required'),
      appName: z.string()
        .min(1, 'App name is required')
        .regex(/^[a-z0-9-]+$/, 'App name must be lowercase alphanumeric with hyphens'),
    }),
  },
};
