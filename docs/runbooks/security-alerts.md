# Security Alerts Runbook

## Overview

This runbook covers how to respond to security-related alerts from OwnPrem.

## Alert: TOKEN_THEFT_DETECTED

### Severity: HIGH

### What it means

A refresh token that was already rotated (replaced with a new token) was presented for use. This indicates one of two scenarios:

1. **Token theft**: An attacker stole an old token and tried to use it after the legitimate user already refreshed
2. **Session replay**: A legitimate user's old token was replayed (less common)

The system automatically invalidates the entire token family when this occurs, logging out all sessions in that lineage.

### Log format

```json
{
  "level": "warn",
  "msg": "TOKEN THEFT DETECTED: Rotated token reused - invalidating entire token family",
  "userId": "abc-123-def",
  "familyId": "xyz-789-uvw"
}
```

### Immediate actions

1. **Identify the affected user:**
   ```bash
   # Find user details
   sqlite3 /var/lib/ownprem/db.sqlite \
     "SELECT username, last_login_at FROM users WHERE id = 'USER_ID_FROM_LOG';"
   ```

2. **Check for active sessions (should be none after auto-invalidation):**
   ```bash
   sqlite3 /var/lib/ownprem/db.sqlite \
     "SELECT * FROM refresh_tokens WHERE user_id = 'USER_ID_FROM_LOG';"
   ```

3. **Review recent audit log for suspicious activity:**
   ```bash
   sqlite3 /var/lib/ownprem/db.sqlite \
     "SELECT * FROM audit_log WHERE user_id = 'USER_ID_FROM_LOG' ORDER BY timestamp DESC LIMIT 20;"
   ```

4. **Check for multiple theft detections:**
   ```bash
   # Count theft events in last 24 hours
   journalctl -u ownprem-orchestrator --since "24 hours ago" | grep "TOKEN THEFT DETECTED" | wc -l
   ```

### Investigation

1. **Compare IP addresses** from the session metadata to identify where the stolen token was used from
2. **Review user's recent actions** to identify what an attacker may have accessed
3. **Check for patterns** across multiple users (may indicate broader compromise)

### Remediation

1. **Contact the affected user** and advise them to:
   - Change their password
   - Enable 2FA if not already enabled
   - Review any actions taken on their behalf

2. **If compromise is confirmed:**
   - Force password reset:
     ```sql
     UPDATE users SET password_hash = 'FORCE_RESET' WHERE id = 'USER_ID';
     ```
   - Consider rotating affected deployment secrets

3. **If pattern indicates broader attack:**
   - Review all active sessions across users
   - Consider invalidating all refresh tokens system-wide
   - Rotate JWT_SECRET (invalidates all access tokens)

### Monitoring setup

Add alerting on this log pattern to your monitoring system:

**Loki/Grafana:**
```
{job="ownprem-orchestrator"} |= "TOKEN THEFT DETECTED"
```

**CloudWatch Logs Insights:**
```
fields @timestamp, @message
| filter @message like /TOKEN THEFT DETECTED/
| sort @timestamp desc
```

**Datadog:**
```
service:ownprem-orchestrator "TOKEN THEFT DETECTED"
```

### Recommended alert thresholds

| Threshold | Action |
|-----------|--------|
| 1 event | Page on-call (investigate immediately) |
| 5+ events in 1 hour | Escalate to security team |
| Pattern across users | Incident response activation |

---

## Alert: CREDENTIAL_INJECTION_ATTEMPT

### Severity: MEDIUM

### What it means

Someone attempted to inject newlines or null bytes into CIFS credentials, potentially trying to escape the credentials file format.

### Log location

Privileged helper logs: `journalctl -u ownprem-privileged-helper`

### Response

1. Identify the source of the request
2. Review what mount operation was being attempted
3. This is blocked by validation but indicates malicious intent

---

## Alert: PATH_VALIDATION_FAILED / SYMLINK_NOT_ALLOWED

### Severity: MEDIUM

### What it means

The privileged helper rejected an operation due to path traversal or symlink attack attempt.

### Response

1. Review privileged helper logs for details
2. Investigate if legitimate operation was incorrectly blocked
3. If attack attempt, investigate source

---

## Monitoring Checklist

Ensure your monitoring system has alerts configured for:

- [ ] `TOKEN THEFT DETECTED` - immediate page
- [ ] `CREDENTIAL_INJECTION_ATTEMPT` - security review queue
- [ ] `PATH_VALIDATION_FAILED` - security review queue
- [ ] `SYMLINK_NOT_ALLOWED` - security review queue
- [ ] `Key rotation failed` - ops alert
- [ ] Multiple failed login attempts (existing rate limiting logs)
