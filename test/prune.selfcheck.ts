import assert from "node:assert/strict";
import { test } from "node:test";
import { elideFetchPreviews, findElisionDrafts } from "../src/prune.js";

const fetchResult = (path: string, text = "big preview ".repeat(100)) => ({
  role: "toolResult",
  toolName: "magpi_fetch",
  content: [{ type: "text", text }],
  details: { contentPath: path },
});

test("elideFetchPreviews keeps recent previews, elides old ones", () => {
  const messages = [
    { role: "user", content: "hi" },
    fetchResult("/cache/a.md"),
    fetchResult("/cache/b.md"),
    { role: "assistant", content: "ok" },
    fetchResult("/cache/c.md"),
    fetchResult("/cache/d.md"),
  ];
  elideFetchPreviews(messages as never[], 2, 0);

  const texts = messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content[0].text as string);
  assert.match(texts[0], /preview elided.*\/cache\/a\.md/);
  assert.match(texts[1], /preview elided.*\/cache\/b\.md/);
  assert.match(texts[2], /big preview/, "recent previews untouched");
  assert.match(texts[3], /big preview/);
  assert.equal((messages[0] as any).content, "hi", "non-fetch messages untouched");
});

test("elideFetchPreviews ignores other tools and pathless results", () => {
  const other = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] };
  const pathless = { role: "toolResult", toolName: "magpi_fetch", content: [{ type: "text", text: "err" }], details: {} };
  const messages = [other, pathless, fetchResult("/cache/x.md"), fetchResult("/cache/y.md"), fetchResult("/cache/z.md")];
  elideFetchPreviews(messages as never[], 2, 0);
  assert.equal((other.content[0] as any).text, "file body");
  assert.equal((pathless.content[0] as any).text, "err");
  assert.match((messages[2] as any).content[0].text, /elided/);
});

test("elision fires on the reclaimed share, not an absolute size", () => {
  const big = "x".repeat(600);
  const messages = [fetchResult("/h/1.md", big), fetchResult("/h/2.md", big), fetchResult("/h/3.md", big)];

  // One eligible preview: 600 chars reclaimed against 1800 invalidated, a third of the region, under the 0.4 share asked for here.
  elideFetchPreviews(messages as never[], 2, 0.4);
  assert.match((messages[0] as any).content[0].text, /^x+$/, "below the share, no elision");

  // Two eligible previews: 1200 against 2400, half the region, so both go at once.
  messages.push(fetchResult("/h/4.md", big));
  elideFetchPreviews(messages as never[], 2, 0.4);
  assert.match((messages[0] as any).content[0].text, /elided/);
  assert.match((messages[1] as any).content[0].text, /elided/);

  // Another fetch makes /h/3.md eligible on its own: 600 against the 1800 that follow it, back under the share, so it survives while the committed stay elided.
  messages.push(fetchResult("/h/5.md", big));
  elideFetchPreviews(messages as never[], 2, 0.4);
  assert.match((messages[0] as any).content[0].text, /elided/, "committed stays elided");
  assert.match((messages[2] as any).content[0].text, /^x+$/, "fresh preview under the share kept");
});

test("a preview dwarfed by its conversation never triggers a pass", () => {
  // Only what follows the rewritten message is invalidated, so the weight that matters sits after the preview, not before it.
  const messages = [
    fetchResult("/big/1.md", "z".repeat(2_000)),
    { role: "assistant", content: "y".repeat(50_000) },
    fetchResult("/big/2.md"),
    fetchResult("/big/3.md"),
  ];
  elideFetchPreviews(messages as never[], 2);
  assert.match((messages[0] as any).content[0].text, /^z+$/, "left alone despite being old");
});

test("findElisionDrafts generates canonical ContextEditEntry drafts", () => {
  const entries = [
    { sourceEntry: { id: "entry-1" }, messages: [fetchResult("/c/1.md", "a".repeat(1000))] },
    { sourceEntry: { id: "entry-2" }, messages: [{ role: "assistant", content: "ok" }] },
    { sourceEntry: { id: "entry-3" }, messages: [fetchResult("/c/2.md", "b".repeat(1000))] },
    { sourceEntry: { id: "entry-4" }, messages: [fetchResult("/c/3.md", "c".repeat(1000))] },
  ];

  const drafts = findElisionDrafts(entries as never[], 2, 0);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, "context_edit");
  assert.equal(drafts[0].targetId, "entry-1");
  assert.match(drafts[0].replacement.content[0].text, /preview elided.*\/c\/1\.md/);
});
