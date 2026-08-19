// Live network selfcheck: the promoted smoke test.
// Hits real free endpoints, so individual sources may be rate-limited; each check tolerates its own flakiness where that's expected, and the whole file skips when offline.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FetchContext } from "../src/handlers/handler.js";
import { resolveHandler } from "../src/handlers/registry.js";
import { webSearch } from "../src/search.js";

const online = await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok)
  .catch(() => false);

function ctx(): FetchContext {
  return {
    mode: "light",
    entryDir: mkdtempSync(join(tmpdir(), "magpi-selfcheck-")),
    exec: async () => ({ stdout: "", stderr: "exec not needed in light mode", code: 1 }),
  };
}

async function fetchVia(urlStr: string) {
  const url = new URL(urlStr);
  return resolveHandler(url).fetch(url, ctx());
}

test("wikipedia handler returns plaintext article", { skip: !online }, async () => {
  const r = await fetchVia("https://en.wikipedia.org/wiki/Zebra");
  assert.equal(r.kind, "article");
  assert.match(r.content, /striped/i);
  assert.doesNotMatch(r.content, /<html/i);
});

test("npm registry handler returns metadata + readme", { skip: !online }, async () => {
  const r = await fetchVia("https://www.npmjs.com/package/lodash");
  assert.equal(r.kind, "package-info");
  assert.match(r.content, /lodash \(npm\)/);
  assert.match(r.content, /version:/);
});

test("pi.dev package pages resolve through npm", { skip: !online }, async () => {
  const r = await fetchVia("https://pi.dev/packages/pi-magpi");
  assert.equal(r.kind, "package-info");
  assert.match(r.content, /pi-magpi \(npm\)/);
});

test("github handler returns readme with metadata header", { skip: !online }, async () => {
  const r = await fetchVia("https://github.com/sindresorhus/p-retry");
  assert.equal(r.kind, "readme");
  assert.match(r.content, /p-retry/);
});

test("arxiv handler answers a versioned pdf url", { skip: !online }, async () => {
  // Whichever way it gets there: the export api, or the abstract page when export.arxiv.org is having one of its days.
  const r = await fetchVia("https://arxiv.org/abs/1706.03762");
  assert.ok(r.kind === "paper" || r.kind === "article", `unexpected kind ${r.kind}`);
  assert.match(r.content, /Attention Is All You Need/i);
  assert.match(r.content, /transduction|Transformer/i, "the abstract came through");
});

test("a /pdf/ url yields the paper, not its abstract", { skip: !online }, async () => {
  // The whole point of asking for the pdf.
  // Metadata-only is a few hundred bytes and stops at the abstract, so both assertions below fail if the handler silently falls back to the abstract page.
  const r = await fetchVia("https://arxiv.org/pdf/1706.03762v7.pdf");
  assert.equal(r.kind, "paper");
  assert.ok(r.content.length > 20_000, `got ${r.content.length} bytes, not a full paper`);
  assert.match(r.content, /References|Bibliography/i, "full text runs past the abstract");
});

test("default handler extracts a generic webpage", { skip: !online }, async () => {
  const r = await fetchVia("https://example.com/");
  assert.equal(r.kind, "article");
  assert.match(r.content, /Example Domain/);
});

test("pdf urls are extracted as text", { skip: !online }, async () => {
  const r = await fetchVia("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf");
  assert.equal(r.kind, "pdf");
  assert.match(r.content, /dummy pdf/i);
});

test("at least one search source returns results", { skip: !online }, async () => {
  // Rate limits are expected and fine; auto falls through ddg -> wikipedia -> hn.
  const { results, errors } = await webSearch("rust programming language", "auto");
  assert.ok(results.length > 0, `all sources failed: ${errors.join("; ")}`);
  assert.match(results[0].url, /^https?:\/\//);
});

// Each source has its own endpoint, its own shape, and its own way of breaking, so one passing source says nothing about the other three.
// Individually they are allowed to be rate-limited; collectively they are not, since a run where every source is down would otherwise look the same as one where the parsers all silently rotted.
const SOURCES = ["ddg", "wikipedia", "hn", "context7"] as const;
const reachable: string[] = [];

for (const source of SOURCES) {
  test(`${source} search returns usable results`, { skip: !online }, async (t) => {
    const { results, errors } = await webSearch("rust async runtime", source);
    if (results.length === 0) {
      t.diagnostic(`${source} unavailable: ${errors.join("; ")}`);
      return; // rate limits are the normal weather on free endpoints
    }
    reachable.push(source);
    for (const r of results) {
      assert.equal(r.source, source, "results are tagged with the source that produced them");
      assert.match(r.url, /^https?:\/\//, `${source} returned an unfetchable url: ${r.url}`);
      assert.ok(r.title.trim().length > 0, `${source} returned an untitled result`);
      assert.doesNotMatch(r.title, /<[a-z/]/i, `${source} leaked markup into a title: ${r.title}`);
    }
    assert.ok(results.length <= 8, `${source} returned ${results.length}, over the per-source cap`);
  });
}

test("the search sources are not all down at once", { skip: !online }, () => {
  assert.ok(reachable.length > 0, "every search source failed; check the parsers before blaming rate limits");
});

test("an unknown source name is rejected rather than silently skipped", { skip: !online }, async () => {
  const { results, errors } = await webSearch("anything", "nope" as never);
  assert.equal(results.length, 0);
  assert.equal(errors.length, 1, "the bad source is reported, not swallowed");
});
