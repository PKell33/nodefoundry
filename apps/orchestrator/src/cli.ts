#!/usr/bin/env node
/**
 * Ownprem CLI
 * Management commands for the orchestrator
 */

import { randomUUID, createHash } from 'crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
Ownprem CLI

Usage: node dist/cli.js <command> [options]

Commands:
  create-user <username> <password> [role]   Create a new user (role: admin or viewer)
  create-agent-token <serverId>              Create an auth token for an agent
  list-agent-tokens                          List all agent tokens
  revoke-agent-token <tokenId>               Revoke an agent token
  list-users                                 List all users
  help                                       Show this help message

Examples:
  node dist/cli.js create-user admin mypassword admin
  node dist/cli.js create-agent-token server-1
  node dist/cli.js list-agent-tokens
`);
}

function getDb(): Database.Database {
  const db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  return db;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function createUser(username: string, password: string, role: string = 'viewer') {
  if (!username || !password) {
    console.error('Error: username and password required');
    process.exit(1);
  }

  if (!['admin', 'viewer'].includes(role)) {
    console.error('Error: role must be admin or viewer');
    process.exit(1);
  }

  // Dynamic import to handle bcrypt
  const bcrypt = await import('bcryptjs');
  const passwordHash = await bcrypt.hash(password, config.security.bcryptRounds);

  const db = getDb();
  try {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, username, passwordHash, role);

    console.log(`User created successfully`);
    console.log(`  Username: ${username}`);
    console.log(`  Role: ${role}`);
    console.log(`  ID: ${id}`);
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      console.error('Error: Username already exists');
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  } finally {
    db.close();
  }
}

function createAgentToken(serverId: string) {
  if (!serverId) {
    console.error('Error: serverId required');
    process.exit(1);
  }

  const db = getDb();
  try {
    // Check if server exists
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId);
    if (!server) {
      console.error(`Error: Server '${serverId}' not found`);
      console.error('Create the server first via the API or UI');
      process.exit(1);
    }

    // Generate token
    const token = `op_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = hashToken(token);
    const id = randomUUID();

    db.prepare(`
      INSERT INTO agent_tokens (id, server_id, token_hash, created_at, last_used_at)
      VALUES (?, ?, ?, datetime('now'), NULL)
    `).run(id, serverId, tokenHash);

    console.log(`Agent token created successfully`);
    console.log(`  Server: ${serverId}`);
    console.log(`  Token ID: ${id}`);
    console.log('');
    console.log(`  AUTH_TOKEN=${token}`);
    console.log('');
    console.log('  Add this to the agent environment file.');
    console.log('  This token will only be shown once!');
  } catch (err: any) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

function listAgentTokens() {
  const db = getDb();
  try {
    const tokens = db.prepare(`
      SELECT
        at.id,
        at.server_id,
        at.created_at,
        at.last_used_at,
        s.name as server_name
      FROM agent_tokens at
      LEFT JOIN servers s ON s.id = at.server_id
      ORDER BY at.created_at DESC
    `).all() as any[];

    if (tokens.length === 0) {
      console.log('No agent tokens found');
      return;
    }

    console.log('Agent Tokens:');
    console.log('─'.repeat(80));
    for (const token of tokens) {
      console.log(`  ID: ${token.id}`);
      console.log(`  Server: ${token.server_id} (${token.server_name || 'unknown'})`);
      console.log(`  Created: ${token.created_at}`);
      console.log(`  Last Used: ${token.last_used_at || 'never'}`);
      console.log('─'.repeat(80));
    }
  } finally {
    db.close();
  }
}

function revokeAgentToken(tokenId: string) {
  if (!tokenId) {
    console.error('Error: tokenId required');
    process.exit(1);
  }

  const db = getDb();
  try {
    const result = db.prepare('DELETE FROM agent_tokens WHERE id = ?').run(tokenId);
    if (result.changes === 0) {
      console.error('Error: Token not found');
      process.exit(1);
    }
    console.log(`Token ${tokenId} revoked successfully`);
  } finally {
    db.close();
  }
}

function listUsers() {
  const db = getDb();
  try {
    const users = db.prepare(`
      SELECT id, username, role, created_at, last_login_at
      FROM users
      ORDER BY created_at DESC
    `).all() as any[];

    if (users.length === 0) {
      console.log('No users found');
      return;
    }

    console.log('Users:');
    console.log('─'.repeat(80));
    for (const user of users) {
      console.log(`  Username: ${user.username}`);
      console.log(`  Role: ${user.role}`);
      console.log(`  ID: ${user.id}`);
      console.log(`  Created: ${user.created_at}`);
      console.log(`  Last Login: ${user.last_login_at || 'never'}`);
      console.log('─'.repeat(80));
    }
  } finally {
    db.close();
  }
}

// Main
async function main() {
  switch (command) {
    case 'create-user':
      await createUser(args[1], args[2], args[3]);
      break;
    case 'create-agent-token':
      createAgentToken(args[1]);
      break;
    case 'list-agent-tokens':
      listAgentTokens();
      break;
    case 'revoke-agent-token':
      revokeAgentToken(args[1]);
      break;
    case 'list-users':
      listUsers();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
