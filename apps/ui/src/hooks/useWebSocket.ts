import { useCallback, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '../stores/useStore';
import { useMetricsStore } from '../stores/useMetricsStore';
import { useSyncProgressStore } from '../stores/useSyncProgressStore';
import { showCommandResult, showError } from '../lib/toast';
import type { Server, Deployment } from '../api/client';

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();
  // Use selectors to avoid subscribing to entire store state
  // This prevents re-renders when history updates
  const setConnected = useStore((state) => state.setConnected);
  const addMetrics = useMetricsStore((state) => state.addMetrics);
  const updateSyncProgress = useSyncProgressStore((state) => state.updateProgress);
  const setSyncComplete = useSyncProgressStore((state) => state.setComplete);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) {
      return;
    }

    const socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      setConnected(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('server:status', (data: ServerStatusEvent) => {
      // Optimistic update - immediately update React Query cache
      queryClient.setQueryData<Server[]>(['servers'], (old) => {
        if (!old) return old;
        return old.map((s) =>
          s.id === data.serverId
            ? {
                ...s,
                agentStatus: 'online' as const,
                metrics: data.metrics,
                networkInfo: data.networkInfo,
                lastSeen: data.timestamp,
              }
            : s
        );
      });

      // Also update individual server query if it exists
      queryClient.setQueryData<Server>(['servers', data.serverId], (old) => {
        if (!old) return old;
        return {
          ...old,
          agentStatus: 'online' as const,
          metrics: data.metrics,
          networkInfo: data.networkInfo,
          lastSeen: data.timestamp,
        };
      });

      // Store metrics history for charts
      if (data.metrics) {
        addMetrics(data.serverId, data.metrics);
      }
    });

    socket.on('server:connected', (data: { serverId: string }) => {
      queryClient.setQueryData<Server[]>(['servers'], (old) => {
        if (!old) return old;
        return old.map((s) =>
          s.id === data.serverId ? { ...s, agentStatus: 'online' as const } : s
        );
      });
      queryClient.setQueryData<Server>(['servers', data.serverId], (old) => {
        if (!old) return old;
        return { ...old, agentStatus: 'online' as const };
      });
    });

    socket.on('server:disconnected', (data: { serverId: string }) => {
      queryClient.setQueryData<Server[]>(['servers'], (old) => {
        if (!old) return old;
        return old.map((s) =>
          s.id === data.serverId ? { ...s, agentStatus: 'offline' as const } : s
        );
      });
      queryClient.setQueryData<Server>(['servers', data.serverId], (old) => {
        if (!old) return old;
        return { ...old, agentStatus: 'offline' as const };
      });
    });

    socket.on('deployment:status', (data: DeploymentStatusEvent) => {
      // Optimistic update - immediately update React Query cache
      queryClient.setQueryData<Deployment[]>(['deployments'], (old) => {
        if (!old) return old;
        return old.map((d) =>
          d.id === data.deploymentId
            ? { ...d, status: data.status, statusMessage: data.message }
            : d
        );
      });

      // Also update individual deployment query if it exists
      queryClient.setQueryData<Deployment>(['deployments', data.deploymentId], (old) => {
        if (!old) return old;
        return { ...old, status: data.status, statusMessage: data.message };
      });

      // Update filtered queries (e.g., by serverId)
      queryClient.setQueriesData<Deployment[]>(
        { queryKey: ['deployments'], exact: false },
        (old) => {
          if (!old) return old;
          return old.map((d) =>
            d.id === data.deploymentId
              ? { ...d, status: data.status, statusMessage: data.message }
              : d
          );
        }
      );
    });

    socket.on('command:result', (data: CommandResultEvent) => {
      // Show toast for command completion
      if (data.action) {
        showCommandResult(data.status, data.action, data.message);
      } else if (data.status === 'error') {
        showCommandResult('error', 'command', data.message);
      }

      // Refresh deployment data when command completes
      if (data.deploymentId) {
        queryClient.invalidateQueries({ queryKey: ['deployments', data.deploymentId] });
        queryClient.invalidateQueries({ queryKey: ['deployments'] });
      }
    });

    // Sync progress events
    socket.on('sync:progress', (data: SyncProgressEvent) => {
      updateSyncProgress(data);
    });

    socket.on('sync:complete', (data: SyncCompleteEvent) => {
      setSyncComplete(data);

      // Show toast for errors if any
      if (data.errors.length > 0) {
        const iconErrors = data.errors.filter(e => e.startsWith('Icon missing:'));
        const otherErrors = data.errors.filter(e => !e.startsWith('Icon missing:'));

        // Show each non-icon error as a toast (limit to first 5 to avoid spam)
        otherErrors.slice(0, 5).forEach(error => {
          showError(error);
        });

        if (otherErrors.length > 5) {
          showError(`...and ${otherErrors.length - 5} more errors`);
        }

        // Log icon errors to console (too noisy for toasts)
        if (iconErrors.length > 0) {
          console.warn(`${iconErrors.length} icons failed to download:`, iconErrors);
        }
      }
    });

    socketRef.current = socket;
  }, [setConnected, addMetrics, queryClient, updateSyncProgress, setSyncComplete]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { connect, disconnect };
}

interface ServerStatusEvent {
  serverId: string;
  timestamp: string;
  metrics: {
    cpuPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
    loadAverage: [number, number, number];
  };
  networkInfo?: {
    ipAddress: string | null;
    macAddress: string | null;
  };
}

interface DeploymentStatusEvent {
  deploymentId: string;
  appName: string;
  serverId: string;
  status: string;
  previousStatus?: string;
  routeActive?: boolean;
  message?: string;
  timestamp: string;
}

interface CommandResultEvent {
  serverId: string;
  commandId: string;
  deploymentId?: string;
  action?: string;
  status: 'success' | 'error';
  message?: string;
}

interface SyncProgressEvent {
  syncId: string;
  storeType: string;
  registryId: string;
  registryName: string;
  phase: 'fetching' | 'processing' | 'complete';
  currentApp?: string;
  processed: number;
  total: number;
  errors: string[];
  timestamp: string;
}

interface SyncCompleteEvent {
  syncId: string;
  storeType: string;
  registryId: string;
  registryName: string;
  synced: number;
  updated: number;
  removed: number;
  errors: string[];
  duration: number;
  timestamp: string;
}
