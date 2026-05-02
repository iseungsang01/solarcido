use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::RuntimeError;

const CLAUDE_AI_PREFIX: &str = "claude.ai ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct McpConfigCollection {
    #[serde(default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

impl McpConfigCollection {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        for (server_name, server) in &self.servers {
            if server_name.trim().is_empty() {
                return Err(RuntimeError::new("MCP server names must not be empty"));
            }
            server.validate().map_err(|error| {
                RuntimeError::new(format!("MCP server `{server_name}`: {error}"))
            })?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum McpServerConfig {
    Stdio(McpStdioServerConfig),
    Http(McpRemoteServerConfig),
    Sse(McpRemoteServerConfig),
    Ws(McpWebSocketServerConfig),
    Sdk(McpSdkServerConfig),
}

impl McpServerConfig {
    #[must_use]
    pub fn transport(&self) -> &'static str {
        match self {
            Self::Stdio(_) => "stdio",
            Self::Http(_) => "http",
            Self::Sse(_) => "sse",
            Self::Ws(_) => "ws",
            Self::Sdk(_) => "sdk",
        }
    }

    #[must_use]
    pub fn summary(&self) -> String {
        match self {
            Self::Stdio(config) => {
                let mut command = vec![config.command.clone()];
                command.extend(config.args.clone());
                format!("stdio: {}", command.join(" "))
            }
            Self::Http(config) | Self::Sse(config) => {
                format!("{}: {}", self.transport(), config.url)
            }
            Self::Ws(config) => format!("ws: {}", config.url),
            Self::Sdk(config) => format!("sdk: {}", config.name),
        }
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        match self {
            Self::Stdio(config) => config.validate(),
            Self::Http(config) | Self::Sse(config) => config.validate(),
            Self::Ws(config) => config.validate(),
            Self::Sdk(config) => config.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpStdioServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(rename = "toolCallTimeoutMs", default)]
    pub tool_call_timeout_ms: Option<u64>,
}

impl McpStdioServerConfig {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.command.trim().is_empty() {
            return Err(RuntimeError::new("command must not be empty"));
        }
        if matches!(self.tool_call_timeout_ms, Some(0)) {
            return Err(RuntimeError::new(
                "toolCallTimeoutMs must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpRemoteServerConfig {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(rename = "headersHelper")]
    pub headers_helper: Option<String>,
}

impl McpRemoteServerConfig {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.url.trim().is_empty() {
            return Err(RuntimeError::new("url must not be empty"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpWebSocketServerConfig {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(rename = "headersHelper")]
    pub headers_helper: Option<String>,
}

impl McpWebSocketServerConfig {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.url.trim().is_empty() {
            return Err(RuntimeError::new("url must not be empty"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpSdkServerConfig {
    pub name: String,
}

impl McpSdkServerConfig {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.name.trim().is_empty() {
            return Err(RuntimeError::new("name must not be empty"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    AuthRequired,
    Error,
}

impl std::fmt::Display for McpConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "disconnected"),
            Self::Connecting => write!(f, "connecting"),
            Self::Connected => write!(f, "connected"),
            Self::AuthRequired => write!(f, "auth_required"),
            Self::Error => write!(f, "error"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpResourceInfo {
    pub uri: String,
    pub name: String,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerState {
    pub server_name: String,
    pub config: McpServerConfig,
    pub status: McpConnectionStatus,
    pub tools: Vec<McpToolInfo>,
    pub resources: Vec<McpResourceInfo>,
    pub server_info: Option<String>,
    pub error_message: Option<String>,
}

impl McpServerState {
    #[must_use]
    pub fn summary(&self) -> String {
        self.config.summary()
    }
}

#[derive(Debug, Clone, Default)]
pub struct McpConnectionManager {
    servers: BTreeMap<String, McpServerState>,
}

impl McpConnectionManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn from_config(config: &McpConfigCollection) -> Self {
        let mut manager = Self::new();
        for (server_name, server_config) in &config.servers {
            manager.register_server(server_name, server_config.clone());
        }
        manager
    }

    pub fn register_server(&mut self, server_name: &str, config: McpServerConfig) {
        self.servers.insert(
            server_name.to_string(),
            McpServerState {
                server_name: server_name.to_string(),
                config,
                status: McpConnectionStatus::Disconnected,
                tools: Vec::new(),
                resources: Vec::new(),
                server_info: None,
                error_message: None,
            },
        );
    }

    #[must_use]
    pub fn list_servers(&self) -> Vec<McpServerState> {
        self.servers.values().cloned().collect()
    }

    #[must_use]
    pub fn get_server(&self, server_name: &str) -> Option<McpServerState> {
        self.servers.get(server_name).cloned()
    }

    pub fn set_status(
        &mut self,
        server_name: &str,
        status: McpConnectionStatus,
    ) -> Result<(), RuntimeError> {
        let state = self
            .servers
            .get_mut(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        state.status = status;
        Ok(())
    }

    pub fn set_server_info(
        &mut self,
        server_name: &str,
        server_info: Option<String>,
    ) -> Result<(), RuntimeError> {
        let state = self
            .servers
            .get_mut(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        state.server_info = server_info;
        Ok(())
    }

    pub fn set_tools(
        &mut self,
        server_name: &str,
        tools: Vec<McpToolInfo>,
    ) -> Result<(), RuntimeError> {
        let state = self
            .servers
            .get_mut(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        state.tools = tools;
        Ok(())
    }

    pub fn set_resources(
        &mut self,
        server_name: &str,
        resources: Vec<McpResourceInfo>,
    ) -> Result<(), RuntimeError> {
        let state = self
            .servers
            .get_mut(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        state.resources = resources;
        Ok(())
    }

    pub fn set_error_message(
        &mut self,
        server_name: &str,
        error_message: Option<String>,
    ) -> Result<(), RuntimeError> {
        let state = self
            .servers
            .get_mut(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        state.error_message = error_message;
        Ok(())
    }

    pub fn list_resources(&self, server_name: &str) -> Result<Vec<McpResourceInfo>, RuntimeError> {
        let state = self
            .servers
            .get(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        if state.status != McpConnectionStatus::Connected {
            return Err(RuntimeError::new(format!(
                "server `{server_name}` is not connected (status: {})",
                state.status
            )));
        }
        Ok(state.resources.clone())
    }

    pub fn read_resource(
        &self,
        server_name: &str,
        uri: &str,
    ) -> Result<McpResourceInfo, RuntimeError> {
        let state = self
            .servers
            .get(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        if state.status != McpConnectionStatus::Connected {
            return Err(RuntimeError::new(format!(
                "server `{server_name}` is not connected (status: {})",
                state.status
            )));
        }
        state
            .resources
            .iter()
            .find(|resource| resource.uri == uri)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(format!(
                    "resource `{uri}` not found on MCP server `{server_name}`"
                ))
            })
    }

    pub fn list_tools(&self, server_name: &str) -> Result<Vec<McpToolInfo>, RuntimeError> {
        let state = self
            .servers
            .get(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))?;
        if state.status != McpConnectionStatus::Connected {
            return Err(RuntimeError::new(format!(
                "server `{server_name}` is not connected (status: {})",
                state.status
            )));
        }
        Ok(state.tools.clone())
    }
}

#[must_use]
pub fn normalize_name_for_mcp(name: &str) -> String {
    let mut normalized = name
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => ch,
            _ => '_',
        })
        .collect::<String>();

    if name.starts_with(CLAUDE_AI_PREFIX) {
        normalized = collapse_underscores(&normalized)
            .trim_matches('_')
            .to_string();
    }

    normalized
}

#[must_use]
pub fn mcp_tool_prefix(server_name: &str) -> String {
    format!("mcp__{}__", normalize_name_for_mcp(server_name))
}

#[must_use]
pub fn mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "{}{}",
        mcp_tool_prefix(server_name),
        normalize_name_for_mcp(tool_name)
    )
}

#[must_use]
pub fn scoped_mcp_config_hash(server_name: &str, config: &McpServerConfig) -> String {
    let rendered = match config {
        McpServerConfig::Stdio(stdio) => format!(
            "{server_name}|stdio|{}|{}|{}",
            stdio.command,
            stdio.args.join(" "),
            stdio
                .tool_call_timeout_ms
                .map_or_else(String::new, |value| value.to_string())
        ),
        McpServerConfig::Http(remote) | McpServerConfig::Sse(remote) => {
            format!("{server_name}|{}|{}", config.transport(), remote.url)
        }
        McpServerConfig::Ws(remote) => format!("{server_name}|ws|{}", remote.url),
        McpServerConfig::Sdk(sdk) => format!("{server_name}|sdk|{}", sdk.name),
    };
    stable_hex_hash(&rendered)
}

fn stable_hex_hash(value: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn collapse_underscores(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut last_was_underscore = false;
    for ch in value.chars() {
        if ch == '_' {
            if !last_was_underscore {
                collapsed.push(ch);
            }
            last_was_underscore = true;
        } else {
            collapsed.push(ch);
            last_was_underscore = false;
        }
    }
    collapsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_config_collection() {
        let mut servers = BTreeMap::new();
        servers.insert(
            "alpha".to_string(),
            McpServerConfig::Stdio(McpStdioServerConfig {
                command: "python".to_string(),
                args: vec!["server.py".to_string()],
                env: BTreeMap::new(),
                tool_call_timeout_ms: Some(5_000),
            }),
        );

        let config = McpConfigCollection { servers };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn rejects_empty_stdio_command() {
        let config = McpServerConfig::Stdio(McpStdioServerConfig {
            command: " ".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            tool_call_timeout_ms: None,
        });

        assert!(config.validate().is_err());
    }

    #[test]
    fn manager_tracks_server_state() {
        let mut servers = BTreeMap::new();
        servers.insert(
            "alpha".to_string(),
            McpServerConfig::Sdk(McpSdkServerConfig {
                name: "alpha-sdk".to_string(),
            }),
        );

        let mut manager = McpConnectionManager::from_config(&McpConfigCollection { servers });
        assert_eq!(
            manager.get_server("alpha").map(|state| state.status),
            Some(McpConnectionStatus::Disconnected)
        );

        manager
            .set_status("alpha", McpConnectionStatus::Connected)
            .unwrap();
        manager
            .set_tools(
                "alpha",
                vec![McpToolInfo {
                    name: "echo".to_string(),
                    description: Some("Echo text".to_string()),
                    input_schema: None,
                }],
            )
            .unwrap();
        assert_eq!(manager.list_tools("alpha").unwrap()[0].name, "echo");
    }

    #[test]
    fn tool_names_are_sanitized() {
        assert_eq!(
            mcp_tool_name("claude.ai alpha", "echo tool"),
            "mcp__claude_ai_alpha__echo_tool"
        );
    }
}
