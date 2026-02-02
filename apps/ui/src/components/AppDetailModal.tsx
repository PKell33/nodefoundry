import { useState } from 'react';
import { ExternalLink, Github, Globe, MessageCircle, ChevronLeft, ChevronRight, Play, Package } from 'lucide-react';
import Modal from './Modal';
import type { UmbrelApp, Server } from '../api/client';

interface AppDetailModalProps {
  app: UmbrelApp;
  servers: Server[];
  isInstalled: boolean;
  deploymentStatus?: string;
  onInstall: () => void;
  onClose: () => void;
}

/**
 * Modal showing full app details including description, release notes, gallery, etc.
 */
export function AppDetailModal({
  app,
  servers,
  isInstalled,
  deploymentStatus,
  onInstall,
  onClose,
}: AppDetailModalProps) {
  const [currentImage, setCurrentImage] = useState(0);
  const [activeTab, setActiveTab] = useState<'about' | 'info' | 'whats-new'>('about');

  const hasGallery = app.gallery && app.gallery.length > 0;
  const hasReleaseNotes = app.manifest.releaseNotes && app.manifest.releaseNotes.trim().length > 0;

  // Check which resources are available
  const hasWebsite = !!app.manifest.website;
  const hasRepo = !!app.manifest.repo;
  const hasSupport = !!app.manifest.support;
  const hasResources = hasWebsite || hasRepo || hasSupport;

  const nextImage = () => {
    if (hasGallery) {
      setCurrentImage((prev) => (prev + 1) % app.gallery.length);
    }
  };

  const prevImage = () => {
    if (hasGallery) {
      setCurrentImage((prev) => (prev - 1 + app.gallery.length) % app.gallery.length);
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

  return (
    <Modal isOpen={true} onClose={onClose} title={app.name} size="lg">
      <div className="space-y-6">
        {/* Header with icon and basic info */}
        <div className="flex items-start gap-4">
          <img
            src={app.icon}
            alt={app.name}
            className="w-20 h-20 rounded-xl bg-[var(--bg-tertiary)]"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="flex-1">
            <h2 className="text-xl font-bold">{app.name}</h2>
            <p className="text-muted">{app.tagline}</p>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted">
              <span>v{app.version}</span>
              <span>by {app.manifest.developer}</span>
              <span className="capitalize">{app.category}</span>
            </div>
          </div>

          {/* Install button */}
          <div>
            {isInstalled ? (
              <span
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  deploymentStatus === 'running'
                    ? 'bg-green-500/20 text-green-500'
                    : deploymentStatus === 'error'
                    ? 'bg-red-500/20 text-red-500'
                    : 'bg-yellow-500/20 text-yellow-500'
                }`}
              >
                {deploymentStatus || 'Installed'}
              </span>
            ) : (
              <button
                onClick={onInstall}
                disabled={servers.length === 0}
                className="btn btn-primary inline-flex items-center gap-2"
              >
                <Play size={16} />
                Install
              </button>
            )}
          </div>
        </div>

        {/* Gallery */}
        {hasGallery && (
          <div className="relative rounded-lg overflow-hidden bg-[var(--bg-tertiary)]">
            <img
              src={app.gallery[currentImage]}
              alt={`${app.name} screenshot ${currentImage + 1}`}
              className="w-full h-64 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).src = '';
              }}
            />

            {app.gallery.length > 1 && (
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
                  {app.gallery.map((_, i) => (
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
        <div className="text-sm text-[var(--text-secondary)] leading-relaxed max-h-48 overflow-y-auto">
          {/* About Tab */}
          {activeTab === 'about' && (
            <div>
              {formatDescription(app.description)}

              {/* Dependencies */}
              {app.dependencies && app.dependencies.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[var(--border-primary)]">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2 text-[var(--text-primary)]">
                    <Package size={16} />
                    Dependencies
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {app.dependencies.map((dep) => (
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
            <div className="grid grid-cols-2 gap-y-4 gap-x-6">
              {/* Version */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Version</span>
                <p className="font-medium text-[var(--text-primary)]">{app.version}</p>
              </div>

              {/* Category */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Category</span>
                <p className="font-medium text-[var(--text-primary)] capitalize">{app.category}</p>
              </div>

              {/* Source code */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">Source code</span>
                {app.manifest.repo ? (
                  <a
                    href={app.manifest.repo}
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
                <p className="font-medium text-[var(--text-primary)]">{app.manifest.developer}</p>
              </div>

              {/* Submitter (if different from developer) - Umbrel only */}
              {!app.source && app.manifest.submitter && app.manifest.submitter !== app.manifest.developer && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wide">Submitted by</span>
                  {app.manifest.submission ? (
                    <a
                      href={app.manifest.submission}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 font-medium text-accent hover:underline"
                    >
                      {app.manifest.submitter}
                      <ExternalLink size={10} />
                    </a>
                  ) : (
                    <p className="font-medium text-[var(--text-primary)]">{app.manifest.submitter}</p>
                  )}
                </div>
              )}

              {/* Port - only show if non-zero */}
              {app.port > 0 && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wide">Port</span>
                  <p className="font-medium text-[var(--text-primary)]">{app.port}</p>
                </div>
              )}

              {/* App Store Source */}
              <div>
                <span className="text-muted text-xs uppercase tracking-wide">App Store</span>
                <p className="font-medium text-[var(--text-primary)]">
                  {app.source === 'start9' ? 'Start9 Marketplace' : 'Umbrel App Store'}
                </p>
              </div>

              {/* Manifest Version / Compatibility - Umbrel only */}
              {!app.source && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wide">Compatible with</span>
                  <p className="font-medium text-[var(--text-primary)]">
                    umbrelOS {app.manifest.manifestVersion >= 1.1 ? '1.0' : '0.5'}+
                  </p>
                </div>
              )}
            </div>
          )}

          {/* What's New Tab */}
          {activeTab === 'whats-new' && hasReleaseNotes && formatDescription(app.manifest.releaseNotes!)}
        </div>

        {/* Resources */}
        {hasResources && (
          <div className="pt-4 border-t border-[var(--border-primary)]">
            <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Resources</h4>
            <div className="flex flex-wrap gap-4">
              {hasWebsite && (
                <a
                  href={app.manifest.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-accent transition-colors"
                >
                  <Globe size={16} />
                  Website
                  <ExternalLink size={12} />
                </a>
              )}
              {hasRepo && (
                <a
                  href={app.manifest.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-accent transition-colors"
                >
                  <Github size={16} />
                  Source Code
                  <ExternalLink size={12} />
                </a>
              )}
              {hasSupport && (
                <a
                  href={app.manifest.support}
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
      </div>
    </Modal>
  );
}
