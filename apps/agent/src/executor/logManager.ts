/**
 * Log reading and streaming functionality.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import type { LogRequestPayload, LogResult, LogStreamPayload, LogStreamLine } from '@ownprem/shared';
import { APP_NAME_PATTERN, MAX_LOG_LINES } from './executorTypes.js';
import { validatePath } from './validation.js';
import logger from '../lib/logger.js';

const logLogger = logger.child({ component: 'logManager' });

/**
 * Get logs for an app from journalctl or file.
 */
export async function getLogs(
  appName: string,
  appsDir: string,
  dataDir: string,
  allowedPaths: string[],
  options: LogRequestPayload = {}
): Promise<Omit<LogResult, 'commandId'>> {
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
    const journalResult = await getJournalctlLogs(serviceName, lines, options.since, options.grep);
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
  return getFileLogs(appName, appsDir, dataDir, allowedPaths, lines, options.grep, options.logPath);
}

async function getJournalctlLogs(
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

function getFileLogs(
  appName: string,
  appsDir: string,
  dataDir: string,
  allowedPaths: string[],
  lines: number,
  grep?: string,
  customLogPath?: string
): Omit<LogResult, 'commandId'> {
  // Build list of paths to try
  const pathsToTry: string[] = [];
  const appDir = `${appsDir}/${appName}`;
  const appDataDir = `${dataDir}/${appName}`;

  // If custom log path is provided, expand variables and try it first
  if (customLogPath) {
    const expandedPath = customLogPath
      .replace(/\$\{appName\}/g, appName)
      .replace(/\$\{appDir\}/g, appDir)
      .replace(/\$\{dataDir\}/g, appDataDir);
    // Validate expanded path to prevent path traversal attacks
    try {
      const validatedPath = validatePath(expandedPath, allowedPaths);
      pathsToTry.push(validatedPath);
    } catch (err) {
      logLogger.warn(
        { appName, customLogPath, expandedPath },
        'Custom log path failed validation, skipping'
      );
    }
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
      return readLogFile(logPath, allowedPaths, lines, grep);
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

function readLogFile(
  logPath: string,
  allowedPaths: string[],
  lines: number,
  grep?: string
): Omit<LogResult, 'commandId'> {
  try {
    // Validate path
    const normalizedPath = validatePath(logPath, allowedPaths);

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

/**
 * Log stream manager for real-time log streaming.
 */
export class LogStreamManager {
  private activeStreams: Map<string, ChildProcess> = new Map();
  private appsDir: string;
  private dataDir: string;
  private allowedPaths: string[];

  constructor(appsDir: string, dataDir: string, allowedPaths: string[]) {
    this.appsDir = appsDir;
    this.dataDir = dataDir;
    this.allowedPaths = allowedPaths;
  }

  /**
   * Start streaming logs for an app.
   */
  startStream(
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
    if (this.activeStreams.has(streamId)) {
      logLogger.warn({ streamId, appName }, 'Stream already exists');
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
        logLogger.warn({ streamId, appName }, `Stream stderr: ${data.toString()}`);
      });

      proc.on('error', (err) => {
        logLogger.error({ streamId, appName, err }, 'Stream process error');
        onError(err.message);
        this.activeStreams.delete(streamId);
      });

      proc.on('close', (code) => {
        logLogger.info({ streamId, appName, code }, 'Log stream closed');
        this.activeStreams.delete(streamId);
      });

      this.activeStreams.set(streamId, proc);
      logLogger.info({ streamId, appName, serviceName }, 'Started log stream');

      // If journalctl exits immediately, the service might not exist
      setTimeout(() => {
        if (!started && proc.exitCode !== null && source === 'auto') {
          // journalctl failed immediately, try file-based streaming
          this.activeStreams.delete(streamId);
          this.startFileStream(streamId, appName, options, onLine, onError);
        }
      }, 1000);

      return true;
    }

    // File-based log streaming
    return this.startFileStream(streamId, appName, options, onLine, onError);
  }

  private startFileStream(
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
      try {
        const validatedPath = validatePath(expandedPath, this.allowedPaths);
        pathsToTry.push(validatedPath);
      } catch (err) {
        logLogger.warn(
          { appName, logPath: options.logPath, expandedPath },
          'Custom log path failed validation, skipping'
        );
      }
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
      validatePath(logPath, this.allowedPaths);
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
      logLogger.warn({ streamId, appName }, `Stream stderr: ${data.toString()}`);
    });

    proc.on('error', (err) => {
      logLogger.error({ streamId, appName, err }, 'Stream process error');
      onError(err.message);
      this.activeStreams.delete(streamId);
    });

    proc.on('close', (code) => {
      logLogger.info({ streamId, appName, code }, 'Log stream closed');
      this.activeStreams.delete(streamId);
    });

    this.activeStreams.set(streamId, proc);
    logLogger.info({ streamId, appName, logPath }, 'Started file-based log stream');

    return true;
  }

  /**
   * Stop a log stream.
   */
  stopStream(streamId: string): boolean {
    const proc = this.activeStreams.get(streamId);
    if (!proc) {
      logLogger.warn({ streamId }, 'Stream not found');
      return false;
    }

    try {
      proc.kill('SIGTERM');
      this.activeStreams.delete(streamId);
      logLogger.info({ streamId }, 'Stopped log stream');
      return true;
    } catch (err) {
      logLogger.error({ streamId, err }, 'Failed to stop log stream');
      return false;
    }
  }

  /**
   * Stop all active log streams (for cleanup on shutdown).
   */
  stopAll(): void {
    for (const [streamId, proc] of this.activeStreams) {
      try {
        proc.kill('SIGTERM');
        logLogger.info({ streamId }, 'Stopped log stream during cleanup');
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.activeStreams.clear();
  }

  /**
   * Get active stream count (for monitoring).
   */
  getCount(): number {
    return this.activeStreams.size;
  }
}
