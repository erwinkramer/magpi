import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import magpi from "../index.js";
import { loadConfig, projectConfigPath, globalConfigPath } from "../src/config.js";

function withTempHome<T>(fn: (home: string, cwd: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "magpi-demotion-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "magpi-demotion-cwd-"));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve()
    .then(() => fn(home, cwd))
    .finally(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldProfile;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

async function declaredToolNames(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
  const msgs = await session.agent.transformContext(
    [
      {
        role: "system",
        content: "",
        toolsAdded: session.agent.state.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        timestamp: Date.now(),
      } as never,
    ],
    new AbortController().signal,
  );
  const sys = msgs[0] as { toolsAdded?: Array<{ name: string }> };
  return sys.toolsAdded?.map((t) => t.name) ?? [];
}

async function bootSession(
  home: string,
  cwd: string,
  opts: {
    projectTrusted?: boolean;
    excludeTools?: string[];
    extraExtension?: ExtensionFactory;
  } = {},
) {
  const agentDir = join(home, ".pi", "agent");
  const extensionFactories: ExtensionFactory[] = [magpi];
  if (opts.extraExtension) extensionFactories.push(opts.extraExtension);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories,
  });
  await loader.reload();

  const settingsManager = SettingsManager.inMemory();
  settingsManager.setProjectTrusted(opts.projectTrusted ?? true);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "builtin",
    excludeTools: opts.excludeTools,
  });
  await session.bindExtensions({});
  return session;
}

test("loadConfig resolves preferredWebSearchTool across global, trusted project, and malformed values", async () => {
  await withTempHome((_home, cwd) => {
    assert.equal(loadConfig(cwd, true).preferredWebSearchTool, null);

    writeJson(globalConfigPath(), { preferredWebSearchTool: "web_search" });
    assert.equal(loadConfig(cwd, true).preferredWebSearchTool, "web_search");

    writeJson(projectConfigPath(cwd), { preferredWebSearchTool: "project_web_search" });
    assert.equal(loadConfig(cwd, true).preferredWebSearchTool, "project_web_search");
    assert.equal(loadConfig(cwd, false).preferredWebSearchTool, "web_search");

    writeJson(projectConfigPath(cwd), { preferredWebSearchTool: null });
    assert.equal(loadConfig(cwd, true).preferredWebSearchTool, null);

    for (const bad of ["", "   ", 123, true, "magpi_search"]) {
      writeJson(projectConfigPath(cwd), { preferredWebSearchTool: bad });
      assert.equal(loadConfig(cwd, true).preferredWebSearchTool, null);
    }
  });
});

test("project search preference overrides global and follows Pi's loadout", async () => {
  await withTempHome(async (home, cwd) => {
    writeJson(globalConfigPath(), { preferredWebSearchTool: "web_search" });
    writeJson(projectConfigPath(cwd), { preferredWebSearchTool: "project_web_search" });
    const extra: ExtensionFactory = (pi) => {
      for (const name of ["web_search", "project_web_search"]) {
        pi.registerTool({
          name,
          label: "Web Search",
          description: "Preferred search",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
      }
    };

    const session = await bootSession(home, cwd, { extraExtension: extra });
    const run = async () => {
      await (session as never as { _prepareRun: (t: unknown) => Promise<unknown> })._prepareRun({
        messageType: "user",
        prompt: "check current loadout",
      });
      return declaredToolNames(session);
    };
    try {
      session.setActiveToolsByName(["magpi_fetch", "magpi_search", "magpi_cached", "web_search"]);
      const globalOnly = await run();
      assert.equal(globalOnly.includes("magpi_search"), true);

      session.setActiveToolsByName(["magpi_fetch", "magpi_search", "magpi_cached", "project_web_search"]);
      const projectSelected = await run();
      assert.equal(projectSelected.includes("magpi_search"), false);
      assert.equal(projectSelected.includes("magpi_fetch"), true);
      assert.equal(projectSelected.includes("magpi_cached"), true);

      session.setActiveToolsByName(["magpi_fetch", "magpi_search", "magpi_cached"]);
      assert.equal((await run()).includes("magpi_search"), true);

      session.setActiveToolsByName(["magpi_fetch", "magpi_search", "magpi_cached", "project_web_search"]);
      assert.equal((await run()).includes("magpi_search"), false);
    } finally {
      await session.dispose();
    }
  });
});

test("explicit exclusion of magpi_search survives preferred tool removal", async () => {
  await withTempHome(async (home, cwd) => {
    writeJson(globalConfigPath(), { preferredWebSearchTool: "web_search" });
    const extra: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description: "Preferred search",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    };

    const session = await bootSession(home, cwd, {
      excludeTools: ["magpi_search"],
      extraExtension: extra,
    });
    try {
      await (session as never as { _prepareRun: (t: unknown) => Promise<unknown> })._prepareRun({
        messageType: "user",
        prompt: "first",
      });
      assert.equal((await declaredToolNames(session)).includes("magpi_search"), false);

      session.setActiveToolsByName(["magpi_fetch", "magpi_search", "magpi_cached"]);
      await (session as never as { _prepareRun: (t: unknown) => Promise<unknown> })._prepareRun({
        messageType: "user",
        prompt: "second",
      });
      const run2 = await declaredToolNames(session);
      assert.equal(run2.includes("magpi_search"), false);
      assert.equal(run2.includes("magpi_fetch"), true);
    } finally {
      await session.dispose();
    }
  });
});

test("inactive or deferred preferred tool does not hide magpi_search", async () => {
  await withTempHome(async (home, cwd) => {
    writeJson(globalConfigPath(), { preferredWebSearchTool: "web_search" });
    const extra: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description: "Deferred search",
        exposure: "deferred",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    };

    const session = await bootSession(home, cwd, { extraExtension: extra });
    try {
      await (session as never as { _prepareRun: (t: unknown) => Promise<unknown> })._prepareRun({
        messageType: "user",
        prompt: "first",
      });
      const run1 = await declaredToolNames(session);
      assert.equal(run1.includes("web_search"), false);
      assert.equal(run1.includes("magpi_search"), true);
    } finally {
      await session.dispose();
    }
  });
});

test("untrusted project override does not replace global preference", async () => {
  await withTempHome(async (home, cwd) => {
    writeJson(globalConfigPath(), { preferredWebSearchTool: "web_search" });
    writeJson(projectConfigPath(cwd), { preferredWebSearchTool: null });
    const extra: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description: "Preferred search",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    };

    const session = await bootSession(home, cwd, { projectTrusted: false, extraExtension: extra });
    try {
      await (session as never as { _prepareRun: (t: unknown) => Promise<unknown> })._prepareRun({
        messageType: "user",
        prompt: "first",
      });
      const run1 = await declaredToolNames(session);
      assert.equal(run1.includes("magpi_search"), false);
    } finally {
      await session.dispose();
    }
  });
});
