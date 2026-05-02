use serde::Serialize;

use crate::mcp::{
    McpConfigCollection, McpConnectionManager, McpResourceInfo, McpServerState, McpToolInfo,
};
use crate::RuntimeError;

#[derive(Debug, Clone)]
pub struct McpToolAdapter {
    manager: McpConnectionManager,
}

impl McpToolAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self {
            manager: McpConnectionManager::new(),
        }
    }

    #[must_use]
    pub fn from_config(config: &McpConfigCollection) -> Self {
        Self {
            manager: McpConnectionManager::from_config(config),
        }
    }

    #[must_use]
    pub fn manager(&self) -> &McpConnectionManager {
        &self.manager
    }

    pub fn manager_mut(&mut self) -> &mut McpConnectionManager {
        &mut self.manager
    }

    #[must_use]
    pub fn server_summaries(&self) -> Vec<McpServerSummary> {
        self.manager
            .list_servers()
            .into_iter()
            .map(|state| McpServerSummary::from(&state))
            .collect()
    }

    pub fn server_report(&self, server_name: &str) -> Result<McpServerState, RuntimeError> {
        self.manager
            .get_server(server_name)
            .ok_or_else(|| RuntimeError::new(format!("unknown MCP server `{server_name}`")))
    }

    pub fn list_resources(&self, server_name: &str) -> Result<Vec<McpResourceInfo>, RuntimeError> {
        self.manager.list_resources(server_name)
    }

    pub fn read_resource(
        &self,
        server_name: &str,
        uri: &str,
    ) -> Result<McpResourceInfo, RuntimeError> {
        self.manager.read_resource(server_name, uri)
    }

    pub fn list_tools(&self, server_name: &str) -> Result<Vec<McpToolInfo>, RuntimeError> {
        self.manager.list_tools(server_name)
    }
}

impl Default for McpToolAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpServerSummary {
    pub name: String,
    pub transport: String,
    pub summary: String,
    pub status: String,
}

impl From<&McpServerState> for McpServerSummary {
    fn from(value: &McpServerState) -> Self {
        Self {
            name: value.server_name.clone(),
            transport: value.config.transport().to_string(),
            summary: value.config.summary(),
            status: value.status.to_string(),
        }
    }
}

#[must_use]
pub fn mcp_server_summaries(adapter: &McpToolAdapter) -> Vec<McpServerSummary> {
    adapter.server_summaries()
}

#[must_use]
pub fn render_mcp_server_summary_text(adapter: &McpToolAdapter) -> String {
    let servers = mcp_server_summaries(adapter);
    if servers.is_empty() {
        return "No MCP servers configured.".to_string();
    }

    let mut out = String::from("Configured MCP servers:\n");
    for server in servers {
        out.push_str(&format!(
            "  {}  transport={}  status={}  {}\n",
            server.name, server.transport, server.status, server.summary
        ));
    }
    out.trim_end().to_string()
}

#[must_use]
pub fn render_mcp_server_summary_json(adapter: &McpToolAdapter) -> serde_json::Value {
    let servers = mcp_server_summaries(adapter);
    serde_json::json!({
        "count": servers.len(),
        "servers": servers,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::mcp::{McpConnectionStatus, McpSdkServerConfig, McpServerConfig};

    use super::{mcp_server_summaries, McpConfigCollection, McpToolAdapter};

    #[test]
    fn renders_summaries_from_config() {
        let config = McpConfigCollection {
            servers: BTreeMap::from([(
                "alpha".to_string(),
                McpServerConfig::Sdk(McpSdkServerConfig {
                    name: "alpha-sdk".to_string(),
                }),
            )]),
        };
        let adapter = McpToolAdapter::from_config(&config);
        let summaries = mcp_server_summaries(&adapter);
        assert_eq!(summaries[0].name, "alpha");
        assert_eq!(summaries[0].transport, "sdk");
    }

    #[test]
    fn renders_json_report() {
        let config = McpConfigCollection {
            servers: BTreeMap::from([(
                "alpha".to_string(),
                McpServerConfig::Sdk(McpSdkServerConfig {
                    name: "alpha-sdk".to_string(),
                }),
            )]),
        };
        let adapter = McpToolAdapter::from_config(&config);
        let value = super::render_mcp_server_summary_json(&adapter);
        assert_eq!(value["count"], 1);
    }

    #[test]
    fn summaries_include_status() {
        let config = McpConfigCollection {
            servers: BTreeMap::from([(
                "alpha".to_string(),
                McpServerConfig::Sdk(McpSdkServerConfig {
                    name: "alpha-sdk".to_string(),
                }),
            )]),
        };
        let mut adapter = McpToolAdapter::from_config(&config);
        adapter
            .manager_mut()
            .set_status("alpha", McpConnectionStatus::Connected)
            .unwrap();
        let summaries = adapter.server_summaries();
        assert_eq!(summaries[0].status, "connected");
        let report = super::render_mcp_server_summary_text(&adapter);
        assert!(report.contains("status=connected"));
    }
}
