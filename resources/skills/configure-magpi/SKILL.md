---
name: configure-magpi
description: Use when asked to change MagPi's preferred web search tool, cache scope, TTL, cache size budget, or private-network access. Configure MagPi settings in magpi.json.
---

# Configure MagPi

## Config files

- Global: `<homedir>/<CONFIG_DIR>/agent/magpi.json` (usually `~/.pi/agent/magpi.json`; if Pi uses another config dir name, check where `settings.json` or `magpi-cache` live)
- Project: `./<CONFIG_DIR>/magpi.json` (usually `.pi/magpi.json`, read only when the project is trusted)

Default to global unless the user asks for a project-local setting.

## Keys

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `preferredWebSearchTool` | `string \| null` | `null` | Exact Pi tool name to prefer over `magpi_search`. When declared for direct use, `magpi_search` hides its direct declaration. Set `null` in `.pi/magpi.json` to disable demotion for that project. |
| `cacheScope` | `"global" \| "project"` | `"global"` | Where new cache writes land; reads union both. |
| `ttlHours` | `number` | `24` | Freshness window in hours before refetch. |
| `maxCacheMB` | `number` | `0` | LRU eviction budget in MB for the write-scope cache (`0` = unlimited). |
| `allowPrivateNetwork` | `boolean` | `false` | Permit loopback and private-network fetches. |
| `searchFallback` | `"ask" \| "skip"` | `"ask"` | What `magpi_search` does when every source fails: prompt for pasted results, or report the failure and carry on unattended. |

## Steps

1. If setting `preferredWebSearchTool` from a natural-language description, match it against the exact tool names currently declared in this session. Ask the user if zero or multiple tools match. Never set `"magpi_search"` as its own replacement.
2. Read the target `magpi.json` if it exists. If it contains invalid JSON, confirm before overwriting.
3. Merge only the requested keys into the existing object and write formatted JSON.
4. For provider-native search with no named Pi tool, or to disable `magpi_search` completely (including via `codemode`), tell the user to launch Pi with `--exclude-tools magpi_search` instead.
