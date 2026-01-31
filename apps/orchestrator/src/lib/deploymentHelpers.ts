/**
 * Deployment helper functions for status updates and common operations.
 * These are extracted to avoid circular dependencies between services.
 */

import { getDb } from '../db/index.js';
import type { DeploymentStatus } from '@ownprem/shared';

/**
 * Update the status of a deployment in the database.
 * This is a standalone function that can be imported by any module.
 *
 * @param deploymentId - The deployment ID
 * @param status - The new deployment status
 * @param message - Optional status message (for errors, etc.)
 */
export function updateDeploymentStatus(
  deploymentId: string,
  status: DeploymentStatus,
  message?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE deployments SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, message || null, deploymentId);
}

/**
 * Update deployment status without a message (clears existing message).
 */
export function setDeploymentStatus(
  deploymentId: string,
  status: DeploymentStatus
): void {
  const db = getDb();
  db.prepare(`
    UPDATE deployments SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, deploymentId);
}
