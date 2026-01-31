/**
 * Service management (systemctl, keepalived).
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { privilegedClient } from '../privilegedClient.js';
import logger from '../lib/logger.js';

const serviceLogger = logger.child({ component: 'serviceManager' });

/**
 * Kill a process group with escalating signals.
 */
export function killProcessGroup(pid: number, service: string): void {
  // Try to kill the process group (negative PID)
  try {
    process.kill(-pid, 'SIGTERM');
    serviceLogger.debug({ service, pid }, 'Sent SIGTERM to process group');
  } catch (err) {
    // Process group might not exist, try individual process
    try {
      process.kill(pid, 'SIGTERM');
      serviceLogger.debug({ service, pid }, 'Sent SIGTERM to process');
    } catch {
      // Process already dead
      return;
    }
  }

  // Give process time to clean up, then force kill if needed
  setTimeout(() => {
    try {
      // Check if still alive
      process.kill(pid, 0);
      // Still alive, force kill
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
      serviceLogger.warn({ service, pid }, 'Process did not respond to SIGTERM, sent SIGKILL');
    } catch {
      // Process is dead, good
    }
  }, 3000);
}

function runSystemctlDirect(action: string, service: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('systemctl', [action, service], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`systemctl ${action} ${service} failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

export interface ServiceManagerState {
  runningProcesses: Map<string, ChildProcess>;
  appsDir: string;
}

/**
 * Execute systemctl action on a service.
 */
export async function systemctl(
  action: string,
  service: string,
  state: ServiceManagerState
): Promise<void> {
  // Validate action (whitelist)
  const allowedActions = ['start', 'stop', 'restart', 'enable', 'disable', 'status'];
  if (!allowedActions.includes(action)) {
    throw new Error(`Invalid systemctl action: ${action}`);
  }

  // Validate service name (alphanumeric, hyphen, underscore, dots)
  if (!/^[a-zA-Z0-9_.-]+$/.test(service)) {
    throw new Error(`Invalid service name: ${service}`);
  }

  // Look up the actual systemd service name from metadata
  let actualServiceName = service;
  const metadataPath = `${state.appsDir}/${service}/.ownprem.json`;
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      if (metadata.serviceName) {
        actualServiceName = metadata.serviceName;
        serviceLogger.info(`Using service name from metadata: ${actualServiceName} (app: ${service})`);
      }
    } catch {
      // Ignore metadata parse errors, use service name as fallback
    }
  }

  // First try privileged helper for systemctl (production mode)
  try {
    const result = await privilegedClient.systemctl(
      action as 'start' | 'stop' | 'restart' | 'enable' | 'disable',
      actualServiceName
    );
    if (result.success) {
      serviceLogger.info(`systemctl ${action} ${actualServiceName} succeeded via privileged helper`);
      return;
    }
    serviceLogger.info(`Privileged helper systemctl failed: ${result.error}, trying fallback`);
  } catch (err) {
    serviceLogger.info(`Privileged helper not available: ${err}, trying fallback`);
  }

  // Fallback: try direct systemctl (works if running as root in dev)
  try {
    await runSystemctlDirect(action, actualServiceName);
    return;
  } catch (err) {
    serviceLogger.info(`Direct systemctl failed, trying dev mode fallback for ${action} ${service}`);
  }

  // Dev mode fallback (uses start.sh/stop.sh scripts)
  const appDir = `${state.appsDir}/${service}`;
  const startScript = `${appDir}/start.sh`;

  if (action === 'start') {
    if (existsSync(startScript)) {
      // Check if already running
      const existingProc = state.runningProcesses.get(service);
      if (existingProc && existingProc.pid) {
        try {
          // Check if process is still alive (kill with signal 0 just checks)
          process.kill(existingProc.pid, 0);
          serviceLogger.info(`${service} already running (pid: ${existingProc.pid})`);
          return;
        } catch {
          // Process not running, clean up stale entry
          state.runningProcesses.delete(service);
        }
      }

      // Run start.sh in background with new process group
      const proc = spawn('bash', [startScript], {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // Creates new process group with PGID = PID
        env: {
          ...process.env,
          APP_DIR: appDir,
          APP_NAME: service,
        },
      });

      proc.stdout?.on('data', (data) => serviceLogger.info(`[${service}] ${data.toString().trim()}`));
      proc.stderr?.on('data', (data) => serviceLogger.error(`[${service}] ${data.toString().trim()}`));

      // Track the process and handle unexpected termination
      state.runningProcesses.set(service, proc);

      proc.on('exit', (code, signal) => {
        // Clean up tracking when process exits
        if (state.runningProcesses.get(service) === proc) {
          state.runningProcesses.delete(service);
          if (code !== 0 && code !== null) {
            serviceLogger.warn({ service, code, signal }, 'Dev mode process exited unexpectedly');
          }
        }
      });

      proc.unref();
      serviceLogger.info(`Started ${service} in dev mode (pid: ${proc.pid}, pgid: ${proc.pid})`);
    } else {
      throw new Error(`No start.sh found for ${service} in dev mode`);
    }
  } else if (action === 'stop') {
    const stopScript = `${appDir}/stop.sh`;
    if (existsSync(stopScript)) {
      // Run stop.sh
      const result = spawnSync('bash', [stopScript], {
        cwd: appDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          APP_DIR: appDir,
          APP_NAME: service,
        },
      });
      if (result.status !== 0) {
        serviceLogger.error(`stop.sh failed: ${result.stderr?.toString()}`);
      }
    }

    // Kill the entire process group to ensure all children are terminated
    const proc = state.runningProcesses.get(service);
    if (proc && proc.pid) {
      killProcessGroup(proc.pid, service);
      state.runningProcesses.delete(service);
    }
    serviceLogger.info(`Stopped ${service} in dev mode`);
  } else if (action === 'restart') {
    await systemctl('stop', service, state);
    await systemctl('start', service, state);
  }
}

/**
 * Configure and manage keepalived for Caddy HA.
 */
export async function configureKeepalived(config: string, enabled: boolean): Promise<void> {
  const keepalivedConf = '/etc/keepalived/keepalived.conf';
  const keepalivedDir = dirname(keepalivedConf);

  // Create keepalived directory via privileged helper
  if (!existsSync(keepalivedDir)) {
    const dirResult = await privilegedClient.createDirectory(keepalivedDir);
    if (!dirResult.success) {
      // Fallback to direct creation
      mkdirSync(keepalivedDir, { recursive: true });
    }
    serviceLogger.info(`Created keepalived directory: ${keepalivedDir}`);
  }

  // Write configuration via privileged helper
  const writeResult = await privilegedClient.writeFile(keepalivedConf, config, undefined, '644');
  if (!writeResult.success) {
    // Fallback to direct write
    writeFileSync(keepalivedConf, config, { mode: 0o644 });
  }
  serviceLogger.info('Wrote keepalived configuration');

  if (enabled) {
    // Check if keepalived is installed
    const whichResult = spawnSync('which', ['keepalived'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (whichResult.status !== 0) {
      // Install keepalived via privileged helper
      serviceLogger.info('Installing keepalived...');
      const installResult = await privilegedClient.aptInstall(['keepalived']);

      if (!installResult.success) {
        throw new Error(`Failed to install keepalived: ${installResult.error}`);
      }
      serviceLogger.info('Keepalived installed');
    }

    // Enable keepalived via privileged helper
    const enableResult = await privilegedClient.systemctl('enable', 'keepalived');
    if (!enableResult.success) {
      serviceLogger.warn(`Warning: Could not enable keepalived: ${enableResult.error}`);
    }

    // Check if service is running
    const statusResult = spawnSync('systemctl', ['is-active', 'keepalived'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (statusResult.stdout.trim() === 'active') {
      // Restart to reload configuration (reload not always supported)
      const restartResult = await privilegedClient.systemctl('restart', 'keepalived');
      if (!restartResult.success) {
        throw new Error(`Failed to restart keepalived: ${restartResult.error}`);
      }
      serviceLogger.info('Keepalived configuration reloaded');
    } else {
      // Start the service
      const startResult = await privilegedClient.systemctl('start', 'keepalived');
      if (!startResult.success) {
        throw new Error(`Failed to start keepalived: ${startResult.error}`);
      }
      serviceLogger.info('Keepalived started');
    }
  } else {
    // Stop keepalived via privileged helper
    const stopResult = await privilegedClient.systemctl('stop', 'keepalived');
    if (!stopResult.success) {
      serviceLogger.warn(`Warning: Could not stop keepalived: ${stopResult.error}`);
    }

    // Disable keepalived
    await privilegedClient.systemctl('disable', 'keepalived');
    serviceLogger.info('Keepalived disabled');
  }
}

/**
 * Check keepalived status.
 */
export async function checkKeepalived(): Promise<{ installed: boolean; running: boolean; state?: string }> {
  // Check if installed
  const whichResult = spawnSync('which', ['keepalived'], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (whichResult.status !== 0) {
    return { installed: false, running: false };
  }

  // Check if running
  const statusResult = spawnSync('systemctl', ['is-active', 'keepalived'], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  const running = statusResult.stdout.trim() === 'active';

  // Get VRRP state if running
  let state: string | undefined;
  if (running) {
    try {
      const journalResult = spawnSync('journalctl', ['-u', 'keepalived', '-n', '50', '--no-pager'], {
        encoding: 'utf-8',
        timeout: 5000,
      });

      if (journalResult.status === 0) {
        const output = journalResult.stdout;
        const masterMatch = output.match(/Entering MASTER STATE/);
        const backupMatch = output.match(/Entering BACKUP STATE/);

        if (masterMatch && (!backupMatch || output.lastIndexOf('MASTER') > output.lastIndexOf('BACKUP'))) {
          state = 'MASTER';
        } else if (backupMatch) {
          state = 'BACKUP';
        }
      }
    } catch {
      // Ignore errors getting state
    }
  }

  return { installed: true, running, state };
}

/**
 * Stop all running dev mode processes.
 */
export function stopAllDevProcesses(runningProcesses: Map<string, ChildProcess>): void {
  for (const [service, proc] of runningProcesses) {
    if (proc.pid) {
      serviceLogger.info({ service, pid: proc.pid }, 'Stopping dev mode process during cleanup');
      killProcessGroup(proc.pid, service);
    }
  }
  runningProcesses.clear();
}
