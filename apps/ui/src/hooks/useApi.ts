import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, CreateMountData, UpdateMountData, AssignMountData } from '../api/client';

// Server queries
export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: api.getServers,
    refetchInterval: 30000,
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    staleTime: 30000, // Server list changes rarely
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
export function useApps(includeSystem = true) {
  return useQuery({
    queryKey: ['apps', includeSystem],
    queryFn: () => api.getApps(includeSystem),
    staleTime: 5 * 60 * 1000, // 5 minutes - app manifests are static
  });
}

export function useApp(name: string) {
  return useQuery({
    queryKey: ['apps', name],
    queryFn: () => api.getApp(name),
    enabled: !!name,
    staleTime: 5 * 60 * 1000, // 5 minutes - app manifest is static
  });
}

// Deployment queries
export function useDeployments(serverId?: string) {
  return useQuery({
    queryKey: ['deployments', serverId],
    queryFn: () => api.getDeployments(serverId),
    refetchInterval: 10000,
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    staleTime: 5000, // Status can change during operations
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
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    staleTime: 10000, // System status relatively stable
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

// Mount queries
export function useMounts() {
  return useQuery({
    queryKey: ['mounts'],
    queryFn: api.getMounts,
    staleTime: 60000, // 1 minute - mount definitions change rarely
  });
}

export function useServerMounts() {
  return useQuery({
    queryKey: ['serverMounts'],
    queryFn: api.getServerMounts,
    refetchInterval: 30000,
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    staleTime: 30000, // Mount status changes rarely
  });
}

// Mount mutations
export function useCreateMount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateMountData) => api.createMount(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mounts'] });
    },
  });
}

export function useUpdateMount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMountData }) => api.updateMount(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mounts'] });
    },
  });
}

export function useDeleteMount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteMount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mounts'] });
      queryClient.invalidateQueries({ queryKey: ['serverMounts'] });
    },
  });
}

export function useAssignMount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: AssignMountData) => api.assignMountToServer(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverMounts'] });
    },
  });
}

export function useMountStorage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverMountId: string) => api.mountStorage(serverMountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverMounts'] });
    },
  });
}

export function useUnmountStorage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverMountId: string) => api.unmountStorage(serverMountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverMounts'] });
    },
  });
}

export function useDeleteServerMount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverMountId: string) => api.deleteServerMount(serverMountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serverMounts'] });
    },
  });
}
