/**
 * Shared types for app store components
 */

export type AppStoreSource = 'umbrel' | 'start9' | 'casaos' | 'runtipi';

/**
 * Normalized app format used across all stores
 */
export interface NormalizedApp {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  category: string;
  categories?: string[];
  developer: string;
  icon: string;
  port: number;
  registry?: string;
  source: AppStoreSource;
  // Original data for install modal compatibility
  original: unknown;
}

/**
 * Registry definition shared across stores
 */
export interface Registry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  appCount?: number;
  lastSync?: string;
  createdAt: string;
}

/**
 * Deployment status for an app
 */
export interface DeploymentStatus {
  appId: string;
  status: 'pending' | 'installing' | 'running' | 'stopped' | 'error';
}

/**
 * Category with count
 */
export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * Sync result from API
 */
export interface SyncResult {
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  message: string;
}
