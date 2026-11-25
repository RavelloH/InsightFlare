/**
 * One-shot handoff from a preloaded route to the immediately following
 * navigation. This is not a general data cache: normal navigations, refreshes
 * and SSR requests must load fresh authorization and data.
 */
export function createBootstrapHandoff<T>(now = Date.now) {
  let pending:
    { key: string; expires: number; promise: Promise<T> } | undefined;
  const ttlMs = 1000;
  return (
    key: string,
    preload: boolean,
    read: () => Promise<T>,
  ): Promise<T> => {
    const previous = pending;
    if (preload && previous?.key === key && previous.expires > now()) {
      return previous.promise;
    }
    pending = undefined;
    if (!preload && previous?.key === key && previous.expires > now()) {
      return previous.promise;
    }
    const promise = read();
    if (preload) {
      const entry = { key, expires: now() + ttlMs, promise };
      pending = entry;
      void promise.catch(() => {
        if (pending === entry) pending = undefined;
      });
      // Release resolved payloads even if navigation never follows.
      setTimeout(() => {
        if (pending === entry) pending = undefined;
      }, ttlMs);
    }
    return promise;
  };
}
