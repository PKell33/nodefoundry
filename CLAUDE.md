# Ownprem

Sovereign Bitcoin infrastructure platform.

## Quick Reference

| Concept | Name | Examples |
|---------|------|----------|
| Orchestrator | foundry | Always one |
| App Server | server | `foundry`, `server-1`, `server-2` |
| App | app | `bitcoin`, `electrs`, `mempool` |

## Development Phases

```
Phase 1: Local Ubuntu (all-in-one)     ← START HERE
Phase 2: Debian VMs (multi-node)       ← Later
Phase 3: Production                    ← Eventually
```

## Architecture

```
User → https://foundry.local
            │
            ▼
┌─────────────────────────────────────────┐
│              FOUNDRY                    │
│  ┌─────────┐  ┌─────────┐  ┌────────┐ │
│  │  Caddy  │→ │   UI    │  │  API   │ │
│  │ (proxy) │→ │/apps/*  │  │        │ │
│  └─────────┘  └─────────┘  └────────┘ │
│                               │        │
│                          WebSocket     │
│                               │        │
│  ┌────────────────────────────┴─────┐ │
│  │             Agent                 │ │
│  │  (always, even on foundry)       │ │
│  └──────────────┬───────────────────┘ │
│                 │                      │
│           ┌─────┴─────┐                │
│           │  bitcoin  │                │
│           └───────────┘                │
└─────────────────────────────────────────┘
            │
       WebSocket
            │
    ┌───────┴───────┐
    ▼               ▼
┌─────────┐   ┌─────────┐
│server-1 │   │server-2 │
│  Agent  │   │  Agent  │
│    │    │   │    │    │
│electrs  │   │  lnd    │
│mempool  │   │  rtl    │
└─────────┘   └─────────┘
```

## Project Structure

```
ownprem/
├── packages/shared/        # Types (@ownprem/shared)
├── apps/
│   ├── orchestrator/       # API, WebSocket, DB, secrets, proxy
│   ├── agent/              # Executor, reporter
│   └── ui/                 # React frontend
├── app-definitions/        # Bitcoin, Electrs, Mempool manifests
└── scripts/                # Install scripts
```

## Local Development (Ubuntu)

### Start Development

```bash
# All-in-one (recommended)
npm run dev

# Or separate terminals:
npm run dev:orchestrator  # Terminal 1 - API on :3001
npm run dev:agent         # Terminal 2 - Connects to :3001
npm run dev:ui            # Terminal 3 - Vite on :5173
```

### Access Points

| Service | URL |
|---------|-----|
| UI | http://localhost:5173 |
| API | http://localhost:3001/api |
| WebSocket | ws://localhost:3001 |

### Local Data

```
./data/ownprem.sqlite    # Database
./data/apps/                 # Installed apps (dev)
./logs/                      # Log files
```

### Testing Apps Locally

**Option A: Mock Apps (fastest)**
- Use `app-definitions/mock-app/` for testing platform
- No real Bitcoin needed
- Tests full install/config/proxy flow

**Option B: Bitcoin Regtest (realistic)**
- Real Bitcoin, instant blocks, ~100MB
- `network: regtest` in config
- Good for testing actual app integration

**Option C: Platform Only**
- Skip real apps entirely
- Test API, UI, agent communication
- Add apps later

## Commands

```bash
npm run dev              # Full stack (orchestrator + agent + ui)
npm run dev:orchestrator # Orchestrator only (port 3001)
npm run dev:agent        # Agent only
npm run dev:ui           # Frontend only (port 5173)
npm run build            # Production build
npm run test             # Tests
npm run typecheck        # TypeScript check
```

## Later: Debian VMs

When platform works locally, test multi-node on Debian:

| VM | IP | Role |
|----|-----|------|
| foundry | 10.100.6.60 | Orchestrator + Agent |
| server-1 | 10.100.6.61 | Agent only |

```bash
# Deploy to foundry
ssh foundry "cd /opt/ownprem/repo && git pull && npm run build"

# Deploy to server-1  
ssh server-1 "cd /opt/ownprem/repo && git pull && npm run build:agent"
```

## Key Principles

1. **Orchestrator always talks to agent** - Even on localhost. Same code path.

2. **Agents are dumb** - Execute commands, write files, report status. No decisions.

3. **Secrets stay in foundry** - Generated, encrypted, rendered into config files.

4. **Single entry point** - All app UIs accessed via foundry reverse proxy.

## Database

SQLite: `/var/lib/ownprem/db.sqlite`

Tables: `servers`, `app_registry`, `deployments`, `secrets`, `services`, `proxy_routes`

## Key Files

- `apps/orchestrator/src/services/deployer.ts` - Main deployment logic
- `apps/orchestrator/src/services/dependencyResolver.ts` - Resolves app dependencies
- `apps/orchestrator/src/services/secretsManager.ts` - Credential generation/encryption
- `apps/orchestrator/src/services/proxyManager.ts` - Caddy config generation
- `apps/agent/src/executor.ts` - Runs install/configure scripts
- `app-definitions/*/manifest.yaml` - App definitions

## API

```
Servers:
  GET/POST   /api/servers
  GET/PUT/DEL /api/servers/:id

Apps:
  GET        /api/apps
  GET        /api/apps/:name

Deployments:
  GET/POST   /api/deployments
  GET/PUT/DEL /api/deployments/:id
  POST       /api/deployments/:id/start
  POST       /api/deployments/:id/stop
```

## WebSocket Events

```
Server → Client:
  server:status, server:connected, server:disconnected
  deployment:status, command:result

Agent → Orchestrator:
  status (periodic), command:result

Orchestrator → Agent:
  command (install, configure, start, stop, restart, uninstall)
```

## App Manifest Structure

```yaml
name: electrs
displayName: Electrs
version: 0.11.0
category: indexer

source:
  type: git
  gitUrl: https://github.com/romanz/electrs.git

requires:
  - service: bitcoin-rpc
    locality: prefer-same-server
    injectAs:
      host: daemon_rpc_host
      credentials:
        rpcuser: daemon_rpc_user

provides:
  - name: electrs-rpc
    port: 50001

webui:                    # Optional
  enabled: true
  port: 3006
  basePath: /apps/electrs

configSchema:
  - name: network
    type: string
    inheritFrom: bitcoin.network
```

## Current Phase

Phase 1: Foundation (Local Ubuntu)

- [ ] packages/shared types
- [ ] Database schema + init
- [ ] Express API skeleton
- [ ] WebSocket setup
- [ ] Agent connection handshake
- [ ] Basic server CRUD
- [ ] Mock app for testing

## Mock App for Testing

Create `app-definitions/mock-app/` to test the platform without real Bitcoin:

```yaml
# manifest.yaml
name: mock-app
displayName: Mock App
version: 1.0.0
category: utility

provides:
  - name: mock-service
    port: 9999
    protocol: http

webui:
  enabled: true
  port: 9999
  basePath: /apps/mock-app

configSchema:
  - name: message
    type: string
    label: Welcome Message
    default: "Hello from Mock App"
```

```bash
# install.sh
#!/bin/bash
cat > /opt/ownprem/apps/mock-app/server.js << 'EOF'
const http = require('http');
const msg = process.env.MESSAGE || 'Mock App Running';
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<h1>${msg}</h1><p>Install works!</p>`);
}).listen(9999, () => console.log('Mock app on :9999'));
EOF

node /opt/ownprem/apps/mock-app/server.js &
```

## Testing

```bash
# Run all tests
npm run test

# Run specific test
npm run test -- --grep "deployer"

# Test API
curl http://localhost:3001/api/servers

# Test agent status
curl http://localhost:3001/api/servers/foundry

# Check WebSocket
npx wscat -c ws://localhost:3001

# Test full install flow with mock app
curl -X POST http://localhost:3001/api/deployments \
  -H "Content-Type: application/json" \
  -d '{"serverId": "foundry", "appName": "mock-app"}'
```

## Troubleshooting

```bash
# Check orchestrator logs
npm run dev:orchestrator 2>&1 | tee orchestrator.log

# Check agent logs  
npm run dev:agent 2>&1 | tee agent.log

# Check database
sqlite3 ./data/ownprem.sqlite ".tables"
sqlite3 ./data/ownprem.sqlite "SELECT * FROM servers;"

# Reset database
rm ./data/ownprem.sqlite
npm run dev:orchestrator  # Recreates schema
```
