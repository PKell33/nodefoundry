interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusColors: Record<string, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-500',
  error: 'bg-red-500',
  running: 'bg-green-500',
  stopped: 'bg-yellow-500',
  pending: 'bg-gray-500',
  installing: 'bg-blue-500',
  configuring: 'bg-blue-500',
  updating: 'bg-blue-500',
  uninstalling: 'bg-orange-500',
};

const statusLabels: Record<string, string> = {
  online: 'Online',
  offline: 'Offline',
  error: 'Error',
  running: 'Running',
  stopped: 'Stopped',
  pending: 'Pending',
  installing: 'Installing',
  configuring: 'Configuring',
  updating: 'Updating',
  uninstalling: 'Uninstalling',
};

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const color = statusColors[status] || 'bg-gray-500';
  const label = statusLabels[status] || status;
  const isAnimated = ['installing', 'configuring', 'updating', 'uninstalling'].includes(status);

  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${sizeClasses}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${color} ${isAnimated ? 'animate-pulse' : ''}`}
      />
      <span className="text-gray-600 dark:text-gray-300">{label}</span>
    </span>
  );
}
