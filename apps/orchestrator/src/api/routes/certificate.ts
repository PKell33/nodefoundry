import { Router } from 'express';
import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { apiLogger } from '../../lib/logger.js';

const router = Router();

// CA certificate paths (in order of preference)
// Priority: step-ca root (shared across Caddy HA) > Caddy internal CA (local fallback)
const CA_CERT_PATHS = [
  '/etc/step-ca/root_ca.crt',           // Step-CA root (preferred for HA)
  '/etc/caddy/ca-root.crt',             // Copied step-ca root on Caddy servers
  '/etc/caddy/root-ca.crt',             // Copied by install-caddy.sh for easy access
  '/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt',  // Caddy internal CA (fallback)
  '/home/caddy/.local/share/caddy/pki/authorities/local/root.crt',
  '/root/.local/share/caddy/pki/authorities/local/root.crt',
];

async function findCaCert(): Promise<string | null> {
  for (const certPath of CA_CERT_PATHS) {
    try {
      await access(certPath, constants.R_OK);
      return certPath;
    } catch {
      // Try next path
    }
  }
  return null;
}

// GET /api/certificate/ca - Download Caddy root CA certificate
router.get('/ca', async (_req, res) => {
  try {
    const certPath = await findCaCert();

    if (!certPath) {
      return res.status(404).json({
        error: {
          code: 'CA_NOT_FOUND',
          message: 'Caddy root CA certificate not found. Caddy may not have generated certificates yet.',
        },
      });
    }

    const cert = await readFile(certPath, 'utf-8');

    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="ownprem-ca.crt"');
    res.send(cert);
  } catch (err) {
    apiLogger.error({ err }, 'Error reading CA certificate');
    res.status(500).json({
      error: {
        code: 'CA_READ_ERROR',
        message: 'Failed to read CA certificate',
      },
    });
  }
});

// GET /api/certificate/ca/info - Check if CA cert is available
router.get('/ca/info', async (_req, res) => {
  try {
    const certPath = await findCaCert();

    if (!certPath) {
      return res.json({
        available: false,
        message: 'Caddy root CA certificate not found',
      });
    }

    const cert = await readFile(certPath, 'utf-8');

    // Extract basic info from the PEM certificate
    const lines = cert.split('\n');
    const isValid = lines.some(l => l.includes('BEGIN CERTIFICATE'));

    res.json({
      available: true,
      path: certPath,
      valid: isValid,
    });
  } catch (err) {
    res.json({
      available: false,
      message: 'Error checking CA certificate',
    });
  }
});

export default router;
