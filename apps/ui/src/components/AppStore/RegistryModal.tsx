import { useState } from 'react';
import { X, Plus, Trash2, Loader2 } from 'lucide-react';
import type { Registry } from './types';

interface RegistryModalProps {
  registries: Registry[];
  onClose: () => void;
  onAdd: (id: string, name: string, url: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  isAdding?: boolean;
  urlPlaceholder?: string;
}

export function RegistryModal({
  registries,
  onClose,
  onAdd,
  onToggle,
  onRemove,
  isAdding = false,
  urlPlaceholder = 'Registry URL (GitHub zip archive URL)',
}: RegistryModalProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRegistry, setNewRegistry] = useState({ id: '', name: '', url: '' });
  const [isLocalSubmitting, setIsLocalSubmitting] = useState(false);
  const isSubmitting = isAdding || isLocalSubmitting;

  const handleAdd = async () => {
    if (!newRegistry.id || !newRegistry.name || !newRegistry.url) return;
    setIsLocalSubmitting(true);
    try {
      await onAdd(newRegistry.id, newRegistry.name, newRegistry.url);
      setShowAddForm(false);
      setNewRegistry({ id: '', name: '', url: '' });
    } finally {
      setIsLocalSubmitting(false);
    }
  };

  const handleRemove = async (id: string, name: string) => {
    if (confirm(`Remove registry "${name}"?`)) {
      await onRemove(id);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--bg-primary)] rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h2 className="text-lg font-semibold">Manage Registries</h2>
          <button onClick={onClose} className="p-2 hover:bg-[var(--bg-secondary)] rounded-lg">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto max-h-[60vh]">
          {/* Registry list */}
          {registries.map(registry => (
            <div
              key={registry.id}
              className="flex items-center justify-between p-3 bg-[var(--bg-secondary)] rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{registry.name}</span>
                  <span className="text-xs text-muted">({registry.appCount || 0} apps)</span>
                </div>
                <p className="text-xs text-muted truncate">{registry.url}</p>
              </div>
              <div className="flex items-center gap-2 ml-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={registry.enabled}
                    onChange={(e) => onToggle(registry.id, e.target.checked)}
                    className="form-checkbox"
                  />
                  <span className="text-sm">Enabled</span>
                </label>
                <button
                  onClick={() => handleRemove(registry.id, registry.name)}
                  className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg"
                  title="Remove registry"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}

          {/* Add registry form */}
          {showAddForm ? (
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg space-y-3">
              <input
                type="text"
                placeholder="Registry ID (e.g., my-registry)"
                value={newRegistry.id}
                onChange={(e) => setNewRegistry({
                  ...newRegistry,
                  id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                })}
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-lg"
              />
              <input
                type="text"
                placeholder="Registry Name"
                value={newRegistry.name}
                onChange={(e) => setNewRegistry({ ...newRegistry, name: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-lg"
              />
              <input
                type="url"
                placeholder={urlPlaceholder}
                value={newRegistry.url}
                onChange={(e) => setNewRegistry({ ...newRegistry, url: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-primary)] rounded-lg"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleAdd}
                  disabled={!newRegistry.id || !newRegistry.name || !newRegistry.url || isSubmitting}
                  className="btn btn-primary inline-flex items-center gap-2"
                >
                  {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  Add
                </button>
                <button
                  onClick={() => {
                    setShowAddForm(false);
                    setNewRegistry({ id: '', name: '', url: '' });
                  }}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full p-3 border-2 border-dashed border-[var(--border-primary)] rounded-lg text-muted hover:text-[var(--text-primary)] hover:border-accent transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={18} />
              Add Registry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
