use crate::{PermissionMode, RuntimeError};
use serde::{Deserialize, Serialize};
use solarcido_api::{ReasoningEffort, DEFAULT_MODEL};
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_FILE_NAME: &str = "config.json";
const MEMORY_FILE_NAME: &str = "memory.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    Never,
    OnFailure,
    OnRequest,
}

impl ApprovalPolicy {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::OnFailure => "on-failure",
            Self::OnRequest => "on-request",
        }
    }

    pub fn parse(value: &str) -> Result<Self, RuntimeError> {
        match value {
            "never" => Ok(Self::Never),
            "on-failure" => Ok(Self::OnFailure),
            "on-request" => Ok(Self::OnRequest),
            other => Err(RuntimeError::new(format!(
                "invalid approvalPolicy `{other}`; expected never, on-failure, or on-request"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SolarcidoConfig {
    pub model: String,
    #[serde(rename = "reasoningEffort")]
    pub reasoning_effort: ReasoningEffort,
    #[serde(rename = "approvalPolicy")]
    pub approval_policy: ApprovalPolicy,
    pub sandbox: PermissionMode,
    pub quiet: bool,
}

impl Default for SolarcidoConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.to_string(),
            reasoning_effort: ReasoningEffort::Medium,
            approval_policy: ApprovalPolicy::OnFailure,
            sandbox: PermissionMode::WorkspaceWrite,
            quiet: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    home: PathBuf,
}

impl ConfigStore {
    #[must_use]
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    pub fn from_env() -> Result<Self, RuntimeError> {
        Ok(Self::new(resolve_solarcido_home()?))
    }

    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }

    #[must_use]
    pub fn config_path(&self) -> PathBuf {
        self.home.join(CONFIG_FILE_NAME)
    }

    #[must_use]
    pub fn memory_path(&self) -> PathBuf {
        self.home.join(MEMORY_FILE_NAME)
    }

    pub fn load(&self) -> Result<SolarcidoConfig, RuntimeError> {
        let path = self.config_path();
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SolarcidoConfig::default());
            }
            Err(error) => {
                return Err(RuntimeError::new(format!(
                    "could not read config at {}: {error}",
                    path.display()
                )));
            }
        };
        let value = serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| {
            RuntimeError::new(format!("invalid JSON in {}: {error}", path.display()))
        })?;
        validate_config_value(&value, &path)
    }

    pub fn save(&self, config: &SolarcidoConfig) -> Result<(), RuntimeError> {
        fs::create_dir_all(&self.home).map_err(|error| {
            RuntimeError::new(format!(
                "failed to create Solarcido home {}: {error}",
                self.home.display()
            ))
        })?;
        let encoded = serde_json::to_string_pretty(config)
            .map_err(|error| RuntimeError::new(format!("failed to encode config: {error}")))?;
        fs::write(self.config_path(), format!("{encoded}\n"))
            .map_err(|error| RuntimeError::new(format!("failed to write config: {error}")))
    }

    pub fn load_memory(&self) -> Result<Option<String>, RuntimeError> {
        match fs::read_to_string(self.memory_path()) {
            Ok(memory) => {
                let trimmed = memory.trim();
                if trimmed.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(trimmed.to_string()))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(RuntimeError::new(format!("failed to read memory: {error}"))),
        }
    }
}

#[must_use]
pub fn config_keys() -> &'static [&'static str] {
    &[
        "model",
        "reasoningEffort",
        "approvalPolicy",
        "sandbox",
        "quiet",
    ]
}

pub fn get_config_value(
    config: &SolarcidoConfig,
    key: Option<&str>,
) -> Result<serde_json::Value, RuntimeError> {
    match key {
        None => serde_json::to_value(config)
            .map_err(|error| RuntimeError::new(format!("failed to encode config: {error}"))),
        Some("model") => Ok(serde_json::Value::String(config.model.clone())),
        Some("reasoningEffort") => Ok(serde_json::Value::String(
            config.reasoning_effort.as_str().to_string(),
        )),
        Some("approvalPolicy") => Ok(serde_json::Value::String(
            config.approval_policy.as_str().to_string(),
        )),
        Some("sandbox") => Ok(serde_json::Value::String(
            config.sandbox.as_str().to_string(),
        )),
        Some("quiet") => Ok(serde_json::Value::Bool(config.quiet)),
        Some(key) => Err(unknown_config_key(key)),
    }
}

pub fn set_config_value(
    mut config: SolarcidoConfig,
    key: &str,
    raw_value: &str,
) -> Result<SolarcidoConfig, RuntimeError> {
    match key {
        "model" => {
            let model = raw_value.trim();
            if model.is_empty() {
                return Err(RuntimeError::new("model must not be empty"));
            }
            config.model = model.to_string();
        }
        "reasoningEffort" => {
            config.reasoning_effort =
                ReasoningEffort::parse(raw_value).map_err(RuntimeError::new)?;
        }
        "approvalPolicy" => config.approval_policy = ApprovalPolicy::parse(raw_value)?,
        "sandbox" => {
            let mode = PermissionMode::parse(raw_value)?;
            if mode == PermissionMode::DangerFullAccess {
                return Err(RuntimeError::new(
                    "sandbox config supports read-only or workspace-write; use --dangerously-skip-permissions for danger-full-access",
                ));
            }
            config.sandbox = mode;
        }
        "quiet" => match raw_value {
            "true" => config.quiet = true,
            "false" => config.quiet = false,
            _ => return Err(RuntimeError::new("quiet must be true or false")),
        },
        key => return Err(unknown_config_key(key)),
    }
    Ok(config)
}

fn validate_config_value(
    value: &serde_json::Value,
    path: &Path,
) -> Result<SolarcidoConfig, RuntimeError> {
    let object = value.as_object().ok_or_else(|| {
        RuntimeError::new(format!(
            "config at {} must be a JSON object",
            path.display()
        ))
    })?;
    for key in object.keys() {
        if key == "maxSteps" {
            return Err(RuntimeError::new(
                "maxSteps is no longer supported. Solarcido runs without a step limit.",
            ));
        }
        if !config_keys().contains(&key.as_str()) {
            return Err(RuntimeError::new(format!(
                "unknown config key in {}: {key}. Valid keys: {}",
                path.display(),
                config_keys().join(", ")
            )));
        }
    }

    let mut config = SolarcidoConfig::default();
    if let Some(value) = object.get("model") {
        config.model = value
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| RuntimeError::new("model must be a non-empty string"))?
            .to_string();
    }
    if let Some(value) = object.get("reasoningEffort") {
        let value = value
            .as_str()
            .ok_or_else(|| RuntimeError::new("reasoningEffort must be low, medium, or high"))?;
        config.reasoning_effort = ReasoningEffort::parse(value).map_err(RuntimeError::new)?;
    }
    if let Some(value) = object.get("approvalPolicy") {
        let value = value.as_str().ok_or_else(|| {
            RuntimeError::new("approvalPolicy must be never, on-failure, or on-request")
        })?;
        config.approval_policy = ApprovalPolicy::parse(value)?;
    }
    if let Some(value) = object.get("sandbox") {
        let value = value
            .as_str()
            .ok_or_else(|| RuntimeError::new("sandbox must be read-only or workspace-write"))?;
        let mode = PermissionMode::parse(value)?;
        if mode == PermissionMode::DangerFullAccess {
            return Err(RuntimeError::new(
                "sandbox config supports read-only or workspace-write",
            ));
        }
        config.sandbox = mode;
    }
    if let Some(value) = object.get("quiet") {
        config.quiet = value
            .as_bool()
            .ok_or_else(|| RuntimeError::new("quiet must be a boolean"))?;
    }
    Ok(config)
}

fn unknown_config_key(key: &str) -> RuntimeError {
    RuntimeError::new(format!(
        "unknown config key: {key}. Valid keys: {}",
        config_keys().join(", ")
    ))
}

fn resolve_solarcido_home() -> Result<PathBuf, RuntimeError> {
    if let Some(home) = std::env::var_os("SOLARCIDO_HOME") {
        return Ok(PathBuf::from(home));
    }
    let user_home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| {
            RuntimeError::new("could not determine home directory; set SOLARCIDO_HOME")
        })?;
    Ok(PathBuf::from(user_home).join(".solarcido"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store(name: &str) -> ConfigStore {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        ConfigStore::new(std::env::temp_dir().join(format!(
            "solarcido-config-test-{name}-{}-{nanos}",
            std::process::id(),
        )))
    }

    #[test]
    fn missing_config_uses_defaults() {
        let store = temp_store("missing");
        let config = store.load().unwrap();
        assert_eq!(config.model, DEFAULT_MODEL);
        assert_eq!(config.sandbox, PermissionMode::WorkspaceWrite);
        let _ = fs::remove_dir_all(store.home());
    }

    #[test]
    fn rejects_unknown_keys() {
        let store = temp_store("unknown");
        fs::create_dir_all(store.home()).unwrap();
        fs::write(store.config_path(), r#"{"model":"x","surprise":true}"#).unwrap();
        let error = store.load().unwrap_err();
        assert!(error.to_string().contains("unknown config key"));
        let _ = fs::remove_dir_all(store.home());
    }

    #[test]
    fn saves_and_loads_config() {
        let store = temp_store("roundtrip");
        let config = set_config_value(SolarcidoConfig::default(), "model", "solar-test").unwrap();
        store.save(&config).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.model, "solar-test");
        let _ = fs::remove_dir_all(store.home());
    }
}
