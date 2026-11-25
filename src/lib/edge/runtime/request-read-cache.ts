/**
 * Explicitly enabled only for read-only dashboard SSR requests.
 * Weak request keys prevent cross-request or cross-user retention.
 */
const requestReads = new WeakMap<Request, Map<string, Promise<unknown>>>();

export function enableRequestReadCache(request: Request): void {
  if (!requestReads.has(request)) requestReads.set(request, new Map());
}

export function memoizeRequestRead<T>(
  request: Request,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const cache = requestReads.get(request);
  if (!cache) return read();
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(read);
  cache.set(key, pending);
  return pending;
}
