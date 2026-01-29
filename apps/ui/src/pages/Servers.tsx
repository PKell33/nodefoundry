import { useState } from 'react';
import { Plus, Copy, Check, Terminal, AlertTriangle } from 'lucide-react';
import { useServers, useDeployments } from '../hooks/useApi';
import { useAuthStore } from '../stores/useAuthStore';
import { api } from '../api/client';
import ServerCard from '../components/ServerCard';
import Modal from '../components/Modal';

export default function Servers() {
  const { data: servers, isLoading, refetch } = useServers();
  const { data: deployments } = useDeployments();
  const { user } = useAuthStore();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null);
  const [setupServerName, setSetupServerName] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const canManage = user?.isSystemAdmin ?? false;

  const handleAddServer = async (name: string, host: string) => {
    try {
      const result = await api.addServer({ name, host });
      setBootstrapCommand(result.bootstrapCommand);
      refetch();
    } catch (err) {
      console.error('Failed to add server:', err);
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    try {
      await api.deleteServer(serverId);
      refetch();
    } catch (err) {
      console.error('Failed to delete server:', err);
    }
  };

  const handleViewGuide = (serverName: string) => {
    setSetupServerName(serverName);
    setGuideModalOpen(true);
  };

  const handleRegenerateToken = async (serverId: string, serverName: string) => {
    try {
      const result = await api.regenerateServerToken(serverId);
      setBootstrapCommand(result.bootstrapCommand);
      setSetupServerName(serverName);
      setSetupModalOpen(true);
    } catch (err) {
      console.error('Failed to regenerate token:', err);
    }
  };

  const copyToClipboard = (text?: string) => {
    const textToCopy = text || bootstrapCommand;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Servers</h1>
          <p className="text-gray-400">Manage your infrastructure</p>
        </div>
        <button
          onClick={() => setAddModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded transition-colors"
        >
          <Plus size={20} />
          Add Server
        </button>
      </div>

      {isLoading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {servers?.map((server) => {
            const serverDeployments = deployments?.filter((d) => d.serverId === server.id) || [];
            return (
              <ServerCard
                key={server.id}
                server={server}
                deploymentCount={serverDeployments.length}
                canManage={canManage}
                onDelete={() => handleDeleteServer(server.id)}
                onViewGuide={() => handleViewGuide(server.name)}
                onRegenerate={() => handleRegenerateToken(server.id, server.name)}
              />
            );
          })}
        </div>
      )}

      {/* Add Server Modal */}
      <Modal
        isOpen={addModalOpen}
        onClose={() => {
          setAddModalOpen(false);
          setBootstrapCommand(null);
        }}
        title={bootstrapCommand ? 'Connect Your Server' : 'Add Server'}
        size={bootstrapCommand ? 'lg' : 'md'}
      >
        {bootstrapCommand ? (
          <div className="space-y-6">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={20} className="text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-yellow-500">Save this information</p>
                <p className="text-gray-400 mt-1">
                  The authentication token is only shown once. If you lose it, you'll need to delete and re-add the server.
                </p>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-3 flex items-center gap-2">
                <Terminal size={16} />
                Setup Instructions
              </h3>
              <ol className="space-y-4 text-sm text-gray-400">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">1</span>
                  <div>
                    <p className="text-gray-200">SSH into your new server</p>
                    <p className="text-xs mt-1">Ensure you have root or sudo access</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">2</span>
                  <div>
                    <p className="text-gray-200">Run the install command</p>
                    <div className="relative mt-2">
                      <pre className="bg-gray-900 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap break-all">
                        {bootstrapCommand}
                      </pre>
                      <button
                        onClick={() => copyToClipboard()}
                        className="absolute top-2 right-2 p-1.5 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
                        title="Copy to clipboard"
                      >
                        {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">3</span>
                  <div>
                    <p className="text-gray-200">Wait for connection</p>
                    <p className="text-xs mt-1">The server status will change from "offline" to "online" once the agent connects</p>
                  </div>
                </li>
              </ol>
            </div>

            <div className="pt-4 border-t border-gray-700">
              <h4 className="text-sm font-medium mb-2">Requirements</h4>
              <ul className="text-xs text-gray-400 space-y-1">
                <li>• Ubuntu 22.04+ or Debian 12+</li>
                <li>• Root or sudo access</li>
                <li>• Network connectivity to this Foundry server</li>
                <li>• curl installed</li>
              </ul>
            </div>

            <button
              onClick={() => {
                setAddModalOpen(false);
                setBootstrapCommand(null);
              }}
              className="w-full px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <AddServerForm onSubmit={handleAddServer} />
        )}
      </Modal>

      {/* Setup Server Modal (for regenerated token) */}
      <Modal
        isOpen={setupModalOpen}
        onClose={() => {
          setSetupModalOpen(false);
          setBootstrapCommand(null);
          setSetupServerName('');
        }}
        title={`Connect ${setupServerName}`}
        size="lg"
      >
        {bootstrapCommand && (
          <div className="space-y-6">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={20} className="text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-yellow-500">New token generated</p>
                <p className="text-gray-400 mt-1">
                  The previous token has been invalidated. Use this new command to connect the agent.
                </p>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-3 flex items-center gap-2">
                <Terminal size={16} />
                Setup Instructions
              </h3>
              <ol className="space-y-4 text-sm text-gray-400">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">1</span>
                  <div>
                    <p className="text-gray-200">SSH into your server</p>
                    <p className="text-xs mt-1">Ensure you have root or sudo access</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">2</span>
                  <div>
                    <p className="text-gray-200">Run the install command</p>
                    <div className="relative mt-2">
                      <pre className="bg-gray-900 p-3 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap break-all">
                        {bootstrapCommand}
                      </pre>
                      <button
                        onClick={() => copyToClipboard()}
                        className="absolute top-2 right-2 p-1.5 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
                        title="Copy to clipboard"
                      >
                        {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-bitcoin text-black flex items-center justify-center text-xs font-bold">3</span>
                  <div>
                    <p className="text-gray-200">Wait for connection</p>
                    <p className="text-xs mt-1">The server status will change to "online" once the agent connects</p>
                  </div>
                </li>
              </ol>
            </div>

            <button
              onClick={() => {
                setSetupModalOpen(false);
                setBootstrapCommand(null);
                setSetupServerName('');
              }}
              className="w-full px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 text-black font-medium rounded transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </Modal>

      {/* Generic Setup Guide Modal (no token) */}
      <Modal
        isOpen={guideModalOpen}
        onClose={() => {
          setGuideModalOpen(false);
          setSetupServerName('');
        }}
        title="Agent Setup Guide"
        size="lg"
      >
        <div className="space-y-6">
          <p className="text-sm text-gray-400">
            This guide explains how to connect a server to OwnPrem. To get the actual install command with
            authentication token, click <strong>"Generate New Token"</strong> from the server menu.
          </p>

          <div>
            <h3 className="font-medium mb-3 flex items-center gap-2">
              <Terminal size={16} />
              Setup Steps
            </h3>
            <ol className="space-y-4 text-sm text-gray-400">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-700 text-white flex items-center justify-center text-xs font-bold">1</span>
                <div>
                  <p className="text-gray-200">Prepare your server</p>
                  <p className="text-xs mt-1">Fresh Ubuntu 22.04+ or Debian 12+ installation with root access</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-700 text-white flex items-center justify-center text-xs font-bold">2</span>
                <div>
                  <p className="text-gray-200">Ensure network connectivity</p>
                  <p className="text-xs mt-1">The server must be able to reach this Foundry instance</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-700 text-white flex items-center justify-center text-xs font-bold">3</span>
                <div>
                  <p className="text-gray-200">Generate a token and run the install command</p>
                  <p className="text-xs mt-1">Use "Generate New Token" to get the command with authentication</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-700 text-white flex items-center justify-center text-xs font-bold">4</span>
                <div>
                  <p className="text-gray-200">Wait for connection</p>
                  <p className="text-xs mt-1">The agent will connect and the server status will show "online"</p>
                </div>
              </li>
            </ol>
          </div>

          <div className="pt-4 border-t border-gray-700">
            <h4 className="text-sm font-medium mb-2">Requirements</h4>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• Ubuntu 22.04+ or Debian 12+</li>
              <li>• Root or sudo access</li>
              <li>• Network connectivity to this Foundry server</li>
              <li>• curl installed</li>
              <li>• At least 1GB RAM, 10GB disk space</li>
            </ul>
          </div>

          <div className="pt-4 border-t border-gray-700">
            <h4 className="text-sm font-medium mb-2">What the installer does</h4>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• Installs Node.js 20 LTS</li>
              <li>• Creates ownprem system user</li>
              <li>• Downloads and configures the agent</li>
              <li>• Sets up systemd service for automatic startup</li>
            </ul>
          </div>

          <button
            onClick={() => {
              setGuideModalOpen(false);
              setSetupServerName('');
            }}
            className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Close
          </button>
        </div>
      </Modal>
    </div>
  );
}

function AddServerForm({ onSubmit }: { onSubmit: (name: string, host: string) => void }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name && host) {
      onSubmit(name, host);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2">Server Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="server-1"
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-2">Host / IP Address</label>
        <input
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="192.168.1.100"
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded focus:outline-none focus:border-bitcoin"
        />
      </div>
      <button
        type="submit"
        disabled={!name || !host}
        className="w-full px-4 py-2 bg-bitcoin hover:bg-bitcoin/90 disabled:bg-gray-700 disabled:text-gray-500 text-black font-medium rounded transition-colors"
      >
        Add Server
      </button>
    </form>
  );
}
