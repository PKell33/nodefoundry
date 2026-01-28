import { execSync, spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { dirname } from 'path';
import type { CommandPayload, ConfigFile } from '@nodefoundry/shared';

export class Executor {
  constructor(private appsDir: string = '/opt/nodefoundry/apps') {}

  async install(appName: string, payload: CommandPayload): Promise<void> {
    const appDir = `${this.appsDir}/${appName}`;
    mkdirSync(appDir, { recursive: true });

    // Write config files
    if (payload.files) {
      await this.writeFiles(payload.files);
    }

    // Run install script
    const installScript = `${appDir}/install.sh`;
    if (existsSync(installScript)) {
      await this.runScript(installScript, {
        ...process.env,
        ...payload.env,
        APP_NAME: appName,
        APP_VERSION: payload.version || '',
        APP_DIR: appDir,
      });
    }
  }

  async configure(appName: string, files: ConfigFile[]): Promise<void> {
    // Write config files
    await this.writeFiles(files);

    // Run configure script if it exists
    const configureScript = `${this.appsDir}/${appName}/configure.sh`;
    if (existsSync(configureScript)) {
      await this.runScript(configureScript, {
        APP_NAME: appName,
        APP_DIR: `${this.appsDir}/${appName}`,
      });
    }
  }

  async uninstall(appName: string): Promise<void> {
    // Stop service first
    await this.systemctl('stop', appName).catch(() => {
      // Ignore errors if service doesn't exist
    });

    // Disable service
    await this.systemctl('disable', appName).catch(() => {
      // Ignore errors
    });

    // Run uninstall script if it exists
    const uninstallScript = `${this.appsDir}/${appName}/uninstall.sh`;
    if (existsSync(uninstallScript)) {
      await this.runScript(uninstallScript, {
        APP_NAME: appName,
        APP_DIR: `${this.appsDir}/${appName}`,
      });
    }
  }

  async systemctl(action: string, service: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('systemctl', [action, service], {
        stdio: 'inherit',
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`systemctl ${action} ${service} failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async writeFiles(files: ConfigFile[]): Promise<void> {
    for (const file of files) {
      const dir = dirname(file.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(file.path, file.content);

      if (file.mode) {
        chmodSync(file.path, parseInt(file.mode, 8));
      }

      if (file.owner) {
        try {
          execSync(`chown ${file.owner} ${file.path}`);
        } catch (err) {
          console.warn(`Failed to change owner of ${file.path}: ${err}`);
        }
      }

      console.log(`Wrote file: ${file.path}`);
    }
  }

  private async runScript(script: string, env: Record<string, string | undefined>): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`Running script: ${script}`);

      const proc = spawn('bash', [script], {
        stdio: 'inherit',
        env: env as NodeJS.ProcessEnv,
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`Script completed: ${script}`);
          resolve();
        } else {
          reject(new Error(`Script ${script} failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
