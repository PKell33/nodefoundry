import { spawnSync, spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, statSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs';
import { dirname, resolve, normalize } from 'path';
import { tmpdir } from 'os';
import type { CommandPayload, ConfigFile, LogRequestPayload, LogResult, LogStreamPayload, LogStreamLine, MountCommandPayload, MountCheckResult } from '@ownprem/shared';
import { privilegedClient } from './privilegedClient.js';
import logger from './lib/logger.js';

const executorLogger = logger.child({ component: 'executor' });

// Allowed base directories for file operations
const ALLOWED_PATH_PREFIXES = [
  '/opt/ownprem/',
  '/etc/ownprem/',
  '/var/lib/ownprem/',
  '/var/log/ownprem/',
  // System app paths (for CA and Caddy)
  '/etc/caddy/',
  '/etc/step-ca/',
  '/var/lib/caddy/',
  '/var/lib/step-ca/',
];

// Valid owner format: user or user:group (alphanumeric, underscore, hyphen)
const OWNER_PATTERN = /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?$/i;

// Valid file mode (octal)
const MODE_PATTERN = /^[0-7]{3,4}$/;

// Valid app name pattern (alphanumeric, hyphen, underscore, dots)
const APP_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// Maximum log lines to return
const MAX_LOG_LINES = 1000;

// Script execution timeout (8 minutes - gives buffer before 10-minute command timeout)
const SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;

// Mount point validation: must be absolute path with allowed characters
const MOUNT_POINT_PATTERN = /^\/[a-zA-Z0-9/_-]+$/;

// NFS source validation: host:/path
const NFS_SOURCE_PATTERN = /^[a-zA-Z0-9.-]+:\/[a-zA-Z0-9/_-]+$/;

// CIFS source validation: //host/share
const CIFS_SOURCE_PATTERN = /^\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9_-]+$/;

// Allowed mount options whitelist
const ALLOWED_MOUNT_OPTIONS = new Set([
  // NFS options
  'vers=3', 'vers=4', 'vers=4.0', 'vers=4.1', 'vers=4.2',
  'rw', 'ro', 'sync', 'async',
  'noatime', 'atime', 'nodiratime', 'relatime',
  'hard', 'soft', 'intr', 'nointr',
  'rsize=8192', 'rsize=16384', 'rsize=32768', 'rsize=65536', 'rsize=131072', 'rsize=262144', 'rsize=524288', 'rsize=1048576',
  'wsize=8192', 'wsize=16384', 'wsize=32768', 'wsize=65536', 'wsize=131072', 'wsize=262144', 'wsize=524288', 'wsize=1048576',
  'timeo=60', 'timeo=120', 'timeo=300', 'timeo=600',
  'retrans=2', 'retrans=3', 'retrans=5',
  'tcp', 'udp',
  'nfsvers=3', 'nfsvers=4', 'nfsvers=4.0', 'nfsvers=4.1', 'nfsvers=4.2',
  // CIFS options
  'uid=1000', 'gid=1000', 'uid=0', 'gid=0',
  'file_mode=0755', 'file_mode=0644', 'dir_mode=0755', 'dir_mode=0644',
  'nobrl', 'nolock', 'noperm',
  'sec=ntlm', 'sec=ntlmv2', 'sec=ntlmssp', 'sec=krb5', 'sec=krb5i', 'sec=none',
  'iocharset=utf8',
  // Common options
  'defaults', 'noexec', 'nosuid', 'nodev',
]);

export class Executor {
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private activeLogStreams: Map<string, ChildProcess> = new Map();
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
      // In dev mode, appsDir might be outside /opt/ownprem
      this.allowedPaths.push(this.appsDir + '/');
    }
    if (!this.allowedPaths.some(p => this.dataDir.startsWith(p))) {
      // In dev mode, dataDir might be outside standard paths
      this.allowedPaths.push(this.dataDir + '/');
    }
  }

  /**
   * Validates that a path is within allowed directories to prevent path traversal
   */
  private validatePath(filePath: string): string {
    // Normalize and resolve the path
    const normalizedPath = normalize(resolve(filePath));

    // Check if path is within allowed directories
    const isAllowed = this.allowedPaths.some(prefix =>
      normalizedPath.startsWith(prefix) || normalizedPath === prefix.slice(0, -1)
    );

    if (!isAllowed) {
      throw new Error(`Path traversal attempt blocked: ${filePath} is outside allowed directories`);
    }

    // Check for path traversal attempts in the original path
    if (filePath.includes('..')) {
      throw new Error(`Path traversal attempt blocked: ${filePath} contains '..'`);
    }

    return normalizedPath;
  }

  /**
   * Validates owner string format to prevent command injection
   */
  private validateOwner(owner: string): string {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error(`Invalid owner format: ${owner}. Expected format: user or user:group`);
    }
    return owner;
  }

  /**
   * Validates file mode format
   */
  private validateMode(mode: string): string {
    if (!MODE_PATTERN.test(mode)) {
      throw new Error(`Invalid file mode: ${mode}. Expected octal format (e.g., 755)`);
    }
    return mode;
  }

  async install(appName: string, payload: CommandPayload): Promise<void> {
    const appDir = `${this.appsDir}/${appName}`;
    mkdirSync(appDir, { recursive: true });

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
      });
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
      } catch {
        // Ignore metadata parse errors
      }
    }

    // Stop service first
    await this.systemctl('stop', appName).catch(() => {
      // Ignore errors if service doesn't exist
    });

    // Disable service
    await this.systemctl('disable', appName).catch(() => {
      // Ignore errors
    });

    // Unregister the service from privileged helper
    try {
      const unregisterResult = await privilegedClient.unregisterService(serviceName);
      if (unregisterResult.success) {
        executorLogger.info(`Unregistered service: ${serviceName}`);
      }
    } catch {
      // Ignore errors - service may not have been registered
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

  async getLogs(appName: string, options: LogRequestPayload = {}): Promise<Omit<LogResult, 'commandId'>> {
    // Validate app name to prevent injection
    if (!APP_NAME_PATTERN.test(appName)) {
      return {
        logs: [],
        source: 'file',
        hasMore: false,
        status: 'error',
        message: `Invalid app name: ${appName}`,
      };
    }

    const lines = Math.min(options.lines || 100, MAX_LOG_LINES);
    const source = options.source || 'auto';
    const serviceName = options.serviceName || appName;

    // Try journalctl first (for systemd services)
    if (source === 'auto' || source === 'journalctl') {
      const journalResult = await this.getJournalctlLogs(serviceName, lines, options.since, options.grep);
      // Check if we got actual logs (not just "-- No entries --")
      const hasRealLogs = journalResult.status === 'success' &&
        journalResult.logs.length > 0 &&
        !(journalResult.logs.length === 1 && journalResult.logs[0].includes('-- No entries --'));
      if (hasRealLogs) {
        return journalResult;
      }
      // If journalctl fails or returns no logs and we're on auto, try file
      if (source === 'journalctl') {
        return journalResult;
      }
    }

    // Fall back to file-based logs
    return this.getFileLogs(appName, lines, options.grep, options.logPath);
  }

  private async getJournalctlLogs(
    appName: string,
    lines: number,
    since?: string,
    grep?: string
  ): Promise<Omit<LogResult, 'commandId'>> {
    const args = ['--no-pager', '-u', appName, '-n', lines.toString(), '--output=short-iso'];

    if (since) {
      // Validate since format (ISO date or relative like "1h", "30m")
      if (/^\d{4}-\d{2}-\d{2}/.test(since) || /^\d+[smhd]$/.test(since)) {
        args.push('--since', since);
      }
    }

    try {
      const result = spawnSync('journalctl', args, {
        encoding: 'utf-8',
        timeout: 10000,
      });

      if (result.status !== 0) {
        // journalctl failed - might not be a systemd service
        return {
          logs: [],
          source: 'journalctl',
          hasMore: false,
          status: 'error',
          message: result.stderr || 'journalctl failed',
        };
      }

      let logLines = result.stdout.split('\n').filter(line => line.trim());

      // Apply grep filter if provided
      if (grep && logLines.length > 0) {
        const grepPattern = new RegExp(grep, 'i');
        logLines = logLines.filter(line => grepPattern.test(line));
      }

      return {
        logs: logLines,
        source: 'journalctl',
        hasMore: logLines.length >= lines,
        status: 'success',
      };
    } catch (err) {
      return {
        logs: [],
        source: 'journalctl',
        hasMore: false,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to read journalctl logs',
      };
    }
  }

  private getFileLogs(
    appName: string,
    lines: number,
    grep?: string,
    customLogPath?: string
  ): Omit<LogResult, 'commandId'> {
    // Build list of paths to try
    const pathsToTry: string[] = [];
    const appDir = `${this.appsDir}/${appName}`;
    const appDataDir = `${this.dataDir}/${appName}`;

    // If custom log path is provided, expand variables and try it first
    if (customLogPath) {
      const expandedPath = customLogPath
        .replace(/\$\{appName\}/g, appName)
        .replace(/\$\{appDir\}/g, appDir)
        .replace(/\$\{dataDir\}/g, appDataDir);
      pathsToTry.push(expandedPath);
    }

    // Standard paths
    pathsToTry.push(`/var/log/ownprem/${appName}.log`);
    pathsToTry.push(`${appDir}/logs/${appName}.log`);

    // Common debug.log locations (used by various apps)
    pathsToTry.push(`${appDataDir}/debug.log`);
    pathsToTry.push(`${appDir}/data/debug.log`);

    // Try each path
    for (const logPath of pathsToTry) {
      if (existsSync(logPath)) {
        return this.readLogFile(logPath, lines, grep);
      }
    }

    return {
      logs: [],
      source: 'file',
      hasMore: false,
      status: 'error',
      message: `Log file not found. Tried: ${pathsToTry.join(', ')}`,
    };
  }

  private readLogFile(
    logPath: string,
    lines: number,
    grep?: string
  ): Omit<LogResult, 'commandId'> {
    try {
      // Validate path
      const normalizedPath = this.validatePath(logPath);

      // Read file (limit to last 5MB to prevent memory issues)
      const stats = statSync(normalizedPath);
      const maxBytes = 5 * 1024 * 1024;
      let content: string;

      if (stats.size > maxBytes) {
        // Read only the last 5MB of the file
        const fd = require('fs').openSync(normalizedPath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        require('fs').readSync(fd, buffer, 0, maxBytes, stats.size - maxBytes);
        require('fs').closeSync(fd);
        content = buffer.toString('utf-8');
      } else {
        content = readFileSync(normalizedPath, 'utf-8');
      }

      let logLines = content.split('\n').filter(line => line.trim());

      // Apply grep filter if provided
      if (grep) {
        const grepPattern = new RegExp(grep, 'i');
        logLines = logLines.filter(line => grepPattern.test(line));
      }

      // Take last N lines
      const totalLines = logLines.length;
      logLines = logLines.slice(-lines);

      return {
        logs: logLines,
        source: 'file',
        hasMore: totalLines > lines,
        status: 'success',
      };
    } catch (err) {
      return {
        logs: [],
        source: 'file',
        hasMore: false,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to read log file',
      };
    }
  }

  async systemctl(action: string, service: string): Promise<void> {
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
    const metadataPath = `${this.appsDir}/${service}/.ownprem.json`;
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        if (metadata.serviceName) {
          actualServiceName = metadata.serviceName;
          executorLogger.info(`Using service name from metadata: ${actualServiceName} (app: ${service})`);
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
        executorLogger.info(`systemctl ${action} ${actualServiceName} succeeded via privileged helper`);
        return;
      }
      executorLogger.info(`Privileged helper systemctl failed: ${result.error}, trying fallback`);
    } catch (err) {
      // Privileged helper not available, try direct or dev mode
      executorLogger.info(`Privileged helper not available: ${err}, trying fallback`);
    }

    // Fallback: try direct systemctl (works if running as root in dev)
    try {
      await this.runSystemctl(action, actualServiceName);
      return;
    } catch (err) {
      // If systemctl fails, try dev mode fallback
      executorLogger.info(`Direct systemctl failed, trying dev mode fallback for ${action} ${service}`);
    }

    // Dev mode fallback (uses start.sh/stop.sh scripts)
    const appDir = `${this.appsDir}/${service}`;
    const startScript = `${appDir}/start.sh`;

    if (action === 'start') {
      if (existsSync(startScript)) {
        // Check if already running
        const existingProc = this.runningProcesses.get(service);
        if (existingProc && existingProc.pid) {
          try {
            // Check if process is still alive (kill with signal 0 just checks)
            process.kill(existingProc.pid, 0);
            executorLogger.info(`${service} already running (pid: ${existingProc.pid})`);
            return;
          } catch {
            // Process not running, clean up stale entry
            this.runningProcesses.delete(service);
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

        proc.stdout?.on('data', (data) => executorLogger.info(`[${service}] ${data.toString().trim()}`));
        proc.stderr?.on('data', (data) => executorLogger.error(`[${service}] ${data.toString().trim()}`));

        // Track the process and handle unexpected termination
        this.runningProcesses.set(service, proc);

        proc.on('exit', (code, signal) => {
          // Clean up tracking when process exits
          if (this.runningProcesses.get(service) === proc) {
            this.runningProcesses.delete(service);
            if (code !== 0 && code !== null) {
              executorLogger.warn({ service, code, signal }, 'Dev mode process exited unexpectedly');
            }
          }
        });

        proc.unref();
        executorLogger.info(`Started ${service} in dev mode (pid: ${proc.pid}, pgid: ${proc.pid})`);
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
          executorLogger.error(`stop.sh failed: ${result.stderr?.toString()}`);
        }
      }

      // Kill the entire process group to ensure all children are terminated
      const proc = this.runningProcesses.get(service);
      if (proc && proc.pid) {
        this.killProcessGroup(proc.pid, service);
        this.runningProcesses.delete(service);
      }
      executorLogger.info(`Stopped ${service} in dev mode`);
    } else if (action === 'restart') {
      await this.systemctl('stop', service);
      await this.systemctl('start', service);
    }
  }

  /**
   * Kill a process group with escalating signals.
   * First tries SIGTERM, then SIGKILL if process doesn't exit.
   */
  private killProcessGroup(pid: number, service: string): void {
    // Try to kill the process group (negative PID)
    try {
      process.kill(-pid, 'SIGTERM');
      executorLogger.debug({ service, pid }, 'Sent SIGTERM to process group');
    } catch (err) {
      // Process group might not exist, try individual process
      try {
        process.kill(pid, 'SIGTERM');
        executorLogger.debug({ service, pid }, 'Sent SIGTERM to process');
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
        executorLogger.warn({ service, pid }, 'Process did not respond to SIGTERM, sent SIGKILL');
      } catch {
        // Process is dead, good
      }
    }, 3000);
  }

  private runSystemctl(action: string, service: string): Promise<void> {
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

  /**
   * Check if a path requires privileged access (system directories)
   */
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
      // Validate mode format
      const safeMode = this.validateMode(file.mode);
      chmodSync(safePath, parseInt(safeMode, 8));
    }

    if (file.owner) {
      try {
        // Validate owner format to prevent command injection
        const safeOwner = this.validateOwner(file.owner);
        // Try privileged helper first for chown
        const result = await privilegedClient.setOwnership(safePath, safeOwner);
        if (!result.success) {
          // Fall back to direct chown (may fail)
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
    timeoutMs: number = SCRIPT_TIMEOUT_MS
  ): Promise<void> {
    // Validate script path to prevent path traversal
    const safeScript = this.validatePath(script);

    // Verify the script exists and is a file
    if (!existsSync(safeScript)) {
      throw new Error(`Script not found: ${safeScript}`);
    }

    return new Promise((resolve, reject) => {
      executorLogger.info({ script: safeScript, timeoutMs }, 'Running script');

      const proc = spawn('bash', [safeScript], {
        stdio: 'inherit',
        env: env as NodeJS.ProcessEnv,
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      // Set up timeout
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          executorLogger.error({ script: safeScript, timeoutMs }, 'Script execution timed out, killing process');

          // Try graceful shutdown first
          proc.kill('SIGTERM');

          // Force kill after 5 seconds if still running
          setTimeout(() => {
            if (!proc.killed) {
              executorLogger.warn({ script: safeScript }, 'Script did not respond to SIGTERM, sending SIGKILL');
              proc.kill('SIGKILL');
            }
          }, 5000);
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

  /**
   * Validates mount point path
   */
  private validateMountPoint(mountPoint: string): string {
    if (!MOUNT_POINT_PATTERN.test(mountPoint)) {
      throw new Error(`Invalid mount point: ${mountPoint}. Must be an absolute path with alphanumeric characters, underscores, and hyphens.`);
    }
    // Normalize to prevent path traversal
    const normalized = normalize(mountPoint);
    if (normalized !== mountPoint || mountPoint.includes('..')) {
      throw new Error(`Invalid mount point: path traversal attempt detected`);
    }
    return normalized;
  }

  /**
   * Validates NFS or CIFS source
   */
  private validateMountSource(source: string, mountType: 'nfs' | 'cifs'): string {
    if (mountType === 'nfs') {
      if (!NFS_SOURCE_PATTERN.test(source)) {
        throw new Error(`Invalid NFS source: ${source}. Expected format: hostname:/path`);
      }
    } else if (mountType === 'cifs') {
      if (!CIFS_SOURCE_PATTERN.test(source)) {
        throw new Error(`Invalid CIFS source: ${source}. Expected format: //hostname/share`);
      }
    } else {
      throw new Error(`Unknown mount type: ${mountType}`);
    }
    return source;
  }

  /**
   * Validates mount options against whitelist
   */
  private validateMountOptions(options: string): string {
    const opts = options.split(',').map(o => o.trim()).filter(o => o);
    const invalidOpts: string[] = [];

    for (const opt of opts) {
      // Check for exact match or pattern match for parameterized options
      const isValid = ALLOWED_MOUNT_OPTIONS.has(opt) ||
        // Allow uid/gid with any numeric value
        /^uid=\d+$/.test(opt) ||
        /^gid=\d+$/.test(opt) ||
        // Allow rsize/wsize with reasonable values
        /^rsize=\d+$/.test(opt) ||
        /^wsize=\d+$/.test(opt) ||
        // Allow timeo/retrans with reasonable values
        /^timeo=\d+$/.test(opt) ||
        /^retrans=\d+$/.test(opt) ||
        // Allow file_mode/dir_mode with octal values
        /^file_mode=0[0-7]{3}$/.test(opt) ||
        /^dir_mode=0[0-7]{3}$/.test(opt);

      if (!isValid) {
        invalidOpts.push(opt);
      }
    }

    if (invalidOpts.length > 0) {
      throw new Error(`Invalid mount options: ${invalidOpts.join(', ')}`);
    }

    return opts.join(',');
  }

  /**
   * Mount network storage (NFS or CIFS)
   */
  async mountStorage(payload: MountCommandPayload): Promise<void> {
    const { mountType, source, mountPoint, options, credentials } = payload;

    // Validate inputs (agent-side validation for early feedback)
    const safeMountPoint = this.validateMountPoint(mountPoint);
    const safeSource = this.validateMountSource(source, mountType);
    const safeOptions = options ? this.validateMountOptions(options) : undefined;

    // Check if already mounted
    const checkResult = await this.checkMount(safeMountPoint);
    if (checkResult.mounted) {
      executorLogger.info(`Already mounted: ${safeMountPoint}`);
      return;
    }

    executorLogger.info(`Mounting ${mountType.toUpperCase()}: ${safeSource} -> ${safeMountPoint}`);

    // Use privileged helper for mount operation
    try {
      const result = await privilegedClient.mount(
        mountType,
        safeSource,
        safeMountPoint,
        safeOptions,
        credentials
      );

      if (!result.success) {
        throw new Error(`Mount failed: ${result.error}`);
      }

      executorLogger.info(`Successfully mounted: ${safeMountPoint}`);
    } catch (err) {
      // Privileged helper not available, try direct mount (requires root)
      executorLogger.warn(`Privileged helper failed, attempting direct mount: ${err}`);
      await this.mountStorageDirect(payload);
    }
  }

  /**
   * Direct mount (fallback when privileged helper is unavailable)
   */
  private async mountStorageDirect(payload: MountCommandPayload): Promise<void> {
    const { mountType, source, mountPoint, options, credentials } = payload;

    const safeMountPoint = this.validateMountPoint(mountPoint);
    const safeSource = this.validateMountSource(source, mountType);
    const safeOptions = options ? this.validateMountOptions(options) : null;

    // Create mount point directory if it doesn't exist
    if (!existsSync(safeMountPoint)) {
      mkdirSync(safeMountPoint, { recursive: true });
      executorLogger.info(`Created mount point: ${safeMountPoint}`);
    }

    // Build mount command args
    const args: string[] = ['-t', mountType];

    if (mountType === 'cifs' && credentials) {
      // Create a secure temporary directory with restricted permissions
      // Using mkdtempSync ensures unpredictable directory name
      let credDir: string | null = null;
      let credFile: string | null = null;

      try {
        // Create temp directory in /run (tmpfs, not persisted to disk)
        // Fall back to system temp if /run is not available
        const tempBase = existsSync('/run') ? '/run' : tmpdir();
        credDir = mkdtempSync(`${tempBase}/ownprem-mount-`);
        credFile = `${credDir}/credentials`;

        // Write credentials with strict permissions (owner read only)
        let credContent = `username=${credentials.username}\npassword=${credentials.password}\n`;
        if (credentials.domain) {
          credContent += `domain=${credentials.domain}\n`;
        }
        writeFileSync(credFile, credContent, { mode: 0o400 });

        const credOptions = `credentials=${credFile}`;
        const allOptions = safeOptions ? `${credOptions},${safeOptions}` : credOptions;
        args.push('-o', allOptions);
        args.push(safeSource, safeMountPoint);

        const result = spawnSync('mount', args, {
          encoding: 'utf-8',
          timeout: 30000,
        });

        if (result.status !== 0) {
          throw new Error(`Mount failed: ${result.stderr || 'Unknown error'}`);
        }
      } finally {
        // Always clean up credentials - this runs even if mount throws
        if (credFile) {
          try {
            // Overwrite file content before deletion to prevent recovery
            writeFileSync(credFile, '0'.repeat(256), { mode: 0o400 });
            unlinkSync(credFile);
          } catch {
            // Log but don't fail - credential cleanup is best effort
            executorLogger.warn('Failed to clean up credential file');
          }
        }
        if (credDir) {
          try {
            rmdirSync(credDir);
          } catch {
            // Directory removal is best effort
          }
        }
      }
    } else {
      // NFS or CIFS without credentials
      if (safeOptions) {
        args.push('-o', safeOptions);
      }
      args.push(safeSource, safeMountPoint);

      const result = spawnSync('mount', args, {
        encoding: 'utf-8',
        timeout: 30000,
      });

      if (result.status !== 0) {
        throw new Error(`Mount failed: ${result.stderr || 'Unknown error'}`);
      }
    }

    executorLogger.info(`Successfully mounted: ${safeMountPoint}`);
  }

  /**
   * Unmount network storage
   */
  async unmountStorage(mountPoint: string): Promise<void> {
    const safeMountPoint = this.validateMountPoint(mountPoint);

    // Check if mounted
    const checkResult = await this.checkMount(safeMountPoint);
    if (!checkResult.mounted) {
      executorLogger.info(`Not mounted: ${safeMountPoint}`);
      return;
    }

    executorLogger.info(`Unmounting: ${safeMountPoint}`);

    // Use privileged helper for unmount operation
    try {
      const result = await privilegedClient.umount(safeMountPoint);

      if (!result.success) {
        throw new Error(`Unmount failed: ${result.error}`);
      }

      executorLogger.info(`Successfully unmounted: ${safeMountPoint}`);
    } catch (err) {
      // Privileged helper not available, try direct umount (requires root)
      executorLogger.warn(`Privileged helper failed, attempting direct unmount: ${err}`);

      const result = spawnSync('umount', [safeMountPoint], {
        encoding: 'utf-8',
        timeout: 30000,
      });

      if (result.status !== 0) {
        throw new Error(`Unmount failed: ${result.stderr || 'Unknown error'}`);
      }

      executorLogger.info(`Successfully unmounted: ${safeMountPoint}`);
    }
  }

  /**
   * Check if a mount point is mounted and get usage stats
   */
  async checkMount(mountPoint: string): Promise<MountCheckResult> {
    const safeMountPoint = this.validateMountPoint(mountPoint);

    // Use findmnt to check if mounted
    const findmntResult = spawnSync('findmnt', ['-n', safeMountPoint], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const mounted = findmntResult.status === 0 && findmntResult.stdout.trim().length > 0;

    if (!mounted) {
      return { mounted: false };
    }

    // Get usage stats with df
    const dfResult = spawnSync('df', ['-B1', safeMountPoint], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (dfResult.status !== 0) {
      return { mounted: true };
    }

    // Parse df output
    // Format: Filesystem 1B-blocks Used Available Use% Mounted on
    const lines = dfResult.stdout.trim().split('\n');
    if (lines.length < 2) {
      return { mounted: true };
    }

    const parts = lines[1].split(/\s+/);
    if (parts.length < 4) {
      return { mounted: true };
    }

    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);

    if (isNaN(total) || isNaN(used)) {
      return { mounted: true };
    }

    return {
      mounted: true,
      usage: { used, total },
    };
  }

  // ===============================
  // Keepalived Management
  // ===============================

  /**
   * Configure and manage keepalived for Caddy HA
   */
  async configureKeepalived(config: string, enabled: boolean): Promise<void> {
    const keepalivedConf = '/etc/keepalived/keepalived.conf';
    const keepalivedDir = dirname(keepalivedConf);

    // Create keepalived directory via privileged helper
    if (!existsSync(keepalivedDir)) {
      const dirResult = await privilegedClient.createDirectory(keepalivedDir);
      if (!dirResult.success) {
        // Fallback to direct creation
        mkdirSync(keepalivedDir, { recursive: true });
      }
      executorLogger.info(`Created keepalived directory: ${keepalivedDir}`);
    }

    // Write configuration via privileged helper
    const writeResult = await privilegedClient.writeFile(keepalivedConf, config, undefined, '644');
    if (!writeResult.success) {
      // Fallback to direct write
      writeFileSync(keepalivedConf, config, { mode: 0o644 });
    }
    executorLogger.info('Wrote keepalived configuration');

    if (enabled) {
      // Check if keepalived is installed
      const whichResult = spawnSync('which', ['keepalived'], {
        encoding: 'utf-8',
        timeout: 5000,
      });

      if (whichResult.status !== 0) {
        // Install keepalived via privileged helper
        executorLogger.info('Installing keepalived...');
        const installResult = await privilegedClient.aptInstall(['keepalived']);

        if (!installResult.success) {
          throw new Error(`Failed to install keepalived: ${installResult.error}`);
        }
        executorLogger.info('Keepalived installed');
      }

      // Enable keepalived via privileged helper
      const enableResult = await privilegedClient.systemctl('enable', 'keepalived');
      if (!enableResult.success) {
        executorLogger.warn(`Warning: Could not enable keepalived: ${enableResult.error}`);
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
        executorLogger.info('Keepalived configuration reloaded');
      } else {
        // Start the service
        const startResult = await privilegedClient.systemctl('start', 'keepalived');
        if (!startResult.success) {
          throw new Error(`Failed to start keepalived: ${startResult.error}`);
        }
        executorLogger.info('Keepalived started');
      }
    } else {
      // Stop keepalived via privileged helper
      const stopResult = await privilegedClient.systemctl('stop', 'keepalived');
      if (!stopResult.success) {
        executorLogger.warn(`Warning: Could not stop keepalived: ${stopResult.error}`);
      }

      // Disable keepalived
      await privilegedClient.systemctl('disable', 'keepalived');
      executorLogger.info('Keepalived disabled');
    }
  }

  /**
   * Check keepalived status
   */
  async checkKeepalived(): Promise<{ installed: boolean; running: boolean; state?: string }> {
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
        // Try to get VRRP state from /var/run/keepalived.*.pid or journalctl
        const journalResult = spawnSync('journalctl', ['-u', 'keepalived', '-n', '50', '--no-pager'], {
          encoding: 'utf-8',
          timeout: 5000,
        });

        if (journalResult.status === 0) {
          const output = journalResult.stdout;
          // Look for state changes in log
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
   * Install and configure a TLS certificate
   */
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
  // Log Streaming
  // ===============================

  /**
   * Start streaming logs for an app.
   * Returns a stream ID that can be used to stop the stream.
   */
  startLogStream(
    streamId: string,
    appName: string,
    options: LogStreamPayload,
    onLine: (line: LogStreamLine) => void,
    onError: (error: string) => void
  ): boolean {
    // Validate app name
    if (!APP_NAME_PATTERN.test(appName)) {
      onError(`Invalid app name: ${appName}`);
      return false;
    }

    // Check if stream already exists
    if (this.activeLogStreams.has(streamId)) {
      executorLogger.warn({ streamId, appName }, 'Stream already exists');
      return false;
    }

    const serviceName = options.serviceName || appName;
    const source = options.source || 'auto';

    // Try journalctl first (for systemd services)
    if (source === 'auto' || source === 'journalctl') {
      const args = ['--no-pager', '-u', serviceName, '-f', '--output=short-iso'];

      if (options.grep) {
        args.push('--grep', options.grep);
      }

      const proc = spawn('journalctl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let started = false;

      proc.stdout?.on('data', (data: Buffer) => {
        started = true;
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          onLine({
            streamId,
            appName,
            line,
            timestamp: new Date().toISOString(),
          });
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        executorLogger.warn({ streamId, appName }, `Stream stderr: ${data.toString()}`);
      });

      proc.on('error', (err) => {
        executorLogger.error({ streamId, appName, err }, 'Stream process error');
        onError(err.message);
        this.activeLogStreams.delete(streamId);
      });

      proc.on('close', (code) => {
        executorLogger.info({ streamId, appName, code }, 'Log stream closed');
        this.activeLogStreams.delete(streamId);
      });

      this.activeLogStreams.set(streamId, proc);
      executorLogger.info({ streamId, appName, serviceName }, 'Started log stream');

      // If journalctl exits immediately, the service might not exist
      // Give it a moment to start producing output
      setTimeout(() => {
        if (!started && proc.exitCode !== null && source === 'auto') {
          // journalctl failed immediately, try file-based streaming
          this.activeLogStreams.delete(streamId);
          this.startFileLogStream(streamId, appName, options, onLine, onError);
        }
      }, 1000);

      return true;
    }

    // File-based log streaming
    return this.startFileLogStream(streamId, appName, options, onLine, onError);
  }

  /**
   * Start file-based log streaming using tail -f
   */
  private startFileLogStream(
    streamId: string,
    appName: string,
    options: LogStreamPayload,
    onLine: (line: LogStreamLine) => void,
    onError: (error: string) => void
  ): boolean {
    const appDir = `${this.appsDir}/${appName}`;
    const appDataDir = `${this.dataDir}/${appName}`;

    // Build list of paths to try
    const pathsToTry: string[] = [];

    if (options.logPath) {
      const expandedPath = options.logPath
        .replace(/\$\{appName\}/g, appName)
        .replace(/\$\{appDir\}/g, appDir)
        .replace(/\$\{dataDir\}/g, appDataDir);
      pathsToTry.push(expandedPath);
    }

    pathsToTry.push(
      `${appDataDir}/${appName}.log`,
      `${appDataDir}/debug.log`,
      `${appDir}/${appName}.log`,
      `${appDir}/output.log`,
      `/var/log/${appName}.log`,
    );

    // Find the first existing log file
    let logPath: string | null = null;
    for (const path of pathsToTry) {
      if (existsSync(path)) {
        logPath = path;
        break;
      }
    }

    if (!logPath) {
      onError(`No log file found for ${appName}`);
      return false;
    }

    // Validate the path is within allowed directories
    try {
      this.validatePath(logPath);
    } catch (err) {
      onError(`Log path not allowed: ${logPath}`);
      return false;
    }

    const args = ['-F', '-n', '0', logPath];

    const proc = spawn('tail', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        // Apply grep filter if specified
        if (options.grep) {
          const grepPattern = new RegExp(options.grep, 'i');
          if (!grepPattern.test(line)) {
            continue;
          }
        }
        onLine({
          streamId,
          appName,
          line,
          timestamp: new Date().toISOString(),
        });
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      executorLogger.warn({ streamId, appName }, `Stream stderr: ${data.toString()}`);
    });

    proc.on('error', (err) => {
      executorLogger.error({ streamId, appName, err }, 'Stream process error');
      onError(err.message);
      this.activeLogStreams.delete(streamId);
    });

    proc.on('close', (code) => {
      executorLogger.info({ streamId, appName, code }, 'Log stream closed');
      this.activeLogStreams.delete(streamId);
    });

    this.activeLogStreams.set(streamId, proc);
    executorLogger.info({ streamId, appName, logPath }, 'Started file-based log stream');

    return true;
  }

  /**
   * Stop a log stream
   */
  stopLogStream(streamId: string): boolean {
    const proc = this.activeLogStreams.get(streamId);
    if (!proc) {
      executorLogger.warn({ streamId }, 'Stream not found');
      return false;
    }

    try {
      proc.kill('SIGTERM');
      this.activeLogStreams.delete(streamId);
      executorLogger.info({ streamId }, 'Stopped log stream');
      return true;
    } catch (err) {
      executorLogger.error({ streamId, err }, 'Failed to stop log stream');
      return false;
    }
  }

  /**
   * Stop all active log streams (for cleanup on shutdown)
   */
  stopAllLogStreams(): void {
    for (const [streamId, proc] of this.activeLogStreams) {
      try {
        proc.kill('SIGTERM');
        executorLogger.info({ streamId }, 'Stopped log stream during cleanup');
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.activeLogStreams.clear();
  }

  /**
   * Get active stream count (for monitoring)
   */
  getActiveStreamCount(): number {
    return this.activeLogStreams.size;
  }

  /**
   * Stop all running dev mode processes.
   * Called during agent shutdown to prevent zombie processes.
   */
  stopAllDevProcesses(): void {
    for (const [service, proc] of this.runningProcesses) {
      if (proc.pid) {
        executorLogger.info({ service, pid: proc.pid }, 'Stopping dev mode process during cleanup');
        this.killProcessGroup(proc.pid, service);
      }
    }
    this.runningProcesses.clear();
  }

  /**
   * Full cleanup for agent shutdown.
   * Stops all log streams and dev mode processes.
   */
  cleanup(): void {
    executorLogger.info('Cleaning up executor resources');
    this.stopAllLogStreams();
    this.stopAllDevProcesses();
  }

  /**
   * Get count of running dev mode processes (for monitoring)
   */
  getRunningProcessCount(): number {
    return this.runningProcesses.size;
  }
}
