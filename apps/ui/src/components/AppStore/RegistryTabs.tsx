import type { Registry } from './types';

interface RegistryTabsProps {
  registries: Registry[];
  selectedRegistryId: string | undefined;
  onSelectRegistry: (registryId: string) => void;
}

export function RegistryTabs({
  registries,
  selectedRegistryId,
  onSelectRegistry,
}: RegistryTabsProps) {
  if (registries.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-2 flex-wrap">
      {registries.map(registry => (
        <button
          key={registry.id}
          onClick={() => onSelectRegistry(registry.id)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            selectedRegistryId === registry.id
              ? 'bg-accent text-white'
              : 'bg-[var(--bg-secondary)] text-muted hover:text-[var(--text-primary)]'
          }`}
        >
          {registry.name}
          <span className="ml-2 text-xs opacity-75">
            ({registry.appCount || 0})
          </span>
        </button>
      ))}
    </div>
  );
}
