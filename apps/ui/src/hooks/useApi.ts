import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Server queries
export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: api.getServers,
    refetchInterval: 30000,
  });
}

export function useServer(id: string) {
  return useQuery({
    queryKey: ['servers', id],
    queryFn: () => api.getServer(id),
    enabled: !!id,
  });
}

// App queries
export function useApps() {
  return useQuery({
    queryKey: ['apps'],
    queryFn: api.getApps,
  });
}

export function useApp(name: string) {
  return useQuery({
    queryKey: ['apps', name],
    queryFn: () => api.getApp(name),
    enabled: !!name,
  });
}

// Deployment queries
export function useDeployments(serverId?: string) {
  return useQuery({
    queryKey: ['deployments', serverId],
    queryFn: () => api.getDeployments(serverId),
    refetchInterval: 10000,
  });
}

export function useDeployment(id: string) {
  return useQuery({
    queryKey: ['deployments', 'detail', id],
    queryFn: () => api.getDeployment(id),
    enabled: !!id,
  });
}

// System status
export function useSystemStatus() {
  return useQuery({
    queryKey: ['system', 'status'],
    queryFn: api.getSystemStatus,
    refetchInterval: 10000,
  });
}

// Mutations
export function useInstallApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serverId, appName, config, groupId }: { serverId: string; appName: string; config?: Record<string, unknown>; groupId?: string }) =>
      api.installApp(serverId, appName, config, groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

export function useStartDeployment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.startDeployment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

export function useStopDeployment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.stopDeployment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

export function useRestartDeployment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.restartDeployment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });
}

export function useUninstallDeployment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.uninstallDeployment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}

export function useValidateInstall(serverId: string, appName: string) {
  return useQuery({
    queryKey: ['validate', serverId, appName],
    queryFn: () => api.validateInstall(serverId, appName),
    enabled: !!serverId && !!appName,
  });
}
