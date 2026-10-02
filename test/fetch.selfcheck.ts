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
    events: { on: (_name: string, _fn: never) => {} },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: () => {},
  };
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
  return { root: projectCacheRoot(cwd), run };
}

/** Seed a fresh light entry under the given url and return its meta. */
function seed(root: string, url: string, content: string) {
  return cache.store(root, url, "light", {
    handler: "webpage",
    kind: "article",
    title: "Selfcheck",
    content,
    hasTree: false,
  });
}

/** Rewrite an entry's fetchedAt so it reads as hoursAgo old. */
function age(dir: string, hoursAgo: number) {
  const metaPath = join(dir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.fetchedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  writeFileSync(metaPath, JSON.stringify(meta));
}

test("a fresh cache hit without a topic serves the pointer, not the body", async () => {
  accounting.reset();
  const { root, run } = bootProjectScope();
  const url = "https://magpi-selfcheck.invalid/fresh-no-topic";
  const entry = seed(root, url, "alpha beta SECRET-MARKER gamma\ndocument body\n");

  const result = await run({ url });
  const text = result.content[0].text;

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
  accounting.reset();
  const { root, run } = bootProjectScope();
  const url = "https://magpi-selfcheck.invalid/fresh-with-topic";
  seed(
    root,
    url,
    [
      "# Overview",
      "Welcome to the task runner documentation.",
      "",
      "# Cancelling tasks",
      "To cancel a task group, call `cancelGroup(id)` before the next tick.",
    ].join("\n"),
  );

  const result = await run({ url, topic: "cancel a task group" });
  const text = result.content[0].text;

  assert.ok(!text.includes("already cached (no refetch)"), "the pointer shortcut is skipped");
  assert.ok(text.includes("cancelGroup"), "the matched section answers the topic");
  assert.ok(text.includes('sections matching "cancel a task group"'), "footer names the matched sections");
  assert.ok(!text.includes("Welcome to the task runner"), "the preamble is not padding");
  const c = accounting.snapshot();
  assert.equal(c.hits, 1, "still counted as a fresh hit, not a fetch");
});

test("a stale hit (expired entry, network down) keeps the full preview", async () => {
  accounting.reset();
  const { root, run } = bootProjectScope();
  const url = "https://magpi-selfcheck.invalid/stale";
  const entry = seed(root, url, "stale body SECRET-MARKER stays visible\n");
  age(entry.dir, 48);

  const result = await run({ url });
  const text = result.content[0].text;

  assert.equal(result.details.fromCache, true, "served from the old entry");
  assert.equal(result.details.stale, true, "flagged stale");
  assert.ok(text.includes("STALE: network unavailable"), "footer says the network failed");
  assert.ok(text.includes("SECRET-MARKER"), "the preview is still served: the file may be the only copy");
  const c = accounting.snapshot();
  assert.equal(c.stale, 1, "counted as a stale serve");
});
