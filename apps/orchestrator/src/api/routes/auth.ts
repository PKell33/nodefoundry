import { Router } from 'express';
import { authService } from '../../services/authService.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { validateBody, schemas } from '../middleware/validate.js';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';

const router = Router();

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 */
router.post('/login', validateBody(schemas.auth.login), async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await authService.validateCredentials(username, password);
    if (!user) {
      // Log failed attempt
      logAudit(null, 'login_failed', 'user', username, req.ip, { reason: 'invalid_credentials' });

      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password',
        },
      });
    }

    const tokens = authService.generateTokens(user, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Log successful login
    logAudit(user.id, 'login', 'user', user.id, req.ip, {});

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      ...tokens,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Login failed',
      },
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', validateBody(schemas.auth.refresh), async (req, res) => {
  try {
    const { refreshToken } = req.body;

    const tokens = await authService.refreshAccessToken(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!tokens) {
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired refresh token',
        },
      });
    }

    res.json(tokens);
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Token refresh failed',
      },
    });
  }
});

/**
 * POST /api/auth/logout
 * Revoke refresh token
 */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await authService.revokeRefreshToken(refreshToken);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Logout failed',
      },
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      },
    });
  }

  const user = authService.getUser(req.user.userId);
  if (!user) {
    return res.status(404).json({
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      },
    });
  }

  res.json(user);
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
router.post('/change-password', requireAuth, validateBody(schemas.auth.changePassword), async (req: AuthenticatedRequest, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const success = await authService.changePassword(req.user!.userId, oldPassword, newPassword);
    if (!success) {
      return res.status(401).json({
        error: {
          code: 'INVALID_PASSWORD',
          message: 'Current password is incorrect',
        },
      });
    }

    logAudit(req.user!.userId, 'password_changed', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Password change failed',
      },
    });
  }
});

/**
 * GET /api/auth/sessions
 * List all active sessions for current user
 */
router.get('/sessions', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    // Get current token hash from the refresh token in the request body or header
    // Since we don't have the refresh token here, we'll pass undefined
    // The UI will send the current refresh token to identify the current session
    const sessions = authService.getUserSessions(req.user!.userId);
    res.json(sessions);
  } catch (err) {
    console.error('Get sessions error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get sessions',
      },
    });
  }
});

/**
 * POST /api/auth/sessions/current
 * Get sessions with current session marked (requires refresh token in body)
 */
router.post('/sessions/current', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const { refreshToken } = req.body;
    let currentTokenHash: string | undefined;

    if (refreshToken) {
      currentTokenHash = authService.getTokenHashFromRefreshToken(refreshToken);
    }

    const sessions = authService.getUserSessions(req.user!.userId, currentTokenHash);
    res.json(sessions);
  } catch (err) {
    console.error('Get sessions error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get sessions',
      },
    });
  }
});

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session
 */
router.delete('/sessions/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const revoked = authService.revokeSession(req.user!.userId, id);

    if (!revoked) {
      return res.status(404).json({
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found',
        },
      });
    }

    logAudit(req.user!.userId, 'session_revoked', 'session', id, req.ip, {});
    res.json({ success: true });
  } catch (err) {
    console.error('Revoke session error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to revoke session',
      },
    });
  }
});

/**
 * POST /api/auth/sessions/revoke-others
 * Revoke all sessions except the current one
 */
router.post('/sessions/revoke-others', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: {
          code: 'MISSING_TOKEN',
          message: 'Current refresh token required',
        },
      });
    }

    const currentTokenHash = authService.getTokenHashFromRefreshToken(refreshToken);
    const revokedCount = authService.revokeOtherSessions(req.user!.userId, currentTokenHash);

    logAudit(req.user!.userId, 'sessions_revoked', 'session', 'all_others', req.ip, { count: revokedCount });
    res.json({ success: true, revokedCount });
  } catch (err) {
    console.error('Revoke other sessions error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to revoke sessions',
      },
    });
  }
});

/**
 * POST /api/auth/setup
 * Initial admin user setup (only works if no users exist)
 */
router.post('/setup', validateBody(schemas.auth.setup), async (req, res) => {
  try {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };

    if (userCount.count > 0) {
      return res.status(403).json({
        error: {
          code: 'SETUP_COMPLETE',
          message: 'Setup already complete. Users exist.',
        },
      });
    }

    const { username, password } = req.body;

    const userId = await authService.createUser(username, password, 'admin');

    logAudit(userId, 'user_created', 'user', userId, req.ip, { setup: true });

    res.status(201).json({
      success: true,
      message: 'Admin user created. You can now log in.',
    });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Setup failed',
      },
    });
  }
});

/**
 * GET /api/auth/users
 * List all users (admin only)
 */
router.get('/users', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required',
      },
    });
  }

  const users = authService.listUsers();
  res.json(users);
});

/**
 * POST /api/auth/users
 * Create a new user (admin only)
 */
router.post('/users', requireAuth, validateBody(schemas.auth.createUser), async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required',
      },
    });
  }

  try {
    const { username, password, role } = req.body;

    const userId = await authService.createUser(username, password, role || 'viewer');

    logAudit(req.user.userId, 'user_created', 'user', userId, req.ip, { username, role });

    const user = authService.getUser(userId);
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof Error && err.message === 'Username already exists') {
      return res.status(409).json({
        error: {
          code: 'USERNAME_EXISTS',
          message: 'Username already exists',
        },
      });
    }
    console.error('Create user error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create user',
      },
    });
  }
});

/**
 * DELETE /api/auth/users/:id
 * Delete a user (admin only, cannot delete self)
 */
router.delete('/users/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required',
      },
    });
  }

  const { id } = req.params;

  // Prevent self-deletion
  if (id === req.user.userId) {
    return res.status(400).json({
      error: {
        code: 'CANNOT_DELETE_SELF',
        message: 'Cannot delete your own account',
      },
    });
  }

  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as { id: string; username: string } | undefined;

    if (!user) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
      });
    }

    // Revoke all tokens first
    await authService.revokeAllUserTokens(id);

    // Delete the user
    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    logAudit(req.user.userId, 'user_deleted', 'user', id, req.ip, { username: user.username });

    res.status(204).send();
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete user',
      },
    });
  }
});

/**
 * Helper to log audit events
 */
function logAudit(
  userId: string | null,
  action: string,
  resourceType: string,
  resourceId: string,
  ipAddress: string | undefined,
  details: Record<string, unknown>
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip_address, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, action, resourceType, resourceId, ipAddress || null, JSON.stringify(details));
  } catch (err) {
    console.error('Failed to log audit event:', err);
  }
}

export default router;
