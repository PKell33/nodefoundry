/**
 * Privileged Helper Service
 *
 * A minimal root service that executes validated privileged operations
 * on behalf of the ownprem agent. Communicates via Unix socket.
 *
 * Security model:
 * - Runs as root
 * - Only accepts connections from ownprem user (via socket permissions)
 * - Validates ALL requests against strict whitelist before execution
 * - Logs all operations for audit
 */

import { createServer, Socket } from 'net';
import { unlinkSync, existsSync, mkdirSync, chownSync, lstatSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { validateRequest, ValidationError } from './validator.js';
import { executeRequest } from './executor.js';
import type { HelperRequest, HelperResponse } from './types.js';

const SOCKET_PATH = '/run/ownprem/helper.sock';
const SOCKET_DIR = '/run/ownprem';
const REGISTERED_SERVICES_DIR = '/var/lib/ownprem/services';

// Get ownprem user ID for socket permissions
function getOwnpremUid(): number {
  const result = spawnSync('id', ['-u', 'ownprem'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    console.error('Failed to get ownprem user ID. Is the ownprem user created?');
    process.exit(1);
  }
  return parseInt(result.stdout.trim(), 10);
}

/**
 * Verify the service registry directory has correct security properties.
 * This prevents attacks where an unprivileged user could create symlinks
 * or manipulate the service registration directory.
 *
 * Requirements:
 * - Directory must exist (created during install)
 * - Must be owned by root:root
 * - Must have mode 0700 (rwx------)
 * - Must NOT be a symlink
 *
 * FAILS STARTUP with clear error if misconfigured.
 */
function verifyServiceRegistryDirectory(): void {
  // Check if directory exists
  if (!existsSync(REGISTERED_SERVICES_DIR)) {
    console.error(`SECURITY ERROR: Service registry directory does not exist: ${REGISTERED_SERVICES_DIR}`);
    console.error('This directory should be created during installation.');
    console.error('To fix manually, run:');
    console.error(`  sudo mkdir -p ${REGISTERED_SERVICES_DIR}`);
    console.error(`  sudo chown root:root ${REGISTERED_SERVICES_DIR}`);
    console.error(`  sudo chmod 0700 ${REGISTERED_SERVICES_DIR}`);
    process.exit(1);
  }

  // Check if it's a symlink (BEFORE resolving to real path)
  try {
    const lstats = lstatSync(REGISTERED_SERVICES_DIR);
    if (lstats.isSymbolicLink()) {
      console.error(`SECURITY ERROR: Service registry directory is a symlink: ${REGISTERED_SERVICES_DIR}`);
      console.error('This is not allowed for security reasons.');
      console.error('To fix, remove the symlink and create a real directory:');
      console.error(`  sudo rm ${REGISTERED_SERVICES_DIR}`);
      console.error(`  sudo mkdir -p ${REGISTERED_SERVICES_DIR}`);
      console.error(`  sudo chown root:root ${REGISTERED_SERVICES_DIR}`);
      console.error(`  sudo chmod 0700 ${REGISTERED_SERVICES_DIR}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`SECURITY ERROR: Cannot stat service registry directory: ${err}`);
    process.exit(1);
  }

  // Get directory stats (follows symlinks, but we already verified it's not a symlink)
  let stats;
  try {
    stats = statSync(REGISTERED_SERVICES_DIR);
  } catch (err) {
    console.error(`SECURITY ERROR: Cannot stat service registry directory: ${err}`);
    process.exit(1);
  }

  // Verify ownership (must be root:root, i.e., uid=0, gid=0)
  if (stats.uid !== 0 || stats.gid !== 0) {
    console.error(`SECURITY ERROR: Service registry directory has wrong ownership`);
    console.error(`  Expected: root:root (uid=0, gid=0)`);
    console.error(`  Found: uid=${stats.uid}, gid=${stats.gid}`);
    console.error('To fix, run:');
    console.error(`  sudo chown root:root ${REGISTERED_SERVICES_DIR}`);
    process.exit(1);
  }

  // Verify permissions (must be 0700)
  // mode includes file type bits, so mask with 0o777 to get just permission bits
  const perms = stats.mode & 0o777;
  if (perms !== 0o700) {
    console.error(`SECURITY ERROR: Service registry directory has wrong permissions`);
    console.error(`  Expected: 0700 (rwx------)`);
    console.error(`  Found: 0${perms.toString(8)}`);
    console.error('To fix, run:');
    console.error(`  sudo chmod 0700 ${REGISTERED_SERVICES_DIR}`);
    process.exit(1);
  }

  // Directory is secure
}

interface PeerCredentials {
  uid: number;
  gid: number;
  pid: number;
}

/**
 * Get peer credentials from a Unix socket using SO_PEERCRED.
 * This allows us to identify which process is making requests.
 *
 * TODO: Implement actual SO_PEERCRED support for enhanced audit logging.
 * Options:
 * 1. Native addon using getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)
 * 2. Use unix-dgram package which exposes peer credentials
 * 3. Parse /proc/net/unix to match socket inode to process
 *
 * Current implementation is a graceful stub - security is not compromised
 * as socket permissions (0600, ownprem user only) provide access control.
 * Peer credentials would enhance audit trail only.
 */
function getPeerCredentials(_socket: Socket): PeerCredentials | null {
  // Stub implementation - returns null until native support is added
  // The socket permission model (ownprem user only) ensures security
  return null;
}

function log(level: string, message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function handleRequest(data: string, peerCreds: PeerCredentials | null): HelperResponse {
  let request: HelperRequest;

  try {
    request = JSON.parse(data);
  } catch {
    return { success: false, error: 'Invalid JSON' };
  }

  // Log the incoming request (without sensitive content)
  const logData: Record<string, unknown> = request.action !== 'write_file'
    ? { ...request }
    : { action: 'write_file', path: (request as any).path };

  // Include peer credentials in audit log if available
  if (peerCreds) {
    logData.peer = { uid: peerCreds.uid, gid: peerCreds.gid, pid: peerCreds.pid };
  }

  log('info', 'Request received', logData);

  try {
    // Validate against whitelist
    validateRequest(request);
  } catch (err) {
    if (err instanceof ValidationError) {
      log('warn', 'Request rejected', { action: request.action, error: err.message });
      return { success: false, error: `Validation failed: ${err.message}` };
    }
    throw err;
  }

  // Execute the validated request
  const response = executeRequest(request);

  log(response.success ? 'info' : 'error', 'Request completed', {
    action: request.action,
    success: response.success,
    error: response.error,
  });

  return response;
}

function handleConnection(socket: Socket): void {
  let buffer = '';

  // Try to get peer credentials for audit logging
  const peerCreds = getPeerCredentials(socket);
  if (peerCreds) {
    log('debug', 'Client connected', { peer: peerCreds });
  }

  socket.on('data', (data) => {
    buffer += data.toString();

    // Protocol: newline-delimited JSON
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        const response = handleRequest(line, peerCreds);
        socket.write(JSON.stringify(response) + '\n');
      }
    }
  });

  socket.on('error', (err) => {
    log('error', 'Socket error', { error: err.message });
  });

  socket.on('close', () => {
    // Connection closed
  });
}

function main(): void {
  // Must run as root
  if (process.getuid?.() !== 0) {
    console.error('Privileged helper must run as root');
    process.exit(1);
  }

  // SECURITY: Verify service registry directory before accepting any requests
  verifyServiceRegistryDirectory();
  log('info', 'Service registry directory verified', { path: REGISTERED_SERVICES_DIR });

  const ownpremUid = getOwnpremUid();

  // Ensure socket directory exists
  if (!existsSync(SOCKET_DIR)) {
    mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o755 });
  }

  // Remove old socket if it exists
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }

  const server = createServer(handleConnection);

  server.listen(SOCKET_PATH, () => {
    // Set socket permissions: only ownprem user can connect
    chownSync(SOCKET_PATH, ownpremUid, ownpremUid);
    // Mode 0600 = owner read/write only
    spawnSync('chmod', ['0600', SOCKET_PATH]);

    log('info', 'Privileged helper started', { socket: SOCKET_PATH });
  });

  server.on('error', (err) => {
    log('error', 'Server error', { error: err.message });
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    log('info', 'Shutting down');
    server.close(() => {
      if (existsSync(SOCKET_PATH)) {
        unlinkSync(SOCKET_PATH);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
