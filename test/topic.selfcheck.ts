import assert from "node:assert/strict";
import { test } from "node:test";
import { matchTopic, splitSections } from "../src/topic.js";

/**
 * Shaped like a real reference page: nav-heavy opening, one precise section, and a long overview that mentions every term in passing.
 */
const DOC = [
  "# Coroutines and tasks",
  "This section outlines high-level asyncio APIs.",
  "- [Coroutines](#coroutines)",
  "- [Task groups](#task-groups)",
  "- [Running in threads](#running-in-threads)",
  "",
  "## Running tasks concurrently",
  `Run awaitable objects concurrently. ${"A task is scheduled as a Task in this task group of tasks. ".repeat(40)}`,
  "",
  "## Task groups",
  "A task group holds a group of tasks and cancels them together when one fails.",
  "",
  "## Running in threads",
  "Asynchronously run a blocking function in a separate thread.",
].join("\n");

test("splitSections breaks on headings and keeps the preamble", () => {
  const sections = splitSections(DOC);
  assert.equal(sections.length, 4);
  assert.match(sections[0], /^# Coroutines and tasks/);
  assert.match(sections[3], /^## Running in threads/);
});

test("a precise section beats a long one that merely repeats the terms", () => {
  const m = matchTopic(DOC, "cancel a task group", 4000);
  assert.ok(m, "the topic matches something");
  assert.equal(m!.headings[0], "Task groups", "not the long overview that says 'task' forty times");
  assert.match(m!.content, /cancels them together/);
});

test("matching returns the section, not the document's opening nav", () => {
  const m = matchTopic(DOC, "run a blocking function in a thread", 4000);
  assert.equal(m!.headings[0], "Running in threads");
  assert.equal(m!.content.includes("[Coroutines](#coroutines)"), false, "the table of contents stays out");
});

test("an unmatched or empty topic yields undefined so the caller falls back", () => {
  assert.equal(matchTopic(DOC, "kubernetes ingress", 4000), undefined, "nothing matched");
  assert.equal(matchTopic(DOC, "", 4000), undefined, "no topic given");
  assert.equal(matchTopic(DOC, "the and for with", 4000), undefined, "stop words alone carry no signal");
});

test("the budget caps output but always returns the best section", () => {
  const m = matchTopic(DOC, "task group", 40);
  assert.ok(m, "a tiny budget still answers");
  assert.ok(m!.content.length <= 40, "top section truncated to fit");
  assert.equal(m!.headings.length, 1, "no room for runners-up");

  const roomy = matchTopic(DOC, "task", 100_000)!;
  assert.ok(roomy.headings.length > 1, "a large budget takes the runners-up too");
});

/** The llms.txt that llmstxt.org publishes about itself: a short preamble plus three links under one heading. */
const LLMS_TXT = [
  "# llms.txt",
  "",
  "> A proposal that those interested in providing LLM-friendly content add a /llms.txt file to their site. This is a markdown file that provides brief background information and guidance, along with links to markdown files providing more detailed information.",
  "",
  "## Docs",
  "",
  "- [llms.txt proposal](https://llmstxt.org/index.md): The proposal for llms.txt",
  "- [Python library docs](https://llmstxt.org/intro.html.md): Docs for `llms-txt` python lib",
  "- [ed demo](https://llmstxt.org/ed.md): Tongue-in-cheek example of how llms.txt could be used in the classic `ed` editor, used to show how editors could incorporate llms.txt in general.",
].join("\n");

test("a list-shaped document returns the matching lines, not the whole list", () => {
  const m = matchTopic(LLMS_TXT, "python library", 4000);
  assert.ok(m, "the topic matches something");
  assert.equal(m!.content, "- [Python library docs](https://llmstxt.org/intro.html.md): Docs for `llms-txt` python lib", "exactly the one matching entry, not the other two");
  assert.ok(m!.content.length < LLMS_TXT.length / 2, "far less than the whole index");
});

test("list mode keeps only entries that score above the relevance floor", () => {
  const m = matchTopic(LLMS_TXT, "editor", 4000)!;
  assert.match(m.content, /ed\.md/);
  assert.equal(m.content.split("\n").length, 1, "only the ed demo entry mentions editor");
});

test("a topic matching nothing in a list-shaped document still falls back usefully", () => {
  const none = matchTopic(LLMS_TXT, "kubernetes ingress", 4000);
  assert.equal(none, undefined, "nothing matches, so the caller falls back to the head of the document");
});

test("a section-shaped document with a few list lines keeps using section mode", () => {
  const m = matchTopic(DOC, "cancel a task group", 4000);
  assert.equal(m!.headings[0], "Task groups", "the four nav links in DOC do not trigger line mode");
});
