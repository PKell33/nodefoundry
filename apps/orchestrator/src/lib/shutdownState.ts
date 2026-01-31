/**
 * Shutdown state management.
 * Extracted to break circular dependency between api/index.ts and index.ts.
 */

let isShuttingDown = false;

/**
 * Check if the server is shutting down.
 * Used by health endpoints to return 503 during shutdown.
 */
export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Set the shutdown state.
 * Called by main index.ts when graceful shutdown begins.
 */
export function setServerShuttingDown(value: boolean): void {
  isShuttingDown = value;
}
