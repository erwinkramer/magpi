import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import magpi from "../index.js";
import * as accounting from "../src/accounting.js";
import * as cache from "../src/cache.js";
import { projectCacheRoot, projectConfigPath } from "../src/config.js";

/** The registered tools of a booted extension, keyed by name. */
type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: Ctx) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
  renderResult?: (
    result: { content: Array<{ text: string }>; details: Record<string, unknown> },
    opts: { expanded: boolean; isPartial: boolean },
    theme: { fg: (_color: string, text: string) => string },
  ) => { render: (width: number) => string[] };
};

type Ctx = {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  ui: { setStatus: () => void; notify: () => void };
};

const URL = "https://magpi-selfcheck.invalid/page";

/**
 * Boot the extension against a fake ExtensionAPI.
 * Cache writes go to the temp project dir (project scope), so the suite never reads or writes the user's real cache except read-only lookups that miss.
 */
function bootProjectScope(allowPrivateNetwork = false) {
  const cwd = mkdtempSync(join(tmpdir(), "magpi-fetch-"));
  const tools = new Map<string, Tool>();
  const pi = {
    on: (_event: string, _handler: never) => undefined,
    registerTool: (t: Tool) => tools.set(t.name, t),
    registerCommand: (_name: string, _def: never) => {},
    events: { on: (_name: string, _fn: never) => {} },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: () => {},
  };
  magpi(pi as never);

  const cfgPath = projectConfigPath(cwd);
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ cacheScope: "project", allowPrivateNetwork }));

  const ctx: Ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { setStatus: () => {}, notify: () => {} },
  };
  const run = (params: Record<string, unknown>) =>
    tools.get("magpi_fetch")!.execute("selfcheck", params, new AbortController().signal, undefined, ctx);
  return { root: projectCacheRoot(cwd), run, tools, ctx };
}

function seedEntry(root: string, url: string, content: string, ageHours = 0) {
  const entry = cache.store(root, url, "light", { handler: "webpage", kind: "article", title: "Selfcheck", content, hasTree: false });
  if (ageHours > 0) {
    const metaPath = join(entry.dir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.fetchedAt = new Date(Date.now() - ageHours * 3_600_000).toISOString();
    entry.meta.fetchedAt = meta.fetchedAt;
    writeFileSync(metaPath, JSON.stringify(meta));
  }
  return entry;
}

/**
 * Reset counters, boot a fresh project scope, seed one light entry for URL (optionally aged past TTL), and serve it.
 * Each call gets its own temp cache root, so one shared URL is fine for every test.
 */
async function serve(content: string, params: Record<string, unknown> = {}, ageHours = 0) {
  accounting.reset();
  const { root, run } = bootProjectScope();
  const entry = seedEntry(root, URL, content, ageHours);
  const result = await run({ url: URL, ...params });
  return { result, text: result.content[0].text, entry };
}

test("a fresh cache hit without a topic serves the pointer, not the body", async () => {
  const { result, text, entry } = await serve("alpha beta SECRET-MARKER gamma\ndocument body\n");

  assert.equal(result.details.fromCache, true, "served from cache");
  assert.equal(result.details.stale, false, "not a stale fallback");
  assert.ok(text.includes("already cached"), "footer explains the no-refetch");
  assert.ok(text.includes(entry.contentPath), "footer points at the full text on disk");
  assert.ok(!text.includes("SECRET-MARKER"), "the body stays out of the prompt");
  const c = accounting.snapshot();
  assert.equal(c.hits, 1, "counted as a fresh hit");
  assert.equal(c.withheldChars, entry.meta.contentBytes, "the whole body counts as withheld");
});

test("a fresh cache hit with a topic still serves the matched sections", async () => {
  const { text } = await serve(
    [
      "# Overview",
      "Welcome to the task runner documentation.",
      "",
      "# Cancelling tasks",
      "To cancel a task group, call `cancelGroup(id)` before the next tick.",
    ].join("\n"),
    { topic: "cancel a task group" },
  );

  assert.ok(!text.includes("already cached (no refetch)"), "the pointer shortcut is skipped");
  assert.ok(text.includes("cancelGroup"), "the matched section answers the topic");
  assert.ok(text.includes('sections matching "cancel a task group"'), "footer names the matched sections");
  assert.ok(!text.includes("Welcome to the task runner"), "the preamble is not padding");
  assert.equal(accounting.snapshot().hits, 1, "still counted as a fresh hit, not a fetch");
});

test("a stale hit (expired entry, network down) keeps the full preview", async () => {
  const { result, text, entry } = await serve("stale body SECRET-MARKER stays visible\n", {}, 48);

  assert.equal(result.details.fromCache, true, "served from the old entry");
  assert.equal(result.details.stale, true, "flagged stale");
  assert.ok(
    text.includes(`STALE: fetch failed; serving cached copy from ${entry.meta.fetchedAt}`),
    "footer says the fetch failed and names the original timestamp",
  );
  assert.ok(text.includes("SECRET-MARKER"), "the preview is still served: the file may be the only copy");
  assert.equal(accounting.snapshot().stale, 1, "counted as a stale serve");
});

test("batch fetch reports stale fallback with timestamp while keeping normal success and failure distinct", async (t) => {
  accounting.reset();
  const { root, run, tools } = bootProjectScope(true);
  const staleEntry = seedEntry(root, URL, "stale batch body\n", 48);
  const freshUrl = "https://magpi-selfcheck.invalid/fresh";
  const missingUrl = "https://magpi-selfcheck.invalid/missing";

  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const target = String(input);
    if (target === freshUrl) {
      return new Response("<html><head><title>Fresh</title></head><body><main><p>fresh body</p></main></body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Unavailable", { status: 503 });
  });

  const result = await run({ urls: [URL, freshUrl, missingUrl] });
  const text = result.content[0].text;
  const staleLabel = `STALE: fetch failed; serving cached copy from ${staleEntry.meta.fetchedAt}`;

  assert.ok(text.includes(`✓ ${URL} (${staleLabel})\n   -> ${staleEntry.contentPath}`));
  assert.ok(text.includes(`✓ ${freshUrl}\n   -> `));
  assert.ok(!text.includes(`${freshUrl} (STALE:`));
  assert.ok(text.includes(`✗ ${missingUrl}:`));
  assert.ok(!text.includes(`${missingUrl} (STALE:`));

  const renderResult = tools.get("magpi_fetch")!.renderResult!;
  const theme = { fg: (_c: string, s: string) => s };
  const collapsed = renderResult(result, { expanded: false, isPartial: false }, theme).render(200).join("\n");
  assert.equal(collapsed.trim(), "✓ 2/3 fetched to cache (1 stale)");

  const expanded = renderResult(result, { expanded: true, isPartial: false }, theme).render(200).join("\n");
  assert.ok(expanded.includes(staleLabel));
});

test("search fetch_top reports stale fallback with original timestamp", async (t) => {
  accounting.reset();
  const { root, tools, ctx } = bootProjectScope(true);
  const staleEntry = seedEntry(root, URL, "stale search body\n", 48);

  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const target = String(input);
    if (target.startsWith("https://lite.duckduckgo.com/lite/")) {
      return new Response(`<a href="${URL}">Stale Result</a><td class="result-snippet">cached snippet</td>`, {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Unavailable", { status: 503 });
  });

  const result = await tools
    .get("magpi_search")!
    .execute("selfcheck-search", { query: "stale selfcheck", source: "ddg", fetch_top: 1 }, new AbortController().signal, undefined, ctx);
  const text = result.content[0].text;
  const staleLabel = `STALE: fetch failed; serving cached copy from ${staleEntry.meta.fetchedAt}`;

  assert.ok(text.includes(`${URL} (${staleLabel})\n  -> ${staleEntry.contentPath}`));
});
