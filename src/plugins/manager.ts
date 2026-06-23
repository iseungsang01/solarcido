// Plugin registry and manager — ported from claw-rust/crates/plugins/src/lib.rs.
// Filesystem and process access are fully injected so tests need no real fs/process.

import type {
  PluginManifest,
  PluginMetadata,
  PluginTool,
  PluginKind,
  PluginHooks,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// HookConfig — aggregated hook commands across all enabled plugins
// ---------------------------------------------------------------------------

export interface HookConfig {
  PreToolUse: string[];
  PostToolUse: string[];
  PostToolUseFailure: string[];
}

// ---------------------------------------------------------------------------
// PluginEntry — a manifest paired with its resolved metadata, as stored in
// the registry after registration.
// ---------------------------------------------------------------------------

interface PluginEntry {
  metadata: PluginMetadata;
  manifest: PluginManifest;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// ManifestSource — injectable source of manifests (function, no real fs)
// ---------------------------------------------------------------------------

export type ManifestSource = () => Array<{
  manifest: PluginManifest;
  kind: PluginKind;
  source: string;
  defaultEnabled?: boolean;
}>;

// ---------------------------------------------------------------------------
// PluginRegistry — in-memory store of registered plugins
// ---------------------------------------------------------------------------

export class PluginRegistry {
  /** Keyed by plugin id, insertion-ordered via Map. */
  private readonly entries = new Map<string, PluginEntry>();

  // -- registration ----------------------------------------------------------

  /**
   * Register a plugin from a manifest and identity fields.
   * Throws if the id is already registered.
   */
  register(manifest: PluginManifest, kind: PluginKind, source: string): void {
    const id = pluginId(manifest.name, kind.kind);
    if (this.entries.has(id)) {
      throw new Error(`plugin \`${id}\` is already registered`);
    }
    const metadata: PluginMetadata = {
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      kind,
      source,
      defaultEnabled: manifest.defaultEnabled,
    };
    const enabled = defaultEnabled(kind, manifest.defaultEnabled);
    this.entries.set(id, { metadata, manifest, enabled });
  }

  // -- enable / disable ------------------------------------------------------

  enable(pluginId: string): void {
    const entry = this.require(pluginId);
    entry.enabled = true;
  }

  disable(pluginId: string): void {
    const entry = this.require(pluginId);
    entry.enabled = false;
  }

  // -- query -----------------------------------------------------------------

  get(pluginId: string): PluginEntry | undefined {
    return this.entries.get(pluginId);
  }

  has(pluginId: string): boolean {
    return this.entries.has(pluginId);
  }

  list(): ReadonlyArray<{
    metadata: PluginMetadata;
    enabled: boolean;
  }> {
    return [...this.entries.values()].map(({ metadata, enabled }) => ({
      metadata,
      enabled,
    }));
  }

  listEnabled(): ReadonlyArray<PluginEntry> {
    return [...this.entries.values()].filter((e) => e.enabled);
  }

  // -- aggregation -----------------------------------------------------------

  /**
   * Collect all hook commands from enabled plugins into a single HookConfig.
   * Order: registration order within each slot.
   */
  aggregatedHooks(): HookConfig {
    const result: HookConfig = {
      PreToolUse: [],
      PostToolUse: [],
      PostToolUseFailure: [],
    };
    for (const entry of this.listEnabled()) {
      const h: PluginHooks = entry.manifest.hooks;
      result.PreToolUse.push(...h.PreToolUse);
      result.PostToolUse.push(...h.PostToolUse);
      result.PostToolUseFailure.push(...h.PostToolUseFailure);
    }
    return result;
  }

  /**
   * Collect all tools from enabled plugins.
   * Throws if two enabled plugins expose a tool with the same name.
   */
  aggregatedTools(): PluginTool[] {
    const seen = new Map<string, string>(); // tool name -> plugin id
    const tools: PluginTool[] = [];

    for (const entry of this.listEnabled()) {
      const { metadata, manifest } = entry;
      for (const t of manifest.tools) {
        const existing = seen.get(t.name);
        if (existing !== undefined) {
          throw new Error(
            `plugin tool \`${t.name}\` is defined by both \`${existing}\` and \`${metadata.id}\``,
          );
        }
        seen.set(t.name, metadata.id);
        tools.push({
          pluginId: metadata.id,
          pluginName: metadata.name,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          command: t.command,
          args: t.args,
          requiredPermission: t.requiredPermission,
        });
      }
    }

    return tools;
  }

  // -- private ---------------------------------------------------------------

  private require(id: string): PluginEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(`plugin \`${id}\` is not registered`);
    }
    return entry;
  }
}

// ---------------------------------------------------------------------------
// PluginManager — higher-level coordinator over a PluginRegistry
// ---------------------------------------------------------------------------

export class PluginManager {
  private readonly registry = new PluginRegistry();

  /**
   * Load plugins from the injected manifest source.
   * Each item in the source array is registered; errors from individual
   * manifests are collected and returned rather than thrown, so callers
   * can decide whether to hard-fail or continue.
   */
  load(source: ManifestSource): { loaded: number; errors: Array<{ id: string; error: string }> } {
    const items = source();
    let loaded = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const item of items) {
      const id = pluginId(item.manifest.name, item.kind.kind);
      try {
        this.registry.register(item.manifest, item.kind, item.source);
        loaded++;
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { loaded, errors };
  }

  enable(id: string): void {
    this.registry.enable(id);
  }

  disable(id: string): void {
    this.registry.disable(id);
  }

  list(): ReturnType<PluginRegistry["list"]> {
    return this.registry.list();
  }

  aggregatedHooks(): HookConfig {
    return this.registry.aggregatedHooks();
  }

  aggregatedTools(): PluginTool[] {
    return this.registry.aggregatedTools();
  }

  getRegistry(): PluginRegistry {
    return this.registry;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors the Rust `plugin_id(name, marketplace)` function. */
function pluginId(name: string, marketplace: string): string {
  return `${marketplace}:${name}`;
}

/** External plugins default to disabled; builtin/bundled use defaultEnabled. */
function defaultEnabled(kind: PluginKind, manifestDefault: boolean): boolean {
  if (kind.kind === "external") return false;
  return manifestDefault;
}
