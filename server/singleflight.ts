const running = new Map<string, Promise<unknown>>();

/**
 * Runs `work` once per key at a time: callers that arrive while it is running share its result
 * instead of starting their own. Used for cuts that write a cache file, where two identical
 * requests at once (a page that loads a clip twice, two tabs) would write the same file.
 */
export function singleflight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = running.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = work().finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}
