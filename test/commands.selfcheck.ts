import assert from "node:assert/strict";
import { test } from "node:test";
import { completeCommand } from "../index.js";

const values = (prefix: string) => (completeCommand(prefix) ?? []).map((i) => i.value);

test("an empty prefix offers every subcommand, each with help text", () => {
  const items = completeCommand("") ?? [];
  assert.ok(items.length >= 10, "the whole menu is offered");
  assert.ok(
    items.every((i) => i.description && i.label === i.value),
    "every row carries a description and completes to its own label",
  );
  assert.ok(values("").includes("cache prune"));
  assert.ok(values("").includes("help"), "help is discoverable from the picker");
});

test("a partial subcommand narrows the menu", () => {
  assert.deepEqual(values("cache "), ["cache stats", "cache clear", "cache prune"]);
  assert.deepEqual(values("scope p"), ["scope project"]);
  assert.equal(completeCommand("nonsense"), null, "no match yields null, not an empty list");
});

test("numeric subcommands suggest whole-argument values", () => {
  assert.deepEqual(values("ttl "), ["ttl 1", "ttl 24", "ttl 168", "ttl 720"]);
  assert.deepEqual(values("ttl 7"), ["ttl 720"], "typed digits filter the suggestions");
  assert.deepEqual(values("max "), ["max 0", "max 100", "max 500", "max 2000"]);
  assert.equal(completeCommand("ttl 999"), null, "an unlisted value just stops suggesting");
});

test("bare ttl still completes as a subcommand, not as a value", () => {
  assert.deepEqual(values("tt"), ["ttl"], "no trailing space means the user is still naming it");
  assert.deepEqual(values("ttl"), ["ttl"]);
});
