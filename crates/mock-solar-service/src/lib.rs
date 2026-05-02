//! Deterministic Solar/OpenAI-compatible mock service for parity testing.
//!
//! The service listens on an ephemeral local port, captures inbound chat
//! completion requests, and returns scripted responses for a fixed set of
//! scenario names embedded in the prompt text.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use solarcido_api::DEFAULT_MODEL;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub const SCENARIO_PREFIX: &str = "PARITY_SCENARIO:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub scenario: String,
    pub stream: bool,
    pub raw_body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MockScenario {
    pub name: String,
    pub response: MockResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MockResponse {
    Completion {
        content: Option<String>,
        #[serde(default)]
        tool_calls: Vec<MockToolCall>,
        #[serde(default)]
        usage: MockUsage,
    },
    Streaming {
        chunks: Vec<String>,
        #[serde(default)]
        usage: MockUsage,
    },
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

pub struct MockSolarService {
    base_url: String,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
}

impl MockSolarService {
    pub async fn spawn() -> io::Result<Self> {
        Self::spawn_on("127.0.0.1:0").await
    }

    pub async fn spawn_on(bind_addr: &str) -> io::Result<Self> {
        let listener = TcpListener::bind(bind_addr).await?;
        let address = listener.local_addr()?;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let request_state = Arc::clone(&requests);

        let join_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else {
                            break;
                        };
                        let request_state = Arc::clone(&request_state);
                        tokio::spawn(async move {
                            let _ = handle_connection(socket, request_state).await;
                        });
                    }
                }
            }
        });

        Ok(Self {
            base_url: format!("http://{address}/v1"),
            requests,
            shutdown: Some(shutdown_tx),
            join_handle,
        })
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    pub async fn captured_requests(&self) -> Vec<CapturedRequest> {
        self.requests.lock().await.clone()
    }
}

impl Drop for MockSolarService {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join_handle.abort();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    StreamingText,
    ReadFileRoundtrip,
    GrepChunkAssembly,
    WriteFileAllowed,
    WriteFileDenied,
    MultiToolTurnRoundtrip,
    BashStdoutRoundtrip,
    BashPermissionPromptApproved,
    BashPermissionPromptDenied,
    PluginToolRoundtrip,
    AutoCompactTriggered,
    TokenCostReporting,
}

impl Scenario {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "streaming_text" => Some(Self::StreamingText),
            "read_file_roundtrip" => Some(Self::ReadFileRoundtrip),
            "grep_chunk_assembly" => Some(Self::GrepChunkAssembly),
            "write_file_allowed" => Some(Self::WriteFileAllowed),
            "write_file_denied" => Some(Self::WriteFileDenied),
            "multi_tool_turn_roundtrip" => Some(Self::MultiToolTurnRoundtrip),
            "bash_stdout_roundtrip" => Some(Self::BashStdoutRoundtrip),
            "bash_permission_prompt_approved" => Some(Self::BashPermissionPromptApproved),
            "bash_permission_prompt_denied" => Some(Self::BashPermissionPromptDenied),
            "plugin_tool_roundtrip" => Some(Self::PluginToolRoundtrip),
            "auto_compact_triggered" => Some(Self::AutoCompactTriggered),
            "token_cost_reporting" => Some(Self::TokenCostReporting),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::StreamingText => "streaming_text",
            Self::ReadFileRoundtrip => "read_file_roundtrip",
            Self::GrepChunkAssembly => "grep_chunk_assembly",
            Self::WriteFileAllowed => "write_file_allowed",
            Self::WriteFileDenied => "write_file_denied",
            Self::MultiToolTurnRoundtrip => "multi_tool_turn_roundtrip",
            Self::BashStdoutRoundtrip => "bash_stdout_roundtrip",
            Self::BashPermissionPromptApproved => "bash_permission_prompt_approved",
            Self::BashPermissionPromptDenied => "bash_permission_prompt_denied",
            Self::PluginToolRoundtrip => "plugin_tool_roundtrip",
            Self::AutoCompactTriggered => "auto_compact_triggered",
            Self::TokenCostReporting => "token_cost_reporting",
        }
    }
}

async fn handle_connection(
    mut socket: tokio::net::TcpStream,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
) -> io::Result<()> {
    let (method, path, headers, raw_body) = read_http_request(&mut socket).await?;
    let request: Value = serde_json::from_str(&raw_body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let scenario = detect_scenario(&request)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parity scenario"))?;

    requests.lock().await.push(CapturedRequest {
        method,
        path,
        headers,
        scenario: scenario.name().to_string(),
        stream: request_stream(&request),
        raw_body,
    });

    let response = build_http_response(&request, scenario);
    socket.write_all(response.as_bytes()).await?;
    Ok(())
}

async fn read_http_request(
    socket: &mut tokio::net::TcpStream,
) -> io::Result<(String, String, HashMap<String, String>, String)> {
    let mut buffer = Vec::new();
    let mut header_end = None;

    loop {
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_header_end(&buffer) {
            header_end = Some(position);
            break;
        }
    }

    let header_end = header_end
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "missing http headers"))?;
    let (header_bytes, remaining) = buffer.split_at(header_end);
    let header_text = String::from_utf8(header_bytes.to_vec())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?
        .to_string();

    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "malformed http header line")
        })?;
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid content-length: {error}"),
                )
            })?;
        }
        headers.insert(name.to_ascii_lowercase(), value);
    }

    let mut body = if remaining.len() >= 4 {
        remaining[4..].to_vec()
    } else {
        Vec::new()
    };
    while body.len() < content_length {
        let mut chunk = vec![0_u8; content_length - body.len()];
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    let body = String::from_utf8(body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    Ok((method, path, headers, body))
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn request_stream(request: &Value) -> bool {
    request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn detect_scenario(request: &Value) -> Option<Scenario> {
    request_messages(request)?.iter().rev().find_map(|message| {
        message_content_text(message).and_then(|text| {
            text.split_whitespace()
                .find_map(|token| token.strip_prefix(SCENARIO_PREFIX))
                .and_then(Scenario::parse)
        })
    })
}

fn latest_tool_result(request: &Value) -> Option<(String, bool)> {
    request_messages(request)?.iter().rev().find_map(|message| {
        let role = message.get("role").and_then(Value::as_str)?;
        if role != "tool" {
            return None;
        }
        let text = message_content_text(message)?;
        let is_error = text.starts_with("ERROR:");
        Some((text.to_string(), is_error))
    })
}

fn tool_results_by_name(request: &Value) -> HashMap<String, (String, bool)> {
    let mut tool_names_by_id = HashMap::new();
    for message in request_messages(request).unwrap_or(&[]) {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(id) = tool_call.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(name) = tool_call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            tool_names_by_id.insert(id.to_string(), name.to_string());
        }
    }

    let mut results = HashMap::new();
    for message in request_messages(request).unwrap_or(&[]).iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        let Some(tool_call_id) = message.get("tool_call_id").and_then(Value::as_str) else {
            continue;
        };
        let tool_name = tool_names_by_id
            .get(tool_call_id)
            .cloned()
            .unwrap_or_else(|| tool_call_id.to_string());
        let Some(text) = message_content_text(message) else {
            continue;
        };
        let is_error = text.starts_with("ERROR:");
        results.entry(tool_name).or_insert_with(|| (text.to_string(), is_error));
    }
    results
}

fn request_messages(request: &Value) -> Option<&[Value]> {
    request.get("messages")?.as_array().map(Vec::as_slice)
}

fn message_content_text(message: &Value) -> Option<&str> {
    match message.get("content")? {
        Value::String(text) => Some(text.as_str()),
        Value::Array(items) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

fn build_http_response(request: &Value, scenario: Scenario) -> String {
    if request_stream(request) {
        let body = build_stream_body(request, scenario);
        return http_response(
            "200 OK",
            "text/event-stream",
            &body,
            &[("x-request-id", request_id_for(scenario))],
        );
    }

    let response = build_message_response(request, scenario);
    http_response(
        "200 OK",
        "application/json",
        &serde_json::to_string(&response).expect("message response should serialize"),
        &[("request-id", request_id_for(scenario))],
    )
}

#[allow(clippy::too_many_lines)]
fn build_stream_body(request: &Value, scenario: Scenario) -> String {
    match scenario {
        Scenario::StreamingText => streaming_text_sse(),
        Scenario::ReadFileRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => final_text_sse(&format!(
                "read_file roundtrip complete: {}",
                extract_read_content(&tool_output)
            )),
            None => tool_use_sse(
                "toolu_read_fixture",
                "read_file",
                &[r#"{"path":"fixture.txt"}"#],
            ),
        },
        Scenario::GrepChunkAssembly => match latest_tool_result(request) {
            Some((tool_output, _)) => final_text_sse(&format!(
                "grep_search matched {} occurrences",
                extract_num_matches(&tool_output)
            )),
            None => tool_use_sse(
                "toolu_grep_fixture",
                "grep_search",
                &[
                    "{\"pattern\":\"par",
                    "ity\",\"path\":\"fixture.txt\"",
                    ",\"output_mode\":\"count\"}",
                ],
            ),
        },
        Scenario::WriteFileAllowed => match latest_tool_result(request) {
            Some((tool_output, _)) => final_text_sse(&format!(
                "write_file succeeded: {}",
                extract_file_path(&tool_output)
            )),
            None => tool_use_sse(
                "toolu_write_allowed",
                "write_file",
                &[r#"{"path":"generated/output.txt","content":"created by mock service\n"}"#],
            ),
        },
        Scenario::WriteFileDenied => match latest_tool_result(request) {
            Some((tool_output, _)) => {
                final_text_sse(&format!("write_file denied as expected: {tool_output}"))
            }
            None => tool_use_sse(
                "toolu_write_denied",
                "write_file",
                &[r#"{"path":"generated/denied.txt","content":"should not exist\n"}"#],
            ),
        },
        Scenario::MultiToolTurnRoundtrip => {
            let tool_results = tool_results_by_name(request);
            match (
                tool_results.get("read_file"),
                tool_results.get("grep_search"),
            ) {
                (Some((read_output, _)), Some((grep_output, _))) => final_text_sse(&format!(
                    "multi-tool roundtrip complete: {} / {} occurrences",
                    extract_read_content(read_output),
                    extract_num_matches(grep_output)
                )),
                _ => tool_uses_sse(&[
                    ToolUseSse {
                        tool_id: "toolu_multi_read",
                        tool_name: "read_file",
                        partial_json_chunks: &[r#"{"path":"fixture.txt"}"#],
                    },
                    ToolUseSse {
                        tool_id: "toolu_multi_grep",
                        tool_name: "grep_search",
                        partial_json_chunks: &[
                            "{\"pattern\":\"par",
                            "ity\",\"path\":\"fixture.txt\"",
                            ",\"output_mode\":\"count\"}",
                        ],
                    },
                ]),
            }
        }
        Scenario::BashStdoutRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => final_text_sse(&format!(
                "bash completed: {}",
                extract_bash_stdout(&tool_output)
            )),
            None => tool_use_sse(
                "toolu_bash_stdout",
                "bash",
                &[r#"{"command":"Write-Output 'alpha from bash'","timeout":1000}"#],
            ),
        },
        Scenario::BashPermissionPromptApproved => match latest_tool_result(request) {
            Some((tool_output, is_error)) => {
                if is_error {
                    final_text_sse(&format!("bash approval unexpectedly failed: {tool_output}"))
                } else {
                    final_text_sse(&format!(
                        "bash approved and executed: {}",
                        extract_bash_stdout(&tool_output)
                    ))
                }
            }
            None => tool_use_sse(
                "toolu_bash_prompt_allow",
                "bash",
                &[r#"{"command":"Write-Output 'approved via prompt'","timeout":1000}"#],
            ),
        },
        Scenario::BashPermissionPromptDenied => match latest_tool_result(request) {
            Some((tool_output, _)) => {
                final_text_sse(&format!("bash denied as expected: {tool_output}"))
            }
            None => tool_use_sse(
                "toolu_bash_prompt_deny",
                "bash",
                &[r#"{"command":"Write-Output 'should not run'","timeout":1000}"#],
            ),
        },
        Scenario::PluginToolRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => final_text_sse(&format!(
                "plugin tool completed: {}",
                extract_plugin_message(&tool_output)
            )),
            None => tool_use_sse(
                "toolu_plugin_echo",
                "plugin_echo",
                &[r#"{"message":"hello from plugin parity"}"#],
            ),
        },
        Scenario::AutoCompactTriggered => {
            final_text_sse_with_usage("auto compact parity complete.", 50_000, 200)
        }
        Scenario::TokenCostReporting => {
            final_text_sse_with_usage("token cost reporting parity complete.", 1_000, 500)
        }
    }
}

fn build_message_response(request: &Value, scenario: Scenario) -> Value {
    match scenario {
        Scenario::StreamingText => completion_text_response(
            "msg_streaming_text",
            "Mock streaming says hello from the parity harness.",
        ),
        Scenario::ReadFileRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_read_file_final",
                &format!(
                    "read_file roundtrip complete: {}",
                    extract_read_content(&tool_output)
                ),
            ),
            None => completion_tool_response(
                "msg_read_file_tool",
                "toolu_read_fixture",
                "read_file",
                json!({"path": "fixture.txt"}),
            ),
        },
        Scenario::GrepChunkAssembly => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_grep_final",
                &format!(
                    "grep_search matched {} occurrences",
                    extract_num_matches(&tool_output)
                ),
            ),
            None => completion_tool_response(
                "msg_grep_tool",
                "toolu_grep_fixture",
                "grep_search",
                json!({"pattern": "parity", "path": "fixture.txt", "output_mode": "count"}),
            ),
        },
        Scenario::WriteFileAllowed => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_write_allowed_final",
                &format!("write_file succeeded: {}", extract_file_path(&tool_output)),
            ),
            None => completion_tool_response(
                "msg_write_allowed_tool",
                "toolu_write_allowed",
                "write_file",
                json!({"path": "generated/output.txt", "content": "created by mock service\n"}),
            ),
        },
        Scenario::WriteFileDenied => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_write_denied_final",
                &format!("write_file denied as expected: {tool_output}"),
            ),
            None => completion_tool_response(
                "msg_write_denied_tool",
                "toolu_write_denied",
                "write_file",
                json!({"path": "generated/denied.txt", "content": "should not exist\n"}),
            ),
        },
        Scenario::MultiToolTurnRoundtrip => {
            let tool_results = tool_results_by_name(request);
            match (
                tool_results.get("read_file"),
                tool_results.get("grep_search"),
            ) {
                (Some((read_output, _)), Some((grep_output, _))) => completion_text_response(
                    "msg_multi_tool_final",
                    &format!(
                        "multi-tool roundtrip complete: {} / {} occurrences",
                        extract_read_content(read_output),
                        extract_num_matches(grep_output)
                    ),
                ),
                _ => completion_tool_response_many(
                    "msg_multi_tool_start",
                    &[
                        ToolUseMessage {
                            tool_id: "toolu_multi_read",
                            tool_name: "read_file",
                            input: json!({"path": "fixture.txt"}),
                        },
                        ToolUseMessage {
                            tool_id: "toolu_multi_grep",
                            tool_name: "grep_search",
                            input: json!({"pattern": "parity", "path": "fixture.txt", "output_mode": "count"}),
                        },
                    ],
                ),
            }
        }
        Scenario::BashStdoutRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_bash_stdout_final",
                &format!("bash completed: {}", extract_bash_stdout(&tool_output)),
            ),
            None => completion_tool_response(
                "msg_bash_stdout_tool",
                "toolu_bash_stdout",
                "bash",
                json!({"command": "Write-Output 'alpha from bash'", "timeout": 1000}),
            ),
        },
        Scenario::BashPermissionPromptApproved => match latest_tool_result(request) {
            Some((tool_output, is_error)) => {
                if is_error {
                    completion_text_response(
                        "msg_bash_prompt_allow_error",
                        &format!("bash approval unexpectedly failed: {tool_output}"),
                    )
                } else {
                    completion_text_response(
                        "msg_bash_prompt_allow_final",
                        &format!(
                            "bash approved and executed: {}",
                            extract_bash_stdout(&tool_output)
                        ),
                    )
                }
            }
            None => completion_tool_response(
                "msg_bash_prompt_allow_tool",
                "toolu_bash_prompt_allow",
                "bash",
                json!({"command": "Write-Output 'approved via prompt'", "timeout": 1000}),
            ),
        },
        Scenario::BashPermissionPromptDenied => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_bash_prompt_deny_final",
                &format!("bash denied as expected: {tool_output}"),
            ),
            None => completion_tool_response(
                "msg_bash_prompt_deny_tool",
                "toolu_bash_prompt_deny",
                "bash",
                json!({"command": "Write-Output 'should not run'", "timeout": 1000}),
            ),
        },
        Scenario::PluginToolRoundtrip => match latest_tool_result(request) {
            Some((tool_output, _)) => completion_text_response(
                "msg_plugin_tool_final",
                &format!(
                    "plugin tool completed: {}",
                    extract_plugin_message(&tool_output)
                ),
            ),
            None => completion_tool_response(
                "msg_plugin_tool_start",
                "toolu_plugin_echo",
                "plugin_echo",
                json!({"message": "hello from plugin parity"}),
            ),
        },
        Scenario::AutoCompactTriggered => completion_text_response_with_usage(
            "msg_auto_compact_triggered",
            "auto compact parity complete.",
            50_000,
            200,
        ),
        Scenario::TokenCostReporting => completion_text_response_with_usage(
            "msg_token_cost_reporting",
            "token cost reporting parity complete.",
            1_000,
            500,
        ),
    }
}

fn request_id_for(scenario: Scenario) -> &'static str {
    match scenario {
        Scenario::StreamingText => "req_streaming_text",
        Scenario::ReadFileRoundtrip => "req_read_file_roundtrip",
        Scenario::GrepChunkAssembly => "req_grep_chunk_assembly",
        Scenario::WriteFileAllowed => "req_write_file_allowed",
        Scenario::WriteFileDenied => "req_write_file_denied",
        Scenario::MultiToolTurnRoundtrip => "req_multi_tool_turn_roundtrip",
        Scenario::BashStdoutRoundtrip => "req_bash_stdout_roundtrip",
        Scenario::BashPermissionPromptApproved => "req_bash_permission_prompt_approved",
        Scenario::BashPermissionPromptDenied => "req_bash_permission_prompt_denied",
        Scenario::PluginToolRoundtrip => "req_plugin_tool_roundtrip",
        Scenario::AutoCompactTriggered => "req_auto_compact_triggered",
        Scenario::TokenCostReporting => "req_token_cost_reporting",
    }
}

fn http_response(status: &str, content_type: &str, body: &str, headers: &[(&str, &str)]) -> String {
    let mut extra_headers = String::new();
    for (name, value) in headers {
        use std::fmt::Write as _;
        write!(&mut extra_headers, "{name}: {value}\r\n").expect("header write should succeed");
    }
    format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\n{extra_headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn completion_text_response(id: &str, text: &str) -> Value {
    completion_response(
        id,
        vec![json!({"role": "assistant", "content": text})],
        "stop",
        10,
        6,
    )
}

fn completion_text_response_with_usage(
    id: &str,
    text: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
) -> Value {
    completion_response(
        id,
        vec![json!({"role": "assistant", "content": text})],
        "stop",
        prompt_tokens,
        completion_tokens,
    )
}

fn completion_tool_response(id: &str, tool_id: &str, tool_name: &str, input: Value) -> Value {
    completion_tool_response_many(
        id,
        &[ToolUseMessage {
            tool_id,
            tool_name,
            input,
        }],
    )
}

struct ToolUseMessage<'a> {
    tool_id: &'a str,
    tool_name: &'a str,
    input: Value,
}

fn completion_tool_response_many(id: &str, tool_uses: &[ToolUseMessage<'_>]) -> Value {
    completion_response(
        id,
        vec![json!({
            "role": "assistant",
            "content": Value::Null,
            "tool_calls": tool_uses.iter().map(|tool_use| {
                json!({
                    "id": tool_use.tool_id,
                    "type": "function",
                    "function": {
                        "name": tool_use.tool_name,
                        "arguments": tool_use.input.to_string(),
                    }
                })
            }).collect::<Vec<_>>()
        })],
        "tool_calls",
        10,
        3,
    )
}

fn completion_response(
    id: &str,
    choices: Vec<Value>,
    finish_reason: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
) -> Value {
    json!({
        "id": id,
        "object": "chat.completion",
        "model": DEFAULT_MODEL,
        "choices": choices
            .into_iter()
            .enumerate()
            .map(|(index, message)| json!({
                "index": index,
                "message": message,
                "finish_reason": finish_reason,
            }))
            .collect::<Vec<_>>(),
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens
        }
    })
}

fn streaming_text_sse() -> String {
    let mut body = String::new();
    append_sse(
        &mut body,
        json!({
            "id": "msg_streaming_text",
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "Mock streaming "},
                "finish_reason": Value::Null
            }]
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": "msg_streaming_text",
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"content": "says hello from the parity harness."},
                "finish_reason": Value::Null
            }]
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": "msg_streaming_text",
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 8,
                "total_tokens": 19
            }
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn tool_use_sse(tool_id: &str, tool_name: &str, partial_json_chunks: &[&str]) -> String {
    tool_uses_sse(&[ToolUseSse {
        tool_id,
        tool_name,
        partial_json_chunks,
    }])
}

struct ToolUseSse<'a> {
    tool_id: &'a str,
    tool_name: &'a str,
    partial_json_chunks: &'a [&'a str],
}

fn tool_uses_sse(tool_uses: &[ToolUseSse<'_>]) -> String {
    let mut body = String::new();
    let message_id = tool_uses
        .first()
        .map_or_else(|| "msg_tool_use".to_string(), |tool_use| format!("msg_{}", tool_use.tool_id));
    append_sse(
        &mut body,
        json!({
            "id": message_id,
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant"},
                "finish_reason": Value::Null
            }]
        }),
    );
    for (index, tool_use) in tool_uses.iter().enumerate() {
        append_sse(
            &mut body,
            json!({
                "id": message_id,
                "object": "chat.completion.chunk",
                "model": DEFAULT_MODEL,
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": index,
                            "id": tool_use.tool_id,
                            "type": "function",
                            "function": {
                                "name": tool_use.tool_name,
                                "arguments": ""
                            }
                        }]
                    },
                    "finish_reason": Value::Null
                }]
            }),
        );
        for chunk in tool_use.partial_json_chunks {
            append_sse(
                &mut body,
                json!({
                    "id": message_id,
                    "object": "chat.completion.chunk",
                    "model": DEFAULT_MODEL,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": index,
                                "function": {
                                    "arguments": chunk
                                }
                            }]
                        },
                        "finish_reason": Value::Null
                    }]
                }),
            );
        }
    }
    append_sse(
        &mut body,
        json!({
            "id": message_id,
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 4,
                "total_tokens": 16
            }
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn final_text_sse(text: &str) -> String {
    let mut body = String::new();
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant"},
                "finish_reason": Value::Null
            }]
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"content": text},
                "finish_reason": Value::Null
            }]
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 14,
                "completion_tokens": 7,
                "total_tokens": 21
            }
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn final_text_sse_with_usage(text: &str, prompt_tokens: u32, completion_tokens: u32) -> String {
    let mut body = String::new();
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant"},
                "finish_reason": Value::Null
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": 0,
                "total_tokens": prompt_tokens
            }
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {"content": text},
                "finish_reason": Value::Null
            }]
        }),
    );
    append_sse(
        &mut body,
        json!({
            "id": unique_message_id(),
            "object": "chat.completion.chunk",
            "model": DEFAULT_MODEL,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens
            }
        }),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn append_sse(buffer: &mut String, payload: Value) {
    use std::fmt::Write as _;

    writeln!(buffer, "data: {}", payload).expect("payload write should succeed");
    buffer.push('\n');
}

fn extract_read_content(tool_output: &str) -> String {
    serde_json::from_str::<Value>(tool_output)
        .ok()
        .and_then(|value| {
            value
                .get("file")
                .and_then(|file| file.get("content"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| tool_output.trim().to_string())
}

fn extract_num_matches(tool_output: &str) -> usize {
    serde_json::from_str::<Value>(tool_output)
        .ok()
        .and_then(|value| value.get("numMatches").and_then(Value::as_u64))
        .unwrap_or(0) as usize
}

fn extract_file_path(tool_output: &str) -> String {
    serde_json::from_str::<Value>(tool_output)
        .ok()
        .and_then(|value| {
            value
                .get("filePath")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| tool_output.trim().to_string())
}

fn extract_bash_stdout(tool_output: &str) -> String {
    serde_json::from_str::<Value>(tool_output)
        .ok()
        .and_then(|value| {
            value
                .get("stdout")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| tool_output.trim().to_string())
}

fn extract_plugin_message(tool_output: &str) -> String {
    serde_json::from_str::<Value>(tool_output)
        .ok()
        .and_then(|value| {
            value
                .get("input")
                .and_then(|input| input.get("message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| tool_output.trim().to_string())
}

fn unique_message_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_nanos();
    format!("msg_{nanos}")
}

#[must_use]
pub fn builtin_scenarios() -> Vec<MockScenario> {
    vec![
        MockScenario {
            name: "streaming_text".to_string(),
            response: MockResponse::Streaming {
                chunks: vec!["Mock streaming ".to_string(), "says hello from the parity harness.".to_string()],
                usage: MockUsage {
                    prompt_tokens: 11,
                    completion_tokens: 8,
                    total_tokens: 19,
                },
            },
        },
        MockScenario {
            name: "read_file_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_read_fixture".to_string(),
                    name: "read_file".to_string(),
                    arguments: r#"{"path":"fixture.txt"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "grep_chunk_assembly".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_grep_fixture".to_string(),
                    name: "grep_search".to_string(),
                    arguments: r#"{"pattern":"parity","path":"fixture.txt","output_mode":"count"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "write_file_allowed".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_write_allowed".to_string(),
                    name: "write_file".to_string(),
                    arguments: r#"{"path":"generated/output.txt","content":"created by mock service\n"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "write_file_denied".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_write_denied".to_string(),
                    name: "write_file".to_string(),
                    arguments: r#"{"path":"generated/denied.txt","content":"should not exist\n"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "multi_tool_turn_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![
                    MockToolCall {
                        id: "toolu_multi_read".to_string(),
                        name: "read_file".to_string(),
                        arguments: r#"{"path":"fixture.txt"}"#.to_string(),
                    },
                    MockToolCall {
                        id: "toolu_multi_grep".to_string(),
                        name: "grep_search".to_string(),
                        arguments: r#"{"pattern":"parity","path":"fixture.txt","output_mode":"count"}"#.to_string(),
                    },
                ],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "bash_stdout_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_bash_stdout".to_string(),
                    name: "bash".to_string(),
                    arguments: r#"{"command":"Write-Output 'alpha from bash'","timeout":1000}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "bash_permission_prompt_approved".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_bash_prompt_allow".to_string(),
                    name: "bash".to_string(),
                    arguments: r#"{"command":"Write-Output 'approved via prompt'","timeout":1000}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "bash_permission_prompt_denied".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_bash_prompt_deny".to_string(),
                    name: "bash".to_string(),
                    arguments: r#"{"command":"Write-Output 'should not run'","timeout":1000}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "plugin_tool_roundtrip".to_string(),
            response: MockResponse::Completion {
                content: None,
                tool_calls: vec![MockToolCall {
                    id: "toolu_plugin_echo".to_string(),
                    name: "plugin_echo".to_string(),
                    arguments: r#"{"message":"hello from plugin parity"}"#.to_string(),
                }],
                usage: MockUsage {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                },
            },
        },
        MockScenario {
            name: "auto_compact_triggered".to_string(),
            response: MockResponse::Streaming {
                chunks: vec!["auto compact parity complete.".to_string()],
                usage: MockUsage {
                    prompt_tokens: 50_000,
                    completion_tokens: 200,
                    total_tokens: 50_200,
                },
            },
        },
        MockScenario {
            name: "token_cost_reporting".to_string(),
            response: MockResponse::Streaming {
                chunks: vec!["token cost reporting parity complete.".to_string()],
                usage: MockUsage {
                    prompt_tokens: 1_000,
                    completion_tokens: 500,
                    total_tokens: 1_500,
                },
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_scenarios() {
        assert_eq!(
            Scenario::parse("streaming_text"),
            Some(Scenario::StreamingText)
        );
        assert_eq!(
            Scenario::parse("read_file_roundtrip"),
            Some(Scenario::ReadFileRoundtrip)
        );
        assert!(Scenario::parse("unknown").is_none());
    }

    #[test]
    fn builds_builtin_scenarios() {
        let scenarios = builtin_scenarios();
        assert!(scenarios.iter().any(|scenario| scenario.name == "streaming_text"));
        assert!(scenarios.iter().any(|scenario| scenario.name == "plugin_tool_roundtrip"));
    }
}
