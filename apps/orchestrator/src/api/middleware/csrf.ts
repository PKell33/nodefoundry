import { Response, NextFunction } from 'express';
import { csrfService } from '../../services/csrfService.js';
import { AuthenticatedRequest } from './auth.js';

const CSRF_HEADER = 'X-CSRF-Token';

// Methods that don't require CSRF protection
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * CSRF protection middleware.
 *
 * Validates X-CSRF-Token header on state-changing requests (POST, PUT, DELETE).
 * GET, HEAD, and OPTIONS requests are exempt.
 *
 * Must be applied AFTER authentication middleware since it relies on req.user.
 */
export function csrfProtection(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Skip safe methods
  if (SAFE_METHODS.includes(req.method)) {
    next();
    return;
  }

  // Skip if user is not authenticated (will fail auth anyway)
  if (!req.user) {
    next();
    return;
  }

  // Get CSRF token from header
  const token = req.headers[CSRF_HEADER.toLowerCase()] as string | undefined;

  if (!token) {
    res.status(403).json({
      error: {
        code: 'MISSING_CSRF_TOKEN',
        message: 'CSRF token is required for this request',
      },
    });
    return;
  }

  // Validate token
  if (!csrfService.validateToken(token, req.user.userId)) {
    res.status(403).json({
      error: {
        code: 'INVALID_CSRF_TOKEN',
        message: 'Invalid or expired CSRF token',
      },
    });
    return;
  }

  next();
}
