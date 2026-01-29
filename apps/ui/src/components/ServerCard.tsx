import { Server, Cpu, HardDrive, MemoryStick, Trash2, MoreVertical } from 'lucide-react';
import { useState } from 'react';
import type { Server as ServerType } from '../api/client';
import StatusBadge from './StatusBadge';

interface ServerCardProps {
  server: ServerType;
  deploymentCount?: number;
  onClick?: () => void;
  onDelete?: () => void;
  canManage?: boolean;
}

export default function ServerCard({ server, deploymentCount = 0, onClick, onDelete, canManage = false }: ServerCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const metrics = server.metrics;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete?.();
      setConfirmDelete(false);
      setShowMenu(false);
    } else {
      setConfirmDelete(true);
    }
  };

  return (
    <div
      onClick={onClick}
      className={`card p-3 md:p-4 ${
        onClick ? 'cursor-pointer card-hover' : ''
      }`}
    >
      <div className="flex items-start justify-between mb-2 md:mb-3">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="p-1.5 md:p-2 rounded-lg flex-shrink-0 dark:bg-gray-700 light:bg-gray-100">
            <Server size={18} className={server.isFoundry ? 'text-bitcoin' : 'dark:text-gray-400 light:text-gray-500'} />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm md:text-base truncate">{server.name}</h3>
            <p className="text-xs md:text-sm dark:text-gray-400 light:text-gray-500 truncate">
              {server.isFoundry ? 'Orchestrator' : server.host || 'Unknown'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={server.agentStatus} />
          {canManage && !server.isFoundry && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(!showMenu);
                  setConfirmDelete(false);
                }}
                className="p-1 rounded hover:bg-gray-700 dark:hover:bg-gray-700 light:hover:bg-gray-200 transition-colors"
              >
                <MoreVertical size={16} />
              </button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMenu(false);
                      setConfirmDelete(false);
                    }}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 py-1 rounded-lg shadow-lg min-w-[140px]
                    dark:bg-gray-800 dark:border dark:border-gray-700
                    light:bg-white light:border light:border-gray-200">
                    <button
                      onClick={handleDelete}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 size={14} />
                      {confirmDelete ? 'Confirm Delete' : 'Delete Server'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {metrics && server.agentStatus === 'online' && (
        <div className="grid grid-cols-3 gap-1 md:gap-2 mt-2 md:mt-3 pt-2 md:pt-3 border-t dark:border-gray-700 light:border-gray-200">
          <MetricItem
            icon={<Cpu size={12} />}
            label="CPU"
            value={`${metrics.cpuPercent}%`}
          />
          <MetricItem
            icon={<MemoryStick size={12} />}
            label="RAM"
            value={formatBytes(metrics.memoryUsed)}
          />
          <MetricItem
            icon={<HardDrive size={12} />}
            label="Disk"
            value={formatBytes(metrics.diskUsed)}
          />
        </div>
      )}

      <div className="mt-2 md:mt-3 pt-2 md:pt-3 border-t dark:border-gray-700 light:border-gray-200 text-xs md:text-sm dark:text-gray-400 light:text-gray-500">
        {deploymentCount} app{deploymentCount !== 1 ? 's' : ''} deployed
      </div>
    </div>
  );
}

function MetricItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 dark:text-gray-400 light:text-gray-500 mb-0.5 md:mb-1">
        {icon}
        <span className="text-[10px] md:text-xs">{label}</span>
      </div>
      <div className="text-xs md:text-sm font-medium">{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
