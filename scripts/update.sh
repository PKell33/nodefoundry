#!/bin/bash
set -e

# Ownprem Update Script
# Usage: sudo ./update.sh

REPO_DIR="/opt/ownprem/repo"
OWNPREM_USER="ownprem"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
    log_error "Repository not found at $REPO_DIR"
    exit 1
fi

cd "$REPO_DIR"

log_info "Checking for updates..."
sudo -u "$OWNPREM_USER" git fetch

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})

if [[ "$LOCAL" == "$REMOTE" ]]; then
    log_info "Already up to date"
    exit 0
fi

log_info "Updates available"
log_info "Current: $LOCAL"
log_info "Latest:  $REMOTE"

# Show changes
log_info "Changes:"
sudo -u "$OWNPREM_USER" git log --oneline HEAD..@{u}

read -p "Apply updates? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
    log_info "Aborted"
    exit 0
fi

# Stop services
log_info "Stopping services..."
systemctl stop ownprem-orchestrator 2>/dev/null || true
systemctl stop ownprem-agent 2>/dev/null || true

# Pull updates
log_info "Pulling updates..."
sudo -u "$OWNPREM_USER" git pull

# Install dependencies
log_info "Installing dependencies..."
sudo -u "$OWNPREM_USER" npm ci --omit=dev 2>/dev/null || sudo -u "$OWNPREM_USER" npm install --omit=dev

# Build
log_info "Building..."
sudo -u "$OWNPREM_USER" npm run build

# Update systemd files if changed
if [[ -f "$REPO_DIR/scripts/systemd/ownprem-orchestrator.service" ]]; then
    cp "$REPO_DIR/scripts/systemd/ownprem-orchestrator.service" /etc/systemd/system/
fi
if [[ -f "$REPO_DIR/scripts/systemd/ownprem-agent.service" ]]; then
    cp "$REPO_DIR/scripts/systemd/ownprem-agent.service" /etc/systemd/system/
fi
systemctl daemon-reload

# Start services
log_info "Starting services..."
systemctl start ownprem-orchestrator 2>/dev/null || true
systemctl start ownprem-agent 2>/dev/null || true

log_info "Update complete!"
log_info "New version: $(git rev-parse --short HEAD)"

# Check service status
echo ""
systemctl status ownprem-orchestrator --no-pager || true
echo ""
systemctl status ownprem-agent --no-pager || true
