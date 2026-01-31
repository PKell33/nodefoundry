#!/bin/bash
set -euo pipefail

# OwnPrem CA Installation Script (step-ca)
# This script downloads and extracts binaries only.
# Privileged operations are handled by the agent via the privileged helper.

APP_DIR="${APP_DIR:-/opt/ownprem/apps/ownprem-ca}"

# step-ca version
STEP_CA_VERSION="0.27.5"
STEP_CLI_VERSION="0.27.4"

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l) ARCH="armv7" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Installing OwnPrem CA (step-ca) binaries..."

# Create app directories (unprivileged - agent owns APP_DIR)
mkdir -p "$APP_DIR/bin"
mkdir -p "$APP_DIR/templates"

# Cleanup function for temporary files
cleanup_temp() {
    if [[ -n "${TEMP_DIR:-}" && -d "${TEMP_DIR}" ]]; then
        rm -rf "${TEMP_DIR}"
    fi
    return 0  # Ensure cleanup always succeeds
}
trap cleanup_temp EXIT

# Download and verify step-ca if not present
if [[ ! -f "$APP_DIR/bin/step-ca" ]]; then
    echo "Downloading step-ca v${STEP_CA_VERSION}..."
    TEMP_DIR=$(mktemp -d)

    STEP_CA_URL="https://dl.smallstep.com/gh-release/certificates/gh-release-header/v${STEP_CA_VERSION}/step-ca_linux_${ARCH}.tar.gz"
    STEP_CA_CHECKSUMS_URL="https://dl.smallstep.com/gh-release/certificates/gh-release-header/v${STEP_CA_VERSION}/checksums.txt"

    curl -fsSL "${STEP_CA_URL}" -o "${TEMP_DIR}/step-ca.tar.gz"
    curl -fsSL "${STEP_CA_CHECKSUMS_URL}" -o "${TEMP_DIR}/checksums.txt"

    # Verify checksum
    cd "${TEMP_DIR}"
    EXPECTED_HASH=$(grep "step-ca_linux_${ARCH}.tar.gz" checksums.txt | awk '{print $1}')
    if [[ -z "${EXPECTED_HASH}" ]]; then
        echo "ERROR: Could not find checksum for step-ca_linux_${ARCH}.tar.gz"
        exit 1
    fi
    ACTUAL_HASH=$(sha256sum step-ca.tar.gz | awk '{print $1}')
    if [[ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]]; then
        echo "ERROR: Checksum verification failed for step-ca!"
        echo "Expected: ${EXPECTED_HASH}"
        echo "Actual:   ${ACTUAL_HASH}"
        exit 1
    fi
    echo "Checksum verified for step-ca"

    tar -xzf step-ca.tar.gz
    mv "step-ca_linux_${ARCH}/step-ca" "${APP_DIR}/bin/"
    chmod +x "${APP_DIR}/bin/step-ca"
    echo "step-ca installed to ${APP_DIR}/bin/"

    rm -rf "${TEMP_DIR}"
    TEMP_DIR=""
fi

# Download and verify step CLI if not present
if [[ ! -f "$APP_DIR/bin/step" ]]; then
    echo "Downloading step CLI v${STEP_CLI_VERSION}..."
    TEMP_DIR=$(mktemp -d)

    STEP_CLI_URL="https://dl.smallstep.com/gh-release/cli/gh-release-header/v${STEP_CLI_VERSION}/step_linux_${ARCH}.tar.gz"
    STEP_CLI_CHECKSUMS_URL="https://dl.smallstep.com/gh-release/cli/gh-release-header/v${STEP_CLI_VERSION}/checksums.txt"

    curl -fsSL "${STEP_CLI_URL}" -o "${TEMP_DIR}/step.tar.gz"
    curl -fsSL "${STEP_CLI_CHECKSUMS_URL}" -o "${TEMP_DIR}/checksums.txt"

    # Verify checksum
    cd "${TEMP_DIR}"
    EXPECTED_HASH=$(grep "step_linux_${ARCH}.tar.gz" checksums.txt | awk '{print $1}')
    if [[ -z "${EXPECTED_HASH}" ]]; then
        echo "ERROR: Could not find checksum for step_linux_${ARCH}.tar.gz"
        exit 1
    fi
    ACTUAL_HASH=$(sha256sum step.tar.gz | awk '{print $1}')
    if [[ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]]; then
        echo "ERROR: Checksum verification failed for step CLI!"
        echo "Expected: ${EXPECTED_HASH}"
        echo "Actual:   ${ACTUAL_HASH}"
        exit 1
    fi
    echo "Checksum verified for step CLI"

    tar -xzf step.tar.gz
    mv "step_linux_${ARCH}/bin/step" "${APP_DIR}/bin/"
    chmod +x "${APP_DIR}/bin/step"
    echo "step CLI installed to ${APP_DIR}/bin/"

    rm -rf "${TEMP_DIR}"
    TEMP_DIR=""
fi

# Create systemd service template (agent will copy to /etc/systemd/system/)
cat > "$APP_DIR/templates/ownprem-ca.service" << 'EOF'
[Unit]
Description=OwnPrem Certificate Authority (step-ca)
After=network-online.target
Wants=network-online.target
Documentation=https://smallstep.com/docs/step-ca

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
Environment=STEPPATH=${DATA_DIR}
ExecStart=${APP_DIR}/bin/step-ca ${DATA_DIR}/config/ca.json --password-file=${DATA_DIR}/secrets/ca-password.txt
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=10

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "=========================================="
echo "OwnPrem CA Binaries Installed"
echo "=========================================="
echo ""
echo "Binaries: $APP_DIR/bin/step-ca, $APP_DIR/bin/step"
echo ""
echo "The agent will now configure the CA with privileged operations."
echo ""
