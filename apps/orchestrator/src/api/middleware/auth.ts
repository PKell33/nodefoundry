import type { Request, Response, NextFunction } from 'express';
import { authService, TokenPayload } from '../../services/authService.js';
import { config } from '../../config.js';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
  requestId?: string;
}

/**
 * Extract token from Authorization header
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Require authentication - returns 401 if no valid token
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // If user is already set (e.g., by devBypassAuth), proceed
  if (req.user) {
    next();
    return;
  }

  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  const payload = authService.verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      },
    });
    return;
  }

  req.user = payload;
  next();
}

/**
 * Optional authentication - sets user if valid token, continues anyway
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);

  if (token) {
    const payload = authService.verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}

/**
 * Require system admin
 */
export function requireSystemAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    return;
  }

  if (!req.user.isSystemAdmin) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
    return;
  }

  next();
}

/**
 * Role constants for permission checks
 */
export const Roles = {
  ADMIN: 'admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
} as const;

/**
 * Permission levels - which roles can do what
 */
export const Permissions = {
  // Full access (deploy, delete, user management)
  MANAGE: [Roles.ADMIN],
  // Can start/stop/restart but not deploy or delete
  OPERATE: [Roles.ADMIN, Roles.OPERATOR],
  // Read only
  VIEW: [Roles.ADMIN, Roles.OPERATOR, Roles.VIEWER],
} as const;

/**
 * Development mode bypass - allows unauthenticated access in development
 * WARNING: Only use for routes that should be accessible during development
 */
export function devBypassAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // In development, allow unauthenticated access but still try to authenticate
  if (config.isDevelopment) {
    const token = extractToken(req);
    if (token) {
      const payload = authService.verifyAccessToken(token);
      if (payload) {
        req.user = payload;
      }
    }

    // If no user set, create a dev user context
    if (!req.user) {
      req.user = {
        userId: 'dev-user',
        username: 'developer',
        isSystemAdmin: true,
      };
    }

    next();
    return;
  }

  // In production, require auth
  requireAuth(req, res, next);
}
