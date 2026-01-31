import { type ReactNode } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';

interface ComponentErrorBoundaryProps {
  children: ReactNode;
  /** Optional name to display in error message */
  componentName?: string;
  /** Compact mode for smaller components */
  compact?: boolean;
}

/**
 * Error boundary for individual components.
 * Displays a smaller inline error state that keeps the rest of the page functional.
 */
export function ComponentErrorBoundary({
  children,
  componentName,
  compact = false
}: ComponentErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error, resetError) => (
        <div
          className={`
            rounded-lg border border-red-500/20 bg-red-500/5
            ${compact ? 'p-3' : 'p-4'}
          `}
        >
          <div className={`flex items-start gap-${compact ? '2' : '3'}`}>
            <AlertCircle
              className={`text-red-400 flex-shrink-0 ${compact ? 'w-4 h-4' : 'w-5 h-5'}`}
            />
            <div className="flex-1 min-w-0">
              <p className={`font-medium text-red-400 ${compact ? 'text-xs' : 'text-sm'}`}>
                {componentName ? `${componentName} failed to load` : 'Component error'}
              </p>

              {!compact && (
                <p className="text-xs text-muted mt-1 truncate" title={error.message}>
                  {error.message || 'An unexpected error occurred'}
                </p>
              )}

              <button
                onClick={resetError}
                className={`
                  flex items-center gap-1.5 text-red-400 hover:text-red-300 transition-colors
                  ${compact ? 'mt-2 text-xs' : 'mt-3 text-sm'}
                `}
              >
                <RotateCw size={compact ? 12 : 14} />
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

export default ComponentErrorBoundary;
