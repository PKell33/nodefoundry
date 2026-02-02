import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Github,
  Globe,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
  Play,
  Package,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { InstallModal, type InstallableApp } from '../../components/InstallModal';
import { api } from '../../api/client';
import type { AppStoreSource } from '../../components/AppStore/types';

// Store display names
const STORE_NAMES: Record<AppStoreSource, string> = {
  umbrel: 'Umbrel',
  start9: 'Start9',
  casaos: 'CasaOS',
  runtipi: 'Runtipi',
};

export default function AppDetail() {
  const { store, registry, appId } = useParams<{
    store: string;
    registry: string;
    appId: string;
  }>();
  const queryClient = useQueryClient();

  const [currentImage, setCurrentImage] = useState(0);
  const [activeTab, setActiveTab] = useState<'about' | 'info' | 'whats-new'>('about');
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [galleryFailed, setGalleryFailed] = useState(false);

  const storeType = store as AppStoreSource;

  // Fetch app data based on store type
  const {
    data: app,
    isLoading: appLoading,
    error: appError,
  } = useQuery({
    queryKey: ['app', store, appId],
    queryFn: async () => {
      switch (storeType) {
        case 'umbrel':
          return api.getApp(appId!);
        case 'start9':
          return api.getStart9App(appId!);
        case 'casaos':
          return api.getCasaOSApp(appId!);
        case 'runtipi':
          return api.getRuntipiApp(appId!);
        default:
          throw new Error(`Unknown store: ${store}`);
      }
    },
    enabled: !!store && !!appId,
  });

  // Fetch servers for install
  const { data: servers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers(),
  });

  // Fetch deployments to check if installed
  const { data: deploymentsData } = useQuery({
    queryKey: ['deployments'],
    queryFn: () => api.getDeployments(),
  });

  // Deploy mutation
  const deployMutation = useMutation({
    mutationFn: async (serverId: string) => {
      return api.deployApp(serverId, appId!);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setShowInstallModal(false);
    },
  });

  const serverList = servers || [];
  const deployments = deploymentsData?.deployments || [];
  const deployment = deployments.find((d) => d.appName === appId);
  const isInstalled = !!deployment;

  // Extract app properties with fallbacks for different store formats
  const getAppProperty = (prop: string): unknown => {
    if (!app) return undefined;
    const appObj = app as unknown as Record<string, unknown>;
    // Try direct property first
    if (prop in appObj) return appObj[prop];
    // Try manifest for Umbrel apps
    if ('manifest' in appObj && appObj.manifest) {
      const manifest = appObj.manifest as Record<string, unknown>;
      if (prop in manifest) return manifest[prop];
    }
    return undefined;
  };

  const appName = (getAppProperty('name') as string) || (getAppProperty('title') as string) || appId || '';
  const appTagline = (getAppProperty('tagline') as string) || (getAppProperty('shortDescription') as string) || '';
  const appDescription = (getAppProperty('description') as string) || (getAppProperty('longDescription') as string) || '';
  const appVersion = (getAppProperty('version') as string) || '';
  const appDeveloper = (getAppProperty('developer') as string) || (getAppProperty('author') as string) || 'Unknown';
  const appCategory = (getAppProperty('category') as string) || '';
  const appIcon = (getAppProperty('icon') as string) || '';
  const appPort = (getAppProperty('port') as number) || 0;
  const appGallery = (getAppProperty('gallery') as string[]) || [];
  const appDependencies = (getAppProperty('dependencies') as string[]) || [];
  const appWebsite = (getAppProperty('website') as string) || (getAppProperty('marketingSite') as string) || '';
  const appRepo = (getAppProperty('repo') as string) || (getAppProperty('wrapperRepo') as string) || (getAppProperty('upstreamRepo') as string) || (getAppProperty('source') as string) || '';
  const appSupport = (getAppProperty('support') as string) || (getAppProperty('supportSite') as string) || '';
  const appReleaseNotes = (getAppProperty('releaseNotes') as string) || '';

  const hasGallery = appGallery.length > 0 && !galleryFailed;
  const hasReleaseNotes = appReleaseNotes.trim().length > 0;
  const hasResources = !!appWebsite || !!appRepo || !!appSupport;

  // Get gallery image URL - use proxy for Umbrel to avoid CORS issues
  const getGalleryUrl = (index: number): string => {
    if (storeType === 'umbrel' && appId) {
      return `/api/apps/${encodeURIComponent(appId)}/gallery/${index}`;
    }
    return appGallery[index] || '';
  };

  const nextImage = () => {
    if (hasGallery) {
      setCurrentImage((prev) => (prev + 1) % appGallery.length);
    }
  };

  const prevImage = () => {
    if (hasGallery) {
      setCurrentImage((prev) => (prev - 1 + appGallery.length) % appGallery.length);
    }
  };

  // Format description - convert double newlines to paragraphs
  const formatDescription = (text: string) => {
    return text.split(/\n\n+/).map((paragraph, i) => (
      <p key={i} className="mb-4 last:mb-0">
        {paragraph.split('\n').map((line, j) => (
          <span key={j}>
            {line}
            {j < paragraph.split('\n').length - 1 && <br />}
          </span>
        ))}
      </p>
    ));
  };

  if (appLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (appError || !app) {
    return (
      <div className="card p-6 text-center">
        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h2 className="text-lg font-medium mb-2">App not found</h2>
        <p className="text-muted">
          The app "{appId}" could not be found in the {STORE_NAMES[storeType]} store.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
        {/* Header with icon and basic info */}
        <div className="flex items-start gap-6">
          <img
            src={appIcon}
            alt={appName}
            className="w-24 h-24 rounded-xl bg-[var(--bg-tertiary)]"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{appName}</h1>
            <p className="text-muted text-lg">{appTagline}</p>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted">
              <span>v{appVersion}</span>
              <span>by {appDeveloper}</span>
              <span className="capitalize">{appCategory}</span>
            </div>
          </div>

          {/* Install button */}
          <div>
            {isInstalled ? (
              <span
                className={`px-4 py-2 rounded-lg text-sm font-medium ${
                  deployment?.status === 'running'
                    ? 'bg-green-500/20 text-green-500'
                    : deployment?.status === 'error'
                    ? 'bg-red-500/20 text-red-500'
                    : 'bg-yellow-500/20 text-yellow-500'
                }`}
              >
                {deployment?.status || 'Installed'}
              </span>
            ) : (
              <button
                onClick={() => setShowInstallModal(true)}
                disabled={serverList.length === 0}
                className="btn btn-primary btn-lg inline-flex items-center gap-2"
              >
                <Play size={18} />
                Install
              </button>
            )}
          </div>
        </div>

        {/* Gallery */}
        {hasGallery && (
          <div className="relative rounded-lg overflow-hidden bg-[var(--bg-tertiary)]">
            <img
              src={getGalleryUrl(currentImage)}
              alt={`${appName} screenshot ${currentImage + 1}`}
              className="w-full h-80 object-contain"
              onError={() => setGalleryFailed(true)}
            />

            {appGallery.length > 1 && (
              <>
                <button
                  onClick={prevImage}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  onClick={nextImage}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
                >
                  <ChevronRight size={20} />
                </button>

                {/* Dots indicator */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                  {appGallery.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setCurrentImage(i)}
                      className={`w-2 h-2 rounded-full transition-colors ${
                        i === currentImage ? 'bg-white' : 'bg-white/40'
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-4 border-b border-[var(--border-primary)]">
          <button
            onClick={() => setActiveTab('about')}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'about'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-[var(--text-primary)]'
            }`}
          >
            About This App
          </button>
          <button
            onClick={() => setActiveTab('info')}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'info'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-[var(--text-primary)]'
            }`}
          >
            Information
          </button>
          {hasReleaseNotes && (
            <button
              onClick={() => setActiveTab('whats-new')}
              className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'whats-new'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-[var(--text-primary)]'
              }`}
            >
              What's New
            </button>
          )}
        </div>

        {/* Tab content */}
        <div className="card p-6 text-sm text-[var(--text-secondary)] leading-relaxed">
          {/* About Tab */}
          {activeTab === 'about' && (
            <div>
              {formatDescription(appDescription)}

              {/* Dependencies */}
              {appDependencies.length > 0 && (
                <div className="mt-6 pt-6 border-t border-[var(--border-primary)]">
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2 text-[var(--text-primary)]">
                    <Package size={16} />
                    Dependencies
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {appDependencies.map((dep) => (
                      <span
                        key={dep}
                        className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-muted"
                      >
                        {dep}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Information Tab */}
          {activeTab === 'info' && (
            <div className="grid grid-cols-2 gap-y-4 gap-x-8">
              {/* Version */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Version</span>
                <p className="font-medium text-[var(--text-primary)]">{appVersion}</p>
              </div>

              {/* Category */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Category</span>
                <p className="font-medium text-[var(--text-primary)] capitalize">{appCategory}</p>
              </div>

              {/* Source code */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Source code</span>
                {appRepo ? (
                  <a
                    href={appRepo}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 font-medium text-accent hover:underline"
                  >
                    <Github size={14} />
                    Public
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  <p className="font-medium text-[var(--text-primary)]">Closed source</p>
                )}
              </div>

              {/* Developer */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Developed by</span>
                <p className="font-medium text-[var(--text-primary)]">{appDeveloper}</p>
              </div>

              {/* Port - only show if non-zero */}
              {appPort > 0 && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wide">Port</span>
                  <p className="font-medium text-[var(--text-primary)]">{appPort}</p>
                </div>
              )}

              {/* App Store Source */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">App Store</span>
                <p className="font-medium text-[var(--text-primary)]">
                  {STORE_NAMES[storeType]} / {registry}
                </p>
              </div>
            </div>
          )}

          {/* What's New Tab */}
          {activeTab === 'whats-new' && hasReleaseNotes && formatDescription(appReleaseNotes)}
        </div>

        {/* Resources */}
        {hasResources && (
          <div className="card p-6">
            <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-4">Resources</h4>
            <div className="flex flex-wrap gap-6">
              {appWebsite && (
                <a
                  href={appWebsite}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-accent transition-colors"
                >
                  <Globe size={16} />
                  Website
                  <ExternalLink size={12} />
                </a>
              )}
              {appRepo && (
                <a
                  href={appRepo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-accent transition-colors"
                >
                  <Github size={16} />
                  Source Code
                  <ExternalLink size={12} />
                </a>
              )}
              {appSupport && (
                <a
                  href={appSupport}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-accent transition-colors"
                >
                  <MessageCircle size={16} />
                  Support
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        )}

      {/* Install Modal */}
      {showInstallModal && app && (
        <InstallModal
          app={{
            name: appName,
            icon: appIcon,
            tagline: appTagline,
            version: appVersion,
            developer: appDeveloper,
            dependencies: appDependencies,
          } satisfies InstallableApp}
          servers={serverList}
          onInstall={(serverId) => deployMutation.mutate(serverId)}
          onClose={() => setShowInstallModal(false)}
          isInstalling={deployMutation.isPending}
        />
      )}
    </div>
  );
}
