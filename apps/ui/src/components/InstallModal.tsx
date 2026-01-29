import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Loader2, Users } from 'lucide-react';
import Modal from './Modal';
import { useApp, useValidateInstall, useInstallApp } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { api, Group } from '../api/client';
import type { Server, ConfigField } from '../api/client';

interface InstallModalProps {
  appName: string;
  servers: Server[];
  onClose: () => void;
}

export default function InstallModal({ appName, servers, onClose }: InstallModalProps) {
  const [selectedServer, setSelectedServer] = useState<string>(servers[0]?.id || '');
  const [selectedGroup, setSelectedGroup] = useState<string>('default');
  const [groups, setGroups] = useState<Group[]>([]);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState<'select' | 'configure' | 'installing'>('select');
  const { user } = useAuthStore();

  const { data: app } = useApp(appName);
  const { data: validation, isLoading: validating } = useValidateInstall(selectedServer, appName);
  const installMutation = useInstallApp();

  const onlineServers = servers.filter((s) => s.agentStatus === 'online');

  // Initialize config with defaults
  useEffect(() => {
    if (app?.configSchema) {
      const defaults: Record<string, unknown> = {};
      for (const field of app.configSchema) {
        if (field.default !== undefined && !field.generated) {
          defaults[field.name] = field.default;
        }
      }
      setConfig(defaults);
    }
  }, [app]);

  // Fetch groups the user can manage (admin role or system admin)
  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const allGroups = await api.getGroups();
        if (user?.isSystemAdmin) {
          // System admins can install to any group
          setGroups(allGroups);
        } else {
          // Regular users can only install to groups where they are admin
          const adminGroups = allGroups.filter(g => {
            const membership = user?.groups?.find(ug => ug.groupId === g.id);
            return membership?.role === 'admin';
          });
          setGroups(adminGroups);
          // Set default to first group user can manage
          if (adminGroups.length > 0 && !adminGroups.find(g => g.id === selectedGroup)) {
            setSelectedGroup(adminGroups[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to fetch groups:', err);
      }
    };
    fetchGroups();
  }, [user]);

  const handleInstall = async () => {
    if (!selectedServer || !appName) return;

    setStep('installing');
    try {
      await installMutation.mutateAsync({
        serverId: selectedServer,
        appName,
        config,
        groupId: selectedGroup,
      });
      onClose();
    } catch (err) {
      console.error('Install failed:', err);
      setStep('configure');
    }
  };

  const configurableFields = app?.configSchema.filter(
    (f) => !f.generated && !f.secret && !f.inheritFrom
  ) || [];

  return (
    <Modal isOpen={true} onClose={onClose} title={`Install ${app?.displayName || appName}`} size="lg">
      {step === 'select' && (
        <div className="space-y-6">
          {/* Server Selection */}
          <div>
            <label className="block text-sm font-medium mb-2">Select Server</label>
            {onlineServers.length === 0 ? (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-400">
                No servers online. Connect a server first.
              </div>
            ) : (
              <div className="space-y-2">
                {onlineServers.map((server) => (
                  <label
                    key={server.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedServer === server.id
                        ? 'border-bitcoin bg-bitcoin/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="server"
                      value={server.id}
                      checked={selectedServer === server.id}
                      onChange={(e) => setSelectedServer(e.target.value)}
                      className="sr-only"
                    />
                    <div className={`w-4 h-4 rounded-full border-2 ${
                      selectedServer === server.id ? 'border-bitcoin bg-bitcoin' : 'border-gray-500'
                    }`} />
                    <div>
                      <div className="font-medium">{server.name}</div>
                      <div className="text-sm text-gray-400">
                        {server.isFoundry ? 'Orchestrator' : server.host}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Group Selection */}
          {groups.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-2">
                <span className="flex items-center gap-2">
                  <Users size={16} />
                  Assign to Group
                </span>
              </label>
              <p className="text-sm text-gray-400 mb-3">
                Select which group this app belongs to. Only members of this group will be able to manage it.
              </p>
              <select
                value={selectedGroup}
                onChange={(e) => setSelectedGroup(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.id === 'default' ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Dependency Check */}
          {selectedServer && (
            <div>
              <label className="block text-sm font-medium mb-2">Dependencies</label>
              {validating ? (
                <div className="flex items-center gap-2 text-gray-400">
                  <Loader2 size={16} className="animate-spin" />
                  Checking dependencies...
                </div>
              ) : validation ? (
                <div className="space-y-2">
                  {validation.dependencies.map((dep) => (
                    <div
                      key={dep.service}
                      className={`flex items-center gap-2 p-2 rounded ${
                        dep.satisfied
                          ? 'bg-green-900/20 text-green-400'
                          : dep.optional
                          ? 'bg-yellow-900/20 text-yellow-400'
                          : 'bg-red-900/20 text-red-400'
                      }`}
                    >
                      {dep.satisfied ? (
                        <CheckCircle size={16} />
                      ) : dep.optional ? (
                        <AlertTriangle size={16} />
                      ) : (
                        <XCircle size={16} />
                      )}
                      <span>{dep.service}</span>
                      {dep.satisfied && dep.providers[0] && (
                        <span className="text-sm opacity-75">
                          (on {dep.providers[0].serverId})
                        </span>
                      )}
                      {!dep.satisfied && dep.optional && (
                        <span className="text-sm opacity-75">(optional)</span>
                      )}
                    </div>
                  ))}

                  {validation.errors.length > 0 && (
                    <div className="mt-2 p-3 bg-red-900/20 border border-red-800 rounded-lg">
                      <div className="font-medium text-red-400 mb-1">Cannot install:</div>
                      <ul className="list-disc list-inside text-sm text-red-400">
                        {validation.errors.map((err, i) => (
                          <li key={i}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validation.warnings.length > 0 && (
                    <div className="mt-2 p-3 bg-yellow-900/20 border border-yellow-800 rounded-lg">
                      <div className="font-medium text-yellow-400 mb-1">Warnings:</div>
                      <ul className="list-disc list-inside text-sm text-yellow-400">
                        {validation.warnings.map((warn, i) => (
                          <li key={i}>{warn}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : app?.requires?.length === 0 ? (
                <div className="flex items-center gap-2 text-green-400">
                  <CheckCircle size={16} />
                  No dependencies required
                </div>
              ) : null}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-gray-700">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setStep('configure')}
              disabled={!validation?.valid || !selectedServer}
              className="flex-1 px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 disabled:bg-gray-700 disabled:text-gray-500 text-black font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'configure' && (
        <div className="space-y-6">
          {configurableFields.length > 0 ? (
            <div className="space-y-4">
              {configurableFields.map((field) => (
                <ConfigFieldInput
                  key={field.name}
                  field={field}
                  value={config[field.name]}
                  onChange={(value) => setConfig({ ...config, [field.name]: value })}
                />
              ))}
            </div>
          ) : (
            <div className="text-gray-400 text-center py-8">
              No configuration needed. Ready to install!
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-gray-700">
            <button
              onClick={() => setStep('select')}
              className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleInstall}
              className="flex-1 px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded transition-colors"
            >
              Install
            </button>
          </div>
        </div>
      )}

      {step === 'installing' && (
        <div className="text-center py-12">
          <Loader2 size={48} className="mx-auto mb-4 animate-spin text-bitcoin" />
          <div className="text-lg font-medium mb-2">Installing {app?.displayName}...</div>
          <div className="text-gray-400">This may take a few minutes</div>
        </div>
      )}
    </Modal>
  );
}

function ConfigFieldInput({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `field-${field.name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-2">
        {field.label}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>

      {field.description && (
        <p className="text-sm text-gray-400 mb-2">{field.description}</p>
      )}

      {field.type === 'select' && field.options ? (
        <select
          id={id}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-700 bg-gray-900 text-bitcoin focus:ring-bitcoin"
          />
          <span className="text-gray-300">Enabled</span>
        </label>
      ) : field.type === 'number' ? (
        <input
          id={id}
          type="number"
          value={String(value || '')}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
        />
      ) : (
        <input
          id={id}
          type={field.type === 'password' ? 'password' : 'text'}
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
        />
      )}
    </div>
  );
}
