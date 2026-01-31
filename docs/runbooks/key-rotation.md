# SECRETS_KEY Rotation Runbook

## Overview

The `SECRETS_KEY` is used to encrypt sensitive data at rest, including:
- Deployment secrets (database credentials, API keys)
- Mount credentials (CIFS passwords)

This runbook covers when and how to rotate the encryption key.

## When to Rotate

**Mandatory rotation:**
- Key compromise (suspected or confirmed)
- Personnel with key access leaving the organization
- Security audit requirement

**Recommended rotation:**
- Annually as a best practice
- After security incidents affecting the infrastructure

## Prerequisites

- Admin access to the orchestrator server
- Current `SECRETS_KEY` value
- New key generated and ready
- Maintenance window (rotation locks secrets during operation)

## Generate a New Key

```bash
# Generate a new 32-byte key in Base64 format (recommended)
openssl rand -base64 32

# Or hex format (64 characters)
openssl rand -hex 32
```

## Rotation Procedure

### 1. Pre-flight Checks

```bash
# Verify orchestrator is healthy
curl -s https://ownprem.local/health | jq .

# Check current secrets count
sqlite3 /var/lib/ownprem/db.sqlite "SELECT COUNT(*) FROM secrets;"

# Backup the database
cp /var/lib/ownprem/db.sqlite /var/lib/ownprem/db.sqlite.backup-$(date +%Y%m%d-%H%M%S)
```

### 2. Perform Rotation

The rotation can be triggered via the orchestrator API or CLI:

**Via API (requires admin authentication):**
```bash
curl -X POST https://ownprem.local/api/admin/rotate-secrets-key \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"newKey": "YOUR_NEW_BASE64_KEY_HERE"}'
```

**Via CLI (on orchestrator server):**
```bash
# Set the new key
export NEW_SECRETS_KEY="YOUR_NEW_BASE64_KEY_HERE"

# Run rotation script
cd /opt/ownprem/repo
npm run rotate-secrets-key
```

### 3. Update Environment

After successful rotation, update the environment configuration:

```bash
# Edit the orchestrator environment file
sudo vim /etc/ownprem/orchestrator.env

# Update the SECRETS_KEY value
SECRETS_KEY=YOUR_NEW_BASE64_KEY_HERE

# Restart the orchestrator
sudo systemctl restart ownprem-orchestrator
```

### 4. Verification

```bash
# Verify orchestrator started successfully
sudo systemctl status ownprem-orchestrator

# Check logs for any decryption errors
journalctl -u ownprem-orchestrator -n 50 | grep -i "decrypt\|secret"

# Test a deployment that uses secrets
curl -s https://ownprem.local/api/deployments | jq '.[] | select(.status == "running")'
```

## Rollback Procedure

If rotation fails or causes issues:

1. **Restore database backup:**
   ```bash
   sudo systemctl stop ownprem-orchestrator
   cp /var/lib/ownprem/db.sqlite.backup-TIMESTAMP /var/lib/ownprem/db.sqlite
   ```

2. **Restore old key in environment:**
   ```bash
   sudo vim /etc/ownprem/orchestrator.env
   # Set SECRETS_KEY back to the old value
   ```

3. **Restart orchestrator:**
   ```bash
   sudo systemctl start ownprem-orchestrator
   ```

## Troubleshooting

### Rotation fails with "Invalid new key format"
- Ensure key is Base64 (44 chars), hex (64 chars), or 32+ characters
- Check for trailing whitespace or newlines

### Rotation fails mid-way
- The operation is transactional - database will be unchanged
- Check logs: `journalctl -u ownprem-orchestrator -n 100`
- Verify database integrity: `sqlite3 /var/lib/ownprem/db.sqlite "PRAGMA integrity_check;"`

### Secrets not decrypting after rotation
- Verify the new key was saved correctly in `/etc/ownprem/orchestrator.env`
- Check the orchestrator restarted and loaded the new key
- Look for startup logs about SECRETS_KEY validation

## Security Notes

- Never log the full key value
- Transmit new keys over secure channels only
- Delete backup files after confirming successful rotation
- The old key is cleared from memory after successful rotation
