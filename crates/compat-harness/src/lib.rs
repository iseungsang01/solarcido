//! Manifest and parity extraction harness for Solarcido.
//!
//! Ported from `claw-rust/crates/compat-harness`. Provides helpers for
//! extracting tool/prompt manifests and running parity scenario checks
//! against the Solar mock service. Full scenario runner is deferred to
//! Phase 8 (Mock Parity Harness).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single parity scenario that can be replayed against the mock service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParityScenario {
    pub name: String,
    pub description: String,
    pub request: Value,
    pub expected_response: Value,
}

/// Outcome of a parity scenario check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParityOutcome {
    Pass,
    Fail { reason: String },
    Skip { reason: String },
}

/// Collection of parity scenarios loaded from a JSON manifest file.
#[derive(Debug, Clone, Default)]
pub struct ParityManifest {
    pub scenarios: Vec<ParityScenario>,
}

impl ParityManifest {
    /// Load scenarios from a JSON file at `path`.
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        let scenarios: Vec<ParityScenario> =
            serde_json::from_str(&content).map_err(|e| format!("invalid parity JSON: {e}"))?;
        Ok(Self { scenarios })
    }
}

/// Upstream path set used when extracting manifests from a TypeScript source tree.
#[derive(Debug, Clone)]
pub struct UpstreamPaths {
    pub src_root: std::path::PathBuf,
}

impl UpstreamPaths {
    #[must_use]
    pub fn new(src_root: impl Into<std::path::PathBuf>) -> Self {
        Self {
            src_root: src_root.into(),
        }
    }
}

/// Extract a tool/prompt manifest from the upstream TypeScript source tree.
/// Returns `None` when the upstream source root does not exist (stub behavior
/// until the full extractor is ported in Phase 8).
#[must_use]
pub fn extract_manifest(paths: &UpstreamPaths) -> Option<Value> {
    if !paths.src_root.exists() {
        return None;
    }
    // Full extraction logic deferred to Phase 8.
    Some(serde_json::json!({ "status": "not-yet-implemented", "src_root": paths.src_root.to_string_lossy() }))
}
