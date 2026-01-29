import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// Serve the agent install script
router.get('/install.sh', (_req, res) => {
  // Try multiple locations for the install script
  const possiblePaths = [
    // Development: relative to project root
    join(process.cwd(), 'scripts', 'install-agent.sh'),
    join(process.cwd(), '..', '..', 'scripts', 'install-agent.sh'),
    // Production: relative to this file
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts', 'install-agent.sh'),
    // Installed location
    '/opt/nodefoundry/scripts/install-agent.sh',
  ];

  let scriptContent: string | null = null;

  for (const scriptPath of possiblePaths) {
    if (existsSync(scriptPath)) {
      scriptContent = readFileSync(scriptPath, 'utf-8');
      break;
    }
  }

  if (!scriptContent) {
    res.status(404).send('# Install script not found\nexit 1');
    return;
  }

  res.setHeader('Content-Type', 'text/plain');
  res.send(scriptContent);
});

export default router;
