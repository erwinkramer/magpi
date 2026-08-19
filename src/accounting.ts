/**
 * Session counters for work magpi did itself.
 * Every number here is measured mechanically from magpi's own actions, with no dependency on the model or on provider usage reporting, so the whole module runs in a plain unit test and behaves identically in a headless run.
 *
 * The saving magpi claims is context, not bandwidth: fetched content goes to disk and only a preview reaches the prompt, and old previews are later replaced by a path.
 * Both of those are counted here.
 */

/** Rough chars per token for prose and markdown. Good enough for a footer. */
const CHARS_PER_TOKEN = 4;

export interface Counters {
  /** Fetches that hit the network. */
  fetches: number;
  /** Fetches served from a fresh cache entry. */
  hits: number;
  /** Fetches served from an expired entry because the network failed. */
  stale: number;
  /** Content that went to disk instead of into the prompt. */
  withheldChars: number;
  /** Preview text removed from messages already in the prompt. */
  elidedChars: number;
  /** Elision passes run. Each one costs a prompt cache break, so it is the price. */
  elisionPasses: number;
}

const zero = (): Counters => ({ fetches: 0, hits: 0, stale: 0, withheldChars: 0, elidedChars: 0, elisionPasses: 0 });

let counters = zero();

/** One completed fetch, however it was served. */
export function recordFetch(fromCache: boolean, stale: boolean): void {
  if (!fromCache) counters.fetches++;
  else if (stale) counters.stale++;
  else counters.hits++;
}

/**
 * Content kept out of the prompt: the truncated tail of a preview, or the whole body when a batch returns paths only.
 * Callers pass byte counts, which match chars for ASCII and run slightly high otherwise; this is an estimate either way.
 */
export function recordWithheld(chars: number): void {
  if (chars > 0) counters.withheldChars += chars;
}

/** Preview text prune.ts replaced with a cache path. Count each preview once. */
export function recordElided(chars: number): void {
  if (chars > 0) counters.elidedChars += chars;
}

/** One batch of previews rewritten, which is one prompt cache break. */
export function recordElisionPass(): void {
  counters.elisionPasses++;
}

export function snapshot(): Counters {
  return { ...counters };
}

/** New session, new numbers. */
export function reset(): void {
  counters = zero();
}

/** Estimated tokens kept out of the context window. */
export function tokensSaved(c: Counters = counters): number {
  return Math.round((c.withheldChars + c.elidedChars) / CHARS_PER_TOKEN);
}

/** One line for /magpi status. */
export function summary(c: Counters = counters): string {
  const cached = c.hits + c.stale;
  const staleNote = c.stale > 0 ? ` (${c.stale} stale)` : "";
  // Elision passes are the cost side: each one breaks the prompt cache.
  const passNote = c.elisionPasses > 0 ? ` | ${c.elisionPasses} elision pass${c.elisionPasses === 1 ? "" : "es"}` : "";
  return `this session: ${c.fetches} fetched, ${cached} from cache${staleNote} | ~${tokensSaved(c).toLocaleString("en-US")} tokens kept out of context${passNote}`;
}
