import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Token thrift: images rarely help an LLM reading cached text.
turndown.addRule("drop-images", {
  filter: "img",
  replacement: () => "",
});

/** For HTML fragments (API-returned bodies): straight to turndown, no Readability. */
export function htmlFragmentToMarkdown(html: string): string {
  return collapseBlankLines(turndown.turndown(html)).trim();
}

export interface ExtractedPage {
  title?: string;
  markdown: string;
}

/**
 * HTML -> readable markdown.
 * Readability isolates the article; turndown converts.
 * Falls back to whole-body text when Readability finds nothing (SPAs, index pages).
 */
export function htmlToMarkdown(html: string, url?: string): ExtractedPage {
  let title: string | undefined;
  let contentHtml: string | undefined;

  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document, {
      charThreshold: 100,
    }).parse();
    if (article?.content && article.textContent && article.textContent.trim().length > 80) {
      title = article.title || undefined;
      contentHtml = article.content;
    }
  } catch {
    // fall through to fallback
  }

  if (contentHtml) {
    let markdown = turndown.turndown(contentHtml).trim();
    markdown = collapseBlankLines(markdown);
    if (title && !markdown.startsWith("#")) markdown = `# ${title}\n\n${markdown}`;
    return { title, markdown };
  }

  return { title: extractTitle(html), markdown: fallbackText(html) };
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : undefined;
}

/** Crude but dependable: strip script/style/tags, decode entities, collapse whitespace. */
export function fallbackText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");
  return collapseBlankLines(decodeEntities(text))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
