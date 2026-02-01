import { create } from 'zustand';
import type { ServerMetrics } from '../api/client';

interface MetricsDataPoint {
  timestamp: number;
  cpu: number;
  memoryPercent: number;
  memoryUsed: number;
  diskPercent: number;
  diskUsed: number;
}

interface MetricsState {
  history: Record<string, MetricsDataPoint[]>;
  addMetrics: (serverId: string, metrics: ServerMetrics) => void;
}

const MAX_DATA_POINTS = 60; // Keep last 60 data points (e.g., 60 minutes if updated every minute)

export const useMetricsStore = create<MetricsState>((set) => ({
  history: {},

  addMetrics: (serverId: string, metrics: ServerMetrics) => {
    const timestamp = Date.now();
    const memoryPercent = metrics.memoryTotal > 0
      ? (metrics.memoryUsed / metrics.memoryTotal) * 100
      : 0;
    const diskPercent = metrics.diskTotal > 0
      ? (metrics.diskUsed / metrics.diskTotal) * 100
      : 0;

    const dataPoint: MetricsDataPoint = {
      timestamp,
      cpu: metrics.cpuPercent,
      memoryPercent: Math.round(memoryPercent * 10) / 10,
      memoryUsed: metrics.memoryUsed,
      diskPercent: Math.round(diskPercent * 10) / 10,
      diskUsed: metrics.diskUsed,
    };

    set((state) => {
      const current = state.history[serverId] || [];
      const updated = [...current, dataPoint].slice(-MAX_DATA_POINTS);
      return {
        history: {
          ...state.history,
          [serverId]: updated,
        },
      };
    });
  },
}));
