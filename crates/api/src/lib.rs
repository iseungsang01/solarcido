//! Solarcido API crate — Solar/OpenAI-compatible provider client and streaming.

pub mod client;
pub mod error;
pub mod sse;
pub mod types;

pub use client::{
    build_chat_completion_request, flatten_tool_result_content, sanitize_tool_message_pairing,
    translate_message, SolarClient, SolarStream,
};
pub use error::ApiError;
pub use types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};

pub const DEFAULT_MODEL: &str = "solar-pro3-260323";
pub const DEFAULT_BASE_URL: &str = "https://api.upstage.ai/v1";
pub const API_KEY_ENV: &str = "UPSTAGE_API_KEY";
pub const BASE_URL_ENV: &str = "UPSTAGE_BASE_URL";

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
}

impl Default for ReasoningEffort {
    fn default() -> Self {
        Self::Medium
    }
}

impl ReasoningEffort {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    /// Parse a reasoning effort string. Returns `Err` with a descriptive
    /// message on invalid input.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            other => Err(format!(
                "invalid reasoning effort `{other}`; expected low, medium, or high"
            )),
        }
    }
}
