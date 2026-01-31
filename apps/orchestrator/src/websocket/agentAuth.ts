/**
 * Agent authentication logic.
 * Handles token hashing and verification.
 */

import { timingSafeEqual, createHmac } from 'crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { wsLogger } from '../lib/logger.js';
import type { ServerRow } from './agentTypes.js';

/**
 * Hash a token for storage using HMAC-SHA256.
 */
export function hashToken(token: string): string {
  const hmacKey = config.tokens.hmacKey;
  if (!hmacKey) {
    throw new Error('Token HMAC key not configured. Set SECRETS_KEY environment variable.');
  }
  return createHmac('sha256', hmacKey).update(token).digest('hex');
}

/**
 * Securely compare tokens using timing-safe comparison.
 */
export function verifyToken(providedToken: string, storedHash: string): boolean {
  const providedHash = hashToken(providedToken);
  const providedBuffer = Buffer.from(providedHash, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');

  if (providedBuffer.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, storedBuffer);
}

/**
 * Check if a client IP is localhost.
 */
export function isLocalhostIp(clientIp: string): boolean {
  return clientIp === '127.0.0.1' ||
         clientIp === '::1' ||
         clientIp === '::ffff:127.0.0.1' ||
         clientIp === 'localhost';
}

export interface AuthResult {
  success: boolean;
  server?: ServerRow;
  reason?: string;
}

/**
 * Authenticate an agent connection.
 * Returns success status with server info or failure reason.
 */
export function authenticateAgent(
  serverId: string,
  token: string | undefined,
  clientIp: string
): AuthResult {
  const db = getDb();
  const server = db.prepare('SELECT id, auth_token, is_core FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;

  if (!server) {
    wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: unknown server');
    return { success: false, reason: 'unknown server' };
  }

  // Core server requires connection from localhost
  if (server.is_core) {
    if (!isLocalhostIp(clientIp)) {
      wsLogger.warn({ serverId, clientIp }, 'Core agent connection rejected: must connect from localhost');
      return { success: false, reason: 'core server must connect from localhost' };
    }
    wsLogger.debug({ serverId, clientIp }, 'Core agent authenticated via localhost verification');
    return { success: true, server };
  }

  // Non-core servers require a token
  if (!token) {
    wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: missing token');
    return { success: false, reason: 'missing token' };
  }

  // Check agent_tokens table for new-style tokens
  const tokenHash = hashToken(token);
  const agentTokenRow = db.prepare(`
    SELECT id FROM agent_tokens
    WHERE server_id = ? AND token_hash = ?
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
  `).get(serverId, tokenHash) as { id: string } | undefined;

  if (agentTokenRow) {
    db.prepare('UPDATE agent_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(agentTokenRow.id);
    wsLogger.debug({ serverId, tokenId: agentTokenRow.id }, 'Agent authenticated via agent_tokens');
    return { success: true, server };
  }

  // Fall back to legacy auth_token
  if (server.auth_token) {
    if (verifyToken(token, server.auth_token)) {
      wsLogger.debug({ serverId }, 'Agent authenticated via legacy auth_token');
      return { success: true, server };
    }
  }

  wsLogger.warn({ serverId, clientIp }, 'Agent connection rejected: invalid token');
  return { success: false, reason: 'invalid token' };
}
