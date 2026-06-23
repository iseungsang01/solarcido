// Plugin manifest types and pure validation — ported from claw-rust/crates/plugins/src/lib.rs.
// No filesystem or process access here; this module is fully pure.

export type { PluginManifest as PluginManifestBase } from "./types.js";

// ---------------------------------------------------------------------------
// Discriminated union enums
// ---------------------------------------------------------------------------

export type PluginKind =
  | { kind: "builtin" }
  | { kind: "bundled" }
  | { kind: "external" };

export type PluginPermission = "read" | "write" | "execute";

export type PluginToolPermission =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

// ---------------------------------------------------------------------------
// Manifest sub-types
// ---------------------------------------------------------------------------

export interface PluginHooks {
  PreToolUse: string[];
  PostToolUse: string[];
  PostToolUseFailure: string[];
}

export interface PluginLifecycle {
  Init: string[];
  Shutdown: string[];
}

export interface PluginToolManifest {
  name: string;
  description: string;
  /** Must be a JSON object (record). */
  inputSchema: Record<string, unknown>;
  command: string;
  args: string[];
  requiredPermission: PluginToolPermission;
}

export interface PluginCommandManifest {
  name: string;
  description: string;
  command: string;
}

// ---------------------------------------------------------------------------
// PluginManifest — canonical validated shape
// ---------------------------------------------------------------------------

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  defaultEnabled: boolean;
  hooks: PluginHooks;
  lifecycle: PluginLifecycle;
  tools: PluginToolManifest[];
  commands: PluginCommandManifest[];
}

// ---------------------------------------------------------------------------
// PluginMetadata — runtime identity attached after loading
// ---------------------------------------------------------------------------

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: PluginKind;
  /** "builtin" | "bundled" | path string */
  source: string;
  defaultEnabled: boolean;
}

// ---------------------------------------------------------------------------
// PluginTool — resolved tool ready for dispatch
// ---------------------------------------------------------------------------

export interface PluginTool {
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: string;
  args: string[];
  requiredPermission: PluginToolPermission;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ManifestValidationError =
  | { tag: "emptyField"; field: string }
  | { tag: "emptyEntryField"; kind: string; field: string; name?: string }
  | { tag: "invalidPermission"; permission: string }
  | { tag: "duplicatePermission"; permission: string }
  | { tag: "duplicateEntry"; kind: string; name: string }
  | { tag: "invalidToolInputSchema"; toolName: string }
  | { tag: "invalidToolRequiredPermission"; toolName: string; permission: string };

export type ValidateManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: ManifestValidationError[] };

const VALID_PERMISSIONS: PluginPermission[] = ["read", "write", "execute"];
const VALID_TOOL_PERMISSIONS: PluginToolPermission[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

function isValidPermission(value: string): value is PluginPermission {
  return (VALID_PERMISSIONS as string[]).includes(value);
}

function isValidToolPermission(value: string): value is PluginToolPermission {
  return (VALID_TOOL_PERMISSIONS as string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw (unknown-shaped) object as a PluginManifest.
 * Pure — no I/O. Path-existence checks are omitted because the TS manager
 * uses injected manifests and tests need no real filesystem.
 */
export function validateManifest(raw: unknown): ValidateManifestResult {
  const errors: ManifestValidationError[] = [];

  if (!isObject(raw)) {
    errors.push({ tag: "emptyField", field: "manifest" });
    return { ok: false, errors };
  }

  // Required string fields
  for (const field of ["name", "version", "description"] as const) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({ tag: "emptyField", field });
    }
  }

  // permissions
  const rawPermissions = Array.isArray(raw["permissions"]) ? raw["permissions"] : [];
  const seenPermissions = new Set<string>();
  const permissions: PluginPermission[] = [];

  for (const p of rawPermissions) {
    const pStr = typeof p === "string" ? p.trim() : "";
    if (pStr === "") {
      errors.push({ tag: "emptyEntryField", kind: "permission", field: "value" });
      continue;
    }
    if (seenPermissions.has(pStr)) {
      errors.push({ tag: "duplicatePermission", permission: pStr });
      continue;
    }
    seenPermissions.add(pStr);
    if (!isValidPermission(pStr)) {
      errors.push({ tag: "invalidPermission", permission: pStr });
    } else {
      permissions.push(pStr);
    }
  }

  // tools
  const rawTools = Array.isArray(raw["tools"]) ? raw["tools"] : [];
  const seenTools = new Set<string>();
  const tools: PluginToolManifest[] = [];

  for (const t of rawTools) {
    if (!isObject(t)) continue;

    const name = typeof t["name"] === "string" ? t["name"].trim() : "";
    if (name === "") {
      errors.push({ tag: "emptyEntryField", kind: "tool", field: "name" });
      continue;
    }
    if (seenTools.has(name)) {
      errors.push({ tag: "duplicateEntry", kind: "tool", name });
      continue;
    }
    seenTools.add(name);

    if (typeof t["description"] !== "string" || (t["description"] as string).trim() === "") {
      errors.push({ tag: "emptyEntryField", kind: "tool", field: "description", name });
    }
    if (typeof t["command"] !== "string" || (t["command"] as string).trim() === "") {
      errors.push({ tag: "emptyEntryField", kind: "tool", field: "command", name });
    }
    if (!isObject(t["inputSchema"])) {
      errors.push({ tag: "invalidToolInputSchema", toolName: name });
    }

    const rawPerm = typeof t["requiredPermission"] === "string"
      ? (t["requiredPermission"] as string).trim()
      : "danger-full-access";
    if (!isValidToolPermission(rawPerm)) {
      errors.push({ tag: "invalidToolRequiredPermission", toolName: name, permission: rawPerm });
      continue;
    }

    tools.push({
      name,
      description: typeof t["description"] === "string" ? t["description"] : "",
      inputSchema: isObject(t["inputSchema"]) ? t["inputSchema"] : {},
      command: typeof t["command"] === "string" ? t["command"] : "",
      args: Array.isArray(t["args"])
        ? (t["args"] as unknown[]).filter((a): a is string => typeof a === "string")
        : [],
      requiredPermission: rawPerm as PluginToolPermission,
    });
  }

  // commands
  const rawCommands = Array.isArray(raw["commands"]) ? raw["commands"] : [];
  const seenCommands = new Set<string>();
  const commands: PluginCommandManifest[] = [];

  for (const c of rawCommands) {
    if (!isObject(c)) continue;

    const name = typeof c["name"] === "string" ? c["name"].trim() : "";
    if (name === "") {
      errors.push({ tag: "emptyEntryField", kind: "command", field: "name" });
      continue;
    }
    if (seenCommands.has(name)) {
      errors.push({ tag: "duplicateEntry", kind: "command", name });
      continue;
    }
    seenCommands.add(name);

    if (typeof c["description"] !== "string" || (c["description"] as string).trim() === "") {
      errors.push({ tag: "emptyEntryField", kind: "command", field: "description", name });
    }
    if (typeof c["command"] !== "string" || (c["command"] as string).trim() === "") {
      errors.push({ tag: "emptyEntryField", kind: "command", field: "command", name });
    }
    commands.push({
      name,
      description: typeof c["description"] === "string" ? c["description"] : "",
      command: typeof c["command"] === "string" ? c["command"] : "",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const hooks = raw["hooks"];
  const lifecycle = raw["lifecycle"];

  const resolvedHooks: PluginHooks = {
    PreToolUse: isObject(hooks) && Array.isArray(hooks["PreToolUse"])
      ? (hooks["PreToolUse"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    PostToolUse: isObject(hooks) && Array.isArray(hooks["PostToolUse"])
      ? (hooks["PostToolUse"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    PostToolUseFailure: isObject(hooks) && Array.isArray(hooks["PostToolUseFailure"])
      ? (hooks["PostToolUseFailure"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  };

  const resolvedLifecycle: PluginLifecycle = {
    Init: isObject(lifecycle) && Array.isArray(lifecycle["Init"])
      ? (lifecycle["Init"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    Shutdown: isObject(lifecycle) && Array.isArray(lifecycle["Shutdown"])
      ? (lifecycle["Shutdown"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  };

  return {
    ok: true,
    manifest: {
      name: (raw["name"] as string).trim(),
      version: (raw["version"] as string).trim(),
      description: (raw["description"] as string).trim(),
      permissions,
      defaultEnabled: raw["defaultEnabled"] === true,
      hooks: resolvedHooks,
      lifecycle: resolvedLifecycle,
      tools,
      commands,
    },
  };
}
