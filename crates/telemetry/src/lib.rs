//! Session tracing and usage telemetry for Solarcido.
//!
//! Ported from `claw-rust/crates/telemetry` with Anthropic-specific identifiers
//! replaced by Solarcido/Solar equivalents.

use std::fmt::{Debug, Formatter};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DEFAULT_APP_NAME: &str = "solarcido";
pub const DEFAULT_RUNTIME: &str = "rust";

/// Identity used in User-Agent and telemetry payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientIdentity {
    pub app_name: String,
    pub app_version: String,
    pub runtime: String,
}

impl ClientIdentity {
    #[must_use]
    pub fn new(app_name: impl Into<String>, app_version: impl Into<String>) -> Self {
        Self {
            app_name: app_name.into(),
            app_version: app_version.into(),
            runtime: DEFAULT_RUNTIME.to_string(),
        }
    }

    #[must_use]
    pub fn with_runtime(mut self, runtime: impl Into<String>) -> Self {
        self.runtime = runtime.into();
        self
    }

    #[must_use]
    pub fn user_agent(&self) -> String {
        format!("{}/{}", self.app_name, self.app_version)
    }
}

impl Default for ClientIdentity {
    fn default() -> Self {
        Self::new(DEFAULT_APP_NAME, env!("CARGO_PKG_VERSION"))
    }
}

/// Token usage for a single API call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    #[serde(default)]
    pub cache_read_input_tokens: u32,
}

impl TokenUsage {
    #[must_use]
    pub const fn total_tokens(&self) -> u32 {
        self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
    }
}

impl std::ops::Add for TokenUsage {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + rhs.input_tokens,
            output_tokens: self.output_tokens + rhs.output_tokens,
            cache_creation_input_tokens: self.cache_creation_input_tokens
                + rhs.cache_creation_input_tokens,
            cache_read_input_tokens: self.cache_read_input_tokens + rhs.cache_read_input_tokens,
        }
    }
}

impl std::ops::AddAssign for TokenUsage {
    fn add_assign(&mut self, rhs: Self) {
        *self = *self + rhs;
    }
}

/// A single trace record written to a JSONL session file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionTraceRecord {
    pub timestamp_ms: u64,
    pub event: String,
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

/// Sink trait for telemetry events. Implementations include JSONL file sink and
/// in-memory sink for tests.
pub trait TelemetrySink: Send + Sync {
    fn record(&self, record: SessionTraceRecord);
}

/// Writes telemetry records as line-delimited JSON to a file.
pub struct JsonlTelemetrySink {
    file: Mutex<File>,
    path: PathBuf,
}

impl Debug for JsonlTelemetrySink {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonlTelemetrySink")
            .field("path", &self.path)
            .finish()
    }
}

impl JsonlTelemetrySink {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            file: Mutex::new(file),
            path,
        })
    }
}

impl TelemetrySink for JsonlTelemetrySink {
    fn record(&self, record: SessionTraceRecord) {
        if let Ok(mut file) = self.file.lock() {
            if let Ok(line) = serde_json::to_string(&record) {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

/// In-memory telemetry sink for tests.
#[derive(Debug, Default)]
pub struct MemoryTelemetrySink {
    records: Mutex<Vec<SessionTraceRecord>>,
}

impl MemoryTelemetrySink {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn drain(&self) -> Vec<SessionTraceRecord> {
        self.records
            .lock()
            .map(|mut g| g.drain(..).collect())
            .unwrap_or_default()
    }
}

impl TelemetrySink for MemoryTelemetrySink {
    fn record(&self, record: SessionTraceRecord) {
        if let Ok(mut records) = self.records.lock() {
            records.push(record);
        }
    }
}

/// High-level telemetry event types emitted by the runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TelemetryEvent {
    SessionStart {
        session_id: String,
        model: String,
    },
    TurnStart {
        session_id: String,
        turn: usize,
    },
    TurnEnd {
        session_id: String,
        turn: usize,
        usage: TokenUsage,
    },
    ToolCall {
        session_id: String,
        tool_name: String,
    },
    ToolResult {
        session_id: String,
        tool_name: String,
        success: bool,
    },
    SessionEnd {
        session_id: String,
        total_usage: TokenUsage,
    },
}

/// Per-session tracer; cheaply cloneable via Arc.
#[derive(Clone)]
pub struct SessionTracer {
    session_id: String,
    counter: Arc<AtomicU64>,
    sink: Arc<dyn TelemetrySink>,
}

impl std::fmt::Debug for SessionTracer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionTracer")
            .field("session_id", &self.session_id)
            .field("counter", &self.counter)
            .field("sink", &"<dyn TelemetrySink>")
            .finish()
    }
}

impl SessionTracer {
    #[must_use]
    pub fn new(session_id: impl Into<String>, sink: Arc<dyn TelemetrySink>) -> Self {
        Self {
            session_id: session_id.into(),
            counter: Arc::new(AtomicU64::new(0)),
            sink,
        }
    }

    pub fn emit(&self, event: TelemetryEvent) {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let payload = match serde_json::to_value(&event) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        self.sink.record(SessionTraceRecord {
            timestamp_ms,
            event: event_type_name(&event).to_string(),
            payload,
        });
        self.counter.fetch_add(1, Ordering::Relaxed);
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn event_count(&self) -> u64 {
        self.counter.load(Ordering::Relaxed)
    }
}

/// Analytics event emitted by the CLI for usage tracking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalyticsEvent {
    pub name: String,
    #[serde(flatten)]
    pub properties: Map<String, Value>,
}

fn event_type_name(event: &TelemetryEvent) -> &'static str {
    match event {
        TelemetryEvent::SessionStart { .. } => "session_start",
        TelemetryEvent::TurnStart { .. } => "turn_start",
        TelemetryEvent::TurnEnd { .. } => "turn_end",
        TelemetryEvent::ToolCall { .. } => "tool_call",
        TelemetryEvent::ToolResult { .. } => "tool_result",
        TelemetryEvent::SessionEnd { .. } => "session_end",
    }
}
