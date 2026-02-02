import { randomBytes, createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { AgentTokenRow, AgentToken, rowToAgentToken, CountRow } from '../db/types.js';
import { auditService } from './auditService.js';
import logger from '../lib/logger.js';

// Re-export for backwards compatibility
export type { AgentToken } from '../db/types.js';

/**
 * Hash a token for storage using SHA-256.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parse a duration string (e.g., "30d", "24h", "1h") to milliseconds.
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error('Invalid duration format');
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error('Invalid duration unit');
  }
}

class AgentTokenService {
  /**
   * Create a new agent token for a server.
   * Returns the raw token (only visible once).
   */
  createToken(
    serverId: string,
    options: { name?: string; expiresIn?: string } = {},
    userId?: string
  ): { token: AgentToken; rawToken: string } {
    const db = getDb();

    // Generate token
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const id = randomUUID();

    // Calculate expiry if provided
    let expiresAt: Date | null = null;
    if (options.expiresIn) {
      const durationMs = parseDuration(options.expiresIn);
      expiresAt = new Date(Date.now() + durationMs);
    }

    // Insert token
    db.prepare(`
      INSERT INTO agent_tokens (id, server_id, token_hash, name, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      serverId,
      tokenHash,
      options.name || null,
      expiresAt?.toISOString() || null
    );

    // Audit log
    auditService.log({
      userId,
      action: 'agent_token_created',
      resourceType: 'server',
      resourceId: serverId,
      details: {
        tokenId: id,
        tokenName: options.name,
        hasExpiry: !!expiresAt,
      },
    });

    logger.info({ serverId, tokenId: id, hasExpiry: !!expiresAt }, 'Agent token created');

    return {
      token: {
        id,
        serverId,
        name: options.name || null,
        expiresAt,
        createdAt: new Date(),
        lastUsedAt: null,
      },
      rawToken,
    };
  }

  /**
   * List all tokens for a server.
   */
  listTokens(serverId: string): AgentToken[] {
    const db = getDb();

    const rows = db.prepare(`
      SELECT id, server_id, name, expires_at, created_at, last_used_at
      FROM agent_tokens
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId) as AgentTokenRow[];

    return rows.map(row => rowToAgentToken(row));
  }

  /**
   * Get a specific token by ID.
   */
  getToken(tokenId: string): AgentToken | null {
    const db = getDb();

    const row = db.prepare(`
      SELECT id, server_id, name, expires_at, created_at, last_used_at
      FROM agent_tokens
      WHERE id = ?
    `).get(tokenId) as AgentTokenRow | undefined;

    return row ? rowToAgentToken(row) : null;
  }

  /**
   * Revoke (delete) a token.
   */
  revokeToken(tokenId: string, serverId: string, userId?: string): boolean {
    const db = getDb();

    const result = db.prepare(`
      DELETE FROM agent_tokens WHERE id = ? AND server_id = ?
    `).run(tokenId, serverId);

    if (result.changes > 0) {
      auditService.log({
        userId,
        action: 'agent_token_revoked',
        resourceType: 'server',
        resourceId: serverId,
        details: { tokenId },
      });

      logger.info({ serverId, tokenId }, 'Agent token revoked');
      return true;
    }

    return false;
  }

  /**
   * Verify a token and return the server ID if valid.
   * Also updates last_used_at timestamp.
   */
  verifyToken(rawToken: string): { serverId: string; tokenId: string } | null {
    const db = getDb();
    const tokenHash = hashToken(rawToken);

    // Look up token, checking expiry
    const row = db.prepare(`
      SELECT id, server_id, expires_at
      FROM agent_tokens
      WHERE token_hash = ?
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).get(tokenHash) as { id: string; server_id: string; expires_at: string | null } | undefined;

    if (!row) {
      return null;
    }

    // Update last_used_at
    db.prepare(`
      UPDATE agent_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(row.id);

    return {
      serverId: row.server_id,
      tokenId: row.id,
    };
  }

  /**
   * Check if a token hash is valid for a server (used by legacy auth flow).
   * Does NOT update last_used_at (used for token comparison, not authentication).
   */
  isValidTokenHash(serverId: string, tokenHash: string): boolean {
    const db = getDb();

    const row = db.prepare(`
      SELECT id FROM agent_tokens
      WHERE server_id = ? AND token_hash = ?
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).get(serverId, tokenHash);

    return !!row;
  }

  /**
   * Update last_used_at for a token by its hash.
   */
  updateLastUsedByHash(tokenHash: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE agent_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?
    `).run(tokenHash);
  }

  /**
   * Count active (non-expired) tokens for a server.
   */
  countActiveTokens(serverId: string): number {
    const db = getDb();

    const result = db.prepare(`
      SELECT COUNT(*) as count FROM agent_tokens
      WHERE server_id = ?
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).get(serverId) as CountRow;

    return result.count;
  }

  /**
   * Delete expired tokens (cleanup).
   */
  cleanupExpiredTokens(): number {
    const db = getDb();

    const result = db.prepare(`
      DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
    `).run();

    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Cleaned up expired agent tokens');
    }

    return result.changes;
  }
}

export const agentTokenService = new AgentTokenService();
