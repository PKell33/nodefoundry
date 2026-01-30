import { getDb } from '../db/index.js';
import { certificateAuthority } from '../services/certificateAuthority.js';
import { auditService } from '../services/auditService.js';
import logger from '../lib/logger.js';

/**
 * Certificate Renewal Job
 *
 * Periodically checks for certificates expiring soon and renews them automatically.
 * Runs every 6 hours by default.
 */

const renewalLogger = logger.child({ component: 'cert-renewal' });

// Check every 6 hours
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

// Renew certificates expiring within this many days
const RENEWAL_THRESHOLD_DAYS = 14;

let checkInterval: NodeJS.Timeout | null = null;
let isRunning = false;

interface CertificateRow {
  id: string;
  name: string;
  type: string;
  subject_cn: string;
  not_after: string;
  issued_to_server_id: string | null;
  issued_to_deployment_id: string | null;
}

/**
 * Start the certificate renewal job.
 */
export function startCertRenewal(): void {
  if (checkInterval) {
    renewalLogger.warn('Certificate renewal job already running');
    return;
  }

  renewalLogger.info({ intervalHours: CHECK_INTERVAL / (60 * 60 * 1000) }, 'Starting certificate renewal job');

  // Run immediately on startup, then on interval
  checkAndRenewCertificates().catch(err => {
    renewalLogger.error({ err }, 'Error in initial certificate renewal check');
  });
  checkInterval = setInterval(() => {
    checkAndRenewCertificates().catch(err => {
      renewalLogger.error({ err }, 'Error in certificate renewal check');
    });
  }, CHECK_INTERVAL);
}

/**
 * Stop the certificate renewal job.
 */
export function stopCertRenewal(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    renewalLogger.info('Stopped certificate renewal job');
  }
}

/**
 * Check for expiring certificates and renew them.
 */
async function checkAndRenewCertificates(): Promise<void> {
  if (isRunning) {
    renewalLogger.debug('Certificate renewal check already in progress, skipping');
    return;
  }

  isRunning = true;
  renewalLogger.debug('Checking for expiring certificates');

  try {
    const db = getDb();

    // Find certificates expiring within threshold
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + RENEWAL_THRESHOLD_DAYS);

    const expiringCerts = db.prepare(`
      SELECT id, name, type, subject_cn, not_after, issued_to_server_id, issued_to_deployment_id
      FROM certificates
      WHERE revoked_at IS NULL
        AND not_after <= ?
        AND type != 'ca'
      ORDER BY not_after ASC
    `).all(thresholdDate.toISOString()) as CertificateRow[];

    if (expiringCerts.length === 0) {
      renewalLogger.debug('No certificates need renewal');
      return;
    }

    renewalLogger.info({ count: expiringCerts.length }, 'Found certificates needing renewal');

    const results: Array<{
      certId: string;
      name: string;
      success: boolean;
      newCertId?: string;
      error?: string;
    }> = [];

    for (const cert of expiringCerts) {
      try {
        const expiresAt = new Date(cert.not_after);
        const daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

        renewalLogger.info({
          certId: cert.id,
          name: cert.name,
          cn: cert.subject_cn,
          daysUntilExpiry,
        }, 'Renewing certificate');

        // Renew the certificate
        const newCert = await certificateAuthority.renewCertificate(cert.id);

        // Audit log
        auditService.log({
          action: 'certificate_renewed',
          resourceType: 'certificate',
          resourceId: newCert.id,
          details: {
            oldCertificateId: cert.id,
            name: cert.name,
            commonName: cert.subject_cn,
            autoRenewal: true,
          },
        });

        results.push({
          certId: cert.id,
          name: cert.name,
          success: true,
          newCertId: newCert.id,
        });

        renewalLogger.info({
          oldCertId: cert.id,
          newCertId: newCert.id,
          name: cert.name,
        }, 'Certificate renewed successfully');

        // If certificate is issued to a deployment, we may need to push the new cert
        // This would be handled by a separate distribution mechanism
        if (cert.issued_to_deployment_id) {
          renewalLogger.debug({
            deploymentId: cert.issued_to_deployment_id,
            newCertId: newCert.id,
          }, 'Certificate renewed for deployment - distribution may be required');
        }

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        renewalLogger.error({
          certId: cert.id,
          name: cert.name,
          err,
        }, 'Failed to renew certificate');

        results.push({
          certId: cert.id,
          name: cert.name,
          success: false,
          error: errorMessage,
        });
      }
    }

    // Summary log
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    renewalLogger.info({
      total: results.length,
      success: successCount,
      failed: failCount,
    }, 'Certificate renewal check completed');

  } catch (err) {
    renewalLogger.error({ err }, 'Error during certificate renewal check');
  } finally {
    isRunning = false;
  }
}

/**
 * Manually trigger a certificate renewal check.
 */
export async function triggerRenewalCheck(): Promise<{
  checked: number;
  renewed: number;
  failed: number;
  details: Array<{ certId: string; name: string; success: boolean; error?: string }>;
}> {
  const db = getDb();

  // Find certificates expiring within threshold
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() + RENEWAL_THRESHOLD_DAYS);

  const expiringCerts = db.prepare(`
    SELECT id, name, type, subject_cn, not_after
    FROM certificates
    WHERE revoked_at IS NULL
      AND not_after <= ?
      AND type != 'ca'
    ORDER BY not_after ASC
  `).all(thresholdDate.toISOString()) as CertificateRow[];

  const details: Array<{ certId: string; name: string; success: boolean; error?: string }> = [];

  for (const cert of expiringCerts) {
    try {
      await certificateAuthority.renewCertificate(cert.id);
      details.push({ certId: cert.id, name: cert.name, success: true });
    } catch (err) {
      details.push({
        certId: cert.id,
        name: cert.name,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return {
    checked: expiringCerts.length,
    renewed: details.filter(d => d.success).length,
    failed: details.filter(d => !d.success).length,
    details,
  };
}

/**
 * Get renewal status and upcoming expirations.
 */
export function getRenewalStatus(): {
  nextCheckAt: Date | null;
  thresholdDays: number;
  expiringCount: number;
  expiringSoon: Array<{
    id: string;
    name: string;
    cn: string;
    expiresAt: Date;
    daysUntilExpiry: number;
  }>;
} {
  const db = getDb();

  // Get certificates expiring in next 30 days
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  const expiring = db.prepare(`
    SELECT id, name, subject_cn, not_after
    FROM certificates
    WHERE revoked_at IS NULL
      AND not_after <= ?
      AND type != 'ca'
    ORDER BY not_after ASC
  `).all(thirtyDaysFromNow.toISOString()) as CertificateRow[];

  const now = Date.now();

  return {
    nextCheckAt: checkInterval ? new Date(now + CHECK_INTERVAL) : null,
    thresholdDays: RENEWAL_THRESHOLD_DAYS,
    expiringCount: expiring.length,
    expiringSoon: expiring.map(cert => {
      const expiresAt = new Date(cert.not_after);
      return {
        id: cert.id,
        name: cert.name,
        cn: cert.subject_cn,
        expiresAt,
        daysUntilExpiry: Math.ceil((expiresAt.getTime() - now) / (1000 * 60 * 60 * 24)),
      };
    }),
  };
}
