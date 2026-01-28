import type { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
  session?: {
    valid: boolean;
    userId?: string;
  };
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // For Phase 1, auth is not implemented
  // All requests are allowed
  req.session = { valid: true };
  next();
}

export function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  // For Phase 1, set session as valid
  req.session = { valid: true };
  next();
}
