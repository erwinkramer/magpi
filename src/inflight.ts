/**
 * Collapse concurrent calls that would do identical work.
 * Pi runs sibling tool calls from one assistant message in parallel, so the same URL can be asked for twice at once; without this both fetch it and race on one cache entry directory.
 *
 * ponytail: the first caller's AbortSignal wins, because followers join its promise rather than starting their own.
 * Siblings in a single message share a signal, so this only matters if a follower needed to be cancelled alone.
 */
const running = new Map<string, Promise<unknown>>();

/** Run `work` under `key`, or join the call already running under it. */
export function share<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = running.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = work().finally(() => running.delete(key));
  running.set(key, started);
  return started;
}

/** Calls currently in flight. For tests and diagnostics. */
export function inFlight(): number {
  return running.size;
}
