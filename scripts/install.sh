#!/bin/bash
set -e

# Ownprem Installation Script
# Usage: sudo ./install.sh [orchestrator|agent|both]

INSTALL_TYPE="${1:-both}"
OWNPREM_USER="ownprem"
OWNPREM_GROUP="ownprem"
REPO_DIR="/opt/ownprem/repo"
APPS_DIR="/opt/ownprem/apps"
DATA_DIR="/var/lib/ownprem"
LOG_DIR="/var/log/ownprem"
CONFIG_DIR="/etc/ownprem"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

# Validate install type
if [[ ! "$INSTALL_TYPE" =~ ^(orchestrator|agent|both)$ ]]; then
    log_error "Invalid install type. Use: orchestrator, agent, or both"
    exit 1
fi

log_info "Starting Ownprem installation (type: $INSTALL_TYPE)"

# Check for Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js 20+ first."
    log_info "Recommended: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 20 ]]; then
    log_error "Node.js version 20+ required. Current: $(node -v)"
    exit 1
fi

log_info "Node.js version: $(node -v)"

# Create ownprem user if it doesn't exist
if ! id "$OWNPREM_USER" &>/dev/null; then
    log_info "Creating system user: $OWNPREM_USER"
    useradd --system --shell /usr/sbin/nologin --home-dir /opt/ownprem "$OWNPREM_USER"
fi

# Create directories
log_info "Creating directories..."
mkdir -p "$REPO_DIR" "$APPS_DIR" "$DATA_DIR" "$LOG_DIR" "$CONFIG_DIR"

# Set ownership
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" /opt/ownprem
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$DATA_DIR"
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$LOG_DIR"

# Check if repo exists, otherwise clone
if [[ ! -d "$REPO_DIR/.git" ]]; then
    log_warn "Repository not found at $REPO_DIR"
    log_info "Please clone the repository manually:"
    log_info "  git clone <repo-url> $REPO_DIR"
    log_info "  chown -R $OWNPREM_USER:$OWNPREM_GROUP $REPO_DIR"
    log_info "Or copy files from current location"
else
    log_info "Repository found at $REPO_DIR"
fi

# Install/update dependencies
if [[ -f "$REPO_DIR/package.json" ]]; then
    log_info "Installing dependencies..."
    cd "$REPO_DIR"
    sudo -u "$OWNPREM_USER" npm ci --omit=dev 2>/dev/null || sudo -u "$OWNPREM_USER" npm install --omit=dev

    log_info "Building application..."
    sudo -u "$OWNPREM_USER" npm run build
fi

# Generate secrets if not exists
generate_secret() {
    openssl rand -base64 32 | tr -d '\n'
}

# Install orchestrator
install_orchestrator() {
    log_info "Installing orchestrator service..."

    # Copy environment template if not exists
    if [[ ! -f "$CONFIG_DIR/orchestrator.env" ]]; then
        cp "$REPO_DIR/scripts/env/orchestrator.env.example" "$CONFIG_DIR/orchestrator.env"

        # Generate secrets
        SECRETS_KEY=$(generate_secret)
        JWT_SECRET=$(generate_secret)

        sed -i "s/^SECRETS_KEY=$/SECRETS_KEY=$SECRETS_KEY/" "$CONFIG_DIR/orchestrator.env"
        sed -i "s/^JWT_SECRET=$/JWT_SECRET=$JWT_SECRET/" "$CONFIG_DIR/orchestrator.env"

        chmod 600 "$CONFIG_DIR/orchestrator.env"
        chown "$OWNPREM_USER:$OWNPREM_GROUP" "$CONFIG_DIR/orchestrator.env"

        log_info "Generated secrets in $CONFIG_DIR/orchestrator.env"
        log_warn "Please review and update CORS_ORIGIN in $CONFIG_DIR/orchestrator.env"
    else
        log_info "Environment file exists: $CONFIG_DIR/orchestrator.env"
    fi

    # Install systemd service
    cp "$REPO_DIR/scripts/systemd/ownprem-orchestrator.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable ownprem-orchestrator

    log_info "Orchestrator service installed"
}

# Install agent
install_agent() {
    log_info "Installing agent service..."

    # Copy environment template if not exists
    if [[ ! -f "$CONFIG_DIR/agent.env" ]]; then
        cp "$REPO_DIR/scripts/env/agent.env.example" "$CONFIG_DIR/agent.env"
        chmod 600 "$CONFIG_DIR/agent.env"
        chown "$OWNPREM_USER:$OWNPREM_GROUP" "$CONFIG_DIR/agent.env"

        log_warn "Please configure SERVER_ID and FOUNDRY_URL in $CONFIG_DIR/agent.env"
    else
        log_info "Environment file exists: $CONFIG_DIR/agent.env"
    fi

    # Install systemd service
    cp "$REPO_DIR/scripts/systemd/ownprem-agent.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable ownprem-agent

    log_info "Agent service installed"
}

# Run installation based on type
case "$INSTALL_TYPE" in
    orchestrator)
        install_orchestrator
        ;;
    agent)
        install_agent
        ;;
    both)
        install_orchestrator
        install_agent
        ;;
esac

log_info "Installation complete!"
echo ""
echo "Next steps:"
echo "==========="

if [[ "$INSTALL_TYPE" == "orchestrator" || "$INSTALL_TYPE" == "both" ]]; then
    echo ""
    echo "Orchestrator:"
    echo "  1. Review configuration: $CONFIG_DIR/orchestrator.env"
    echo "  2. Start service: systemctl start ownprem-orchestrator"
    echo "  3. Check status: systemctl status ownprem-orchestrator"
    echo "  4. View logs: journalctl -u ownprem-orchestrator -f"
fi

if [[ "$INSTALL_TYPE" == "agent" || "$INSTALL_TYPE" == "both" ]]; then
    echo ""
    echo "Agent:"
    echo "  1. Configure: $CONFIG_DIR/agent.env"
    echo "     - Set SERVER_ID (unique per server)"
    echo "     - Set FOUNDRY_URL (orchestrator address)"
    echo "     - Set AUTH_TOKEN (from orchestrator)"
    echo "  2. Start service: systemctl start ownprem-agent"
    echo "  3. Check status: systemctl status ownprem-agent"
    echo "  4. View logs: journalctl -u ownprem-agent -f"
fi

echo ""
echo "Useful commands:"
echo "  systemctl start ownprem-orchestrator ownprem-agent"
echo "  systemctl stop ownprem-orchestrator ownprem-agent"
echo "  systemctl restart ownprem-orchestrator ownprem-agent"
echo "  journalctl -u ownprem-orchestrator -u ownprem-agent -f"
