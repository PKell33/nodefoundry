import { createHmac, randomBytes } from 'crypto';
import { config } from '../config.js';

const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * CSRF Token Service
 *
 * Generates and validates CSRF tokens using HMAC signatures.
 * Tokens are tied to user sessions and include timestamps for expiry.
 */
class CsrfService {
  private secretKey: Buffer | null = null;

  /**
   * Get or generate the HMAC key for token signing.
   * Uses SECRETS_KEY if available, otherwise generates a session key.
   */
  private getKey(): Buffer {
    if (this.secretKey) {
      return this.secretKey;
    }

    const secretsKey = config.secrets.key;
    if (secretsKey) {
      // Derive a key from SECRETS_KEY for CSRF
      this.secretKey = createHmac('sha256', secretsKey)
        .update('csrf-token-key')
        .digest();
    } else {
      // Development mode: generate a session key
      // This is acceptable for CSRF since tokens only need to be valid for the current session
      this.secretKey = randomBytes(32);
    }

    return this.secretKey;
  }

  /**
   * Generate a CSRF token for a user.
   * Token format: timestamp.signature
   */
  generateToken(userId: string): string {
    const timestamp = Date.now().toString();
    const data = `${userId}:${timestamp}`;

    const signature = createHmac('sha256', this.getKey())
      .update(data)
      .digest('base64url');

    return `${timestamp}.${signature}`;
  }

  /**
   * Validate a CSRF token for a user.
   * Returns true if the token is valid and not expired.
   */
  validateToken(token: string, userId: string): boolean {
    if (!token || !userId) {
      return false;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return false;
    }

    const [timestamp, providedSignature] = parts;

    // Check expiry
    const tokenTime = parseInt(timestamp, 10);
    if (isNaN(tokenTime)) {
      return false;
    }

    const now = Date.now();
    if (now - tokenTime > TOKEN_EXPIRY_MS) {
      return false;
    }

    // Verify signature
    const data = `${userId}:${timestamp}`;
    const expectedSignature = createHmac('sha256', this.getKey())
      .update(data)
      .digest('base64url');

    // Constant-time comparison to prevent timing attacks
    if (providedSignature.length !== expectedSignature.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < providedSignature.length; i++) {
      result |= providedSignature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }

    return result === 0;
  }
}

export const csrfService = new CsrfService();
