import { getDb } from '../db/index.js';
import { CountRow } from '../db/types.js';
import { auditService } from '../services/auditService.js';
import logger from '../lib/logger.js';

// Run cleanup every hour
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Keep used backup codes for 90 days (for audit trail), then clean up
const BACKUP_CODE_RETENTION_DAYS = 90;

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Clean up expired refresh tokens from the database.
 * Returns the number of tokens deleted.
 */
export function cleanupExpiredSessions(): number {
  try {
    const db = getDb();

    // Delete expired refresh tokens
    const result = db.prepare(`
      DELETE FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP
    `).run();

    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Cleaned up expired sessions');

      // Log to audit (optional - might generate lots of entries)
      auditService.log({
        action: 'sessions_cleanup',
        resourceType: 'auth',
        details: { deletedCount: result.changes },
      });
    }

    return result.changes;
  } catch (err) {
    logger.error({ err }, 'Failed to clean up expired sessions');
    return 0;
  }
}

/**
 * Clean up old used backup codes from the database.
 * Keeps codes for BACKUP_CODE_RETENTION_DAYS for audit purposes,
 * then removes them as they're no longer relevant (codes have been regenerated).
 * Returns the number of entries deleted.
 */
export function cleanupOldBackupCodes(): number {
  try {
    const db = getDb();

    // Delete used backup codes older than retention period
    const result = db.prepare(`
      DELETE FROM used_backup_codes
      WHERE used_at < datetime('now', '-' || ? || ' days')
    `).run(BACKUP_CODE_RETENTION_DAYS);

    if (result.changes > 0) {
      logger.info(
        { deleted: result.changes, retentionDays: BACKUP_CODE_RETENTION_DAYS },
        'Cleaned up old used backup codes'
      );
    }

    return result.changes;
  } catch (err) {
    logger.error({ err }, 'Failed to clean up old backup codes');
    return 0;
  }
}

/**
 * Clean up orphaned used backup codes (users that no longer exist).
 * This handles edge cases where cascade delete might have been missed.
 */
export function cleanupOrphanedBackupCodes(): number {
  try {
    const db = getDb();

    const result = db.prepare(`
      DELETE FROM used_backup_codes
      WHERE user_id NOT IN (SELECT id FROM users)
    `).run();

    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Cleaned up orphaned backup codes');
    }

    return result.changes;
  } catch (err) {
    logger.error({ err }, 'Failed to clean up orphaned backup codes');
    return 0;
  }
}

/**
 * Get the count of expired sessions that would be cleaned up.
 */
export function getExpiredSessionCount(): number {
  try {
    const db = getDb();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP
    `).get() as CountRow;
    return result.count;
  } catch (err) {
    logger.error({ err }, 'Failed to count expired sessions');
    return 0;
  }
}

/**
 * Get the total count of active sessions across all users.
 */
export function getActiveSessionCount(): number {
  try {
    const db = getDb();
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM refresh_tokens WHERE expires_at > CURRENT_TIMESTAMP
    `).get() as CountRow;
    return result.count;
  } catch (err) {
    logger.error({ err }, 'Failed to count active sessions');
    return 0;
  }
}

/**
 * Run all cleanup tasks.
 */
function runAllCleanupTasks(): void {
  cleanupExpiredSessions();
  cleanupOldBackupCodes();
  cleanupOrphanedBackupCodes();
}

/**
 * Start the background session cleanup job.
 * Runs immediately, then repeats at CLEANUP_INTERVAL.
 * Also cleans up old backup codes.
 */
export function startSessionCleanup(): void {
  if (cleanupInterval) {
    logger.warn('Session cleanup job already running');
    return;
  }

  // Run once at startup
  runAllCleanupTasks();

  // Schedule periodic cleanup
  cleanupInterval = setInterval(() => {
    runAllCleanupTasks();
  }, CLEANUP_INTERVAL);

  logger.info({ intervalMs: CLEANUP_INTERVAL }, 'Session cleanup job started');
}

/**
 * Stop the background session cleanup job.
 */
export function stopSessionCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('Session cleanup job stopped');
  }
}
