export interface Service {
  id: string;
  deploymentId: string;
  serviceName: string;
  serverId: string;
  host: string;
  port: number;
  torAddress?: string;
  status: ServiceStatus;
}

export type ServiceStatus = 'available' | 'unavailable';

export interface ServiceConnection {
  host: string;
  port: number;
  credentials?: Record<string, string>;
}
