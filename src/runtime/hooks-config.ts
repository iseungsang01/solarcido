/**
 * Tool-hook configuration loaded from `$SOLARCIDO_HOME/hooks.json`. Absent or
 * malformed config yields no hooks — hooks are strictly opt-in and additive.
 *
 * Shape (either flat or under a `hooks` key):
 *   { "preToolUse": ["cmd …"], "postToolUse": [...], "postToolUseFailure": [...] }
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { getSolarcidoHome } from "./config.js";
import { emptyHookConfig, type HookConfig } from "./hooks.js";

export function getHooksConfigPath(): string {
  return path.join(getSolarcidoHome(), "hooks.json");
}

function asCommands(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((command): command is string => typeof command === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a hooks.json document into a HookConfig. Accepts flat or `{hooks:{…}}`. */
export function parseHookConfig(raw: string): HookConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyHookConfig();
  }
  if (!isRecord(parsed)) return emptyHookConfig();

  const root = isRecord(parsed.hooks) ? parsed.hooks : parsed;
  return {
    preToolUse: asCommands(root.preToolUse ?? root.PreToolUse),
    postToolUse: asCommands(root.postToolUse ?? root.PostToolUse),
    postToolUseFailure: asCommands(root.postToolUseFailure ?? root.PostToolUseFailure),
  };
}

/** Merge several HookConfigs (e.g. file config + plugin-aggregated hooks). */
export function mergeHookConfigs(...configs: HookConfig[]): HookConfig {
  const merged = emptyHookConfig();
  for (const config of configs) {
    merged.preToolUse.push(...config.preToolUse);
    merged.postToolUse.push(...config.postToolUse);
    merged.postToolUseFailure.push(...config.postToolUseFailure);
  }
  return merged;
}

/** Load configured hooks, returning an empty config when the file is absent/invalid. */
export function loadHookConfig(configPath: string = getHooksConfigPath()): HookConfig {
  try {
    return parseHookConfig(readFileSync(configPath, "utf8"));
  } catch {
    return emptyHookConfig();
  }
}
