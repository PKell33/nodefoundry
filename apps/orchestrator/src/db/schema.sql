-- Servers (all machines including core)
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT,
    is_core BOOLEAN DEFAULT FALSE,
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
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    version TEXT NOT NULL,
    config JSON NOT NULL,
    status TEXT DEFAULT 'pending',
    status_message TEXT,
    tor_addresses JSON,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(server_id, app_name)
);

CREATE INDEX IF NOT EXISTS idx_deployments_group ON deployments(group_id);

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

-- Service routes (for proxying service endpoints through Caddy)
CREATE TABLE IF NOT EXISTS service_routes (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    route_type TEXT NOT NULL, -- 'http' or 'tcp'
    external_path TEXT,       -- For HTTP: /services/bitcoin-rpc
    external_port INTEGER,    -- For TCP: allocated port (e.g., 50001)
    upstream_host TEXT NOT NULL,
    upstream_port INTEGER NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(external_path),
    UNIQUE(external_port)
);

CREATE INDEX IF NOT EXISTS idx_service_routes_service ON service_routes(service_id);

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

-- Users for authentication
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_system_admin BOOLEAN DEFAULT FALSE,
    totp_secret TEXT,
    totp_enabled BOOLEAN DEFAULT FALSE,
    backup_codes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

-- Groups for organizing users and apps
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    totp_required BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User-Group membership with role
CREATE TABLE IF NOT EXISTS user_groups (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);

-- Refresh tokens / sessions for JWT
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Agent tokens for authentication
CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_server ON agent_tokens(server_id);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

-- Audit log for security
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip_address TEXT,
    details JSON
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

-- Initialize core server on first run
INSERT OR IGNORE INTO servers (id, name, is_core, agent_status)
VALUES ('core', 'core', TRUE, 'offline');

-- Initialize default group on first run
INSERT OR IGNORE INTO groups (id, name, description, totp_required)
VALUES ('default', 'Default', 'Default group for all users and apps', FALSE);
