import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID, createHash, randomBytes } from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_system_admin: boolean;
  totp_secret: string | null;
  totp_enabled: boolean;
  backup_codes: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  totp_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserGroupRow {
  user_id: string;
  group_id: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: string;
}

export interface UserGroupMembership {
  groupId: string;
  groupName: string;
  role: 'admin' | 'operator' | 'viewer';
  totpRequired: boolean;
}

export interface TotpSetupResult {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
  last_used_at: string | null;
}

export interface SessionInfo {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}

export interface SessionMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenPayload {
  userId: string;
  username: string;
  isSystemAdmin: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

class AuthService {
  private getJwtSecret(): string {
    if (!config.jwt.secret) {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    return config.jwt.secret;
  }

  async createUser(username: string, password: string, isSystemAdmin: boolean = false): Promise<string> {
    const db = getDb();

    // Check if user exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      throw new Error('Username already exists');
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, is_system_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, username, passwordHash, isSystemAdmin ? 1 : 0);

    // Add non-system-admin users to default group as viewer
    // System admins have full access and don't need group membership
    if (!isSystemAdmin) {
      this.addUserToGroup(id, 'default', 'viewer');
    }

    return id;
  }

  async validateCredentials(username: string, password: string): Promise<UserRow | null> {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;

    if (!user) {
      // Prevent timing attacks by still doing a hash comparison
      await bcrypt.compare(password, '$2a$12$invalid.hash.to.prevent.timing.attacks');
      return null;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return null;
    }

    // Update last login
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    return user;
  }

  generateTokens(user: UserRow, sessionMeta?: SessionMetadata): AuthTokens {
    const payload: TokenPayload = {
      userId: user.id,
      username: user.username,
      isSystemAdmin: user.is_system_admin,
    };

    const accessToken = jwt.sign(payload, this.getJwtSecret(), {
      expiresIn: config.jwt.accessTokenExpiry as jwt.SignOptions['expiresIn'],
    });

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      this.getJwtSecret(),
      { expiresIn: config.jwt.refreshTokenExpiry as jwt.SignOptions['expiresIn'] }
    );

    // Store refresh token hash with session metadata
    this.storeRefreshToken(user.id, refreshToken, sessionMeta);

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
    };
  }

  private storeRefreshToken(userId: string, token: string, sessionMeta?: SessionMetadata): void {
    const db = getDb();
    const id = randomUUID();
    const tokenHash = this.hashToken(token);

    // Parse expiry from JWT
    const decoded = jwt.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000).toISOString();

    db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, ip_address, user_agent, last_used_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, userId, tokenHash, expiresAt, sessionMeta?.ipAddress || null, sessionMeta?.userAgent || null);

    // Clean up old tokens for this user (keep last 10 sessions)
    db.prepare(`
      DELETE FROM refresh_tokens
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
      )
    `).run(userId, userId);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  verifyAccessToken(token: string): TokenPayload | null {
    try {
      const payload = jwt.verify(token, this.getJwtSecret()) as TokenPayload;
      return payload;
    } catch {
      return null;
    }
  }

  async refreshAccessToken(refreshToken: string, sessionMeta?: SessionMetadata): Promise<AuthTokens | null> {
    const db = getDb();

    // Verify the refresh token
    let decoded: { userId: string; type: string };
    try {
      decoded = jwt.verify(refreshToken, this.getJwtSecret()) as { userId: string; type: string };
      if (decoded.type !== 'refresh') {
        return null;
      }
    } catch {
      return null;
    }

    // Check if token is in database
    const tokenHash = this.hashToken(refreshToken);
    const storedToken = db.prepare(`
      SELECT * FROM refresh_tokens
      WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash) as RefreshTokenRow | undefined;

    if (!storedToken) {
      return null;
    }

    // Get user
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as UserRow | undefined;
    if (!user) {
      return null;
    }

    // Delete old refresh token
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(storedToken.id);

    // Generate new tokens, preserving session metadata (update IP if changed)
    const meta: SessionMetadata = {
      ipAddress: sessionMeta?.ipAddress || storedToken.ip_address || undefined,
      userAgent: storedToken.user_agent || sessionMeta?.userAgent || undefined,
    };
    return this.generateTokens(user, meta);
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const db = getDb();
    const tokenHash = this.hashToken(refreshToken);
    db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    const db = getDb();
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
  }

  getUserSessions(userId: string, currentTokenHash?: string): SessionInfo[] {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT id, ip_address, user_agent, created_at, last_used_at, expires_at, token_hash
      FROM refresh_tokens
      WHERE user_id = ? AND expires_at > CURRENT_TIMESTAMP
      ORDER BY last_used_at DESC
    `).all(userId) as (RefreshTokenRow & { token_hash: string })[];

    return sessions.map(s => ({
      id: s.id,
      ipAddress: s.ip_address,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
      expiresAt: s.expires_at,
      isCurrent: currentTokenHash ? s.token_hash === currentTokenHash : false,
    }));
  }

  getSessionIdFromToken(refreshToken: string): string | null {
    const db = getDb();
    const tokenHash = this.hashToken(refreshToken);
    const session = db.prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as { id: string } | undefined;
    return session?.id || null;
  }

  getTokenHashFromRefreshToken(refreshToken: string): string {
    return this.hashToken(refreshToken);
  }

  revokeSession(userId: string, sessionId: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM refresh_tokens WHERE id = ? AND user_id = ?').run(sessionId, userId);
    return result.changes > 0;
  }

  revokeOtherSessions(userId: string, currentTokenHash: string): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND token_hash != ?').run(userId, currentTokenHash);
    return result.changes;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

    if (!user) {
      return false;
    }

    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) {
      return false;
    }

    const newHash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, userId);

    // Revoke all refresh tokens
    await this.revokeAllUserTokens(userId);

    return true;
  }

  getUser(userId: string): Omit<UserRow, 'password_hash' | 'totp_secret' | 'backup_codes'> | null {
    const db = getDb();
    const user = db.prepare('SELECT id, username, is_system_admin, totp_enabled, created_at, last_login_at FROM users WHERE id = ?').get(userId) as Omit<UserRow, 'password_hash' | 'totp_secret' | 'backup_codes'> | undefined;
    return user || null;
  }

  listUsers(): (Omit<UserRow, 'password_hash' | 'totp_secret' | 'backup_codes'> & { groups: UserGroupMembership[] })[] {
    const db = getDb();
    const users = db.prepare('SELECT id, username, is_system_admin, totp_enabled, created_at, last_login_at FROM users ORDER BY created_at').all() as Omit<UserRow, 'password_hash' | 'totp_secret' | 'backup_codes'>[];

    return users.map(user => ({
      ...user,
      groups: this.getUserGroups(user.id),
    }));
  }

  // Group methods
  createGroup(name: string, description?: string, totpRequired: boolean = false): string {
    const db = getDb();

    const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(name);
    if (existing) {
      throw new Error('Group name already exists');
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO groups (id, name, description, totp_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, name, description || null, totpRequired ? 1 : 0);

    return id;
  }

  updateGroup(groupId: string, updates: { name?: string; description?: string; totpRequired?: boolean }): boolean {
    const db = getDb();

    const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
    if (!group) {
      return false;
    }

    // Prevent enabling 2FA on default group
    if (groupId === 'default' && updates.totpRequired) {
      throw new Error('Cannot require 2FA for the default group');
    }

    if (updates.name) {
      const existing = db.prepare('SELECT id FROM groups WHERE name = ? AND id != ?').get(updates.name, groupId);
      if (existing) {
        throw new Error('Group name already exists');
      }
    }

    const setClauses: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const values: (string | number)[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
    }
    if (updates.totpRequired !== undefined) {
      setClauses.push('totp_required = ?');
      values.push(updates.totpRequired ? 1 : 0);
    }

    values.push(groupId);
    db.prepare(`UPDATE groups SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  deleteGroup(groupId: string): boolean {
    const db = getDb();

    // Prevent deleting default group
    if (groupId === 'default') {
      throw new Error('Cannot delete the default group');
    }

    const result = db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    return result.changes > 0;
  }

  getGroup(groupId: string): GroupRow | null {
    const db = getDb();
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as GroupRow | undefined || null;
  }

  listGroups(): GroupRow[] {
    const db = getDb();
    return db.prepare('SELECT * FROM groups ORDER BY name').all() as GroupRow[];
  }

  // User-Group membership methods
  addUserToGroup(userId: string, groupId: string, role: 'admin' | 'operator' | 'viewer'): void {
    const db = getDb();

    db.prepare(`
      INSERT OR REPLACE INTO user_groups (user_id, group_id, role, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(userId, groupId, role);
  }

  removeUserFromGroup(userId: string, groupId: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?').run(userId, groupId);
    return result.changes > 0;
  }

  updateUserGroupRole(userId: string, groupId: string, role: 'admin' | 'operator' | 'viewer'): boolean {
    const db = getDb();
    const result = db.prepare('UPDATE user_groups SET role = ? WHERE user_id = ? AND group_id = ?').run(role, userId, groupId);
    return result.changes > 0;
  }

  getUserGroups(userId: string): UserGroupMembership[] {
    const db = getDb();
    const memberships = db.prepare(`
      SELECT ug.group_id, g.name, ug.role, g.totp_required
      FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = ?
      ORDER BY g.name
    `).all(userId) as { group_id: string; name: string; role: 'admin' | 'operator' | 'viewer'; totp_required: boolean }[];

    return memberships.map(m => ({
      groupId: m.group_id,
      groupName: m.name,
      role: m.role,
      totpRequired: !!m.totp_required,
    }));
  }

  getGroupMembers(groupId: string): { userId: string; username: string; role: 'admin' | 'operator' | 'viewer'; isSystemAdmin: boolean }[] {
    const db = getDb();
    return db.prepare(`
      SELECT u.id as userId, u.username, ug.role, u.is_system_admin as isSystemAdmin
      FROM user_groups ug
      JOIN users u ON u.id = ug.user_id
      WHERE ug.group_id = ?
      ORDER BY u.username
    `).all(groupId) as { userId: string; username: string; role: 'admin' | 'operator' | 'viewer'; isSystemAdmin: boolean }[];
  }

  getUserRoleInGroup(userId: string, groupId: string): 'admin' | 'operator' | 'viewer' | null {
    const db = getDb();
    const membership = db.prepare('SELECT role FROM user_groups WHERE user_id = ? AND group_id = ?').get(userId, groupId) as { role: 'admin' | 'operator' | 'viewer' } | undefined;
    return membership?.role || null;
  }

  // Check if user requires 2FA based on any group membership
  userRequiresTotp(userId: string): boolean {
    const db = getDb();
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = ? AND g.totp_required = TRUE
    `).get(userId) as { count: number };
    return result.count > 0;
  }

  // Check if user can disable their own TOTP (only if no group requires it)
  canUserDisableTotp(userId: string): boolean {
    return !this.userRequiresTotp(userId);
  }

  // Get user's highest role across all groups (for display purposes)
  getUserHighestRole(userId: string): 'admin' | 'operator' | 'viewer' | null {
    const db = getDb();
    const user = db.prepare('SELECT is_system_admin FROM users WHERE id = ?').get(userId) as { is_system_admin: boolean } | undefined;

    if (user?.is_system_admin) {
      return 'admin';
    }

    const membership = db.prepare(`
      SELECT role FROM user_groups WHERE user_id = ?
      ORDER BY CASE role
        WHEN 'admin' THEN 1
        WHEN 'operator' THEN 2
        WHEN 'viewer' THEN 3
      END
      LIMIT 1
    `).get(userId) as { role: 'admin' | 'operator' | 'viewer' } | undefined;

    return membership?.role || null;
  }

  isSystemAdmin(userId: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT is_system_admin FROM users WHERE id = ?').get(userId) as { is_system_admin: boolean } | undefined;
    return !!user?.is_system_admin;
  }

  setSystemAdmin(userId: string, isAdmin: boolean): boolean {
    const db = getDb();
    const result = db.prepare('UPDATE users SET is_system_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(isAdmin ? 1 : 0, userId);
    return result.changes > 0;
  }

  deleteUser(userId: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  }

  // TOTP Methods
  isTotpEnabled(userId: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId) as { totp_enabled: boolean } | undefined;
    return user?.totp_enabled || false;
  }

  isTotpEnabledForUsername(username: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT totp_enabled FROM users WHERE username = ?').get(username) as { totp_enabled: boolean } | undefined;
    return user?.totp_enabled || false;
  }

  async setupTotp(userId: string): Promise<TotpSetupResult> {
    const db = getDb();
    const user = db.prepare('SELECT username, totp_enabled FROM users WHERE id = ?').get(userId) as { username: string; totp_enabled: boolean } | undefined;

    if (!user) {
      throw new Error('User not found');
    }

    if (user.totp_enabled) {
      throw new Error('TOTP is already enabled');
    }

    // Generate secret
    const secret = new OTPAuth.Secret({ size: 20 });

    // Create TOTP instance
    const totp = new OTPAuth.TOTP({
      issuer: 'OwnPrem',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret,
    });

    // Generate QR code
    const otpauthUrl = totp.toString();
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    // Store secret (not enabled yet - user must verify first)
    db.prepare(`
      UPDATE users
      SET totp_secret = ?, backup_codes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(secret.base32, JSON.stringify(backupCodes.map(c => this.hashToken(c))), userId);

    return {
      secret: secret.base32,
      qrCode,
      backupCodes,
    };
  }

  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      // Generate 8-character alphanumeric codes
      const code = randomBytes(4).toString('hex').toUpperCase();
      codes.push(code);
    }
    return codes;
  }

  verifyAndEnableTotp(userId: string, code: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId) as { totp_secret: string | null; totp_enabled: boolean } | undefined;

    if (!user || !user.totp_secret) {
      return false;
    }

    if (user.totp_enabled) {
      return false; // Already enabled
    }

    // Verify the code
    const totp = new OTPAuth.TOTP({
      issuer: 'OwnPrem',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totp_secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      return false;
    }

    // Enable TOTP
    db.prepare('UPDATE users SET totp_enabled = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    return true;
  }

  verifyTotpCode(userId: string, code: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT totp_secret, totp_enabled, backup_codes FROM users WHERE id = ?').get(userId) as { totp_secret: string | null; totp_enabled: boolean; backup_codes: string | null } | undefined;

    if (!user || !user.totp_secret || !user.totp_enabled) {
      return false;
    }

    // First try TOTP code
    const totp = new OTPAuth.TOTP({
      issuer: 'OwnPrem',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totp_secret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta !== null) {
      return true;
    }

    // Try backup code
    if (user.backup_codes) {
      const hashedCodes = JSON.parse(user.backup_codes) as string[];
      const codeHash = this.hashToken(code.toUpperCase());
      const codeIndex = hashedCodes.indexOf(codeHash);

      if (codeIndex !== -1) {
        // Remove used backup code
        hashedCodes.splice(codeIndex, 1);
        db.prepare('UPDATE users SET backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(JSON.stringify(hashedCodes), userId);
        return true;
      }
    }

    return false;
  }

  disableTotp(userId: string, password: string): Promise<boolean> {
    return this.disableTotpWithPassword(userId, password);
  }

  async disableTotpWithPassword(userId: string, password: string): Promise<boolean> {
    const db = getDb();

    // Check if user can disable TOTP (no group requires it)
    if (!this.canUserDisableTotp(userId)) {
      throw new Error('Cannot disable 2FA: one or more of your groups requires it');
    }

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;

    if (!user) {
      return false;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return false;
    }

    db.prepare(`
      UPDATE users
      SET totp_secret = NULL, totp_enabled = FALSE, backup_codes = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId);

    return true;
  }

  // Admin reset - doesn't require password, just admin permission
  resetTotpForUser(userId: string): boolean {
    const db = getDb();
    const user = db.prepare('SELECT id, totp_enabled FROM users WHERE id = ?').get(userId) as { id: string; totp_enabled: boolean } | undefined;

    if (!user) {
      return false;
    }

    db.prepare(`
      UPDATE users
      SET totp_secret = NULL, totp_enabled = FALSE, backup_codes = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId);

    return true;
  }

  regenerateBackupCodes(userId: string): string[] | null {
    const db = getDb();
    const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId) as { totp_enabled: boolean } | undefined;

    if (!user || !user.totp_enabled) {
      return null;
    }

    const backupCodes = this.generateBackupCodes();
    db.prepare('UPDATE users SET backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(backupCodes.map(c => this.hashToken(c))), userId);

    return backupCodes;
  }

  getTotpStatus(userId: string): { enabled: boolean; backupCodesRemaining: number } {
    const db = getDb();
    const user = db.prepare('SELECT totp_enabled, backup_codes FROM users WHERE id = ?').get(userId) as { totp_enabled: boolean; backup_codes: string | null } | undefined;

    if (!user) {
      return { enabled: false, backupCodesRemaining: 0 };
    }

    let backupCodesRemaining = 0;
    if (user.backup_codes) {
      try {
        const codes = JSON.parse(user.backup_codes) as string[];
        backupCodesRemaining = codes.length;
      } catch {
        backupCodesRemaining = 0;
      }
    }

    return {
      enabled: user.totp_enabled,
      backupCodesRemaining,
    };
  }

  async ensureDefaultUser(): Promise<void> {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };

    if (userCount.count === 0) {
      // Create default admin user in development
      if (config.isDevelopment) {
        const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';
        await this.createUser('admin', defaultPassword, true); // isSystemAdmin = true
        // System admins don't need group membership - they have full access
        console.log('Created default admin user (username: admin)');
      } else {
        console.warn('No users exist. Create an admin user with: POST /api/auth/setup');
      }
    }
  }
}

export const authService = new AuthService();
