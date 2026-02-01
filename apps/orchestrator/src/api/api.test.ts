import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create test database
let db: Database.Database;

// Mock modules
vi.mock('../db/index.js', () => ({
  getDb: () => db,
  initDb: () => {},
  closeDb: () => {},
}));

vi.mock('../config.js', () => ({
  config: {
    port: 3001,
    nodeEnv: 'test',
    isDevelopment: true,
    database: { path: ':memory:' },
    paths: {
      data: '/tmp/test-data',
      apps: '/tmp/test-apps',
      appDefinitions: join(__dirname, '../../../app-definitions'),
      logs: '/tmp/test-logs',
      backups: '/tmp/test-backups',
      caddyConfig: '/tmp/test-caddy/Caddyfile',
    },
    caddy: {
      domain: 'test.local',
      reloadCommand: '',
      devUiPort: 5173,
    },
    secrets: { key: 'test-secrets-key-32-characters!!' },
    jwt: {
      secret: 'test-jwt-secret-for-testing-purposes',
      isEphemeral: false,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    },
    cookies: {
      secure: false,
      sameSite: 'strict',
      httpOnly: true,
      accessTokenMaxAge: 15 * 60 * 1000,
      refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000,
      refreshTokenPath: '/api/auth',
    },
    security: {
      bcryptRounds: 4,
      rateLimitWindow: 15 * 60 * 1000,
      rateLimitMax: 100,
      authRateLimitMax: 10,
      loginLockoutWindow: 60 * 60 * 1000,
      loginLockoutMax: 5,
    },
    csp: {
      additionalConnectSrc: [],
      reportOnly: false,
      reportUri: null,
    },
    cors: { origin: '*' },
    devMode: {
      bypassAuth: false,
      productionIndicators: [],
    },
  },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
};

vi.mock('../lib/logger.js', () => ({
  default: mockLogger,
  logger: mockLogger,
  apiLogger: mockLogger,
  wsLogger: mockLogger,
  dbLogger: mockLogger,
  authLogger: mockLogger,
  createRequestLogger: () => (_req: any, _res: any, next: any) => next(),
}));

// Import after mocks
const { createApi } = await import('./index.js');
const { authService } = await import('../services/authService.js');
const { csrfService } = await import('../services/csrfService.js');

describe('API Endpoints', () => {
  let app: ReturnType<typeof createApi>;
  let authToken: string;
  let csrfToken: string;
  let testUserId: string;

  beforeAll(async () => {
    // Create in-memory database
    db = new Database(':memory:');

    // Load schema
    const schemaPath = join(__dirname, '../db/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    // Create test app
    app = createApi();

    // Create test user and get token
    testUserId = await authService.createUser('testadmin', 'testpassword', true);
    const user = await authService.validateCredentials('testadmin', 'testpassword');
    const tokens = authService.generateTokens(user!);
    authToken = tokens.accessToken;
    csrfToken = csrfService.generateToken(testUserId);
  });

  afterAll(() => {
    db.close();
  });

  describe('Health Endpoints', () => {
    it('GET /health should return ok', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });

    it('GET /ready should return ready status', async () => {
      const res = await request(app).get('/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks).toBeDefined();
    });
  });

  describe('Auth Endpoints', () => {
    beforeEach(() => {
      // Clear auth-related tables (use single quotes for string literals in SQLite)
      db.exec("DELETE FROM users WHERE username != 'testadmin'");
      db.exec('DELETE FROM refresh_tokens');
    });

    it('POST /api/auth/login should authenticate valid credentials', async () => {
      // Create a test user first
      await authService.createUser('logintest', 'password123', true);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'logintest', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('logintest');
      // Tokens are now set via httpOnly cookies, not in response body
      const cookieHeader = res.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      // set-cookie can be string or string[] depending on number of cookies
      const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
      expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    });

    it('POST /api/auth/login should reject invalid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'wrong', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('POST /api/auth/login should validate input', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /api/auth/me should return user info with valid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('testadmin');
    });

    it('GET /api/auth/me should reject without token', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
    });
  });

  describe('Servers Endpoints', () => {
    it('GET /api/servers should return servers list', async () => {
      const res = await request(app)
        .get('/api/servers')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Should have core server from schema init
      expect(res.body.some((s: any) => s.id === 'core')).toBe(true);
    });

    it('GET /api/servers/:id should return specific server', async () => {
      const res = await request(app)
        .get('/api/servers/core')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('core');
      expect(res.body.isCore).toBe(true);
    });

    it('GET /api/servers/:id should return 404 for unknown server', async () => {
      const res = await request(app)
        .get('/api/servers/nonexistent')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Input Validation', () => {
    it('POST /api/servers should validate required fields', async () => {
      const res = await request(app)
        .post('/api/servers')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/servers should validate name format', async () => {
      const res = await request(app)
        .post('/api/servers')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-CSRF-Token', csrfToken)
        .send({ name: 'INVALID_NAME!@#', host: 'localhost' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
