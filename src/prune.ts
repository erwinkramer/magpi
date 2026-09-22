import { onReset, recordElided, recordElisionPass } from "./accounting.js";

export interface MessageLike {
  role: string;
  toolName?: string;
  content?: unknown;
  details?: { contentPath?: string; treePath?: string };
}

export interface ProjectedEntryLike {
  sourceEntry: { id: string; type?: string };
  messages: MessageLike[];
}

export interface ContextEditDraft {
  type: "context_edit";
  targetId: string;
  replacement: {
    content: Array<{ type: "text"; text: string }>;
  };
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
// In 0.87, ContextEditEntry records are committed to the session file and persist across
// restarts and branches. This set is kept for in-memory accounting deduplication.
const committed = new Set<string>();

onReset(() => committed.clear());

export function resetElisionState(): void {
  committed.clear();
}

function isFetchResult(m: MessageLike): boolean {
  return m.role === "toolResult" && m.toolName === "magpi_fetch" && !!m.details?.contentPath;
}

function isElided(m: MessageLike): boolean {
  if (committed.has(m.details?.contentPath ?? "")) return true;
  if (typeof m.content === "string") return m.content.startsWith("(magpi: preview elided");
  if (Array.isArray(m.content) && m.content[0] && typeof (m.content[0] as { text?: unknown }).text === "string") {
    return ((m.content[0] as { text: string }).text).startsWith("(magpi: preview elided");
  }
  return false;
}

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

function elisionNotice(contentPath: string, treePath?: string): string {
  return `(magpi: preview elided to save context; full text at ${contentPath}${treePath ? `; files at ${treePath}` : ""})`;
}

/**
 * Find aged magpi_fetch previews across the session projection and generate
 * append-only ContextEditEntry drafts to replace them with cache path pointers.
 *
 * Persisted as canonical session edits: survives restart/branch navigation and
 * avoids per-request message mutation.
 */
export function findElisionDrafts(
  entries: ProjectedEntryLike[],
  keepRecent = 2,
  ratio = ELIDE_RATIO,
): ContextEditDraft[] {
  const allMessages: MessageLike[] = [];
  const fetchEntries: Array<{ entryId: string; message: MessageLike }> = [];

  for (const entry of entries) {
    for (const m of entry.messages) {
      allMessages.push(m);
      if (isFetchResult(m)) {
        fetchEntries.push({ entryId: entry.sourceEntry.id, message: m });
      }
    }
  }

  const eligible = fetchEntries.slice(0, Math.max(0, fetchEntries.length - keepRecent));
  const fresh = eligible.filter(({ message }) => !isElided(message));

  if (fresh.length === 0) return [];

  const freshChars = fresh.reduce((n, { message }) => n + previewChars(message), 0);
  const firstFreshIndex = allMessages.indexOf(fresh[0].message);
  const invalidated = allMessages.slice(firstFreshIndex).reduce((n, m) => n + messageChars(m), 0);

  if (freshChars <= ratio * invalidated) return [];

  const drafts: ContextEditDraft[] = [];
  for (const { entryId, message } of fresh) {
    const d = message.details!;
    committed.add(d.contentPath!);
    recordElided(previewChars(message));
    drafts.push({
      type: "context_edit",
      targetId: entryId,
      replacement: {
        content: [
          {
            type: "text",
            text: elisionNotice(d.contentPath!, d.treePath),
          },
        ],
      },
    });
  }
  recordElisionPass();
  return drafts;
}

/**
 * In-memory elision for tests or non-session callers. Mutates in place.
 *
 * Rewriting an old message invalidates the prompt cache from that point on, so elision is batched and only fires when the reclaimed previews are a large enough share of what the rewrite would re-send.
 * One cache break amortized over several fetches, and a preview that is small next to its conversation never breaks the cache at all.
 */
export function elideFetchPreviews<T extends MessageLike>(
  messages: T[],
  keepRecent = 2,
  ratio = ELIDE_RATIO,
): T[] {
  const syntheticEntries: ProjectedEntryLike[] = messages.map((m, i) => ({
    sourceEntry: { id: String(i) },
    messages: [m],
  }));

  const drafts = findElisionDrafts(syntheticEntries, keepRecent, ratio);
  for (const draft of drafts) {
    const idx = Number(draft.targetId);
    messages[idx].content = draft.replacement.content as never;
  }

  const fetches = messages.filter(isFetchResult);
  const eligible = fetches.slice(0, Math.max(0, fetches.length - keepRecent));
  for (const m of eligible) {
    if (!committed.has(m.details!.contentPath!)) continue;
    const d = m.details!;
    m.content = [
      {
        type: "text",
        text: elisionNotice(d.contentPath!, d.treePath),
      },
    ] as never;
  }
  return messages;
}
