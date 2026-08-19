import { recordElided, recordElisionPass } from "./accounting.js";

interface MessageLike {
  role: string;
  toolName?: string;
  content?: unknown;
  details?: { contentPath?: string; treePath?: string };
}

/**
 * Share of the invalidated region the elided previews must account for before a pass is worth running.
 *
 * Rewriting a message drops the prompt cache from that message onward, so the pass pays to re-send everything after it and then saves the elided tokens on every later call.
 * Reclaiming a third of what it re-sends is roughly where the trade starts making sense.
 * An absolute byte count cannot express this: 20k chars is a bargain in a 30k-char context and a waste in a 300k-char one.
 */
const ELIDE_RATIO = 0.3;

// Paths whose previews we have committed to eliding.
// The context event hands us a fresh deep copy of the original messages on every LLM call, so the decision must live outside the messages or it would flip-flop between calls and break the prompt cache repeatedly.
// Once a path is in here it stays elided.
// ponytail: module state, resets on session restart; that costs one extra cache break per restart, which is what a restart costs anyway.
const committed = new Set<string>();

function previewChars(m: MessageLike): number {
  if (typeof m.content === "string") return m.content.length;
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const block of m.content as { text?: unknown }[]) {
    if (typeof block?.text === "string") n += block.text.length;
  }
  return n;
}

/**
 * Rough size of any message, not just a fetch preview.
 * Used to size the region a rewrite would invalidate, so unknown content shapes must not read as free.
 */
function messageChars(m: MessageLike): number {
  const text = previewChars(m);
  if (text > 0) return text;
  try {
    return JSON.stringify(m.content ?? "").length;
  } catch {
    return 0; // circular or otherwise unserializable; rare enough to ignore
  }
}

/**
 * Context thrift: old magpi_fetch previews are dead weight; the full text is already on disk.
 * Replace old previews (all but the most recent `keepRecent`) with a one-line pointer to the cached file.
 * Mutates in place.
 *
 * Rewriting an old message invalidates the prompt cache from that point on, so elision is batched and only fires when the reclaimed previews are a large enough share of what the rewrite would re-send.
 * One cache break amortized over several fetches, and a preview that is small next to its conversation never breaks the cache at all.
 */
export function elideFetchPreviews<T extends MessageLike>(
  messages: T[],
  keepRecent = 2,
  ratio = ELIDE_RATIO,
): T[] {
  const fetches = messages.filter(
    (m) => m.role === "toolResult" && m.toolName === "magpi_fetch" && m.details?.contentPath,
  );
  const eligible = fetches.slice(0, Math.max(0, fetches.length - keepRecent));
  const fresh = eligible.filter((m) => !committed.has(m.details!.contentPath!));

  if (fresh.length > 0) {
    const freshChars = fresh.reduce((n, m) => n + previewChars(m), 0);
    // The first message we would rewrite is where the cache breaks; everything from there on has to be re-sent.
    const invalidated = messages.slice(messages.indexOf(fresh[0])).reduce((n, m) => n + messageChars(m), 0);
    if (freshChars > ratio * invalidated) {
      // Count each preview once, on the pass that commits it.
      // Committed paths are re-elided on every later call, and those repeats are not new savings.
      for (const m of fresh) {
        committed.add(m.details!.contentPath!);
        recordElided(previewChars(m));
      }
      recordElisionPass();
    }
  }

  for (const m of eligible) {
    if (!committed.has(m.details!.contentPath!)) continue;
    const d = m.details!;
    m.content = [
      {
        type: "text",
        text: `(magpi: preview elided to save context; full text at ${d.contentPath}${d.treePath ? `; files at ${d.treePath}` : ""})`,
      },
    ];
  }
  return messages;
}
