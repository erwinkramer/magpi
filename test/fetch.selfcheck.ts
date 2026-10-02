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
};

type Ctx = {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  ui: { setStatus: () => void; notify: () => void };
};

const URL = "https://magpi-selfcheck.invalid/page";

/** A stub handler answering the selfcheck URL without a network round-trip. */
const stubHandler = (content: string) => ({
  name: "selfcheck-stub",
  match: (u: globalThis.URL) => u.hostname === "magpi-selfcheck.invalid",
  fetch: async () => ({ kind: "article", content }),
});

/**
 * Boot the extension against a fake ExtensionAPI.
 * Cache writes go to the temp project dir (project scope), so the suite never reads or writes the user's real cache except read-only lookups that miss.
 */
function bootProjectScope() {
  const cwd = mkdtempSync(join(tmpdir(), "magpi-fetch-"));
  const tools = new Map<string, Tool>();
  const pi = {
    on: (_event: string, _handler: never) => undefined,
    registerTool: (t: Tool) => tools.set(t.name, t),
    registerCommand: (_name: string, _def: never) => {},
    // Capture the handler-registration hook so tests can install a stub handler for the selfcheck URL.
    events: { on: (name: string, fn: never) => { if (name === "magpi:register-handler") registerHook = fn as (h: unknown) => void; } },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: () => {},
  };
  let registerHook: ((h: unknown) => void) | undefined;
  magpi(pi as never);

  const cfgPath = projectConfigPath(cwd);
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ cacheScope: "project" }));

  const ctx: Ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { setStatus: () => {}, notify: () => {} },
  };
  const run = (params: Record<string, unknown>) =>
    tools.get("magpi_fetch")!.execute("selfcheck", params, new AbortController().signal, undefined, ctx);
  return { root: projectCacheRoot(cwd), run, registerHandler: (h: unknown) => registerHook!(h) };
}

/**
 * Reset counters, boot a fresh project scope, seed one light entry for URL (optionally aged past TTL), and serve it.
 * Each call gets its own temp cache root, so one shared URL is fine for every test.
 */
async function serve(content: string, params: Record<string, unknown> = {}, ageHours = 0) {
  accounting.reset();
  const { root, run } = bootProjectScope();
  const entry = cache.store(root, URL, "light", { handler: "webpage", kind: "article", title: "Selfcheck", content, hasTree: false });
  if (ageHours > 0) {
    const metaPath = join(entry.dir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.fetchedAt = new Date(Date.now() - ageHours * 3_600_000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta));
  }
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
  const { result, text } = await serve("stale body SECRET-MARKER stays visible\n", {}, 48);

  assert.equal(result.details.fromCache, true, "served from the old entry");
  assert.equal(result.details.stale, true, "flagged stale");
  assert.ok(text.includes("STALE: network unavailable"), "footer says the network failed");
  assert.ok(text.includes("SECRET-MARKER"), "the preview is still served: the file may be the only copy");
  assert.equal(accounting.snapshot().stale, 1, "counted as a stale serve");
});

/**
 * Boot a fresh project scope with the stub handler installed, so the fetch really runs the handler (no cache to hit).
 */
async function freshFetch(content: string, params: Record<string, unknown> = {}) {
  accounting.reset();
  const { run, registerHandler } = bootProjectScope();
  registerHandler(stubHandler(content));
  const result = await run({ url: URL, ...params });
  return { result, text: result.content[0].text };
}

test("preview: false returns the cache path without the preview body", async () => {
  const body = "fresh fetch SECRET-MARKER body\n";
  const { result, text } = await freshFetch(body, { preview: false });

  assert.equal(result.details.fromCache, false, "really fetched, not served from cache");
  const contentPath = (result.details as { contentPath: string }).contentPath;
  assert.ok(text.includes(contentPath), "the cache path is returned");
  assert.ok(text.includes("Read/grep the path above for content."), "footer points at the file");
  assert.ok(text.includes("magpi: article via selfcheck-stub"), "footer names the kind and handler");
  assert.ok(!text.includes("SECRET-MARKER"), "the preview body stays out of the prompt");
  assert.equal(accounting.snapshot().withheldChars, body.length, "the whole body counts as withheld");
});

test("default single-URL fetch still includes the preview body", async () => {
  const { result, text } = await freshFetch("fresh fetch SECRET-MARKER body\n");

  assert.equal(result.details.fromCache, false, "really fetched");
  assert.ok(text.includes("SECRET-MARKER"), "the default keeps the preview");
  assert.ok(text.includes("full text:"), "footer still points at the full text");
});
