export function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'aborted');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** fetch с собственным timeout и внешней отменой; побеждает более ранняя. */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Ждёт операцию, а при abort немедленно завершает её через onAbort и снимает listener. */
export async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  let listener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      listener = () => {
        try { onAbort(); } catch { /* операция завершится ошибкой ниже */ }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', listener, { once: true });
      operation.then(resolve, reject);
    });
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}
