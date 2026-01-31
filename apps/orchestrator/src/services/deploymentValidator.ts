/**
 * Deployment validation logic.
 * Validates pre-conditions before deployment operations.
 */

import { getDb } from '../db/index.js';
import { dependencyResolver } from './dependencyResolver.js';
import logger from '../lib/logger.js';
import type { AppManifest } from '@ownprem/shared';

interface AppRegistryRow {
  name: string;
  manifest: string;
  system: number;
  mandatory: number;
  singleton: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface AppInfo {
  manifest: AppManifest;
  isSingleton: boolean;
  isMandatory: boolean;
  isSystem: boolean;
}

/**
 * Get app info from registry, including parsed manifest.
 */
export function getAppInfo(appName: string): AppInfo {
  const db = getDb();
  const appRow = db.prepare('SELECT * FROM app_registry WHERE name = ?').get(appName) as AppRegistryRow | undefined;

  if (!appRow) {
    throw new Error(`App ${appName} not found in registry`);
  }

  let manifest: AppManifest;
  try {
    manifest = JSON.parse(appRow.manifest) as AppManifest;
  } catch (e) {
    throw new Error(`Failed to parse manifest for app ${appName}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    manifest,
    isSingleton: appRow.singleton === 1,
    isMandatory: appRow.mandatory === 1,
    isSystem: appRow.system === 1,
  };
}

/**
 * Check if app is already deployed on the given server.
 */
export function checkNotAlreadyDeployed(serverId: string, appName: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM deployments WHERE server_id = ? AND app_name = ?').get(serverId, appName);

  if (existing) {
    throw new Error(`App ${appName} is already deployed on ${serverId}`);
  }
}

/**
 * Check singleton constraint - only one instance allowed across all servers.
 */
export function checkSingletonConstraint(appName: string, isSingleton: boolean): void {
  if (!isSingleton) return;

  const db = getDb();
  const existingAny = db.prepare('SELECT server_id FROM deployments WHERE app_name = ?').get(appName) as { server_id: string } | undefined;

  if (existingAny) {
    const serverName = db.prepare('SELECT name FROM servers WHERE id = ?').get(existingAny.server_id) as { name: string } | undefined;
    throw new Error(`App ${appName} is a singleton and is already deployed on ${serverName?.name || existingAny.server_id}`);
  }
}

/**
 * Check for conflicts with already installed apps on the server.
 */
export function checkConflicts(serverId: string, appName: string, conflicts?: string[]): void {
  if (!conflicts || conflicts.length === 0) return;

  const db = getDb();
  const placeholders = conflicts.map(() => '?').join(',');
  const conflicting = db.prepare(`
    SELECT app_name FROM deployments
    WHERE server_id = ? AND app_name IN (${placeholders})
  `).get(serverId, ...conflicts) as { app_name: string } | undefined;

  if (conflicting) {
    throw new Error(`Cannot install ${appName}: conflicts with ${conflicting.app_name} already installed on this server`);
  }
}

/**
 * Validate app dependencies.
 */
export async function validateDependencies(
  manifest: AppManifest,
  serverId: string,
  appName: string
): Promise<ValidationResult> {
  const validation = await dependencyResolver.validate(manifest, serverId);

  if (!validation.valid) {
    return {
      valid: false,
      errors: [`Dependency validation failed: ${validation.errors.join(', ')}`],
      warnings: validation.warnings,
    };
  }

  // Log warnings
  for (const warning of validation.warnings) {
    logger.warn({ appName }, warning);
  }

  return {
    valid: true,
    errors: [],
    warnings: validation.warnings,
  };
}

/**
 * Check if an app can be uninstalled (not mandatory on core server).
 */
export function checkCanUninstall(appName: string, serverId: string): void {
  const db = getDb();

  const appRow = db.prepare('SELECT mandatory FROM app_registry WHERE name = ?').get(appName) as { mandatory: number } | undefined;
  const server = db.prepare('SELECT is_core FROM servers WHERE id = ?').get(serverId) as { is_core: number } | undefined;

  if (appRow?.mandatory === 1 && server?.is_core === 1) {
    throw new Error(`App ${appName} is mandatory and cannot be uninstalled from the core server`);
  }
}

/**
 * Run all pre-install validations.
 */
export async function validateInstall(
  serverId: string,
  appName: string
): Promise<{ appInfo: AppInfo; validationResult: ValidationResult }> {
  const appInfo = getAppInfo(appName);

  checkNotAlreadyDeployed(serverId, appName);
  checkSingletonConstraint(appName, appInfo.isSingleton);
  checkConflicts(serverId, appName, appInfo.manifest.conflicts);

  const validationResult = await validateDependencies(appInfo.manifest, serverId, appName);

  if (!validationResult.valid) {
    throw new Error(validationResult.errors[0]);
  }

  return { appInfo, validationResult };
}
