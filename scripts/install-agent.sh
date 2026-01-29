#!/bin/bash
set -e

# Ownprem Agent Installer
# Usage: curl -sSL http://foundry/agent/install.sh | sudo bash -s -- --foundry http://foundry:3001 --token TOKEN --id server-1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[ownprem]${NC} $1"; }
warn() { echo -e "${YELLOW}[ownprem]${NC} $1"; }
error() { echo -e "${RED}[ownprem]${NC} $1" >&2; }

# Parse arguments
FOUNDRY_URL=""
AUTH_TOKEN=""
SERVER_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --foundry)
      FOUNDRY_URL="$2"
      shift 2
      ;;
    --token)
      AUTH_TOKEN="$2"
      shift 2
      ;;
    --id)
      SERVER_ID="$2"
      shift 2
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate required arguments
if [[ -z "$FOUNDRY_URL" ]]; then
  error "Missing required argument: --foundry"
  exit 1
fi

if [[ -z "$AUTH_TOKEN" ]]; then
  error "Missing required argument: --token"
  exit 1
fi

if [[ -z "$SERVER_ID" ]]; then
  error "Missing required argument: --id"
  exit 1
fi

# Check if running as root
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
  exit 1
fi

log "Installing Ownprem Agent..."
log "  Foundry URL: $FOUNDRY_URL"
log "  Server ID: $SERVER_ID"

# Detect OS
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS=$ID
  VERSION=$VERSION_ID
else
  error "Cannot detect OS. /etc/os-release not found."
  exit 1
fi

log "Detected OS: $OS $VERSION"

# Install dependencies
log "Installing dependencies..."
apt-get update -qq
apt-get install -y -qq curl git

# Install Node.js (v20 LTS)
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  log "Installing Node.js v20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  log "Node.js $(node -v) already installed"
fi

# Create ownprem user if it doesn't exist
if ! id "ownprem" &>/dev/null; then
  log "Creating ownprem user..."
  useradd -r -m -d /opt/ownprem -s /bin/bash ownprem
fi

# Create directories
log "Creating directories..."
mkdir -p /opt/ownprem/agent
mkdir -p /opt/ownprem/apps
mkdir -p /opt/ownprem/data
mkdir -p /var/log/ownprem

# Download agent code
log "Downloading agent..."
cd /opt/ownprem

# For now, clone the repo (in production this would download a release)
if [[ -d repo ]]; then
  cd repo
  git pull --quiet
else
  git clone --quiet --depth 1 https://github.com/ownprem/ownprem.git repo
  cd repo
fi

# Install dependencies and build
log "Building agent..."
npm ci --quiet
npm run build --workspace=@ownprem/shared --quiet
npm run build --workspace=@ownprem/agent --quiet

# Create environment file
log "Configuring agent..."
cat > /opt/ownprem/agent.env << EOF
# Ownprem Agent Configuration
FOUNDRY_URL=$FOUNDRY_URL
SERVER_ID=$SERVER_ID
AUTH_TOKEN=$AUTH_TOKEN
APPS_DIR=/opt/ownprem/apps
DATA_DIR=/opt/ownprem/data
LOG_DIR=/var/log/ownprem
EOF

chmod 600 /opt/ownprem/agent.env

# Create systemd service
log "Creating systemd service..."
cat > /etc/systemd/system/ownprem-agent.service << EOF
[Unit]
Description=Ownprem Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ownprem
Group=ownprem
WorkingDirectory=/opt/ownprem/repo/apps/agent
EnvironmentFile=/opt/ownprem/agent.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/ownprem/agent.log
StandardError=append:/var/log/ownprem/agent.log

# Security hardening
NoNewPrivileges=false
ProtectSystem=false
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF

# Set ownership
chown -R ownprem:ownprem /opt/ownprem
chown -R ownprem:ownprem /var/log/ownprem

# Enable and start service
log "Starting agent service..."
systemctl daemon-reload
systemctl enable ownprem-agent
systemctl start ownprem-agent

# Wait for connection
log "Waiting for agent to connect..."
sleep 3

if systemctl is-active --quiet ownprem-agent; then
  log "Agent service is running!"
  log ""
  log "Installation complete!"
  log "  - Service: ownprem-agent"
  log "  - Logs: /var/log/ownprem/agent.log"
  log "  - Config: /opt/ownprem/agent.env"
  log ""
  log "Commands:"
  log "  systemctl status ownprem-agent  # Check status"
  log "  journalctl -u ownprem-agent -f  # View logs"
else
  error "Agent service failed to start. Check logs:"
  error "  journalctl -u ownprem-agent -n 50"
  exit 1
fi
