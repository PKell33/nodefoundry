import { Server, Cpu, HardDrive, MemoryStick, Trash2, MoreVertical, FileText, KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { Server as ServerType } from '../api/client';
import StatusBadge from './StatusBadge';

interface ServerCardProps {
  server: ServerType;
  deploymentCount?: number;
  onClick?: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onViewGuide?: () => void;
  canManage?: boolean;
}

export default function ServerCard({ server, deploymentCount = 0, onClick, onDelete, onRegenerate, onViewGuide, canManage = false }: ServerCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const metrics = server.metrics;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete?.();
      setConfirmDelete(false);
      setShowMenu(false);
    } else {
      setConfirmDelete(true);
      setConfirmRegenerate(false);
    }
  };

  const handleViewGuide = (e: React.MouseEvent) => {
    e.stopPropagation();
    onViewGuide?.();
    setShowMenu(false);
  };

  const handleRegenerate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmRegenerate) {
      setConfirmRegenerate(true);
      setConfirmDelete(false);
      return;
    }
    onRegenerate?.();
    setConfirmRegenerate(false);
    setShowMenu(false);
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
          <div className="p-1.5 md:p-2 rounded-lg flex-shrink-0 bg-[var(--bg-secondary)]">
            <Server size={18} className={server.isCore ? 'text-accent' : 'text-muted'} />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm md:text-base truncate">{server.name}</h3>
            <p className="text-xs md:text-sm text-muted truncate">
              {server.isCore ? 'Orchestrator' : server.host || 'Unknown'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={server.agentStatus} />
          {canManage && !server.isCore && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(!showMenu);
                  setConfirmDelete(false);
                  setConfirmRegenerate(false);
                }}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
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
                      setConfirmRegenerate(false);
                    }}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 py-1 rounded-lg shadow-lg min-w-[180px]
                    bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                    <button
                      onClick={handleViewGuide}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      <FileText size={14} />
                      Setup Guide
                    </button>
                    <button
                      onClick={handleRegenerate}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                        ${confirmRegenerate
                          ? 'text-yellow-500 hover:bg-yellow-500/10'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                    >
                      <KeyRound size={14} />
                      {confirmRegenerate ? 'Confirm (invalidates token)' : 'Generate New Token'}
                    </button>
                    <div className="my-1 border-t border-[var(--border-color)]" />
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
        <div className="grid grid-cols-3 gap-1 md:gap-2 mt-2 md:mt-3 pt-2 md:pt-3 border-t border-[var(--border-color)]">
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

      <div className="mt-2 md:mt-3 pt-2 md:pt-3 border-t border-[var(--border-color)] text-xs md:text-sm text-muted">
        {deploymentCount} app{deploymentCount !== 1 ? 's' : ''} deployed
      </div>
    </div>
  );
}

function MetricItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 text-muted mb-0.5 md:mb-1">
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
