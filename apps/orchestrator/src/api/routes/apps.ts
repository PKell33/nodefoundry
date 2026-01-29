import { Router } from 'express';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';
import { createError } from '../middleware/error.js';
import { AppManifestSchema } from '@ownprem/shared';
import type { AppManifest } from '@ownprem/shared';

const router = Router();

interface AppRegistryRow {
  name: string;
  manifest: string;
  loaded_at: string;
}

function loadAppManifests(): AppManifest[] {
  const appDefsPath = config.paths.appDefinitions;
  if (!existsSync(appDefsPath)) {
    return [];
  }

  const apps: AppManifest[] = [];
  const dirs = readdirSync(appDefsPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of dirs) {
    const manifestPath = join(appDefsPath, dir, 'manifest.yaml');
    if (!existsSync(manifestPath)) {
      continue;
    }

    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const parsed = parseYaml(content);
      const validated = AppManifestSchema.parse(parsed);
      apps.push(validated);
    } catch (err) {
      console.warn(`Failed to load manifest for ${dir}:`, err);
    }
  }

  return apps;
}

function syncAppRegistry(): void {
  const db = getDb();
  const manifests = loadAppManifests();

  // Get current app names from filesystem
  const appNames = new Set(manifests.map(m => m.name));

  // Remove apps that no longer exist in filesystem
  const existingApps = db.prepare('SELECT name FROM app_registry').all() as { name: string }[];
  const deleteStmt = db.prepare('DELETE FROM app_registry WHERE name = ?');
  for (const { name } of existingApps) {
    if (!appNames.has(name)) {
      deleteStmt.run(name);
    }
  }

  // Insert or update apps from filesystem
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO app_registry (name, manifest, loaded_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);

  for (const manifest of manifests) {
    insertStmt.run(manifest.name, JSON.stringify(manifest));
  }
}

// GET /api/apps - List available apps
router.get('/', (_req, res) => {
  syncAppRegistry();

  const db = getDb();
  const rows = db.prepare('SELECT * FROM app_registry ORDER BY name').all() as AppRegistryRow[];

  const apps = rows.map(row => ({
    ...JSON.parse(row.manifest) as AppManifest,
    loadedAt: new Date(row.loaded_at),
  }));

  res.json(apps);
});

// GET /api/apps/:name - Get app manifest
router.get('/:name', (req, res) => {
  syncAppRegistry();

  const db = getDb();
  const row = db.prepare('SELECT * FROM app_registry WHERE name = ?').get(req.params.name) as AppRegistryRow | undefined;

  if (!row) {
    throw createError('App not found', 404, 'APP_NOT_FOUND');
  }

  res.json(JSON.parse(row.manifest) as AppManifest);
});

// GET /api/apps/:name/versions - Get available versions
router.get('/:name/versions', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM app_registry WHERE name = ?').get(req.params.name) as AppRegistryRow | undefined;

  if (!row) {
    throw createError('App not found', 404, 'APP_NOT_FOUND');
  }

  const manifest = JSON.parse(row.manifest) as AppManifest;

  // For Phase 1, just return the current version
  // Later this could fetch from GitHub releases
  res.json({
    current: manifest.version,
    available: [manifest.version],
  });
});

export default router;
