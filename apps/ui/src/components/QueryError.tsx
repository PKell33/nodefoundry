import { AlertCircle, RefreshCw, WifiOff } from 'lucide-react';

interface QueryErrorProps {
  /** The error object from React Query */
  error: Error | null;
  /** Refetch function from useQuery to retry the request */
  refetch?: () => void;
  /** Custom error message to display instead of error.message */
  message?: string;
  /** Compact mode for inline errors */
  compact?: boolean;
}

/**
 * Displays query errors with optional retry functionality.
 * Use this when a React Query request fails.
 *
 * @example
 * const { data, isLoading, error, refetch } = useServers();
 *
 * if (isLoading) return <LoadingSpinner />;
 * if (error) return <QueryError error={error} refetch={refetch} />;
 */
export function QueryError({
  error,
  refetch,
  message,
  compact = false,
}: QueryErrorProps) {
  if (!error) return null;

  const errorMessage = message || error.message || 'An unexpected error occurred';
  const isNetworkError = errorMessage.toLowerCase().includes('network') ||
                         errorMessage.toLowerCase().includes('fetch') ||
                         errorMessage.toLowerCase().includes('failed to fetch');

  if (compact) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
        <span className="text-sm text-red-400 flex-1">{errorMessage}</span>
        {refetch && (
          <button
            onClick={() => refetch()}
            className="text-xs text-red-400 hover:text-red-300 underline"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
        {isNetworkError ? (
          <WifiOff className="w-6 h-6 text-red-400" />
        ) : (
          <AlertCircle className="w-6 h-6 text-red-400" />
        )}
      </div>

      <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        {isNetworkError ? 'Connection Error' : 'Failed to Load'}
      </h3>

      <p className="text-sm text-muted mb-4 max-w-md">
        {isNetworkError
          ? 'Unable to connect to the server. Please check your connection and try again.'
          : errorMessage}
      </p>

      {refetch && (
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] rounded-lg transition-colors"
        >
          <RefreshCw size={16} />
          Try Again
        </button>
      )}
    </div>
  );
}

/**
 * Inline error display for cards and smaller components.
 */
export function InlineQueryError({
  error,
  refetch,
  message,
}: Omit<QueryErrorProps, 'compact'>) {
  return <QueryError error={error} refetch={refetch} message={message} compact />;
}

export default QueryError;
