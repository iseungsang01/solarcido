//! Manifest and parity extraction helpers for Solarcido.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single parity scenario loaded from a JSON manifest file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParityScenario {
    pub name: String,
    pub category: String,
    pub description: String,
    #[serde(default)]
    pub parity_refs: Vec<String>,
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
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        let scenarios: Vec<ParityScenario> =
            serde_json::from_str(&content).map_err(|e| format!("invalid parity JSON: {e}"))?;
        Ok(Self { scenarios })
    }
}

/// Upstream path set used when extracting manifests from a source tree.
#[derive(Debug, Clone)]
pub struct UpstreamPaths {
    pub src_root: PathBuf,
}

impl UpstreamPaths {
    #[must_use]
    pub fn new(src_root: impl Into<PathBuf>) -> Self {
        Self {
            src_root: src_root.into(),
        }
    }
}

/// Extract the parity scenario manifest from a source tree.
///
/// The current Solarcido port uses the repository-root `mock_parity_scenarios.json`
/// file as the canonical manifest. If that file is missing, return `None` rather
/// than fabricating fallback data.
#[must_use]
pub fn extract_manifest(paths: &UpstreamPaths) -> Option<Value> {
    let manifest_path = paths.src_root.join("mock_parity_scenarios.json");
    let content = fs::read_to_string(manifest_path).ok()?;
    serde_json::from_str(&content).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_manifest_json() {
        let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../mock_parity_scenarios.json");
        let manifest = ParityManifest::load(&manifest_path).expect("manifest should load");
        assert!(!manifest.scenarios.is_empty());
    }

    #[test]
    fn extracts_manifest_from_repo_root() {
        let paths = UpstreamPaths::new(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
        let value = extract_manifest(&paths).expect("manifest should exist");
        assert!(value.is_array());
    }
}
