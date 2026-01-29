/**
 * Retry utility with exponential backoff.
 * Used for transient failures like network hiccups or temporary unavailability.
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Function to determine if error is retryable (default: all errors are retryable) */
  shouldRetry?: (error: Error) => boolean;
  /** Optional logger for retry attempts */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  shouldRetry: () => true,
};

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://api.example.com/data'),
 *   {
 *     maxAttempts: 3,
 *     baseDelayMs: 1000,
 *     shouldRetry: (err) => err.message.includes('ECONNRESET'),
 *     onRetry: (attempt, err, delay) => logger.warn({ attempt, err, delay }, 'Retrying'),
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt or if error is not retryable
      if (attempt === opts.maxAttempts || !opts.shouldRetry(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.3 * exponentialDelay; // Add up to 30% jitter
      const delayMs = Math.min(exponentialDelay + jitter, opts.maxDelayMs);

      // Call retry callback if provided
      if (options.onRetry) {
        options.onRetry(attempt, lastError, delayMs);
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error('Retry failed');
}

/**
 * Check if an error is a network-related error that may be transient.
 */
export function isNetworkError(error: Error): boolean {
  const networkErrorCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ];

  const message = error.message.toLowerCase();
  return (
    networkErrorCodes.some(code => message.includes(code.toLowerCase())) ||
    message.includes('network') ||
    message.includes('socket hang up') ||
    message.includes('connection reset')
  );
}

/**
 * Check if an HTTP status code is retryable.
 */
export function isRetryableStatus(status: number): boolean {
  // 429 Too Many Requests, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
  return status === 429 || status === 502 || status === 503 || status === 504;
}
