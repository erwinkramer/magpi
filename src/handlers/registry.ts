import type { MagpiHandler } from "./handler.js";
import { arxivHandler } from "./arxiv.js";
import { defaultHandler } from "./default.js";
import { githubHandler } from "./github.js";
import { gitlabHandler } from "./gitlab.js";
import { hackerNewsHandler } from "./hackernews.js";
import { redditHandler } from "./reddit.js";
import { registryHandler } from "./registries/index.js";
import { stackExchangeHandler } from "./stackexchange.js";
import { wikipediaHandler } from "./wikipedia.js";

// Order matters: specific handlers first, catch-all webpage last.
const handlers: MagpiHandler[] = [
  githubHandler,
  gitlabHandler,
  wikipediaHandler,
  stackExchangeHandler,
  redditHandler,
  hackerNewsHandler,
  arxivHandler,
  registryHandler,
  defaultHandler,
];

/** External handlers (from other extensions via pi.events "magpi:register-handler") are prepended so they can shadow built-ins for their domains. */
export function registerHandler(h: MagpiHandler): void {
  if (!h || typeof h.name !== "string" || typeof h.match !== "function" || typeof h.fetch !== "function") {
    throw new Error("magpi: handler must have { name, match(url), fetch(url, ctx) }; build it with defineHandler()");
  }
  const existing = handlers.findIndex((x) => x.name === h.name);
  if (existing !== -1) handlers.splice(existing, 1);
  handlers.unshift(h);
}

export function resolveHandler(url: URL): MagpiHandler {
  return handlers.find((h) => h.match(url)) ?? defaultHandler;
}

export function listHandlers(): MagpiHandler[] {
  return [...handlers];
}
