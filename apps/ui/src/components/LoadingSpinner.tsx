import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  /** Size of the spinner icon */
  size?: 'sm' | 'md' | 'lg';
  /** Optional loading message to display */
  message?: string;
  /** Center the spinner in its container */
  centered?: boolean;
  /** Additional CSS classes */
  className?: string;
}

const sizeMap = {
  sm: 16,
  md: 24,
  lg: 32,
};

/**
 * Consistent loading spinner component.
 * Replaces "Loading..." text throughout the app.
 */
export function LoadingSpinner({
  size = 'md',
  message,
  centered = true,
  className = '',
}: LoadingSpinnerProps) {
  const iconSize = sizeMap[size];

  const content = (
    <div className={`flex items-center gap-3 ${className}`}>
      <Loader2 size={iconSize} className="animate-spin text-muted" />
      {message && (
        <span className="text-muted text-sm">{message}</span>
      )}
    </div>
  );

  if (centered) {
    return (
      <div className="flex items-center justify-center p-8">
        {content}
      </div>
    );
  }

  return content;
}

/**
 * Full-page loading spinner for page-level loading states.
 */
export function PageLoadingSpinner({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <LoadingSpinner size="lg" message={message} centered={false} />
    </div>
  );
}

/**
 * Inline loading spinner for smaller sections.
 */
export function InlineLoadingSpinner({ message }: { message?: string }) {
  return <LoadingSpinner size="sm" message={message} centered={false} />;
}

export default LoadingSpinner;
