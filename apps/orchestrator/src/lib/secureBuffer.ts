/**
 * Secure Buffer Utilities
 *
 * Provides utilities for handling sensitive data in memory with
 * best-effort clearing when the data is no longer needed.
 *
 * Note: JavaScript/Node.js doesn't provide guaranteed memory clearing
 * due to garbage collection, string immutability, and potential copies.
 * These utilities provide defense-in-depth but shouldn't be considered
 * cryptographically secure memory protection.
 */

import { randomBytes } from 'crypto';

/**
 * Zero out a buffer's contents.
 * Uses multiple passes and random data to make recovery harder.
 */
export function zeroBuffer(buffer: Buffer): void {
  if (!buffer || buffer.length === 0) {
    return;
  }

  // First pass: fill with zeros
  buffer.fill(0);

  // Second pass: fill with random data (makes pattern analysis harder)
  const randomData = randomBytes(Math.min(buffer.length, 256));
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = randomData[i % randomData.length];
  }

  // Third pass: fill with zeros again
  buffer.fill(0);
}

/**
 * A wrapper around a Buffer that provides automatic cleanup.
 * Use this for sensitive data like encryption keys.
 */
export class SecureBuffer {
  private buffer: Buffer | null;
  private cleared: boolean = false;

  constructor(data: Buffer | string) {
    if (typeof data === 'string') {
      this.buffer = Buffer.from(data);
    } else {
      // Create a copy so we own the memory
      this.buffer = Buffer.alloc(data.length);
      data.copy(this.buffer);
    }
  }

  /**
   * Get the buffer for use. Throws if already cleared.
   */
  get(): Buffer {
    if (this.cleared || !this.buffer) {
      throw new Error('SecureBuffer has been cleared');
    }
    return this.buffer;
  }

  /**
   * Execute a function with access to the buffer, then optionally clear it.
   * This is the preferred way to use sensitive data.
   *
   * @param fn Function to execute with the buffer
   * @param clearAfter Whether to clear the buffer after use (default: false)
   */
  use<T>(fn: (buffer: Buffer) => T, clearAfter: boolean = false): T {
    const result = fn(this.get());
    if (clearAfter) {
      this.clear();
    }
    return result;
  }

  /**
   * Clear the buffer's contents and mark it as unusable.
   */
  clear(): void {
    if (this.buffer && !this.cleared) {
      zeroBuffer(this.buffer);
      this.buffer = null;
      this.cleared = true;
    }
  }

  /**
   * Check if the buffer has been cleared.
   */
  isCleared(): boolean {
    return this.cleared;
  }

  /**
   * Get the length of the buffer.
   */
  get length(): number {
    return this.buffer?.length ?? 0;
  }
}

/**
 * Registry of cleanup functions to run on process exit.
 * Used to ensure sensitive data is cleared even on unexpected shutdown.
 */
const cleanupRegistry: (() => void)[] = [];
let cleanupRegistered = false;

/**
 * Register a cleanup function to run on process exit.
 */
export function registerCleanup(fn: () => void): void {
  cleanupRegistry.push(fn);

  // Register process handlers only once
  if (!cleanupRegistered) {
    cleanupRegistered = true;

    const runCleanup = () => {
      for (const cleanup of cleanupRegistry) {
        try {
          cleanup();
        } catch {
          // Ignore errors during cleanup
        }
      }
      cleanupRegistry.length = 0;
    };

    // Register for various exit scenarios
    process.on('exit', runCleanup);
    process.on('SIGTERM', () => {
      runCleanup();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      runCleanup();
      process.exit(0);
    });
  }
}

/**
 * Create a SecureBuffer that will be automatically cleared on process exit.
 */
export function createSecureBuffer(data: Buffer | string): SecureBuffer {
  const sb = new SecureBuffer(data);
  registerCleanup(() => sb.clear());
  return sb;
}
