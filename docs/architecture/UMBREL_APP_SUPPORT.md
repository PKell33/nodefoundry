# Architecture: Umbrel App Support

## Overview

This document outlines the architecture for adding Umbrel app ecosystem compatibility to OwnPrem, enabling access to 200+ apps while maintaining OwnPrem's multi-server differentiator.

## Goals

1. **Import Umbrel apps** - Parse `umbrel-app.yml` and `docker-compose.yml`
2. **Multi-server deployment** - Deploy Docker apps across multiple nodes (Umbrel differentiator)
3. **Unified management** - Mix native apps (bitcoin-core) with Docker apps (mempool)
4. **Storage integration** - Map NFS/CIFS mounts into containers
5. **Proxy integration** - Auto-configure Caddy routes for Docker apps
6. **Secrets integration** - Inject credentials into containers

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRATOR                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  App Store   │  │   Deployer   │  │    Proxy     │  │     Secrets      │ │
│  │   Service    │  │   Service    │  │   Manager    │  │     Manager      │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘  └──────────────────┘ │
│         │                 │                                                  │
│         │ ┌───────────────┴───────────────┐                                 │
│         │ │                               │                                 │
│         ▼ ▼                               ▼                                 │
│  ┌──────────────┐                 ┌──────────────┐                          │
│  │    Native    │                 │    Docker    │                          │
│  │   Deployer   │                 │   Deployer   │  ◄── NEW                 │
│  │  (existing)  │                 │              │                          │
│  └──────────────┘                 └──────────────┘                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                            │ WebSocket
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│    Agent      │   │    Agent      │   │    Agent      │
│   server-1    │   │   server-2    │   │   server-3    │
├───────────────┤   ├───────────────┤   ├───────────────┤
│ Native Exec   │   │ Native Exec   │   │ Native Exec   │
│ Docker Exec ◄─┼───┼─ NEW          │   │ Docker Exec   │
├───────────────┤   ├───────────────┤   ├───────────────┤
│ bitcoin-core  │   │ mempool    🐳 │   │ nextcloud  🐳 │
│ electrs       │   │ thunderhub 🐳 │   │ photoprism 🐳 │
│ caddy         │   │              │   │              │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                    ┌───────┴───────┐
                    │   NAS/NFS     │
                    │  (shared)     │
                    └───────────────┘
```

## Component Changes

### 1. App Store Service (NEW)

Manages app catalogs from multiple sources.

```typescript
// apps/orchestrator/src/services/appStoreService.ts

interface AppSource {
  type: 'native' | 'umbrel' | 'custom';
  url?: string;           // Git repo URL for Umbrel apps
  path?: string;          // Local path for native apps
  refreshInterval?: number;
}

interface UnifiedAppManifest {
  // Common fields
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  icon: string;

  // Deployment type
  deploymentType: 'native' | 'docker';

  // Native-specific (existing)
  native?: {
    source: AppSource;
    installScript: string;
    // ... existing manifest fields
  };

  // Docker-specific (new)
  docker?: {
    composeFile: string;        // docker-compose.yml content
    umbrelManifest: UmbrelApp;  // Original umbrel-app.yml
    images: string[];           // Pre-pulled image list
  };

  // Unified fields
  port?: number;
  webui?: { enabled: boolean; basePath: string };
  dependencies?: string[];
  provides?: ServiceProvide[];
  requires?: ServiceRequire[];
}

class AppStoreService {
  private sources: AppSource[] = [];
  private apps: Map<string, UnifiedAppManifest> = new Map();

  // Sync apps from all sources
  async syncApps(): Promise<void>;

  // Convert Umbrel manifest to unified format
  private parseUmbrelApp(dir: string): UnifiedAppManifest;

  // List all available apps
  getApps(filter?: { category?: string; type?: string }): UnifiedAppManifest[];

  // Get single app
  getApp(id: string): UnifiedAppManifest | null;
}
```

### 2. Docker Deployer (NEW)

Handles Docker-based app deployment.

```typescript
// apps/orchestrator/src/services/dockerDeployer.ts

interface DockerDeployment {
  deploymentId: string;
  appId: string;
  serverId: string;
  status: DeploymentStatus;
  containers: ContainerInfo[];
  volumes: VolumeMapping[];
  networks: string[];
}

class DockerDeployer {
  constructor(
    private agentManager: AgentManager,
    private secretsManager: SecretsManager,
    private proxyManager: ProxyManager,
    private storageService: StorageService,
  ) {}

  async deploy(
    app: UnifiedAppManifest,
    serverId: string,
    config: DeploymentConfig,
  ): Promise<DockerDeployment> {
    // 1. Resolve dependencies
    const deps = await this.resolveDependencies(app, serverId);

    // 2. Generate environment variables
    const env = await this.generateEnvVars(app, serverId, config);

    // 3. Prepare volume mappings (including NFS mounts)
    const volumes = await this.prepareVolumes(app, serverId, config);

    // 4. Transform docker-compose.yml
    const compose = this.transformCompose(app, env, volumes);

    // 5. Send to agent for deployment
    await this.agentManager.sendCommand(serverId, {
      type: 'docker:deploy',
      payload: { compose, appId: app.id },
    });

    // 6. Configure proxy routes
    await this.configureProxy(app, serverId);

    return deployment;
  }

  // Transform Umbrel compose to OwnPrem format
  private transformCompose(
    app: UnifiedAppManifest,
    env: Record<string, string>,
    volumes: VolumeMapping[],
  ): string {
    const compose = yaml.parse(app.docker!.composeFile);

    // Remove Umbrel's app_proxy service (we use Caddy)
    delete compose.services.app_proxy;

    // Inject environment variables
    for (const [service, config] of Object.entries(compose.services)) {
      config.environment = {
        ...config.environment,
        ...env,
      };
    }

    // Map volumes to OwnPrem storage mounts
    // Transform ${APP_DATA_DIR} -> /mnt/ownprem/apps/<app-id>
    // Transform ${APP_BITCOIN_DATA_DIR} -> bitcoin-core data path

    return yaml.stringify(compose);
  }
}
```

### 3. Environment Variable Mapping

Map Umbrel's env vars to OwnPrem equivalents.

```typescript
// apps/orchestrator/src/services/envMapper.ts

interface EnvMapping {
  umbrel: string;
  ownprem: () => Promise<string>;
}

const ENV_MAPPINGS: EnvMapping[] = [
  // Device info
  { umbrel: 'DEVICE_HOSTNAME', ownprem: () => getHostname() },
  { umbrel: 'DEVICE_DOMAIN_NAME', ownprem: () => getDomainName() },

  // App-specific
  { umbrel: 'APP_DATA_DIR', ownprem: (app) => getAppDataDir(app) },
  { umbrel: 'APP_PASSWORD', ownprem: (app) => secretsManager.getOrGenerate(app, 'password') },
  { umbrel: 'APP_SEED', ownprem: (app) => secretsManager.getOrGenerate(app, 'seed') },

  // Bitcoin integration
  { umbrel: 'APP_BITCOIN_NODE_IP', ownprem: () => getBitcoinNodeIP() },
  { umbrel: 'APP_BITCOIN_RPC_PORT', ownprem: () => '8332' },
  { umbrel: 'APP_BITCOIN_RPC_USER', ownprem: () => secretsManager.get('bitcoin-core', 'rpc-user') },
  { umbrel: 'APP_BITCOIN_RPC_PASS', ownprem: () => secretsManager.get('bitcoin-core', 'rpc-pass') },
  { umbrel: 'APP_BITCOIN_DATA_DIR', ownprem: () => getBitcoinDataDir() },

  // Electrs integration
  { umbrel: 'APP_ELECTRS_NODE_IP', ownprem: () => getElectrsIP() },
  { umbrel: 'APP_ELECTRS_NODE_PORT', ownprem: () => '50001' },

  // LND integration
  { umbrel: 'APP_LIGHTNING_NODE_IP', ownprem: () => getLndIP() },
  { umbrel: 'APP_LIGHTNING_NODE_GRPC_PORT', ownprem: () => '10009' },
  { umbrel: 'APP_LIGHTNING_NODE_REST_PORT', ownprem: () => '8080' },
  { umbrel: 'APP_LIGHTNING_NODE_DATA_DIR', ownprem: () => getLndDataDir() },

  // Tor (optional)
  { umbrel: 'TOR_PROXY_IP', ownprem: () => getTorProxyIP() },
  { umbrel: 'TOR_PROXY_PORT', ownprem: () => '9050' },
];

async function generateEnvVars(
  app: UnifiedAppManifest,
  serverId: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const mapping of ENV_MAPPINGS) {
    env[mapping.umbrel] = await mapping.ownprem(app, serverId);
  }

  return env;
}
```

### 4. Agent Docker Executor (NEW)

Add Docker command handling to agents.

```typescript
// apps/agent/src/dockerExecutor.ts

class DockerExecutor {
  async deploy(compose: string, appId: string): Promise<void> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;

    // Write compose file
    await fs.writeFile(composeFile, compose);

    // Pull images
    await this.exec(`docker compose -f ${composeFile} pull`);

    // Start containers
    await this.exec(`docker compose -f ${composeFile} up -d`);
  }

  async stop(appId: string): Promise<void> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;
    await this.exec(`docker compose -f ${composeFile} stop`);
  }

  async start(appId: string): Promise<void> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;
    await this.exec(`docker compose -f ${composeFile} start`);
  }

  async uninstall(appId: string): Promise<void> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;
    await this.exec(`docker compose -f ${composeFile} down -v`);
    await fs.rm(`/var/lib/ownprem/docker/${appId}`, { recursive: true });
  }

  async logs(appId: string, lines: number = 100): Promise<string> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;
    return this.exec(`docker compose -f ${composeFile} logs --tail=${lines}`);
  }

  async status(appId: string): Promise<ContainerStatus[]> {
    const composeFile = `/var/lib/ownprem/docker/${appId}/docker-compose.yml`;
    const output = await this.exec(
      `docker compose -f ${composeFile} ps --format json`
    );
    return JSON.parse(output);
  }
}
```

### 5. Cross-Server Networking

Enable Docker containers to communicate across servers.

```typescript
// apps/orchestrator/src/services/networkManager.ts

/**
 * Options for cross-server Docker networking:
 *
 * 1. WireGuard mesh (recommended)
 *    - Each server gets WireGuard interface
 *    - Containers use host networking or bridge to WG
 *    - Simple, secure, performant
 *
 * 2. Docker Swarm overlay
 *    - Native Docker solution
 *    - Requires Swarm mode
 *    - More complex setup
 *
 * 3. Direct host networking
 *    - Containers bind to host ports
 *    - Simplest but port conflicts possible
 *    - Good enough for most home setups
 */

interface NetworkConfig {
  mode: 'wireguard' | 'swarm' | 'host';

  // WireGuard config
  wireguard?: {
    subnet: string;          // e.g., '10.100.0.0/24'
    serverIPs: Map<string, string>;  // serverId -> WG IP
  };
}

class NetworkManager {
  // Get IP address for a service running on a server
  async getServiceIP(
    serverId: string,
    serviceId: string,
  ): Promise<string> {
    switch (this.config.mode) {
      case 'wireguard':
        return this.config.wireguard!.serverIPs.get(serverId)!;
      case 'host':
        return this.getServerIP(serverId);
      case 'swarm':
        return `${serviceId}.ownprem`;  // Swarm DNS
    }
  }
}
```

### 6. Storage Integration

Map OwnPrem NFS mounts to Docker volumes.

```typescript
// apps/orchestrator/src/services/dockerStorage.ts

interface VolumeMapping {
  source: string;      // Host path or NFS mount
  target: string;      // Container path
  readonly: boolean;
}

class DockerStorageService {
  constructor(private storageService: StorageService) {}

  async prepareVolumes(
    app: UnifiedAppManifest,
    serverId: string,
    userConfig: { storageMount?: string },
  ): Promise<VolumeMapping[]> {
    const volumes: VolumeMapping[] = [];

    // App data directory
    if (app.docker?.composeFile.includes('${APP_DATA_DIR}')) {
      if (userConfig.storageMount) {
        // Use user-selected NFS mount
        const mount = await this.storageService.getMount(userConfig.storageMount);
        const serverMount = await this.storageService.getServerMount(
          mount.id,
          serverId,
        );
        volumes.push({
          source: `${serverMount.mountPoint}/apps/${app.id}`,
          target: '/app/data',
          readonly: false,
        });
      } else {
        // Use local storage
        volumes.push({
          source: `/var/lib/ownprem/apps/${app.id}/data`,
          target: '/app/data',
          readonly: false,
        });
      }
    }

    // Bitcoin data (read-only access to existing bitcoin-core deployment)
    if (app.docker?.composeFile.includes('${APP_BITCOIN_DATA_DIR}')) {
      const bitcoinDeployment = await this.getDeployment('bitcoin-core', serverId);
      volumes.push({
        source: bitcoinDeployment.dataDir,
        target: '/bitcoin',
        readonly: true,
      });
    }

    // LND data
    if (app.docker?.composeFile.includes('${APP_LIGHTNING_NODE_DATA_DIR}')) {
      const lndDeployment = await this.getDeployment('lnd', serverId);
      volumes.push({
        source: lndDeployment.dataDir,
        target: '/lnd',
        readonly: true,
      });
    }

    return volumes;
  }
}
```

### 7. Database Schema Changes

```sql
-- Add deployment type
ALTER TABLE deployments ADD COLUMN deployment_type TEXT DEFAULT 'native';
-- 'native' | 'docker'

-- Docker-specific deployment info
CREATE TABLE docker_deployments (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id),
  compose_file TEXT NOT NULL,
  container_ids TEXT,  -- JSON array of container IDs
  network_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- App sources
CREATE TABLE app_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'native' | 'umbrel' | 'custom'
  url TEXT,
  path TEXT,
  enabled INTEGER DEFAULT 1,
  last_sync TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Cached app manifests from external sources
CREATE TABLE app_cache (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES app_sources(id),
  manifest TEXT NOT NULL,  -- JSON
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### 8. UI Changes

#### App Store Page (Enhanced)

```tsx
// Filter by app type
<Tabs value={filter} onChange={setFilter}>
  <Tab value="all">All Apps</Tab>
  <Tab value="native">Native</Tab>
  <Tab value="docker">Docker</Tab>
</Tabs>

// App card shows deployment type
<AppCard>
  <Badge>{app.deploymentType === 'docker' ? '🐳 Docker' : '⚡ Native'}</Badge>
  {/* ... */}
</AppCard>
```

#### Install Modal (Enhanced)

```tsx
// For Docker apps, show storage selection
{app.deploymentType === 'docker' && (
  <div>
    <label>Data Storage</label>
    <select value={storageMount} onChange={setStorageMount}>
      <option value="">Local (this server only)</option>
      {mounts.map(m => (
        <option key={m.id} value={m.id}>
          {m.name} - {m.source} ({m.freeSpace} free)
        </option>
      ))}
    </select>
    <p className="text-muted">
      Using NFS storage allows migrating the app to another server later.
    </p>
  </div>
)}
```

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Add `deployment_type` to deployments table
- [ ] Create DockerExecutor in agent
- [ ] Add Docker health check to agent status
- [ ] Basic `docker compose up/down` support

### Phase 2: Umbrel Parsing (Week 2-3)
- [ ] Create AppStoreService
- [ ] Parse `umbrel-app.yml` format
- [ ] Parse and transform `docker-compose.yml`
- [ ] Environment variable mapping

### Phase 3: Integration (Week 3-4)
- [ ] Caddy proxy auto-configuration for Docker apps
- [ ] Storage mount integration
- [ ] Secrets injection
- [ ] Cross-service discovery (Bitcoin RPC, etc.)

### Phase 4: Multi-Server (Week 4-5)
- [ ] Cross-server networking (WireGuard or host mode)
- [ ] Service discovery across nodes
- [ ] Dependency placement logic

### Phase 5: UI & Polish (Week 5-6)
- [ ] App store UI with type filtering
- [ ] Install modal storage selection
- [ ] Docker-specific log viewing
- [ ] Container status display

## Migration Path

Existing native apps continue to work unchanged. New Docker apps are additive.

```
Before:
  - bitcoin-core (native)
  - electrs (native)

After:
  - bitcoin-core (native) ─┐
  - electrs (native) ──────┼── Bitcoin RPC credentials shared
  - mempool (docker) ──────┤
  - thunderhub (docker) ───┘
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Docker not installed on server | Agent checks for Docker, prompts install |
| Umbrel compose format changes | Pin to specific Umbrel repo version |
| Cross-server latency | Recommend same LAN, warn on WAN |
| Resource contention | Show memory/CPU usage, recommend placement |
| Umbrel app doesn't work | Maintain compatibility list, community reports |

## Success Criteria

1. Install Mempool from Umbrel catalog in < 2 minutes
2. App auto-connects to existing Bitcoin Core
3. Caddy route auto-configured
4. App accessible at `https://ownprem.local/apps/mempool`
5. Data persists on NFS mount
6. Can migrate app to different server with same data
