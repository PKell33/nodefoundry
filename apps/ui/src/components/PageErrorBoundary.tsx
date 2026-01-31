import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Home, RotateCw } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';

interface PageErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Error boundary for page-level components.
 * Displays a full-page centered error message with options to retry or go home.
 */
export function PageErrorBoundary({ children }: PageErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error, resetError) => (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="max-w-md w-full text-center">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-red-500" />
            </div>

            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              Page Error
            </h1>

            <p className="text-muted mb-2">
              This page encountered an unexpected error and couldn't load properly.
            </p>

            <p className="text-sm text-red-400 mb-6 font-mono bg-[var(--bg-secondary)] p-3 rounded-lg">
              {error.message || 'Unknown error'}
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={resetError}
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent/90 text-slate-900 font-medium rounded-lg transition-colors"
              >
                <RotateCw size={18} />
                Try Again
              </button>

              <Link
                to="/"
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] font-medium rounded-lg transition-colors"
              >
                <Home size={18} />
                Go to Dashboard
              </Link>
            </div>

            {process.env.NODE_ENV === 'development' && error.stack && (
              <details className="mt-6 text-left">
                <summary className="text-sm text-muted cursor-pointer hover:text-[var(--text-secondary)]">
                  Show error details
                </summary>
                <pre className="mt-2 p-3 text-xs bg-[var(--bg-primary)] rounded-lg overflow-x-auto text-red-300 whitespace-pre-wrap">
                  {error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

export default PageErrorBoundary;
