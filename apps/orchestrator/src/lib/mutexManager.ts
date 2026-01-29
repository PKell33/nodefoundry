import { Mutex } from 'async-mutex';

/**
 * Manages mutexes for concurrent resource access protection.
 * Uses per-resource mutexes to allow parallel operations on different resources
 * while serializing operations on the same resource.
 */
class MutexManager {
  private serverMutexes = new Map<string, Mutex>();
  private deploymentMutexes = new Map<string, Mutex>();

  /**
   * Get or create a mutex for a specific server.
   * Used to protect agent connection replacement and related operations.
   */
  getServerMutex(serverId: string): Mutex {
    let mutex = this.serverMutexes.get(serverId);
    if (!mutex) {
      mutex = new Mutex();
      this.serverMutexes.set(serverId, mutex);
    }
    return mutex;
  }

  /**
   * Get or create a mutex for a specific deployment.
   * Used to protect deployment status updates from concurrent command results
   * and status reports.
   */
  getDeploymentMutex(deploymentId: string): Mutex {
    let mutex = this.deploymentMutexes.get(deploymentId);
    if (!mutex) {
      mutex = new Mutex();
      this.deploymentMutexes.set(deploymentId, mutex);
    }
    return mutex;
  }

  /**
   * Run a function exclusively for a server.
   * Ensures no concurrent operations on the same server.
   */
  async withServerLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getServerMutex(serverId);
    return mutex.runExclusive(fn);
  }

  /**
   * Run a function exclusively for a deployment.
   * Ensures no concurrent status updates for the same deployment.
   */
  async withDeploymentLock<T>(deploymentId: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getDeploymentMutex(deploymentId);
    return mutex.runExclusive(fn);
  }

  /**
   * Clean up mutex for a server that is no longer connected.
   * Called when a server is disconnected and cleanup is complete.
   */
  cleanupServerMutex(serverId: string): void {
    this.serverMutexes.delete(serverId);
  }

  /**
   * Clean up mutex for a deployment that has been uninstalled.
   * Called when a deployment is deleted.
   */
  cleanupDeploymentMutex(deploymentId: string): void {
    this.deploymentMutexes.delete(deploymentId);
  }

  /**
   * Get statistics about mutex usage for monitoring.
   * Useful for detecting potential memory leaks.
   */
  getStats(): { serverMutexes: number; deploymentMutexes: number } {
    return {
      serverMutexes: this.serverMutexes.size,
      deploymentMutexes: this.deploymentMutexes.size,
    };
  }
}

export const mutexManager = new MutexManager();
