import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as cache from "../src/cache.js";
import * as cachedb from "../src/cachedb.js";

const skip = !cachedb.available();

function seed(root: string) {
  cache.store(root, "https://example.com/rust-async", "light", {
    handler: "webpage",
    kind: "article",
    title: "Async Rust guide",
    content: "Tokio runtimes schedule asynchronous tasks across worker threads efficiently.",
    hasTree: false,
  });
  cache.store(root, "https://example.com/pasta", "light", {
    handler: "webpage",
    kind: "article",
    title: "Cooking pasta",
    content: "Boil water with plenty of salt before adding the pasta.",
    hasTree: false,
  });
}

test("index-backed listing and stats match stored entries", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-db-"));
  seed(root);
  assert.equal(cache.listEntries(root).length, 2);
  const s = cache.stats(root);
  assert.equal(s.entries, 2);
  assert.ok(s.bytes > 0);
  cache.clear(root);
  assert.equal(cache.stats(root).entries, 0);
});

test("reading an unused cache creates nothing on disk", { skip }, () => {
  // The status line asks both roots for stats at session start, before any fetch.
  const root = join(mkdtempSync(join(tmpdir(), "magpi-db-")), "never-used");
  assert.equal(cache.stats(root).entries, 0);
  assert.equal(cache.listEntries(root).length, 0);
  assert.equal(cache.searchContent([root], "anything"), null);
  assert.equal(cache.heal(root), "skipped");
  assert.ok(!existsSync(root), "no cache root");

  // The first write still gets its index.
  seed(root);
  assert.ok(existsSync(join(root, "index.db")), "index.db appears on first write");
  assert.equal(cache.stats(root).entries, 2);
});

test("full-text recall ranks by relevance, stems, and snips", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-db-"));
  seed(root);
  const hits = cache.searchContent([root], "scheduling async tasks");
  assert.ok(hits && hits.length === 1, "porter stemming matches schedule/scheduling");
  assert.equal(hits![0].url, "https://example.com/rust-async");
  assert.match(hits![0].snippet, />>/, "matched terms are marked");
  assert.ok(existsSync(hits![0].contentPath));
  assert.equal(cache.searchContent([root], "quantum chromodynamics")!.length, 0);
  cache.clear(root);
});

test("LRU eviction removes least-recently-used first", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-db-"));
  seed(root);
  // Touch the pasta entry so rust-async becomes the LRU victim
  cache.lookup(root, "https://example.com/pasta", "light", 24);
  const removed = cache.evictToBudget(root, 100); // budget below one entry
  assert.ok(removed >= 1);
  const urls = cache.listEntries(root).map((e) => e.meta.url);
  assert.ok(!urls.includes("https://example.com/rust-async"), "untouched entry evicted first");
  cache.clear(root);
});

test("all-dot hostnames cannot escape the cache root", () => {
  const dir = cache.entryDir("/root", "https://../etc").replace(/\\/g, "/");
  assert.ok(dir.startsWith("/root/invalid-host/"), dir);
});

test("heal rebuilds a corrupt or missing index", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-heal-"));
  seed(root);
  assert.equal(cache.heal(root), "ok", "healthy index untouched");

  // Corrupt the db and confirm heal restores recall
  cachedb.close(root);
  writeFileSync(join(root, "index.db"), "not a database");
  assert.equal(cache.heal(root), "rebuilt");
  assert.equal(cache.searchContent([root], "tokio")!.length, 1);

  // Delete the db entirely; files alone should trigger a rebuild
  cachedb.close(root);
  for (const f of ["index.db", "index.db-wal", "index.db-shm"]) rmSync(join(root, f), { force: true });
  assert.equal(cache.heal(root), "rebuilt");
  assert.equal(cache.listEntries(root).length, 2);
  cache.clear(root);
});

test("reindex rebuilds the search index from files on disk", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-db-"));
  seed(root);
  // Simulate a lost index: close the handle, delete the db, prove recall is gone
  cachedb.close(root);
  rmSync(join(root, "index.db"), { force: true });
  rmSync(join(root, "index.db-wal"), { force: true });
  rmSync(join(root, "index.db-shm"), { force: true });
  // No index file means no index, and the caller falls back to the filesystem walk.
  assert.equal(cache.searchContent([root], "tokio"), null);

  assert.equal(cache.reindexRoot(root), 2);
  assert.equal(cache.searchContent([root], "tokio")!.length, 1);
  assert.equal(cache.listEntries(root).length, 2, "walk fallback and index agree");
  cache.clear(root);
});
