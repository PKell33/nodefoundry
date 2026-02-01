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

// TODO: Umbrel App Store hooks will be added here

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
