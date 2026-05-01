//! Plugin manager, metadata, hooks, and lifecycle surfaces for Solarcido.
//!
//! Ported from `claw-rust/crates/plugins` with Claw/Claude branding replaced
//! by Solarcido. Full lifecycle management is deferred to a later port phase.

use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const MANIFEST_RELATIVE_PATH: &str = ".solarcido-plugin/plugin.json";

/// Kind of a plugin installation source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Builtin,
    Bundled,
    External,
}

impl Display for PluginKind {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Builtin => write!(f, "builtin"),
            Self::Bundled => write!(f, "bundled"),
            Self::External => write!(f, "external"),
        }
    }
}

/// Lightweight plugin metadata record used in listings and registries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: PluginKind,
    pub source: String,
    pub default_enabled: bool,
    pub root: Option<PathBuf>,
}

/// Hook scripts associated with a plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginHooks {
    #[serde(rename = "PreToolUse", default)]
    pub pre_tool_use: Vec<String>,
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<String>,
    #[serde(rename = "PostToolUseFailure", default)]
    pub post_tool_use_failure: Vec<String>,
}

impl PluginHooks {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pre_tool_use.is_empty()
            && self.post_tool_use.is_empty()
            && self.post_tool_use_failure.is_empty()
    }

    #[must_use]
    pub fn merged_with(&self, other: &Self) -> Self {
        let mut merged = self.clone();
        merged
            .pre_tool_use
            .extend(other.pre_tool_use.iter().cloned());
        merged
            .post_tool_use
            .extend(other.post_tool_use.iter().cloned());
        merged
            .post_tool_use_failure
            .extend(other.post_tool_use_failure.iter().cloned());
        merged
    }
}

/// Lifecycle hooks for a plugin (Init/Shutdown scripts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginLifecycle {
    #[serde(rename = "Init", default)]
    pub init: Vec<String>,
    #[serde(rename = "Shutdown", default)]
    pub shutdown: Vec<String>,
}

impl PluginLifecycle {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.init.is_empty() && self.shutdown.is_empty()
    }
}

/// Plugin manifest (`plugin.json`) schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub hooks: PluginHooks,
    #[serde(default)]
    pub lifecycle: PluginLifecycle,
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
}

/// Stub plugin registry. Full implementation deferred to Phase 7.
#[derive(Debug, Default)]
pub struct PluginRegistry {
    plugins: Vec<PluginMetadata>,
}

impl PluginRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn plugins(&self) -> &[PluginMetadata] {
        &self.plugins
    }

    pub fn register(&mut self, plugin: PluginMetadata) {
        self.plugins.push(plugin);
    }
}

/// Stub plugin manager. Full implementation deferred to Phase 7.
#[derive(Debug, Default)]
pub struct PluginManager {
    registry: PluginRegistry,
}

impl PluginManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn registry(&self) -> &PluginRegistry {
        &self.registry
    }

    #[must_use]
    pub fn combined_hooks(&self) -> PluginHooks {
        self.registry
            .plugins()
            .iter()
            .filter(|p| p.default_enabled)
            .fold(PluginHooks::default(), |acc, _p| acc)
    }
}

/// Config passed when constructing a `PluginManager`.
#[derive(Debug, Clone, Default)]
pub struct PluginManagerConfig {
    pub plugins_dir: Option<PathBuf>,
}
