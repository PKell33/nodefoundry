#!/bin/bash
set -e

# Ownprem Installation Script
# Usage: sudo ./install.sh [options]
#
# Options:
#   --type TYPE       Install type: orchestrator, agent, or both (default: both)
#   --domain DOMAIN   Domain name (default: ownprem.local)
#   --local           Use OwnPrem CA / step-ca (for .local domains)
#   --email EMAIL     Email for Let's Encrypt (required for public domains)
#   --skip-deps       Skip installing system dependencies
#   --skip-caddy      Skip Caddy installation
#   --skip-firewall   Skip firewall configuration
#   --repo-url URL    Git repository URL to clone
#   -h, --help        Show this help message

# Default values
INSTALL_TYPE="both"
DOMAIN="ownprem.local"
IS_LOCAL="false"
EMAIL=""
SKIP_DEPS="false"
SKIP_CADDY="false"
SKIP_FIREWALL="false"
REPO_URL=""

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
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

show_help() {
    cat << EOF
Ownprem Installation Script

Usage: sudo ./install.sh [options]

Options:
  --type TYPE       Install type: orchestrator, agent, or both (default: both)
  --domain DOMAIN   Domain name (default: ownprem.local)
  --local           Use OwnPrem CA / step-ca (for .local domains)
  --email EMAIL     Email for Let's Encrypt (required for public domains)
  --skip-deps       Skip installing system dependencies (Node.js, etc.)
  --skip-caddy      Skip Caddy installation
  --skip-firewall   Skip firewall configuration
  --repo-url URL    Git repository URL to clone
  -h, --help        Show this help message

Examples:
  # Full local installation (recommended for testing)
  sudo ./install.sh --local

  # Production installation with Let's Encrypt
  sudo ./install.sh --domain ownprem.example.com --email admin@example.com

  # Install only the agent (for additional servers)
  sudo ./install.sh --type agent --skip-caddy

  # Install from Git repository
  sudo ./install.sh --local --repo-url https://github.com/yourorg/ownprem.git

EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --type)
            INSTALL_TYPE="$2"
            shift 2
            ;;
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --local)
            IS_LOCAL="true"
            shift
            ;;
        --email)
            EMAIL="$2"
            shift 2
            ;;
        --skip-deps)
            SKIP_DEPS="true"
            shift
            ;;
        --skip-caddy)
            SKIP_CADDY="true"
            shift
            ;;
        --skip-firewall)
            SKIP_FIREWALL="true"
            shift
            ;;
        --repo-url)
            REPO_URL="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Auto-detect local domain
if [[ "$DOMAIN" == *.local ]]; then
    IS_LOCAL="true"
fi

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

# Validate install type
if [[ ! "$INSTALL_TYPE" =~ ^(orchestrator|agent|both)$ ]]; then
    log_error "Invalid install type: $INSTALL_TYPE"
    log_error "Use: orchestrator, agent, or both"
    exit 1
fi

# Validate email for non-local domains
if [[ "$IS_LOCAL" != "true" && -z "$EMAIL" ]]; then
    log_error "Email is required for public domains (for Let's Encrypt)"
    log_error "Use --email your@email.com or --local for self-signed certs"
    exit 1
fi

echo ""
echo "========================================"
echo "       Ownprem Installation"
echo "========================================"
echo ""
echo "Configuration:"
echo "  Install type: $INSTALL_TYPE"
echo "  Domain: $DOMAIN"
echo "  TLS: $([ "$IS_LOCAL" == "true" ] && echo "OwnPrem CA (step-ca)" || echo "Let's Encrypt")"
echo "  Skip deps: $SKIP_DEPS"
echo "  Skip Caddy: $SKIP_CADDY"
echo "  Skip firewall: $SKIP_FIREWALL"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_info "Installation cancelled"
    exit 0
fi

# ============================================
# Step 1: Install System Dependencies
# ============================================
if [[ "$SKIP_DEPS" != "true" ]]; then
    log_step "Installing system dependencies..."

    apt-get update
    apt-get install -y curl git build-essential openssl rsync libcap2-bin

    # Install Node.js if not present or wrong version
    NEED_NODE="false"
    if ! command -v node &> /dev/null; then
        NEED_NODE="true"
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $NODE_VERSION -lt 20 ]]; then
            log_warn "Node.js $NODE_VERSION found, upgrading to v20..."
            NEED_NODE="true"
        fi
    fi

    if [[ "$NEED_NODE" == "true" ]]; then
        log_info "Installing Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi

    log_info "Node.js version: $(node -v)"
    log_info "npm version: $(npm -v)"
fi

# Verify Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Run without --skip-deps or install manually."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 20 ]]; then
    log_error "Node.js version 20+ required. Current: $(node -v)"
    exit 1
fi

# ============================================
# Step 2: Create User and Directories
# ============================================
log_step "Creating user and directories..."

# Create ownprem user if it doesn't exist
if ! id "$OWNPREM_USER" &>/dev/null; then
    log_info "Creating system user: $OWNPREM_USER"
    useradd --system --shell /usr/sbin/nologin --home-dir /opt/ownprem "$OWNPREM_USER"
fi

# Create directories
mkdir -p "$REPO_DIR" "$APPS_DIR" "$DATA_DIR" "$LOG_DIR" "$CONFIG_DIR"

# Set ownership
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" /opt/ownprem
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$DATA_DIR"
chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$LOG_DIR"

# ============================================
# Step 3: Clone or Copy Repository
# ============================================
log_step "Setting up repository..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -n "$REPO_URL" ]]; then
    # Clone from URL
    if [[ -d "$REPO_DIR/.git" ]]; then
        log_info "Repository exists, pulling latest..."
        cd "$REPO_DIR"
        sudo -u "$OWNPREM_USER" git pull
    else
        log_info "Cloning repository from $REPO_URL..."
        rm -rf "$REPO_DIR"
        git clone "$REPO_URL" "$REPO_DIR"
        chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$REPO_DIR"
    fi
elif [[ -f "$SOURCE_DIR/package.json" ]]; then
    # Copy from current location
    if [[ "$SOURCE_DIR" != "$REPO_DIR" ]]; then
        log_info "Copying files from $SOURCE_DIR to $REPO_DIR..."
        rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'data' \
              --exclude 'logs' --exclude '*.sqlite' \
              "$SOURCE_DIR/" "$REPO_DIR/"
        chown -R "$OWNPREM_USER:$OWNPREM_GROUP" "$REPO_DIR"
    else
        log_info "Already running from $REPO_DIR"
    fi
else
    log_error "No repository found. Use --repo-url to specify a Git URL"
    log_error "or run this script from within the ownprem repository."
    exit 1
fi

# ============================================
# Step 4: Install Dependencies and Build
# ============================================
log_step "Installing npm dependencies and building..."

cd "$REPO_DIR"
# Install all dependencies (including devDependencies needed for build)
sudo -u "$OWNPREM_USER" npm ci 2>/dev/null || sudo -u "$OWNPREM_USER" npm install
sudo -u "$OWNPREM_USER" npm run build

# ============================================
# Step 5: Generate Secrets
# ============================================
generate_secret() {
    openssl rand -base64 32 | tr -d '\n'
}

# ============================================
# Step 6: Install Orchestrator
# ============================================
install_orchestrator() {
    log_step "Installing orchestrator service..."

    # Create environment file
    if [[ ! -f "$CONFIG_DIR/orchestrator.env" ]]; then
        cp "$REPO_DIR/scripts/env/orchestrator.env.example" "$CONFIG_DIR/orchestrator.env"

        # Generate secrets
        SECRETS_KEY=$(generate_secret)
        JWT_SECRET=$(generate_secret)

        sed -i "s/^SECRETS_KEY=$/SECRETS_KEY=$SECRETS_KEY/" "$CONFIG_DIR/orchestrator.env"
        sed -i "s/^JWT_SECRET=$/JWT_SECRET=$JWT_SECRET/" "$CONFIG_DIR/orchestrator.env"

        # Set CORS origin
        if [[ "$IS_LOCAL" == "true" ]]; then
            sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://$DOMAIN|" "$CONFIG_DIR/orchestrator.env"
        else
            sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://$DOMAIN|" "$CONFIG_DIR/orchestrator.env"
        fi

        chmod 600 "$CONFIG_DIR/orchestrator.env"
        chown "$OWNPREM_USER:$OWNPREM_GROUP" "$CONFIG_DIR/orchestrator.env"

        log_info "Generated secrets in $CONFIG_DIR/orchestrator.env"
    else
        log_info "Environment file exists: $CONFIG_DIR/orchestrator.env"
    fi

    # Install systemd service
    cp "$REPO_DIR/scripts/systemd/ownprem-orchestrator.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable ownprem-orchestrator

    log_info "Orchestrator service installed"
}

# ============================================
# Step 7: Install Agent
# ============================================
install_agent() {
    log_step "Installing agent service..."

    # Create environment file
    if [[ ! -f "$CONFIG_DIR/agent.env" ]]; then
        cp "$REPO_DIR/scripts/env/agent.env.example" "$CONFIG_DIR/agent.env"

        # Set SERVER_ID: use 'core' for the core server, hostname for remote agents
        if [[ "$INSTALL_TYPE" == "both" || "$INSTALL_TYPE" == "orchestrator" ]]; then
            # This is the core server - use 'core' as the server ID
            sed -i "s/^SERVER_ID=.*/SERVER_ID=core/" "$CONFIG_DIR/agent.env"
            log_info "Created $CONFIG_DIR/agent.env with SERVER_ID=core (core server)"
        else
            # Remote agent - use hostname
            HOSTNAME=$(hostname -s)
            sed -i "s/^SERVER_ID=.*/SERVER_ID=$HOSTNAME/" "$CONFIG_DIR/agent.env"
            log_info "Created $CONFIG_DIR/agent.env with SERVER_ID=$HOSTNAME"
        fi

        chmod 600 "$CONFIG_DIR/agent.env"
        chown "$OWNPREM_USER:$OWNPREM_GROUP" "$CONFIG_DIR/agent.env"
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

# ============================================
# Step 8: Install Caddy
# ============================================
if [[ "$SKIP_CADDY" != "true" && ("$INSTALL_TYPE" == "orchestrator" || "$INSTALL_TYPE" == "both") ]]; then
    log_step "Installing Caddy reverse proxy..."

    # Check if Caddy is installed
    if ! command -v caddy &> /dev/null; then
        log_info "Installing Caddy..."
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update
        apt-get install -y caddy
    fi

    # Configure Caddy (install-caddy.sh expects: <domain> [email])
    # For local domains, no email is needed (uses internal CA)
    if [[ "$IS_LOCAL" == "true" ]]; then
        bash "$REPO_DIR/scripts/caddy/install-caddy.sh" "$DOMAIN"
    else
        bash "$REPO_DIR/scripts/caddy/install-caddy.sh" "$DOMAIN" "$EMAIL"
    fi
fi

# ============================================
# Step 9: Install Mandatory System Apps
# ============================================
# These apps require root to install (systemd services, system users, etc.)
# so they must be installed here, not by the agent
if [[ "$INSTALL_TYPE" == "orchestrator" || "$INSTALL_TYPE" == "both" ]]; then
    log_step "Installing mandatory system apps..."

    # Install OwnPrem CA (step-ca)
    CA_INSTALL_SCRIPT="$REPO_DIR/app-definitions/ownprem-ca/install.sh"
    if [[ -f "$CA_INSTALL_SCRIPT" ]]; then
        log_info "Installing OwnPrem CA (step-ca)..."

        # Set environment variables for the install script
        export APP_DIR="$APPS_DIR/ownprem-ca"
        export CA_NAME="OwnPrem Root CA"
        export CA_DNS="ca.ownprem.local"
        export ACME_ENABLED="true"
        export DEFAULT_CERT_DURATION="720h"
        export MAX_CERT_DURATION="8760h"
        export ROOT_CERT_DURATION="10"

        # Create app directory
        mkdir -p "$APP_DIR"

        # Copy scripts to app directory
        cp "$REPO_DIR/app-definitions/ownprem-ca/"*.sh "$APP_DIR/" 2>/dev/null || true
        chmod +x "$APP_DIR/"*.sh 2>/dev/null || true

        # Write metadata file
        cat > "$APP_DIR/.ownprem.json" << EOF
{
  "name": "ownprem-ca",
  "displayName": "Smallstep CA",
  "version": "0.27.5",
  "serviceName": "ownprem-ca"
}
EOF

        # Run install script
        bash "$CA_INSTALL_SCRIPT"

        # Start the CA service
        systemctl start ownprem-ca
        sleep 2

        if systemctl is-active --quiet ownprem-ca; then
            log_info "OwnPrem CA installed and started successfully"
        else
            log_warn "OwnPrem CA installed but may not have started correctly"
            journalctl -u ownprem-ca --no-pager -n 5
        fi

        # Add hosts entries for local DNS (needed for ACME and UI access)
        if ! grep -q "ca.ownprem.local" /etc/hosts; then
            log_info "Adding ca.ownprem.local to /etc/hosts..."
            echo "127.0.0.1 ca.ownprem.local" >> /etc/hosts
        fi
        if ! grep -q " ${DOMAIN}$\| ${DOMAIN} " /etc/hosts && [[ "$DOMAIN" == *".local" ]]; then
            log_info "Adding ${DOMAIN} to /etc/hosts..."
            echo "127.0.0.1 ${DOMAIN}" >> /etc/hosts
        fi
    else
        log_warn "CA install script not found: $CA_INSTALL_SCRIPT"
    fi
fi

# ============================================
# Step 10: Configure Firewall
# ============================================
if [[ "$SKIP_FIREWALL" != "true" ]]; then
    log_step "Configuring firewall..."

    if command -v ufw &> /dev/null; then
        ufw allow 22/tcp comment 'SSH'
        ufw allow 80/tcp comment 'HTTP'
        ufw allow 443/tcp comment 'HTTPS'
        ufw allow 8443/tcp comment 'OwnPrem CA (ACME)'

        if [[ $(ufw status | grep -c "Status: active") -eq 0 ]]; then
            log_warn "UFW is not enabled. Enable with: sudo ufw enable"
        fi

        log_info "Firewall rules added (SSH, HTTP, HTTPS, CA)"
    else
        log_warn "UFW not installed, skipping firewall configuration"
    fi
fi

# ============================================
# Step 11: Start Services
# ============================================
log_step "Starting services..."

if [[ "$INSTALL_TYPE" == "orchestrator" || "$INSTALL_TYPE" == "both" ]]; then
    systemctl start ownprem-orchestrator
    sleep 2
    if systemctl is-active --quiet ownprem-orchestrator; then
        log_info "Orchestrator started successfully"
    else
        log_error "Orchestrator failed to start"
        journalctl -u ownprem-orchestrator --no-pager -n 10
    fi
fi

if [[ "$INSTALL_TYPE" == "agent" || "$INSTALL_TYPE" == "both" ]]; then
    systemctl start ownprem-agent
    sleep 2
    if systemctl is-active --quiet ownprem-agent; then
        log_info "Agent started successfully"
    else
        log_error "Agent failed to start"
        journalctl -u ownprem-agent --no-pager -n 10
    fi
fi

# ============================================
# Done!
# ============================================
echo ""
echo "========================================"
echo "     Installation Complete!"
echo "========================================"
echo ""
echo "Services:"
if [[ "$INSTALL_TYPE" == "orchestrator" || "$INSTALL_TYPE" == "both" ]]; then
    echo "  Orchestrator: $(systemctl is-active ownprem-orchestrator)"
    echo "  CA (step-ca): $(systemctl is-active ownprem-ca 2>/dev/null || echo 'not installed')"
fi
if [[ "$INSTALL_TYPE" == "agent" || "$INSTALL_TYPE" == "both" ]]; then
    echo "  Agent: $(systemctl is-active ownprem-agent)"
fi
if [[ "$SKIP_CADDY" != "true" ]]; then
    echo "  Caddy: $(systemctl is-active caddy)"
fi
echo ""

if [[ "$IS_LOCAL" == "true" ]]; then
    echo "Access:"
    echo "  URL: https://$DOMAIN"
    echo ""
    echo "Client Setup:"
    echo "  1. Add to your hosts file:"
    SERVER_IP=$(hostname -I | awk '{print $1}')
    echo "     $SERVER_IP $DOMAIN"
    echo ""
    echo "  2. Download and install the root CA certificate:"
    echo "     https://$DOMAIN/certificate"
    echo ""
else
    echo "Access:"
    echo "  URL: https://$DOMAIN"
    echo ""
    echo "DNS Setup:"
    echo "  Create an A record pointing $DOMAIN to this server's IP"
    echo ""
fi

echo "Configuration files:"
echo "  Orchestrator: $CONFIG_DIR/orchestrator.env"
echo "  Agent: $CONFIG_DIR/agent.env"
echo "  Caddy: /etc/caddy/Caddyfile"
echo ""
echo "Useful commands:"
echo "  systemctl status ownprem-orchestrator ownprem-agent ownprem-ca"
echo "  journalctl -u ownprem-orchestrator -u ownprem-agent -u ownprem-ca -f"
echo "  sudo caddy reload --config /etc/caddy/Caddyfile"
echo ""
