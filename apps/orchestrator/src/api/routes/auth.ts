import { Router } from 'express';
import { authService } from '../../services/authService.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { validateBody, schemas } from '../middleware/validate.js';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';

const router = Router();

/**
 * POST /api/auth/login
 * Authenticate user and return tokens (or require TOTP if enabled/required)
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

      logAudit(user.id, 'login', 'user', user.id, req.ip, { totpSetupRequired: true });

      return res.json({
        user: {
          userId: user.id,
          username: user.username,
          isSystemAdmin: !!user.is_system_admin,
          groups: authService.getUserGroups(user.id),
        },
        totpSetupRequired: true,
        ...tokens,
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
        userId: user.id,
        username: user.username,
        isSystemAdmin: !!user.is_system_admin,
        groups: authService.getUserGroups(user.id),
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
 * POST /api/auth/login/totp
 * Complete login with TOTP code
 */
router.post('/login/totp', validateBody(schemas.auth.loginWithTotp), async (req, res) => {
  try {
    const { username, password, totpCode } = req.body;

    const user = await authService.validateCredentials(username, password);
    if (!user) {
      logAudit(null, 'login_failed', 'user', username, req.ip, { reason: 'invalid_credentials' });

      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid username or password',
        },
      });
    }

    // Verify TOTP code
    const totpValid = authService.verifyTotpCode(user.id, totpCode);
    if (!totpValid) {
      logAudit(user.id, 'login_failed', 'user', user.id, req.ip, { reason: 'invalid_totp' });

      return res.status(401).json({
        error: {
          code: 'INVALID_TOTP',
          message: 'Invalid verification code',
        },
      });
    }

    const tokens = authService.generateTokens(user, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    logAudit(user.id, 'login', 'user', user.id, req.ip, { totp: true });

    res.json({
      user: {
        userId: user.id,
        username: user.username,
        isSystemAdmin: !!user.is_system_admin,
        groups: authService.getUserGroups(user.id),
      },
      ...tokens,
    });
  } catch (err) {
    console.error('TOTP login error:', err);
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

  res.json({
    userId: user.id,
    username: user.username,
    isSystemAdmin: !!user.is_system_admin,
    groups: authService.getUserGroups(user.id),
    totpEnabled: user.totp_enabled,
    totpRequired: authService.userRequiresTotp(user.id),
  });
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

// ==================
// TOTP Endpoints
// ==================

/**
 * GET /api/auth/totp/status
 * Get TOTP status for current user
 */
router.get('/totp/status', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const status = authService.getTotpStatus(req.user!.userId);
    res.json(status);
  } catch (err) {
    console.error('Get TOTP status error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get TOTP status',
      },
    });
  }
});

/**
 * POST /api/auth/totp/setup
 * Start TOTP setup - generates secret and QR code
 */
router.post('/totp/setup', requireAuth, async (req: AuthenticatedRequest, res) => {
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
      return res.status(400).json({
        error: {
          code: 'TOTP_ALREADY_ENABLED',
          message: 'Two-factor authentication is already enabled',
        },
      });
    }
    console.error('TOTP setup error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to setup TOTP',
      },
    });
  }
});

/**
 * POST /api/auth/totp/verify
 * Verify TOTP code and enable 2FA
 */
router.post('/totp/verify', requireAuth, validateBody(schemas.auth.totpVerify), (req: AuthenticatedRequest, res) => {
  try {
    const { code } = req.body;

    const success = authService.verifyAndEnableTotp(req.user!.userId, code);
    if (!success) {
      return res.status(400).json({
        error: {
          code: 'INVALID_CODE',
          message: 'Invalid verification code',
        },
      });
    }

    logAudit(req.user!.userId, 'totp_enabled', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true, message: 'Two-factor authentication enabled' });
  } catch (err) {
    console.error('TOTP verify error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to verify TOTP',
      },
    });
  }
});

/**
 * POST /api/auth/totp/disable
 * Disable TOTP (requires password, blocked if group requires 2FA)
 */
router.post('/totp/disable', requireAuth, validateBody(schemas.auth.totpDisable), async (req: AuthenticatedRequest, res) => {
  try {
    const { password } = req.body;

    const success = await authService.disableTotp(req.user!.userId, password);
    if (!success) {
      return res.status(401).json({
        error: {
          code: 'INVALID_PASSWORD',
          message: 'Invalid password',
        },
      });
    }

    logAudit(req.user!.userId, 'totp_disabled', 'user', req.user!.userId, req.ip, {});

    res.json({ success: true, message: 'Two-factor authentication disabled' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot disable 2FA')) {
      return res.status(403).json({
        error: {
          code: 'TOTP_REQUIRED_BY_GROUP',
          message: err.message,
        },
      });
    }
    console.error('TOTP disable error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to disable TOTP',
      },
    });
  }
});

/**
 * POST /api/auth/totp/backup-codes
 * Regenerate backup codes
 */
router.post('/totp/backup-codes', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const codes = authService.regenerateBackupCodes(req.user!.userId);
    if (!codes) {
      return res.status(400).json({
        error: {
          code: 'TOTP_NOT_ENABLED',
          message: 'Two-factor authentication is not enabled',
        },
      });
    }

    logAudit(req.user!.userId, 'totp_backup_codes_regenerated', 'user', req.user!.userId, req.ip, {});

    res.json({ backupCodes: codes });
  } catch (err) {
    console.error('Regenerate backup codes error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to regenerate backup codes',
      },
    });
  }
});

/**
 * POST /api/auth/users/:id/totp/reset
 * Admin reset of user's 2FA (system admin only)
 */
router.post('/users/:id/totp/reset', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  const { id } = req.params;

  // Prevent self-reset via this endpoint (use normal disable for self)
  if (id === req.user.userId) {
    return res.status(400).json({
      error: {
        code: 'CANNOT_RESET_SELF',
        message: 'Use the disable endpoint to reset your own 2FA',
      },
    });
  }

  try {
    const success = authService.resetTotpForUser(id);
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
      });
    }

    logAudit(req.user.userId, 'totp_reset_by_admin', 'user', id, req.ip, { targetUserId: id });

    res.json({ success: true, message: 'Two-factor authentication has been reset for the user' });
  } catch (err) {
    console.error('Admin TOTP reset error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to reset 2FA',
      },
    });
  }
});

/**
 * POST /api/auth/setup
 * Initial system admin user setup (only works if no users exist)
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

    // Create first user as system admin
    // System admins don't need group membership - they have full access
    const userId = await authService.createUser(username, password, true);

    logAudit(userId, 'user_created', 'user', userId, req.ip, { setup: true, isSystemAdmin: true });

    res.status(201).json({
      success: true,
      message: 'System admin user created. You can now log in.',
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
 * List all users (system admin only)
 */
router.get('/users', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  const users = authService.listUsers();
  res.json(users);
});

/**
 * POST /api/auth/users
 * Create a new user (system admin only)
 */
router.post('/users', requireAuth, validateBody(schemas.auth.createUser), async (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
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
 * Delete a user (system admin only, cannot delete self)
 */
router.delete('/users/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
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
    const user = authService.getUser(id);

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

    // Delete the user (cascades to user_groups)
    authService.deleteUser(id);

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

// ==================
// Group Management Endpoints
// ==================

/**
 * GET /api/auth/groups
 * List all groups (system admin only)
 */
router.get('/groups', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  const groups = authService.listGroups();
  res.json(groups);
});

/**
 * POST /api/auth/groups
 * Create a new group (system admin only)
 */
router.post('/groups', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { name, description, totpRequired } = req.body;

    if (!name || typeof name !== 'string' || name.length < 2) {
      return res.status(400).json({
        error: {
          code: 'INVALID_NAME',
          message: 'Group name must be at least 2 characters',
        },
      });
    }

    const groupId = authService.createGroup(name, description, totpRequired || false);

    logAudit(req.user.userId, 'group_created', 'group', groupId, req.ip, { name, totpRequired });

    const group = authService.getGroup(groupId);
    res.status(201).json(group);
  } catch (err) {
    if (err instanceof Error && err.message === 'Group name already exists') {
      return res.status(409).json({
        error: {
          code: 'GROUP_EXISTS',
          message: 'Group name already exists',
        },
      });
    }
    console.error('Create group error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create group',
      },
    });
  }
});

/**
 * GET /api/auth/groups/:id
 * Get a specific group with members (system admin only)
 */
router.get('/groups/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  const { id } = req.params;
  const group = authService.getGroup(id);

  if (!group) {
    return res.status(404).json({
      error: {
        code: 'GROUP_NOT_FOUND',
        message: 'Group not found',
      },
    });
  }

  const members = authService.getGroupMembers(id);
  res.json({ ...group, members });
});

/**
 * PUT /api/auth/groups/:id
 * Update a group (system admin only)
 */
router.put('/groups/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { id } = req.params;
    const { name, description, totpRequired } = req.body;

    const success = authService.updateGroup(id, { name, description, totpRequired });
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    }

    logAudit(req.user.userId, 'group_updated', 'group', id, req.ip, { name, totpRequired });

    const group = authService.getGroup(id);
    res.json(group);
  } catch (err) {
    if (err instanceof Error && err.message === 'Group name already exists') {
      return res.status(409).json({
        error: {
          code: 'GROUP_EXISTS',
          message: 'Group name already exists',
        },
      });
    }
    console.error('Update group error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update group',
      },
    });
  }
});

/**
 * DELETE /api/auth/groups/:id
 * Delete a group (system admin only)
 */
router.delete('/groups/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { id } = req.params;

    const group = authService.getGroup(id);
    if (!group) {
      return res.status(404).json({
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    }

    const success = authService.deleteGroup(id);
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    }

    logAudit(req.user.userId, 'group_deleted', 'group', id, req.ip, { name: group.name });

    res.status(204).send();
  } catch (err) {
    if (err instanceof Error && err.message === 'Cannot delete the default group') {
      return res.status(400).json({
        error: {
          code: 'CANNOT_DELETE_DEFAULT',
          message: 'Cannot delete the default group',
        },
      });
    }
    console.error('Delete group error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete group',
      },
    });
  }
});

// ==================
// User-Group Membership Endpoints
// ==================

/**
 * POST /api/auth/groups/:id/members
 * Add a user to a group (system admin only)
 */
router.post('/groups/:id/members', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { id: groupId } = req.params;
    const { userId, role } = req.body;

    if (!userId || !role || !['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'userId and role (admin/operator/viewer) are required',
        },
      });
    }

    const group = authService.getGroup(groupId);
    if (!group) {
      return res.status(404).json({
        error: {
          code: 'GROUP_NOT_FOUND',
          message: 'Group not found',
        },
      });
    }

    const user = authService.getUser(userId);
    if (!user) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
      });
    }

    authService.addUserToGroup(userId, groupId, role);

    logAudit(req.user.userId, 'user_added_to_group', 'group', groupId, req.ip, { userId, role });

    res.json({ success: true });
  } catch (err) {
    console.error('Add user to group error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to add user to group',
      },
    });
  }
});

/**
 * PUT /api/auth/groups/:id/members/:userId
 * Update a user's role in a group (system admin only)
 */
router.put('/groups/:id/members/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { id: groupId, userId } = req.params;
    const { role } = req.body;

    if (!role || !['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ROLE',
          message: 'Role must be admin, operator, or viewer',
        },
      });
    }

    const success = authService.updateUserGroupRole(userId, groupId, role);
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'MEMBERSHIP_NOT_FOUND',
          message: 'User is not a member of this group',
        },
      });
    }

    logAudit(req.user.userId, 'user_role_updated', 'group', groupId, req.ip, { userId, role });

    res.json({ success: true });
  } catch (err) {
    console.error('Update user role error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update user role',
      },
    });
  }
});

/**
 * DELETE /api/auth/groups/:id/members/:userId
 * Remove a user from a group (system admin only)
 */
router.delete('/groups/:id/members/:userId', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  try {
    const { id: groupId, userId } = req.params;

    const success = authService.removeUserFromGroup(userId, groupId);
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'MEMBERSHIP_NOT_FOUND',
          message: 'User is not a member of this group',
        },
      });
    }

    logAudit(req.user.userId, 'user_removed_from_group', 'group', groupId, req.ip, { userId });

    res.status(204).send();
  } catch (err) {
    console.error('Remove user from group error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to remove user from group',
      },
    });
  }
});

/**
 * PUT /api/auth/users/:id/system-admin
 * Set/unset system admin flag (system admin only)
 */
router.put('/users/:id/system-admin', requireAuth, (req: AuthenticatedRequest, res) => {
  if (!req.user?.isSystemAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'System admin access required',
      },
    });
  }

  const { id } = req.params;
  const { isSystemAdmin } = req.body;

  // Prevent removing your own system admin status
  if (id === req.user.userId && !isSystemAdmin) {
    return res.status(400).json({
      error: {
        code: 'CANNOT_DEMOTE_SELF',
        message: 'Cannot remove your own system admin status',
      },
    });
  }

  try {
    const success = authService.setSystemAdmin(id, !!isSystemAdmin);
    if (!success) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        },
      });
    }

    logAudit(req.user.userId, isSystemAdmin ? 'user_promoted_to_admin' : 'user_demoted_from_admin', 'user', id, req.ip, {});

    res.json({ success: true });
  } catch (err) {
    console.error('Set system admin error:', err);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update system admin status',
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
