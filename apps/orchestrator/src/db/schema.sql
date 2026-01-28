-- Servers (all machines including foundry)
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT,
    is_foundry BOOLEAN DEFAULT FALSE,
    agent_status TEXT DEFAULT 'offline',
    auth_token TEXT,
    metrics JSON,
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- App registry (loaded from app-definitions/)
CREATE TABLE IF NOT EXISTS app_registry (
    name TEXT PRIMARY KEY,
    manifest JSON NOT NULL,
    loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deployments (apps installed on servers)
CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    app_name TEXT NOT NULL REFERENCES app_registry(name),
    version TEXT NOT NULL,
    config JSON NOT NULL,
    status TEXT DEFAULT 'pending',
    status_message TEXT,
    tor_addresses JSON,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(server_id, app_name)
);

-- Secrets (encrypted)
CREATE TABLE IF NOT EXISTS secrets (
    deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Service registry
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id),
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    tor_address TEXT,
    status TEXT DEFAULT 'available',

    UNIQUE(deployment_id, service_name)
);

CREATE INDEX IF NOT EXISTS idx_services_name ON services(service_name);

-- Proxy routes (for web UIs)
CREATE TABLE IF NOT EXISTS proxy_routes (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    upstream TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Command log
CREATE TABLE IF NOT EXISTS command_log (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    deployment_id TEXT,
    action TEXT NOT NULL,
    payload JSON,
    status TEXT,
    result_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- Initialize foundry server on first run
INSERT OR IGNORE INTO servers (id, name, is_foundry, agent_status)
VALUES ('foundry', 'foundry', TRUE, 'offline');
