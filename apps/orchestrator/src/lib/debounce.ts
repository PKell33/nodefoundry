/**
 * Creates a debounced function that coalesces multiple calls within a delay window.
 * All callers receive the same promise that resolves when the function executes.
 *
 * @param fn - The async function to debounce
 * @param delayMs - Delay in milliseconds before executing (default: 2000)
 * @returns A debounced version of the function
 */
export function createDebouncedFn<T>(
  fn: () => Promise<T>,
  delayMs: number = 2000
): () => Promise<T> {
  let pendingPromise: Promise<T> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let resolveQueue: Array<(value: T) => void> = [];
  let rejectQueue: Array<(reason: unknown) => void> = [];

  return (): Promise<T> => {
    // If there's an existing timer, clear it and reset the delay
    if (timer) {
      clearTimeout(timer);
    }

    // Create a new promise for this caller
    const promise = new Promise<T>((resolve, reject) => {
      resolveQueue.push(resolve);
      rejectQueue.push(reject);
    });

    // Set up the timer to execute the function
    timer = setTimeout(async () => {
      timer = null;
      const currentResolveQueue = resolveQueue;
      const currentRejectQueue = rejectQueue;
      resolveQueue = [];
      rejectQueue = [];
      pendingPromise = null;

      try {
        const result = await fn();
        for (const resolve of currentResolveQueue) {
          resolve(result);
        }
      } catch (error) {
        for (const reject of currentRejectQueue) {
          reject(error);
        }
      }
    }, delayMs);

    pendingPromise = promise;
    return promise;
  };
}

/**
 * Creates a fire-and-forget debounced function.
 * Multiple calls within the delay window are coalesced into a single execution.
 * Returns void immediately - the actual execution happens asynchronously.
 *
 * @param fn - The async function to debounce
 * @param delayMs - Delay in milliseconds before executing (default: 2000)
 * @param onError - Optional error handler
 * @returns A debounced version of the function that returns void
 */
export function createFireAndForgetDebounce<T>(
  fn: () => Promise<T>,
  delayMs: number = 2000,
  onError?: (error: unknown) => void
): () => void {
  let timer: NodeJS.Timeout | null = null;

  return (): void => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(async () => {
      timer = null;
      try {
        await fn();
      } catch (error) {
        if (onError) {
          onError(error);
        }
      }
    }, delayMs);
  };
}
