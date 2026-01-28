import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID, createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
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
  role: string;
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

  async createUser(username: string, password: string, role: string = 'admin'): Promise<string> {
    const db = getDb();

    // Check if user exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      throw new Error('Username already exists');
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, username, passwordHash, role);

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
      role: user.role,
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

  getUser(userId: string): Omit<UserRow, 'password_hash'> | null {
    const db = getDb();
    const user = db.prepare('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?').get(userId) as Omit<UserRow, 'password_hash'> | undefined;
    return user || null;
  }

  listUsers(): Omit<UserRow, 'password_hash'>[] {
    const db = getDb();
    return db.prepare('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY created_at').all() as Omit<UserRow, 'password_hash'>[];
  }

  async ensureDefaultUser(): Promise<void> {
    const db = getDb();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };

    if (userCount.count === 0) {
      // Create default admin user in development
      if (config.isDevelopment) {
        const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';
        await this.createUser('admin', defaultPassword, 'admin');
        console.log('Created default admin user (username: admin)');
      } else {
        console.warn('No users exist. Create an admin user with: POST /api/auth/setup');
      }
    }
  }
}

export const authService = new AuthService();
