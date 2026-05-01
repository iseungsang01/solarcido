//! Deterministic Solar/OpenAI-compatible mock service for parity testing.
//!
//! Ported from `claw-rust/crates/mock-anthropic-service` adapted to the Solar
//! OpenAI-compatible wire format. Full scenario playback is deferred to Phase 8.
//!
//! ## Wire format
//!
//! The mock service speaks the OpenAI-compatible chat completions API:
//!
//! - `POST /v1/chat/completions` — returns a scripted completion response.
//! - Streaming is returned as `text/event-stream` SSE when `stream: true`.
//! - Errors are returned as `{"error": {"message": "...", "type": "...", "code": 400}}`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A scripted response for a single mock scenario.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MockScenario {
    pub name: String,
    pub response: MockResponse,
}

/// Response variant the mock service returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MockResponse {
    /// Plain text completion with optional tool calls.
    Completion {
        content: Option<String>,
        #[serde(default)]
        tool_calls: Vec<MockToolCall>,
        #[serde(default)]
        usage: MockUsage,
    },
    /// Streaming completion (SSE chunks).
    Streaming {
        chunks: Vec<String>,
        #[serde(default)]
        usage: MockUsage,
    },
    /// Provider error response.
    Error {
        status: u16,
        message: String,
        error_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MockToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MockUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Build an OpenAI-compatible chat completion JSON body from a `MockResponse`.
#[must_use]
pub fn build_completion_body(scenario: &MockScenario) -> Value {
    match &scenario.response {
        MockResponse::Completion {
            content,
            tool_calls,
            usage,
        } => {
            let message = if tool_calls.is_empty() {
                json!({
                    "role": "assistant",
                    "content": content
                })
            } else {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": tc.arguments
                            }
                        })
                    })
                    .collect();
                json!({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": calls
                })
            };
            json!({
                "id": format!("chatcmpl-mock-{}", scenario.name),
                "object": "chat.completion",
                "model": "solar-pro3-260323",
                "choices": [{
                    "index": 0,
                    "message": message,
                    "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" }
                }],
                "usage": {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens
                }
            })
        }
        MockResponse::Error {
            status,
            message,
            error_type,
        } => {
            json!({
                "error": {
                    "message": message,
                    "type": error_type,
                    "code": status
                }
            })
        }
        MockResponse::Streaming { chunks, usage } => {
            // For non-streaming callers, concatenate chunks into a single response.
            let full = chunks.join("");
            json!({
                "id": format!("chatcmpl-mock-{}", scenario.name),
                "object": "chat.completion",
                "model": "solar-pro3-260323",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": full },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens
                }
            })
        }
    }
}

/// Build SSE streaming chunks for a `MockResponse::Streaming` scenario.
#[must_use]
pub fn build_sse_chunks(scenario: &MockScenario) -> Vec<String> {
    let MockResponse::Streaming { chunks, usage } = &scenario.response else {
        return Vec::new();
    };
    let id = format!("chatcmpl-mock-{}", scenario.name);
    let mut events = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let delta = if i == 0 {
            json!({ "role": "assistant", "content": chunk })
        } else {
            json!({ "content": chunk })
        };
        let data = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "model": "solar-pro3-260323",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": serde_json::Value::Null
            }]
        });
        events.push(format!("data: {}\n\n", serde_json::to_string(&data).unwrap()));
    }
    // Final usage chunk.
    let final_data = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "model": "solar-pro3-260323",
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens
        }
    });
    events.push(format!("data: {}\n\n", serde_json::to_string(&final_data).unwrap()));
    events.push("data: [DONE]\n\n".to_string());
    events
}

/// Built-in named scenarios used by the parity harness.
#[must_use]
pub fn builtin_scenarios() -> Vec<MockScenario> {
    vec![
        MockScenario {
            name: "streaming_text".to_string(),
            response: MockResponse::Streaming {
                chunks: vec!["Hello, ".to_string(), "world!".to_string()],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                },
            },
        },
        MockScenario {
            name: "read_file_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "call_read_1".to_string(),
                    name: "read_file".to_string(),
                    arguments: r#"{"path":"src/lib.rs"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 20,
                    completion_tokens: 10,
                    total_tokens: 30,
                },
            },
        },
        MockScenario {
            name: "write_file_allowed".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "call_write_1".to_string(),
                    name: "write_file".to_string(),
                    arguments: r#"{"path":"out.txt","content":"hello"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 15,
                    completion_tokens: 8,
                    total_tokens: 23,
                },
            },
        },
        MockScenario {
            name: "bash_stdout_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "call_bash_1".to_string(),
                    name: "bash".to_string(),
                    arguments: r#"{"command":"echo hello"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 12,
                    completion_tokens: 6,
                    total_tokens: 18,
                },
            },
        },
    ]
}
