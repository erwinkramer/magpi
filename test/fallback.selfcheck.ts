// searchFallback on a forced miss: "skip" reports the failure as a normal tool result without
// the paste-results dialog; "ask" (default) prompts the user, and an empty paste throws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchFailure } from "../index.js";
import { webSearch } from "../src/search.js";

/** An already-aborted signal makes every source fail at the fetch call: no network, no stubbing. */
const deadSignal = (() => {
  const c = new AbortController();
  c.abort();
  return c.signal;
})();

/** Run the real source chain against the dead signal, so the miss comes from webSearch itself. */
async function forceMiss() {
  const query = "anything";
  const { results, errors } = await webSearch(query, "auto", deadSignal);
  assert.deepEqual(results, []);
  assert.equal(errors.length, 4, "ddg, wikipedia, hn, and context7 each report their own failure");
  return { query, errors };
}

function ui(dialogs: { count: number }) {
  return {
    hasUI: true,
    ui: {
      // Submitting nothing: the ask path must fall through to the throw.
      input: async () => {
        dialogs.count++;
        return undefined;
      },
    },
  };
}

test("skip: a forced miss returns a soft failure without the dialog", async () => {
  const { query, errors } = await forceMiss();
  const dialogs = { count: 0 };
  const r = (await searchFailure(query, errors, "skip", ui(dialogs))) as {
    content: Array<{ text: string }>;
    details: { failed?: boolean; results: unknown[]; errors: string[] };
  };
  assert.equal(dialogs.count, 0, "the paste-results dialog never opened");
  assert.equal(r.details.failed, true, "the failure is marked in details");
  assert.deepEqual(r.details.results, []);
  assert.deepEqual(r.details.errors, errors);
  const text = r.content[0].text;
  assert.match(text, /All search sources failed/);
  assert.match(text, /do not silently fall back to memory/i, "the no-memory-fallback rule survives in skip mode");
  assert.match(text, /magpi_cached/);
  assert.match(text, /say so plainly/);
});

test("ask: the same forced miss prompts the user, and an empty paste throws", async () => {
  const { query, errors } = await forceMiss();
  const dialogs = { count: 0 };
  await assert.rejects(searchFailure(query, errors, "ask", ui(dialogs)), /Ask the user to search/i);
  assert.equal(dialogs.count, 1, "the user was prompted");
});
