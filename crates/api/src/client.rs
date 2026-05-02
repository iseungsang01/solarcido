use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{suggested_action_for_status, ApiError};
use crate::types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
use crate::{API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL};

const REQUEST_ID_HEADER: &str = "request-id";
const ALT_REQUEST_ID_HEADER: &str = "x-request-id";
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(128);
const DEFAULT_MAX_RETRIES: u32 = 8;
const MAX_REQUEST_BODY_BYTES: usize = 104_857_600; // 100 MB

static JITTER_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Solar API client using OpenAI-compatible chat completions.
#[derive(Debug, Clone)]
pub struct SolarClient {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    max_retries: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
}

impl SolarClient {
    pub fn from_env() -> Result<Self, ApiError> {
        let api_key = read_env_non_empty(API_KEY_ENV)?
            .ok_or_else(|| ApiError::missing_credentials("Upstage", &[API_KEY_ENV]))?;
        let base_url = std::env::var(BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        Ok(Self::new(api_key, base_url))
    }

    #[must_use]
    pub fn new(api_key: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            max_retries: DEFAULT_MAX_RETRIES,
            initial_backoff: DEFAULT_INITIAL_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
        }
    }

    #[must_use]
    pub fn with_retry_policy(
        mut self,
        max_retries: u32,
        initial_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        self.max_retries = max_retries;
        self.initial_backoff = initial_backoff;
        self.max_backoff = max_backoff;
        self
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn send_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageResponse, ApiError> {
        let request = MessageRequest {
            stream: false,
            ..request.clone()
        };
        let response = self.send_with_retry(&request).await?;
        let request_id = request_id_from_headers(response.headers());
        let body = response.text().await.map_err(ApiError::from)?;

        // Check for error envelope before full deserialization.
        if let Ok(raw) = serde_json::from_str::<Value>(&body) {
            if let Some(err_obj) = raw.get("error") {
                let msg = err_obj
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("provider returned an error")
                    .to_string();
                let code = err_obj
                    .get("code")
                    .and_then(Value::as_u64)
                    .map(|c| c as u16);
                let status = reqwest::StatusCode::from_u16(code.unwrap_or(400))
                    .unwrap_or(reqwest::StatusCode::BAD_REQUEST);
                return Err(ApiError::Api {
                    status,
                    error_type: err_obj
                        .get("type")
                        .and_then(|t| t.as_str())
                        .map(str::to_owned),
                    message: Some(msg),
                    request_id,
                    body,
                    retryable: false,
                    suggested_action: suggested_action_for_status(status),
                });
            }
        }

        let payload = serde_json::from_str::<ChatCompletionResponse>(&body)
            .map_err(|e| ApiError::json_deserialize("Upstage", &request.model, &body, e))?;
        let mut normalized = normalize_response(&request.model, payload)?;
        if normalized.request_id.is_none() {
            normalized.request_id = request_id;
        }
        Ok(normalized)
    }

    pub async fn stream_message(&self, request: &MessageRequest) -> Result<SolarStream, ApiError> {
        let response = self
            .send_with_retry(&request.clone().with_streaming())
            .await?;
        Ok(SolarStream {
            request_id: request_id_from_headers(response.headers()),
            response,
            parser: OpenAiSseParser::new(&request.model),
            pending: VecDeque::new(),
            done: false,
            state: StreamState::new(request.model.clone()),
        })
    }

    async fn send_with_retry(
        &self,
        request: &MessageRequest,
    ) -> Result<reqwest::Response, ApiError> {
        let mut attempts = 0;
        let last_error = loop {
            attempts += 1;
            let retryable_error = match self.send_raw(request).await {
                Ok(response) => match expect_success(response).await {
                    Ok(response) => return Ok(response),
                    Err(e) if e.is_retryable() && attempts <= self.max_retries + 1 => e,
                    Err(e) => return Err(e),
                },
                Err(e) if e.is_retryable() && attempts <= self.max_retries + 1 => e,
                Err(e) => return Err(e),
            };
            if attempts > self.max_retries {
                break retryable_error;
            }
            tokio::time::sleep(self.jittered_backoff(attempts)?).await;
        };
        Err(ApiError::RetriesExhausted {
            attempts,
            last_error: Box::new(last_error),
        })
    }

    async fn send_raw(&self, request: &MessageRequest) -> Result<reqwest::Response, ApiError> {
        check_request_body_size(request)?;
        let url = chat_completions_endpoint(&self.base_url);
        self.http
            .post(&url)
            .header("content-type", "application/json")
            .bearer_auth(&self.api_key)
            .json(&build_chat_completion_request(request))
            .send()
            .await
            .map_err(ApiError::from)
    }

    fn backoff(&self, attempt: u32) -> Result<Duration, ApiError> {
        let Some(multiplier) = 1_u32.checked_shl(attempt.saturating_sub(1)) else {
            return Err(ApiError::BackoffOverflow {
                attempt,
                base_delay: self.initial_backoff,
            });
        };
        Ok(self
            .initial_backoff
            .checked_mul(multiplier)
            .map_or(self.max_backoff, |d| d.min(self.max_backoff)))
    }

    fn jittered_backoff(&self, attempt: u32) -> Result<Duration, ApiError> {
        let base = self.backoff(attempt)?;
        Ok(base + jitter_for_base(base))
    }
}

fn jitter_for_base(base: Duration) -> Duration {
    let base_nanos = u64::try_from(base.as_nanos()).unwrap_or(u64::MAX);
    if base_nanos == 0 {
        return Duration::ZERO;
    }
    let raw = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|e| u64::try_from(e.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let tick = JITTER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut mixed = raw.wrapping_add(tick).wrapping_add(0x9E37_79B9_7F4A_7C15);
    mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    mixed ^= mixed >> 31;
    Duration::from_nanos(mixed % base_nanos.saturating_add(1))
}

// --- Streaming ---

/// Streaming response from Solar chat completions.
#[derive(Debug)]
pub struct SolarStream {
    request_id: Option<String>,
    response: reqwest::Response,
    parser: OpenAiSseParser,
    pending: VecDeque<StreamEvent>,
    done: bool,
    state: StreamState,
}

impl SolarStream {
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>, ApiError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.done {
                self.pending.extend(self.state.finish()?);
                if let Some(event) = self.pending.pop_front() {
                    return Ok(Some(event));
                }
                return Ok(None);
            }
            match self.response.chunk().await? {
                Some(chunk) => {
                    for parsed in self.parser.push(&chunk)? {
                        self.pending.extend(self.state.ingest_chunk(parsed)?);
                    }
                }
                None => {
                    self.done = true;
                }
            }
        }
    }
}

// --- OpenAI SSE parser ---

#[derive(Debug, Default)]
struct OpenAiSseParser {
    buffer: Vec<u8>,
    model: String,
}

impl OpenAiSseParser {
    fn new(model: &str) -> Self {
        Self {
            buffer: Vec::new(),
            model: model.to_string(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<ChatCompletionChunk>, ApiError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(frame) = next_sse_frame(&mut self.buffer) {
            if let Some(event) = parse_sse_frame(&frame, &self.model)? {
                events.push(event);
            }
        }
        Ok(events)
    }
}

// --- Stream state machine ---

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug)]
struct StreamState {
    model: String,
    message_started: bool,
    text_started: bool,
    text_finished: bool,
    finished: bool,
    stop_reason: Option<String>,
    usage: Option<Usage>,
    tool_calls: BTreeMap<u32, ToolCallState>,
}

impl StreamState {
    fn new(model: String) -> Self {
        Self {
            model,
            message_started: false,
            text_started: false,
            text_finished: false,
            finished: false,
            stop_reason: None,
            usage: None,
            tool_calls: BTreeMap::new(),
        }
    }

    fn ingest_chunk(&mut self, chunk: ChatCompletionChunk) -> Result<Vec<StreamEvent>, ApiError> {
        let mut events = Vec::new();

        if !self.message_started {
            self.message_started = true;
            events.push(StreamEvent::MessageStart(MessageStartEvent {
                message: MessageResponse {
                    id: chunk.id.clone(),
                    kind: "message".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: chunk.model.clone().unwrap_or_else(|| self.model.clone()),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Usage::default(),
                    request_id: None,
                },
            }));
        }

        if let Some(u) = chunk.usage {
            self.usage = Some(Usage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
            });
        }

        for choice in chunk.choices {
            if let Some(content) = choice.delta.content.filter(|v| !v.is_empty()) {
                if !self.text_started {
                    self.text_started = true;
                    events.push(StreamEvent::ContentBlockStart(ContentBlockStartEvent {
                        index: 0,
                        content_block: OutputContentBlock::Text {
                            text: String::new(),
                        },
                    }));
                }
                events.push(StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
                    index: 0,
                    delta: ContentBlockDelta::TextDelta { text: content },
                }));
            }

            for tc in choice.delta.tool_calls {
                let state = self.tool_calls.entry(tc.index).or_default();
                state.apply(tc);
                let idx = state.block_index();
                if !state.started {
                    if let Some(start) = state.start_event()? {
                        state.started = true;
                        events.push(StreamEvent::ContentBlockStart(start));
                    } else {
                        continue;
                    }
                }
                if let Some(delta) = state.delta_event() {
                    events.push(StreamEvent::ContentBlockDelta(delta));
                }
                if choice.finish_reason.as_deref() == Some("tool_calls") && !state.stopped {
                    state.stopped = true;
                    events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                        index: idx,
                    }));
                }
            }

            if let Some(reason) = choice.finish_reason {
                self.stop_reason = Some(normalize_finish_reason(&reason));
                if reason == "tool_calls" {
                    for s in self.tool_calls.values_mut() {
                        if s.started && !s.stopped {
                            s.stopped = true;
                            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                                index: s.block_index(),
                            }));
                        }
                    }
                }
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ApiError> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;
        let mut events = Vec::new();

        if self.text_started && !self.text_finished {
            self.text_finished = true;
            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                index: 0,
            }));
        }
        for s in self.tool_calls.values_mut() {
            if !s.started {
                if let Some(start) = s.start_event()? {
                    s.started = true;
                    events.push(StreamEvent::ContentBlockStart(start));
                    if let Some(delta) = s.delta_event() {
                        events.push(StreamEvent::ContentBlockDelta(delta));
                    }
                }
            }
            if s.started && !s.stopped {
                s.stopped = true;
                events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                    index: s.block_index(),
                }));
            }
        }

        if self.message_started {
            events.push(StreamEvent::MessageDelta(MessageDeltaEvent {
                delta: MessageDelta {
                    stop_reason: Some(
                        self.stop_reason
                            .clone()
                            .unwrap_or_else(|| "end_turn".to_string()),
                    ),
                    stop_sequence: None,
                },
                usage: self.usage.clone().unwrap_or_default(),
            }));
            events.push(StreamEvent::MessageStop(MessageStopEvent {}));
        }
        Ok(events)
    }
}

#[derive(Debug, Default)]
struct ToolCallState {
    openai_index: u32,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    emitted_len: usize,
    started: bool,
    stopped: bool,
}

impl ToolCallState {
    fn apply(&mut self, tc: DeltaToolCall) {
        self.openai_index = tc.index;
        if let Some(id) = tc.id {
            self.id = Some(id);
        }
        if let Some(name) = tc.function.name {
            self.name = Some(name);
        }
        if let Some(args) = tc.function.arguments {
            self.arguments.push_str(&args);
        }
    }

    const fn block_index(&self) -> u32 {
        self.openai_index + 1
    }

    #[allow(clippy::unnecessary_wraps)]
    fn start_event(&self) -> Result<Option<ContentBlockStartEvent>, ApiError> {
        let Some(name) = self.name.clone() else {
            return Ok(None);
        };
        let id = self
            .id
            .clone()
            .unwrap_or_else(|| format!("tool_call_{}", self.openai_index));
        Ok(Some(ContentBlockStartEvent {
            index: self.block_index(),
            content_block: OutputContentBlock::ToolUse {
                id,
                name,
                input: json!({}),
            },
        }))
    }

    fn delta_event(&mut self) -> Option<ContentBlockDeltaEvent> {
        if self.emitted_len >= self.arguments.len() {
            return None;
        }
        let delta = self.arguments[self.emitted_len..].to_string();
        self.emitted_len = self.arguments.len();
        Some(ContentBlockDeltaEvent {
            index: self.block_index(),
            delta: ContentBlockDelta::InputJsonDelta {
                partial_json: delta,
            },
        })
    }
}

// --- Internal deserialization types ---

fn deserialize_null_as_empty_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    id: String,
    model: String,
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMsg,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatMsg {
    role: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ResponseToolCall>,
}

#[derive(Debug, Deserialize)]
struct ResponseToolCall {
    id: String,
    function: ResponseToolFunction,
}

#[derive(Debug, Deserialize)]
struct ResponseToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_as_empty_vec")]
    tool_calls: Vec<DeltaToolCall>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: DeltaFunction,
}

#[derive(Debug, Default, Deserialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(rename = "type")]
    error_type: Option<String>,
    message: Option<String>,
}

// --- Public helpers ---

/// Build an OpenAI-compatible chat completion request payload.
#[must_use]
pub fn build_chat_completion_request(request: &MessageRequest) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.system.as_ref().filter(|v| !v.is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for message in &request.messages {
        messages.extend(translate_message(message));
    }
    messages = sanitize_tool_message_pairing(messages);

    let mut payload = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "messages": messages,
        "stream": request.stream,
    });

    if request.stream {
        payload["stream_options"] = json!({ "include_usage": true });
    }

    if let Some(tools) = &request.tools {
        payload["tools"] = Value::Array(tools.iter().map(openai_tool_definition).collect());
    }
    if let Some(tc) = &request.tool_choice {
        payload["tool_choice"] = openai_tool_choice(tc);
    }
    if let Some(t) = request.temperature {
        payload["temperature"] = json!(t);
    }
    if let Some(tp) = request.top_p {
        payload["top_p"] = json!(tp);
    }
    if let Some(fp) = request.frequency_penalty {
        payload["frequency_penalty"] = json!(fp);
    }
    if let Some(pp) = request.presence_penalty {
        payload["presence_penalty"] = json!(pp);
    }
    if let Some(stop) = &request.stop {
        if !stop.is_empty() {
            payload["stop"] = json!(stop);
        }
    }
    if let Some(effort) = &request.reasoning_effort {
        payload["reasoning_effort"] = json!(effort);
    }
    payload
}

/// Translate an `InputMessage` to OpenAI-compatible wire format.
#[must_use]
pub fn translate_message(message: &InputMessage) -> Vec<Value> {
    match message.role.as_str() {
        "assistant" => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for block in &message.content {
                match block {
                    InputContentBlock::Text { text: v } => text.push_str(v),
                    InputContentBlock::ToolUse { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() }
                    })),
                    InputContentBlock::ToolResult { .. } => {}
                }
            }
            if text.is_empty() && tool_calls.is_empty() {
                Vec::new()
            } else {
                let mut msg = json!({
                    "role": "assistant",
                    "content": (!text.is_empty()).then_some(text),
                });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                vec![msg]
            }
        }
        _ => message
            .content
            .iter()
            .filter_map(|block| match block {
                InputContentBlock::Text { text } => {
                    Some(json!({ "role": "user", "content": text }))
                }
                InputContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => Some(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": flatten_tool_result_content(content),
                })),
                InputContentBlock::ToolUse { .. } => None,
            })
            .collect(),
    }
}

/// Remove orphaned tool messages that have no matching assistant tool_calls.
#[must_use]
pub fn sanitize_tool_message_pairing(messages: Vec<Value>) -> Vec<Value> {
    let mut drop_indices = std::collections::HashSet::new();
    for (i, msg) in messages.iter().enumerate() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("tool") {
            continue;
        }
        let tool_call_id = msg
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let preceding = messages[..i]
            .iter()
            .rev()
            .find(|m| m.get("role").and_then(|v| v.as_str()) != Some("tool"));
        let preceding_role = preceding
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if preceding_role != "assistant" {
            continue;
        }
        let paired = preceding
            .and_then(|m| m.get("tool_calls").and_then(|tc| tc.as_array()))
            .is_some_and(|tool_calls| {
                tool_calls
                    .iter()
                    .any(|tc| tc.get("id").and_then(|v| v.as_str()) == Some(tool_call_id))
            });
        if !paired {
            drop_indices.insert(i);
        }
    }
    if drop_indices.is_empty() {
        return messages;
    }
    messages
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !drop_indices.contains(i))
        .map(|(_, m)| m)
        .collect()
}

/// Flatten tool result content blocks into a single string.
#[must_use]
pub fn flatten_tool_result_content(content: &[ToolResultContentBlock]) -> String {
    let mut result = String::new();
    for (i, block) in content.iter().enumerate() {
        if i > 0 {
            result.push('\n');
        }
        match block {
            ToolResultContentBlock::Text { text } => result.push_str(text),
            ToolResultContentBlock::Json { value } => result.push_str(&value.to_string()),
        }
    }
    result
}

// --- Internal helpers ---

fn openai_tool_definition(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        }
    })
}

fn openai_tool_choice(tc: &ToolChoice) -> Value {
    match tc {
        ToolChoice::Auto => Value::String("auto".to_string()),
        ToolChoice::Any => Value::String("required".to_string()),
        ToolChoice::Tool { name } => json!({
            "type": "function",
            "function": { "name": name },
        }),
    }
}

fn normalize_response(
    model: &str,
    response: ChatCompletionResponse,
) -> Result<MessageResponse, ApiError> {
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or(ApiError::InvalidSseFrame("response missing choices"))?;
    let mut content = Vec::new();
    if let Some(text) = choice.message.content.filter(|v| !v.is_empty()) {
        content.push(OutputContentBlock::Text { text });
    }
    for tc in choice.message.tool_calls {
        content.push(OutputContentBlock::ToolUse {
            id: tc.id,
            name: tc.function.name,
            input: parse_tool_arguments(&tc.function.arguments),
        });
    }
    Ok(MessageResponse {
        id: response.id,
        kind: "message".to_string(),
        role: choice.message.role,
        content,
        model: if response.model.is_empty() {
            model.to_string()
        } else {
            response.model
        },
        stop_reason: choice.finish_reason.map(|v| normalize_finish_reason(&v)),
        stop_sequence: None,
        usage: Usage {
            prompt_tokens: response.usage.as_ref().map_or(0, |u| u.prompt_tokens),
            completion_tokens: response.usage.as_ref().map_or(0, |u| u.completion_tokens),
        },
        request_id: None,
    })
}

fn parse_tool_arguments(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| json!({ "raw": arguments }))
}

fn normalize_finish_reason(value: &str) -> String {
    match value {
        "stop" => "end_turn",
        "tool_calls" => "tool_use",
        other => other,
    }
    .to_string()
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn request_id_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(REQUEST_ID_HEADER)
        .or_else(|| headers.get(ALT_REQUEST_ID_HEADER))
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn expect_success(response: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let request_id = request_id_from_headers(response.headers());
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<ErrorEnvelope>(&body).ok();
    let retryable = matches!(status.as_u16(), 408 | 409 | 429 | 500 | 502 | 503 | 504);
    Err(ApiError::Api {
        status,
        error_type: parsed.as_ref().and_then(|e| e.error.error_type.clone()),
        message: parsed.as_ref().and_then(|e| e.error.message.clone()),
        request_id,
        body,
        retryable,
        suggested_action: suggested_action_for_status(status),
    })
}

fn check_request_body_size(request: &MessageRequest) -> Result<(), ApiError> {
    let payload = build_chat_completion_request(request);
    let size = serde_json::to_vec(&payload).map_or(0, |v| v.len());
    if size > MAX_REQUEST_BODY_BYTES {
        Err(ApiError::RequestBodySizeExceeded {
            estimated_bytes: size,
            max_bytes: MAX_REQUEST_BODY_BYTES,
            provider: "Upstage",
        })
    } else {
        Ok(())
    }
}

fn read_env_non_empty(key: &str) -> Result<Option<String>, ApiError> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Ok(None),
    }
}

fn next_sse_frame(buffer: &mut Vec<u8>) -> Option<String> {
    let separator = buffer
        .windows(2)
        .position(|w| w == b"\n\n")
        .map(|p| (p, 2))
        .or_else(|| {
            buffer
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| (p, 4))
        })?;
    let (pos, sep_len) = separator;
    let frame = buffer.drain(..pos + sep_len).collect::<Vec<_>>();
    let len = frame.len().saturating_sub(sep_len);
    Some(String::from_utf8_lossy(&frame[..len]).into_owned())
}

fn parse_sse_frame(frame: &str, model: &str) -> Result<Option<ChatCompletionChunk>, ApiError> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }
    // Check for embedded error.
    if let Ok(raw) = serde_json::from_str::<Value>(&payload) {
        if let Some(err_obj) = raw.get("error") {
            let msg = err_obj
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("provider returned an error in stream")
                .to_string();
            let code = err_obj
                .get("code")
                .and_then(Value::as_u64)
                .map(|c| c as u16);
            let status = reqwest::StatusCode::from_u16(code.unwrap_or(400))
                .unwrap_or(reqwest::StatusCode::BAD_REQUEST);
            return Err(ApiError::Api {
                status,
                error_type: err_obj
                    .get("type")
                    .and_then(|t| t.as_str())
                    .map(str::to_owned),
                message: Some(msg),
                request_id: None,
                body: payload,
                retryable: false,
                suggested_action: suggested_action_for_status(status),
            });
        }
    }
    serde_json::from_str::<ChatCompletionChunk>(&payload)
        .map(Some)
        .map_err(|e| ApiError::json_deserialize("Upstage", model, &payload, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InputMessage, MessageRequest};

    #[test]
    fn builds_chat_completion_request() {
        let req = MessageRequest {
            model: "solar-pro3-260323".to_string(),
            max_tokens: 4096,
            messages: vec![InputMessage::user_text("hello")],
            system: Some("You are helpful.".to_string()),
            ..Default::default()
        };
        let payload = build_chat_completion_request(&req);
        assert_eq!(payload["model"], "solar-pro3-260323");
        assert_eq!(payload["max_tokens"], 4096);
        let msgs = payload["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn normalize_finish_reasons() {
        assert_eq!(normalize_finish_reason("stop"), "end_turn");
        assert_eq!(normalize_finish_reason("tool_calls"), "tool_use");
        assert_eq!(normalize_finish_reason("length"), "length");
    }

    #[test]
    fn chat_completions_endpoint_construction() {
        assert_eq!(
            chat_completions_endpoint("https://api.upstage.ai/v1"),
            "https://api.upstage.ai/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://api.upstage.ai/v1/"),
            "https://api.upstage.ai/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://proxy.example.com/v1/chat/completions"),
            "https://proxy.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn translate_tool_result_message() {
        let msg = InputMessage::user_tool_result("call_1", "file contents here", false);
        let translated = translate_message(&msg);
        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0]["role"], "tool");
        assert_eq!(translated[0]["tool_call_id"], "call_1");
    }
}
