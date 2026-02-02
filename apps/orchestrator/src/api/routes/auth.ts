import { Router, NextFunction, Response, CookieOptions } from 'express';
import { authService, AuthTokens } from '../../services/authService.js';
import { csrfService } from '../../services/csrfService.js';
import { requireAuth, devBypassAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { validateBody, validateParams, schemas } from '../middleware/validate.js';
import { createError } from '../middleware/error.js';
import { getDb } from '../../db/index.js';
import { CountRow } from '../../db/types.js';
import { authLogger } from '../../lib/logger.js';
import { config } from '../../config.js';

const router = Router();

/**
 * Set authentication cookies (httpOnly for security against XSS).
 */
function setAuthCookies(res: Response, tokens: AuthTokens): void {
  const baseOptions: CookieOptions = {
    httpOnly: config.cookies.httpOnly,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
  };

  // Access token cookie - short-lived, accessible to all API routes
  res.cookie('access_token', tokens.accessToken, {
    ...baseOptions,
    maxAge: config.cookies.accessTokenMaxAge,
    path: '/',
  });

  // Refresh token cookie - longer-lived, restricted to auth endpoints only
  res.cookie('refresh_token', tokens.refreshToken, {
    ...baseOptions,
    maxAge: config.cookies.refreshTokenMaxAge,
    path: config.cookies.refreshTokenPath,
  });
}

/**
 * Clear authentication cookies on logout.
 */
function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: config.cookies.refreshTokenPath });
}

/**
 * POST /api/auth/login
 * Authenticate user and return tokens (or require TOTP if enabled/required)
 */
router.post('/login', validateBody(schemas.auth.login), async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const user = await authService.validateCredentials(username, password);
    if (!user) {
      // Log failed attempt
      logAudit(null, 'login_failed', 'user', username, req.ip, { reason: 'invalid_credentials' });
      throw createError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
    }

    // Check if TOTP is enabled
    const totpEnabled = authService.isTotpEnabled(user.id);
    const totpRequired = authService.userRequiresTotp(user.id);

    if (totpEnabled) {
      // Don't issue tokens yet - require TOTP verification
      return res.json({
        totpRequired: true,
        message: 'TOTP verification required',
      });
    }

    // Check if TOTP is required but not set up
    if (totpRequired && !totpEnabled) {
      // Issue tokens but flag that setup is required
      const tokens = authService.generateTokens(user, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Set httpOnly cookies instead of returning tokens in body
      setAuthCookies(res, tokens);

      logAudit(user.id, 'login', 'user', user.id, req.ip, { totpSetupRequired: true });

      return res.json({
        user: {
          userId: user.id,
          username: user.username,
          isSystemAdmin: !!user.is_system_admin,
          groups: authService.getUserGroups(user.id),
        },
        totpSetupRequired: true,
        expiresIn: tokens.expiresIn,
      });
    }

    const tokens = authService.generateTokens(user, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Set httpOnly cookies instead of returning tokens in body
    setAuthCookies(res, tokens);

    // Log successful login
    logAudit(user.id, 'login', 'user', user.id, req.ip, {});

    res.json({
      user: {
        userId: user.id,
        username: user.username,
        isSystemAdmin: !!user.is_system_admin,
        groups: authService.getUserGroups(user.id),
      },
      expiresIn: tokens.expiresIn,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login/totp
 * Complete login with TOTP code
 */
router.post('/login/totp', validateBody(schemas.auth.loginWithTotp), async (req, res, next) => {
  try {
    const { username, password, totpCode } = req.body;

    const user = await authService.validateCredentials(username, password);
    if (!user) {
      logAudit(null, 'login_failed', 'user', username, req.ip, { reason: 'invalid_credentials' });
      throw createError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
    }

    // Verify TOTP code
    const totpValid = authService.verifyTotpCode(user.id, totpCode);
    if (!totpValid) {
      logAudit(user.id, 'login_failed', 'user', user.id, req.ip, { reason: 'invalid_totp' });
      throw createError('Invalid verification code', 401, 'INVALID_TOTP');
    }

    const tokens = authService.generateTokens(user, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Set httpOnly cookies instead of returning tokens in body
    setAuthCookies(res, tokens);

    logAudit(user.id, 'login', 'user', user.id, req.ip, { totp: true });

    res.json({
      user: {
        userId: user.id,
        username: user.username,
        isSystemAdmin: !!user.is_system_admin,
        groups: authService.getUserGroups(user.id),
      },
      expiresIn: tokens.expiresIn,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token from cookie
 */
router.post('/refresh', async (req, res, next) => {
  try {
    // Get refresh token from cookie (preferred) or body (fallback for backwards compatibility)
    const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;

    if (!refreshToken) {
      throw createError('Refresh token required', 401, 'INVALID_TOKEN');
    }

    const tokens = await authService.refreshAccessToken(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (!tokens) {
      // Clear invalid cookies
      clearAuthCookies(res);
      throw createError('Invalid or expired refresh token', 401, 'INVALID_TOKEN');
    }

    // Set new httpOnly cookies
    setAuthCookies(res, tokens);

    res.json({ expiresIn: tokens.expiresIn });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Revoke refresh token and clear auth cookies
 */
router.post('/logout', async (req, res, next) => {
  try {
    // Get refresh token from cookie (preferred) or body (fallback for backwards compatibility)
    const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;

    if (refreshToken) {
      await authService.revokeRefreshToken(refreshToken);
    }

    // Clear httpOnly auth cookies
    clearAuthCookies(res);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/csrf-token
 * Get a CSRF token for the current user
 * Uses devBypassAuth to allow development testing
 */
router.get('/csrf-token', devBypassAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const csrfToken = csrfService.generateToken(req.user.userId);
    res.json({ csrfToken });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user) {
      throw createError('Not authenticated', 401, 'UNAUTHORIZED');
    }

    const user = authService.getUser(req.user.userId);
    if (!user) {
      throw createError('User not found', 404, 'USER_NOT_FOUND');
    }

    res.json({
      userId: user.id,
      username: user.username,
      isSystemAdmin: !!user.is_system_admin,
      groups: authService.getUserGroups(user.id),
      totpEnabled: user.totp_enabled,
      totpRequired: authService.userRequiresTotp(user.id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/change-password
 * Change current user's password
 */
router.post('/change-password', requireAuth, validateBody(schemas.auth.changePassword), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const success = await authService.changePassword(req.user!.userId, oldPassword, newPassword);
    if (!success) {
      throw createError('Current password is incorrect', 401, 'INVALID_PASSWORD');
    }

    logAudit(req.user!.userId, 'password_changed', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/sessions
 * List all active sessions for current user
 */
router.get('/sessions', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    // Get current token hash from the refresh token in the request body or header
    // Since we don't have the refresh token here, we'll pass undefined
    // The UI will send the current refresh token to identify the current session
    const sessions = authService.getUserSessions(req.user!.userId);
    res.json(sessions);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/sessions/current
 * Get sessions with current session marked (uses refresh token from cookie or body)
 */
router.post('/sessions/current', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    // Get refresh token from cookie (preferred) or body (fallback)
    const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;
    let currentTokenHash: string | undefined;

    if (refreshToken) {
      currentTokenHash = authService.getTokenHashFromRefreshToken(refreshToken);
    }

    const sessions = authService.getUserSessions(req.user!.userId, currentTokenHash);
    res.json(sessions);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session
 */
router.delete('/sessions/:id', requireAuth, validateParams(schemas.idParam), (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const revoked = authService.revokeSession(req.user!.userId, id);

    if (!revoked) {
      throw createError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    logAudit(req.user!.userId, 'session_revoked', 'session', id, req.ip, {});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/sessions/revoke-others
 * Revoke all sessions except the current one
 */
router.post('/sessions/revoke-others', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    // Get refresh token from cookie (preferred) or body (fallback)
    const refreshToken = req.cookies?.refresh_token || req.body?.refreshToken;

    if (!refreshToken) {
      throw createError('Refresh token required to identify current session', 400, 'VALIDATION_ERROR');
    }

    const currentTokenHash = authService.getTokenHashFromRefreshToken(refreshToken);
    const revokedCount = authService.revokeOtherSessions(req.user!.userId, currentTokenHash);

    logAudit(req.user!.userId, 'sessions_revoked', 'session', 'all_others', req.ip, { count: revokedCount });
    res.json({ success: true, revokedCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/sessions/revoke-all
 * Revoke all sessions including the current one (force logout everywhere)
 */
router.post('/sessions/revoke-all', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    await authService.revokeAllUserTokens(req.user!.userId);

    logAudit(req.user!.userId, 'sessions_revoked', 'session', 'all', req.ip, {});
    res.json({ success: true, message: 'All sessions revoked. Please log in again.' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/sessions/active
 * Get the count of active sessions across all users (system admin only)
 */
router.get('/sessions/active', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    // Import dynamically to avoid circular dependencies
    const { getActiveSessionCount } = await import('../../jobs/sessionCleanup.js');

    if (req.user?.isSystemAdmin) {
      // System admin gets total count
      const count = getActiveSessionCount();
      res.json({ activeSessionCount: count });
    } else {
      // Regular user gets their own session count
      const sessions = authService.getUserSessions(req.user!.userId);
      res.json({ activeSessionCount: sessions.length });
    }
  } catch (err) {
    next(err);
  }
});

// ==================
// TOTP Endpoints
// ==================

/**
 * GET /api/auth/totp/status
 * Get TOTP status for current user
 */
router.get('/totp/status', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    const status = authService.getTotpStatus(req.user!.userId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/totp/setup
 * Start TOTP setup - generates secret and QR code
 */
router.post('/totp/setup', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await authService.setupTotp(req.user!.userId);

    logAudit(req.user!.userId, 'totp_setup_started', 'user', req.user!.userId, req.ip, {});

    res.json({
      secret: result.secret,
      qrCode: result.qrCode,
      backupCodes: result.backupCodes,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'TOTP is already enabled') {
      return next(createError('Two-factor authentication is already enabled', 400, 'TOTP_ALREADY_ENABLED'));
    }
    next(err);
  }
});

/**
 * POST /api/auth/totp/verify
 * Verify TOTP code and enable 2FA
 */
router.post('/totp/verify', requireAuth, validateBody(schemas.auth.totpVerify), (req: AuthenticatedRequest, res, next) => {
  try {
    const { code } = req.body;

    const success = authService.verifyAndEnableTotp(req.user!.userId, code);
    if (!success) {
      throw createError('Invalid verification code', 400, 'INVALID_CODE');
    }

    logAudit(req.user!.userId, 'totp_enabled', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true, message: 'Two-factor authentication enabled' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/totp/disable
 * Disable TOTP (requires password, blocked if group requires 2FA)
 */
router.post('/totp/disable', requireAuth, validateBody(schemas.auth.totpDisable), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { password } = req.body;

    const success = await authService.disableTotp(req.user!.userId, password);
    if (!success) {
      throw createError('Invalid password', 401, 'INVALID_PASSWORD');
    }

    logAudit(req.user!.userId, 'totp_disabled', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true, message: 'Two-factor authentication disabled' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot disable 2FA')) {
      return next(createError(err.message, 403, 'TOTP_REQUIRED_BY_GROUP'));
    }
    next(err);
  }
});

/**
 * POST /api/auth/totp/backup-codes
 * Regenerate backup codes
 */
router.post('/totp/backup-codes', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const codes = authService.regenerateBackupCodes(req.user!.userId);
    if (!codes) {
      throw createError('Two-factor authentication is not enabled', 400, 'TOTP_NOT_ENABLED');
    }

    logAudit(req.user!.userId, 'totp_backup_codes_regenerated', 'user', req.user!.userId, req.ip, {});

    res.json({ backupCodes: codes });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/users/:id/totp/reset
 * Admin reset of user's 2FA (system admin only)
 */
router.post('/users/:id/totp/reset', requireAuth, validateParams(schemas.idParam), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;

    // Prevent self-reset via this endpoint (use normal disable for self)
    if (id === req.user.userId) {
      throw createError('Use the disable endpoint to reset your own 2FA', 400, 'CANNOT_RESET_SELF');
    }

    const success = authService.resetTotpForUser(id);
    if (!success) {
      throw createError('User not found', 404, 'USER_NOT_FOUND');
    }

    logAudit(req.user.userId, 'totp_reset_by_admin', 'user', id, req.ip, { targetUserId: id });

    res.json({ success: true, message: 'Two-factor authentication has been reset for the user' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/setup
 * Check if initial setup is needed (no users exist)
 */
router.get('/setup', (_req, res) => {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as CountRow;

  res.json({
    needsSetup: userCount.count === 0,
  });
});

/**
 * POST /api/auth/setup
 * Initial system admin user setup (only works if no users exist)
 */
router.post('/setup', validateBody(schemas.auth.setup), async (req, res, next) => {
  try {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as CountRow;

    if (userCount.count > 0) {
      throw createError('Setup already complete. Users exist.', 403, 'SETUP_COMPLETE');
    }

    const { username, password } = req.body;

    // Create first user as system admin
    // System admins don't need group membership - they have full access
    const userId = await authService.createUser(username, password, true);

    logAudit(userId, 'user_created', 'user', userId, req.ip, { setup: true, isSystemAdmin: true });

    res.status(201).json({
      success: true,
      message: 'System admin user created. You can now log in.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/users
 * List all users (system admin only)
 */
router.get('/users', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const users = authService.listUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/users
 * Create a new user (system admin only)
 */
router.post('/users', requireAuth, validateBody(schemas.auth.createUser), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { username, password, groupId, role } = req.body;

    const userId = await authService.createUser(username, password, false);

    // If group and role specified, add to that group; otherwise already added to default as viewer
    if (groupId && role) {
      // Remove from default group if adding to a different one
      if (groupId !== 'default') {
        authService.removeUserFromGroup(userId, 'default');
      }
      authService.addUserToGroup(userId, groupId, role);
    }

    logAudit(req.user.userId, 'user_created', 'user', userId, req.ip, { username, groupId, role });

    const user = authService.getUser(userId);
    res.status(201).json({
      ...user,
      groups: authService.getUserGroups(userId),
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Username already exists') {
      return next(createError('Username already exists', 409, 'USERNAME_EXISTS'));
    }
    next(err);
  }
});

/**
 * DELETE /api/auth/users/:id
 * Delete a user (system admin only, cannot delete self)
 */
router.delete('/users/:id', requireAuth, validateParams(schemas.idParam), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;

    // Prevent self-deletion
    if (id === req.user.userId) {
      throw createError('Cannot delete your own account', 400, 'CANNOT_DELETE_SELF');
    }

    const user = authService.getUser(id);

    if (!user) {
      throw createError('User not found', 404, 'USER_NOT_FOUND');
    }

    // Revoke all tokens first
    await authService.revokeAllUserTokens(id);

    // Delete the user (cascades to user_groups)
    authService.deleteUser(id);

    logAudit(req.user.userId, 'user_deleted', 'user', id, req.ip, { username: user.username });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ==================
// Group Management Endpoints
// ==================

/**
 * GET /api/auth/groups
 * List all groups (system admin only)
 */
router.get('/groups', requireAuth, (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const groups = authService.listGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/groups
 * Create a new group (system admin only)
 */
router.post('/groups', requireAuth, validateBody(schemas.groups.create), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { name, description, totpRequired } = req.body;

    const groupId = authService.createGroup(name, description, totpRequired || false);

    logAudit(req.user.userId, 'group_created', 'group', groupId, req.ip, { name, totpRequired });

    const group = authService.getGroup(groupId);
    res.status(201).json(group);
  } catch (err) {
    if (err instanceof Error && err.message === 'Group name already exists') {
      return next(createError('Group name already exists', 409, 'GROUP_EXISTS'));
    }
    next(err);
  }
});

/**
 * GET /api/auth/groups/:id
 * Get a specific group with members (system admin only)
 */
router.get('/groups/:id', requireAuth, validateParams(schemas.groupIdParam), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;
    const group = authService.getGroup(id);

    if (!group) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }

    const members = authService.getGroupMembers(id);
    res.json({ ...group, members });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/auth/groups/:id
 * Update a group (system admin only)
 */
router.put('/groups/:id', requireAuth, validateParams(schemas.groupIdParam), validateBody(schemas.groups.update), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;
    const { name, description, totpRequired } = req.body;

    const success = authService.updateGroup(id, { name, description, totpRequired });
    if (!success) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }

    logAudit(req.user.userId, 'group_updated', 'group', id, req.ip, { name, totpRequired });

    const group = authService.getGroup(id);
    res.json(group);
  } catch (err) {
    if (err instanceof Error && err.message === 'Group name already exists') {
      return next(createError('Group name already exists', 409, 'GROUP_EXISTS'));
    }
    next(err);
  }
});

/**
 * DELETE /api/auth/groups/:id
 * Delete a group (system admin only)
 */
router.delete('/groups/:id', requireAuth, validateParams(schemas.groupIdParam), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;

    const group = authService.getGroup(id);
    if (!group) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }

    const success = authService.deleteGroup(id);
    if (!success) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }

    logAudit(req.user.userId, 'group_deleted', 'group', id, req.ip, { name: group.name });

    res.status(204).send();
  } catch (err) {
    if (err instanceof Error && err.message === 'Cannot delete the default group') {
      return next(createError('Cannot delete the default group', 400, 'CANNOT_DELETE_DEFAULT'));
    }
    next(err);
  }
});

// ==================
// User-Group Membership Endpoints
// ==================

/**
 * POST /api/auth/groups/:id/members
 * Add a user to a group (system admin only)
 */
router.post('/groups/:id/members', requireAuth, validateParams(schemas.groupIdParam), validateBody(schemas.groups.addMember), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id: groupId } = req.params;
    const { userId, role } = req.body;

    const group = authService.getGroup(groupId);
    if (!group) {
      throw createError('Group not found', 404, 'GROUP_NOT_FOUND');
    }

    const user = authService.getUser(userId);
    if (!user) {
      throw createError('User not found', 404, 'USER_NOT_FOUND');
    }

    authService.addUserToGroup(userId, groupId, role);

    logAudit(req.user.userId, 'user_added_to_group', 'group', groupId, req.ip, { userId, role });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/auth/groups/:id/members/:userId
 * Update a user's role in a group (system admin only)
 */
router.put('/groups/:id/members/:userId', requireAuth, validateParams(schemas.groupMemberParams), validateBody(schemas.groups.updateMember), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id: groupId, userId } = req.params;
    const { role } = req.body;

    const success = authService.updateUserGroupRole(userId, groupId, role);
    if (!success) {
      throw createError('User is not a member of this group', 404, 'MEMBERSHIP_NOT_FOUND');
    }

    logAudit(req.user.userId, 'user_role_updated', 'group', groupId, req.ip, { userId, role });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/auth/groups/:id/members/:userId
 * Remove a user from a group (system admin only)
 */
router.delete('/groups/:id/members/:userId', requireAuth, validateParams(schemas.groupMemberParams), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id: groupId, userId } = req.params;

    const success = authService.removeUserFromGroup(userId, groupId);
    if (!success) {
      throw createError('User is not a member of this group', 404, 'MEMBERSHIP_NOT_FOUND');
    }

    logAudit(req.user.userId, 'user_removed_from_group', 'group', groupId, req.ip, { userId });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/auth/users/:id/system-admin
 * Set/unset system admin flag (system admin only)
 */
router.put('/users/:id/system-admin', requireAuth, validateParams(schemas.idParam), validateBody(schemas.auth.setSystemAdmin), (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.isSystemAdmin) {
      throw createError('System admin access required', 403, 'FORBIDDEN');
    }

    const { id } = req.params;
    const { isSystemAdmin } = req.body;

    // Prevent removing your own system admin status
    if (id === req.user.userId && !isSystemAdmin) {
      throw createError('Cannot remove your own system admin status', 400, 'CANNOT_DEMOTE_SELF');
    }

    const success = authService.setSystemAdmin(id, !!isSystemAdmin);
    if (!success) {
      throw createError('User not found', 404, 'USER_NOT_FOUND');
    }

    logAudit(req.user.userId, isSystemAdmin ? 'user_promoted_to_admin' : 'user_demoted_from_admin', 'user', id, req.ip, {});

    res.json({ success: true });
  } catch (err) {
    next(err);
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
    authLogger.error({ err }, 'Failed to log audit event');
  }
}

export default router;
