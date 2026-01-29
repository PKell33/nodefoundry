import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import type { ServerMetrics, AppStatus } from '@ownprem/shared';

export class Reporter {
  constructor(
    private serverId: string,
    private appsDir: string = '/opt/ownprem/apps'
  ) {}

  async getMetrics(): Promise<ServerMetrics> {
    return {
      cpuPercent: this.getCpuPercent(),
      memoryUsed: this.getMemoryUsed(),
      memoryTotal: this.getMemoryTotal(),
      diskUsed: this.getDiskUsed(),
      diskTotal: this.getDiskTotal(),
      loadAverage: this.getLoadAverage(),
    };
  }

  async getAppStatuses(): Promise<AppStatus[]> {
    const statuses: AppStatus[] = [];

    // Check which apps are installed
    if (!existsSync(this.appsDir)) {
      return statuses;
    }

    const apps = readdirSync(this.appsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const app of apps) {
      statuses.push(await this.getAppStatus(app));
    }

    return statuses;
  }

  private async getAppStatus(appName: string): Promise<AppStatus> {
    try {
      // Check systemd service status
      const result = execSync(`systemctl is-active ${appName} 2>/dev/null || true`, {
        encoding: 'utf-8',
      }).trim();

      let status: AppStatus['status'];
      switch (result) {
        case 'active':
          status = 'running';
          break;
        case 'inactive':
        case 'failed':
          status = 'stopped';
          break;
        default:
          status = 'not-installed';
      }

      return {
        name: appName,
        status,
      };
    } catch {
      return {
        name: appName,
        status: 'error',
      };
    }
  }

  private getCpuPercent(): number {
    try {
      // Read /proc/stat for CPU usage
      const stat = readFileSync('/proc/stat', 'utf-8');
      const cpuLine = stat.split('\n')[0];
      const values = cpuLine.split(/\s+/).slice(1).map(Number);
      const idle = values[3];
      const total = values.reduce((a, b) => a + b, 0);
      // This is a snapshot, not average - good enough for periodic reporting
      return Math.round((1 - idle / total) * 100);
    } catch {
      return 0;
    }
  }

  private getMemoryUsed(): number {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8');
      const lines = meminfo.split('\n');
      const total = this.parseMemLine(lines.find(l => l.startsWith('MemTotal:')) || '');
      const available = this.parseMemLine(lines.find(l => l.startsWith('MemAvailable:')) || '');
      return total - available;
    } catch {
      return 0;
    }
  }

  private getMemoryTotal(): number {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8');
      const line = meminfo.split('\n').find(l => l.startsWith('MemTotal:'));
      return this.parseMemLine(line || '');
    } catch {
      return 0;
    }
  }

  private parseMemLine(line: string): number {
    const match = line.match(/(\d+)/);
    return match ? parseInt(match[1], 10) * 1024 : 0; // Convert KB to bytes
  }

  private getDiskUsed(): number {
    try {
      const result = execSync("df / | tail -1 | awk '{print $3}'", {
        encoding: 'utf-8',
      });
      return parseInt(result.trim(), 10) * 1024; // Convert KB to bytes
    } catch {
      return 0;
    }
  }

  private getDiskTotal(): number {
    try {
      const result = execSync("df / | tail -1 | awk '{print $2}'", {
        encoding: 'utf-8',
      });
      return parseInt(result.trim(), 10) * 1024; // Convert KB to bytes
    } catch {
      return 0;
    }
  }

  private getLoadAverage(): [number, number, number] {
    try {
      const loadavg = readFileSync('/proc/loadavg', 'utf-8');
      const parts = loadavg.split(' ');
      return [
        parseFloat(parts[0]),
        parseFloat(parts[1]),
        parseFloat(parts[2]),
      ];
    } catch {
      return [0, 0, 0];
    }
  }
}
