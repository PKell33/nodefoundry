/**
 * Executor - coordinates app lifecycle operations.
 * Delegates to specialized modules for specific functionality.
 */

import { spawnSync, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import type { CommandPayload, ConfigFile, LogRequestPayload, LogResult, LogStreamPayload, LogStreamLine, MountCommandPayload, MountCheckResult } from '@ownprem/shared';
import { privilegedClient } from './privilegedClient.js';
import logger from './lib/logger.js';

// Import from extracted modules
import { ALLOWED_PATH_PREFIXES, SCRIPT_TIMEOUT_MS } from './executor/executorTypes.js';
import { validatePath, validateOwner, validateMode } from './executor/validation.js';
import { getLogs as getLogsInternal, LogStreamManager } from './executor/logManager.js';
import { mountStorage as mountStorageInternal, unmountStorage as unmountStorageInternal, checkMount as checkMountInternal } from './executor/mountManager.js';
import { systemctl as systemctlInternal, configureKeepalived as configureKeepalivedInternal, checkKeepalived as checkKeepalivedInternal, stopAllDevProcesses } from './executor/serviceManager.js';
import { spawnScript, killProcessGroup as killProcessGroupUtil, INSTALL_SCRIPT_LIMITS, DEFAULT_SCRIPT_LIMITS, type ResourceLimits } from './executor/processRunner.js';

const executorLogger = logger.child({ component: 'executor' });

export class Executor {
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private logStreamManager: LogStreamManager;
  private appsDir: string;
  private dataDir: string;
  private allowedPaths: string[];

  constructor(appsDir: string = '/opt/ownprem/apps', dataDir?: string) {
    // Ensure appsDir is absolute
    this.appsDir = resolve(appsDir);
    // Default dataDir to /var/lib/ownprem in production, or appsDir in dev mode
    this.dataDir = dataDir ? resolve(dataDir) : (
      this.appsDir.includes('/opt/ownprem') ? '/var/lib/ownprem' : this.appsDir
    );
    mkdirSync(this.appsDir, { recursive: true });

    // Build allowed paths list (include appsDir and dataDir for dev mode)
    this.allowedPaths = [...ALLOWED_PATH_PREFIXES];
    if (!this.allowedPaths.some(p => this.appsDir.startsWith(p))) {
      this.allowedPaths.push(this.appsDir + '/');
    }
    if (!this.allowedPaths.some(p => this.dataDir.startsWith(p))) {
      this.allowedPaths.push(this.dataDir + '/');
    }

    // Initialize log stream manager
    this.logStreamManager = new LogStreamManager(this.appsDir, this.dataDir, this.allowedPaths);
  }

  // ===============================
  // Path Validation
  // ===============================

  private validatePath(filePath: string): string {
    return validatePath(filePath, this.allowedPaths);
  }

  // ===============================
  // App Lifecycle
  // ===============================

  async install(appName: string, payload: CommandPayload): Promise<void> {
    const appDir = `${this.appsDir}/${appName}`;

    // Track created paths for cleanup on failure
    const createdPaths: string[] = [];
    let installSuccess = false;

    try {
      // Create app directory and track it
      if (!existsSync(appDir)) {
        mkdirSync(appDir, { recursive: true });
        createdPaths.push(appDir);
      }

      const metadata = payload.metadata;
      const serviceUser = metadata?.serviceUser;
      const serviceGroup = metadata?.serviceGroup || serviceUser;
      const dataDirectories = metadata?.dataDirectories || [];
      const capabilities = metadata?.capabilities || [];

      // === PRE-INSTALL: Privileged setup ===

      // Create service user if specified
      if (serviceUser) {
        executorLogger.info(`Creating service user: ${serviceUser}`);
        try {
          const homeDir = dataDirectories[0]?.path || `/var/lib/${serviceUser}`;
          const result = await privilegedClient.createServiceUser(serviceUser, homeDir);
          if (result.success) {
            executorLogger.info(`Service user created: ${serviceUser}`);
          } else if (!result.error?.includes('already exists')) {
            executorLogger.warn(`Could not create service user: ${result.error}`);
          }
        } catch (err) {
          executorLogger.warn(`Failed to create service user via helper: ${err}`);
        }
      }

      // Create data directories with correct ownership
      for (const dir of dataDirectories) {
        executorLogger.info(`Creating data directory: ${dir.path}`);
        try {
          const owner = serviceUser && serviceGroup ? `${serviceUser}:${serviceGroup}` : undefined;
          const result = await privilegedClient.createDirectory(dir.path, owner, '755');
          if (result.success) {
            executorLogger.info(`Created directory: ${dir.path}`);
            // Track created directories for potential cleanup
            createdPaths.push(dir.path);
          } else {
            executorLogger.warn(`Could not create directory ${dir.path}: ${result.error}`);
          }
        } catch (err) {
          executorLogger.warn(`Failed to create directory via helper: ${err}`);
        }
      }

      // Write metadata file for status reporting
      if (metadata) {
        const metadataPath = `${appDir}/.ownprem.json`;
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        executorLogger.info(`Wrote metadata: ${metadataPath}`);
      }

      // Write config files (install script, configs, etc.)
      if (payload.files) {
        await this.writeFiles(payload.files);
      }

      // === RUN INSTALL SCRIPT ===
      const installScript = `${appDir}/install.sh`;
      if (existsSync(installScript)) {
        // Use more permissive limits for install scripts (compiling, downloading, etc.)
        await this.runScript(installScript, {
          ...process.env,
          ...payload.env,
          APP_NAME: appName,
          APP_VERSION: payload.version || '',
          APP_DIR: appDir,
          SERVICE_USER: serviceUser || '',
          SERVICE_GROUP: serviceGroup || '',
          DATA_DIR: dataDirectories[0]?.path || '',
          CONFIG_DIR: dataDirectories[1]?.path || '',
        }, SCRIPT_TIMEOUT_MS, INSTALL_SCRIPT_LIMITS);
      }

      // === POST-INSTALL: Finalize privileged setup ===

      // Set capabilities on binary if specified
      for (const cap of capabilities) {
        const binaryPath = `${appDir}/bin/${appName.replace('ownprem-', '')}`;
        if (existsSync(binaryPath)) {
          executorLogger.info(`Setting capability ${cap} on ${binaryPath}`);
          try {
            const result = await privilegedClient.setCapability(binaryPath, cap);
            if (!result.success) {
              executorLogger.warn(`Could not set capability: ${result.error}`);
            }
          } catch (err) {
            executorLogger.warn(`Failed to set capability via helper: ${err}`);
          }
        }
      }

      // Copy systemd service template if it exists
      const serviceName = metadata?.serviceName || appName;
      const serviceTemplate = `${appDir}/templates/${serviceName}.service`;
      if (existsSync(serviceTemplate)) {
        executorLogger.info(`Installing systemd service: ${serviceName}`);
        try {
          // Read template and substitute variables
          let serviceContent = readFileSync(serviceTemplate, 'utf-8');
          serviceContent = serviceContent
            .replace(/\$\{APP_DIR\}/g, appDir)
            .replace(/\$\{DATA_DIR\}/g, dataDirectories[0]?.path || '')
            .replace(/\$\{CONFIG_DIR\}/g, dataDirectories[1]?.path || '')
            .replace(/\$\{SERVICE_USER\}/g, serviceUser || 'root')
            .replace(/\$\{SERVICE_GROUP\}/g, serviceGroup || 'root');

          const servicePath = `/etc/systemd/system/${serviceName}.service`;
          const result = await privilegedClient.writeFile(servicePath, serviceContent);
          if (result.success) {
            executorLogger.info(`Wrote systemd service: ${servicePath}`);

            // Register the service with privileged helper before systemctl operations
            const registerResult = await privilegedClient.registerService(serviceName);
            if (!registerResult.success) {
              executorLogger.warn(`Could not register service: ${registerResult.error}`);
            } else {
              executorLogger.info(`Registered service: ${serviceName}`);
            }

            // Reload systemd
            await privilegedClient.systemctl('daemon-reload');

            // Enable service
            const enableResult = await privilegedClient.systemctl('enable', serviceName);
            if (enableResult.success) {
              executorLogger.info(`Enabled service: ${serviceName}`);
            }
          } else {
            executorLogger.warn(`Could not write systemd service: ${result.error}`);
          }
        } catch (err) {
          executorLogger.warn(`Failed to install systemd service: ${err}`);
        }
      }

      // Mark installation as successful
      installSuccess = true;
    } finally {
      // Clean up created paths if installation failed
      if (!installSuccess) {
        await this.cleanupFailedInstall(appName, createdPaths);
      }
    }
  }

  /**
   * Clean up created paths after a failed installation.
   * Removes paths in reverse order (deepest first).
   */
  private async cleanupFailedInstall(appName: string, createdPaths: string[]): Promise<void> {
    if (createdPaths.length === 0) {
      return;
    }

    executorLogger.warn({ appName, paths: createdPaths }, 'Cleaning up failed installation');

    // Remove in reverse order (deepest paths first)
    for (const path of createdPaths.reverse()) {
      try {
        if (existsSync(path)) {
          rmSync(path, { recursive: true, force: true });
          executorLogger.info(`Cleaned up: ${path}`);
        }
      } catch (cleanupError) {
        // Log but don't throw - best effort cleanup
        executorLogger.error({ path, error: cleanupError }, 'Failed to cleanup path during install failure');
      }
    }
  }

  async configure(appName: string, files: ConfigFile[]): Promise<void> {
    // Write config files
    await this.writeFiles(files);

    // Run configure script if it exists
    const configureScript = `${this.appsDir}/${appName}/configure.sh`;
    if (existsSync(configureScript)) {
      await this.runScript(configureScript, {
        APP_NAME: appName,
        APP_DIR: `${this.appsDir}/${appName}`,
      });
    }
  }

  async uninstall(appName: string): Promise<void> {
    // Get service name from metadata if available
    let serviceName = appName;
    const metadataPath = `${this.appsDir}/${appName}/.ownprem.json`;
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        if (metadata.serviceName) {
          serviceName = metadata.serviceName;
        }
      } catch (err) {
        executorLogger.debug({ appName, metadataPath, err }, 'Ignored metadata parse error during uninstall');
      }
    }

    // Stop service first
    await this.systemctl('stop', appName).catch((err) => {
      executorLogger.debug({ appName, err }, 'Ignored stop error during uninstall (service may not exist)');
    });

    // Disable service
    await this.systemctl('disable', appName).catch((err) => {
      executorLogger.debug({ appName, err }, 'Ignored disable error during uninstall (service may not exist)');
    });

    // Unregister the service from privileged helper
    try {
      const unregisterResult = await privilegedClient.unregisterService(serviceName);
      if (unregisterResult.success) {
        executorLogger.info(`Unregistered service: ${serviceName}`);
      }
    } catch (err) {
      executorLogger.debug({ serviceName, err }, 'Ignored unregister error during uninstall (service may not have been registered)');
    }

    // Run uninstall script if it exists
    const appDir = `${this.appsDir}/${appName}`;
    const uninstallScript = `${appDir}/uninstall.sh`;
    if (existsSync(uninstallScript)) {
      await this.runScript(uninstallScript, {
        APP_NAME: appName,
        APP_DIR: appDir,
        DATA_DIR: `${this.dataDir}/${appName}`,
      });
    }

    // Clean up the app directory
    const { rmSync } = await import('fs');
    try {
      rmSync(appDir, { recursive: true, force: true });
      executorLogger.info(`Removed app directory: ${appDir}`);
    } catch (err) {
      executorLogger.error(`Failed to remove app directory: ${err}`);
    }
  }

  // ===============================
  // Logging
  // ===============================

  async getLogs(appName: string, options: LogRequestPayload = {}): Promise<Omit<LogResult, 'commandId'>> {
    return getLogsInternal(appName, this.appsDir, this.dataDir, this.allowedPaths, options);
  }

  startLogStream(
    streamId: string,
    appName: string,
    options: LogStreamPayload,
    onLine: (line: LogStreamLine) => void,
    onError: (error: string) => void
  ): boolean {
    return this.logStreamManager.startStream(streamId, appName, options, onLine, onError);
  }

  stopLogStream(streamId: string): boolean {
    return this.logStreamManager.stopStream(streamId);
  }

  stopAllLogStreams(): void {
    this.logStreamManager.stopAll();
  }

  getActiveStreamCount(): number {
    return this.logStreamManager.getCount();
  }

  // ===============================
  // Service Control
  // ===============================

  async systemctl(action: string, service: string): Promise<void> {
    return systemctlInternal(action, service, {
      runningProcesses: this.runningProcesses,
      appsDir: this.appsDir,
    });
  }

  // ===============================
  // Mount Operations
  // ===============================

  async mountStorage(payload: MountCommandPayload): Promise<void> {
    return mountStorageInternal(payload);
  }

  async unmountStorage(mountPoint: string): Promise<void> {
    return unmountStorageInternal(mountPoint);
  }

  async checkMount(mountPoint: string): Promise<MountCheckResult> {
    return checkMountInternal(mountPoint);
  }

  // ===============================
  // Keepalived
  // ===============================

  async configureKeepalived(config: string, enabled: boolean): Promise<void> {
    return configureKeepalivedInternal(config, enabled);
  }

  async checkKeepalived(): Promise<{ installed: boolean; running: boolean; state?: string }> {
    return checkKeepalivedInternal();
  }

  // ===============================
  // Certificates
  // ===============================

  async installCertificate(certPem: string, keyPem: string, caCertPem: string | undefined, paths: {
    certPath: string;
    keyPath: string;
    caPath?: string;
  }): Promise<void> {
    // Validate paths
    const certPath = this.validatePath(paths.certPath);
    const keyPath = this.validatePath(paths.keyPath);

    // Create directories if needed
    const certDir = dirname(certPath);
    const keyDir = dirname(keyPath);

    if (!existsSync(certDir)) {
      mkdirSync(certDir, { recursive: true });
    }
    if (!existsSync(keyDir)) {
      mkdirSync(keyDir, { recursive: true });
    }

    // Write certificate (readable by services)
    writeFileSync(certPath, certPem, { mode: 0o644 });
    executorLogger.info(`Wrote certificate to ${certPath}`);

    // Write private key (restricted permissions)
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    executorLogger.info(`Wrote private key to ${keyPath}`);

    // Write CA certificate if provided
    if (caCertPem && paths.caPath) {
      const caPath = this.validatePath(paths.caPath);
      const caDir = dirname(caPath);
      if (!existsSync(caDir)) {
        mkdirSync(caDir, { recursive: true });
      }
      writeFileSync(caPath, caCertPem, { mode: 0o644 });
      executorLogger.info(`Wrote CA certificate to ${caPath}`);
    }
  }

  // ===============================
  // File Operations
  // ===============================

  private requiresPrivilege(filePath: string): boolean {
    const systemPrefixes = [
      '/etc/',
      '/var/lib/caddy/',
      '/var/lib/step-ca/',
      '/var/log/',
      '/run/',
      '/usr/',
    ];
    return systemPrefixes.some(prefix => filePath.startsWith(prefix));
  }

  private async writeFiles(files: ConfigFile[]): Promise<void> {
    for (const file of files) {
      // Validate path to prevent path traversal attacks
      const safePath = this.validatePath(file.path);
      const dir = dirname(safePath);

      // Check if this requires privileged access
      const needsPrivilege = this.requiresPrivilege(safePath);

      if (needsPrivilege) {
        // Use privileged helper for system paths
        try {
          // Create directory via privileged helper
          if (!existsSync(dir)) {
            const dirResult = await privilegedClient.createDirectory(dir);
            if (!dirResult.success) {
              executorLogger.warn(`Failed to create directory ${dir} via helper: ${dirResult.error}`);
            }
          }

          // Write file via privileged helper
          const writeResult = await privilegedClient.writeFile(
            safePath,
            file.content,
            file.owner,
            file.mode
          );
          if (!writeResult.success) {
            throw new Error(`Failed to write ${safePath} via helper: ${writeResult.error}`);
          }
          executorLogger.info(`Wrote file (via helper): ${safePath}`);
        } catch (err) {
          // Fall back to direct write (may fail without privileges)
          executorLogger.warn(`Privileged helper failed, attempting direct write: ${err}`);
          await this.writeFileDirect(safePath, file);
        }
      } else {
        // Direct write for non-privileged paths (e.g., /opt/ownprem/apps/)
        await this.writeFileDirect(safePath, file);
      }
    }
  }

  private async writeFileDirect(safePath: string, file: ConfigFile): Promise<void> {
    const dir = dirname(safePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(safePath, file.content);

    if (file.mode) {
      const safeMode = validateMode(file.mode);
      chmodSync(safePath, parseInt(safeMode, 8));
    }

    if (file.owner) {
      try {
        const safeOwner = validateOwner(file.owner);
        const result = await privilegedClient.setOwnership(safePath, safeOwner);
        if (!result.success) {
          const spawnResult = spawnSync('chown', [safeOwner, safePath], { stdio: 'pipe' });
          if (spawnResult.status !== 0) {
            const stderr = spawnResult.stderr?.toString() || 'Unknown error';
            executorLogger.warn(`Failed to change owner of ${safePath}: ${stderr}`);
          }
        }
      } catch (err) {
        executorLogger.warn(`Failed to change owner of ${safePath}: ${err}`);
      }
    }

    executorLogger.info(`Wrote file: ${safePath}`);
  }

  private async runScript(
    script: string,
    env: Record<string, string | undefined>,
    timeoutMs: number = SCRIPT_TIMEOUT_MS,
    limits: ResourceLimits = DEFAULT_SCRIPT_LIMITS
  ): Promise<void> {
    // Validate script path to prevent path traversal
    const safeScript = this.validatePath(script);

    // Verify the script exists and is a file
    if (!existsSync(safeScript)) {
      throw new Error(`Script not found: ${safeScript}`);
    }

    return new Promise((resolve, reject) => {
      executorLogger.info({ script: safeScript, timeoutMs, limits }, 'Running script with resource limits');

      // Spawn with resource limits and detached process group
      const proc = spawnScript(safeScript, env, limits, true);

      const pgid = proc.pid!;

      // Capture stdout/stderr for logging instead of inheriting
      proc.stdout?.on('data', (data: Buffer) => {
        executorLogger.info({ script: safeScript }, data.toString().trim());
      });
      proc.stderr?.on('data', (data: Buffer) => {
        executorLogger.error({ script: safeScript }, data.toString().trim());
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      // Set up timeout
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          executorLogger.error({ script: safeScript, timeoutMs, pgid }, 'Script execution timed out, killing process group');

          // Kill entire process group with escalating signals
          killProcessGroupUtil(pgid, 5000).catch(err => {
            executorLogger.error({ script: safeScript, pgid, err }, 'Error killing process group');
          });
        }, timeoutMs);
      }

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      };

      proc.on('close', (code) => {
        cleanup();
        if (timedOut) {
          reject(new Error(`Script ${safeScript} timed out after ${timeoutMs}ms`));
        } else if (code === 0) {
          executorLogger.info({ script: safeScript }, 'Script completed');
          resolve();
        } else {
          reject(new Error(`Script ${safeScript} failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  // ===============================
  // Cleanup
  // ===============================

  async stopAllDevProcesses(): Promise<void> {
    await stopAllDevProcesses(this.runningProcesses);
  }

  async cleanup(): Promise<void> {
    executorLogger.info('Cleaning up executor resources');
    this.stopAllLogStreams();
    await this.stopAllDevProcesses();
  }

  getRunningProcessCount(): number {
    return this.runningProcesses.size;
  }
}
