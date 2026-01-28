export interface Server {
  id: string;
  name: string;
  host: string | null;
  isFoundry: boolean;
  agentStatus: 'online' | 'offline' | 'error';
  authToken: string | null;
  metrics?: ServerMetrics;
  lastSeen: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServerMetrics {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  loadAverage: [number, number, number];
}

export type AgentStatus = 'online' | 'offline' | 'error';
