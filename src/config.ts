import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Kept in sync with pi's project config dir.
// Imported lazily in index.ts to keep this module importable in tests without pi installed.
export let CONFIG_DIR = ".pi";
export function setConfigDirName(name: string) {
  CONFIG_DIR = name;
}

export interface MagpiConfig {
  /** Where the fetch cache lives: per-user or inside the project's .pi folder. */
  cacheScope: "global" | "project";
  /** Cache entries older than this are refetched. */
  ttlHours: number;
  /** Size budget in MB for the write-scope cache; least-recently-used entries are evicted past it. 0 = unlimited. */
  maxCacheMB: number;
  /** Allow fetching loopback/private-network addresses (intranet wikis, local dev servers). */
  allowPrivateNetwork: boolean;
}

export const DEFAULTS: MagpiConfig = { cacheScope: "global", ttlHours: 24, maxCacheMB: 0, allowPrivateNetwork: false };

export const globalConfigPath = () => join(homedir(), CONFIG_DIR, "agent", "magpi.json");
export const projectConfigPath = (cwd: string) => join(cwd, CONFIG_DIR, "magpi.json");

function readJson(path: string): Partial<MagpiConfig> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Global config, overridden by project config (only when the project is trusted). */
export function loadConfig(cwd: string, projectTrusted: boolean): MagpiConfig {
  return {
    ...DEFAULTS,
    ...readJson(globalConfigPath()),
    ...(projectTrusted ? readJson(projectConfigPath(cwd)) : {}),
  };
}

export function saveConfig(path: string, patch: Partial<MagpiConfig>): void {
  const merged = { ...readJson(path), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

export const globalCacheRoot = () => join(homedir(), CONFIG_DIR, "agent", "magpi-cache");
export const projectCacheRoot = (cwd: string) => join(cwd, CONFIG_DIR, "magpi-cache");

/** Where writes land. Reads always union both roots. */
export function cacheRoot(cwd: string, cfg: MagpiConfig): string {
  return cfg.cacheScope === "project" ? projectCacheRoot(cwd) : globalCacheRoot();
}

export function configExists(path: string): boolean {
  return existsSync(path);
}

/** Config files that exist but fail to parse (and are silently ignored by loadConfig). */
export function invalidConfigPaths(cwd: string, projectTrusted: boolean): string[] {
  return [globalConfigPath(), ...(projectTrusted ? [projectConfigPath(cwd)] : [])].filter((p) => {
    if (!existsSync(p)) return false;
    try {
      JSON.parse(readFileSync(p, "utf8"));
      return false;
    } catch {
      return true;
    }
  });
}
