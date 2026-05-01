pub mod session;
pub mod usage;

use serde_json::Value;
pub use session::{new_session_id, Session, SessionSnapshot, SessionStore};
use solarcido_api::{
    ContentBlockDelta, InputContentBlock, InputMessage, MessageRequest, OutputContentBlock,
    ReasoningEffort, SolarClient, StreamEvent, ToolDefinition, Usage,
};
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl PermissionMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }

    pub fn parse(value: &str) -> Result<Self, RuntimeError> {
        match value {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            "danger-full-access" => Ok(Self::DangerFullAccess),
            other => Err(RuntimeError::new(format!(
                "invalid permission mode `{other}`; expected read-only, workspace-write, or danger-full-access"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

pub trait PermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    pub tool_name: String,
    pub input: String,
    pub current_mode: PermissionMode,
    pub required_mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPolicy {
    active_mode: PermissionMode,
    requirements: Vec<(String, PermissionMode)>,
}

impl PermissionPolicy {
    #[must_use]
    pub fn new(active_mode: PermissionMode) -> Self {
        Self {
            active_mode,
            requirements: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_tool_requirement(
        mut self,
        tool_name: impl Into<String>,
        required: PermissionMode,
    ) -> Self {
        self.requirements.push((tool_name.into(), required));
        self
    }

    #[must_use]
    pub fn required_mode_for(&self, tool_name: &str) -> PermissionMode {
        self.requirements
            .iter()
            .find_map(|(name, mode)| (name == tool_name).then_some(*mode))
            .unwrap_or(PermissionMode::DangerFullAccess)
    }

    pub fn authorize(
        &self,
        tool_name: &str,
        input: &str,
        prompter: Option<&mut dyn PermissionPrompter>,
    ) -> PermissionOutcome {
        let required_mode = self.required_mode_for(tool_name);
        if self.active_mode >= required_mode {
            return PermissionOutcome::Allow;
        }

        if self.active_mode == PermissionMode::WorkspaceWrite
            && required_mode == PermissionMode::DangerFullAccess
        {
            let request = PermissionRequest {
                tool_name: tool_name.to_string(),
                input: input.to_string(),
                current_mode: self.active_mode,
                required_mode,
            };
            if let Some(p) = prompter {
                if p.decide(&request) {
                    return PermissionOutcome::Allow;
                }
            }
            return PermissionOutcome::Deny {
                reason: format!(
                    "tool `{tool_name}` requires approval to escalate from {} to {}",
                    self.active_mode.as_str(),
                    required_mode.as_str()
                ),
            };
        }

        PermissionOutcome::Deny {
            reason: format!(
                "tool `{tool_name}` requires {} permission; current mode is {}",
                required_mode.as_str(),
                self.active_mode.as_str()
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    message: String,
}

impl RuntimeError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    message: String,
}

impl ToolError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for ToolError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ToolError {}

pub trait ToolExecutor {
    fn definitions(&self) -> Vec<ToolDefinition>;
    fn permission_specs(&self) -> Vec<(String, PermissionMode)>;
    fn execute(&mut self, tool_name: &str, input: &Value) -> Result<String, ToolError>;
}

#[derive(Debug, Clone, Default)]
pub struct TurnSummary {
    pub assistant_text: String,
    pub tool_results: Vec<(String, String)>,
    pub iterations: usize,
    pub usage: Usage,
}

pub struct ConversationRuntime<T> {
    client: SolarClient,
    model: String,
    reasoning_effort: ReasoningEffort,
    system_prompt: String,
    session: Session,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    max_iterations: usize,
}

impl<T> ConversationRuntime<T>
where
    T: ToolExecutor,
{
    #[must_use]
    pub fn new(
        client: SolarClient,
        model: impl Into<String>,
        reasoning_effort: ReasoningEffort,
        system_prompt: impl Into<String>,
        tool_executor: T,
        permission_mode: PermissionMode,
    ) -> Self {
        let permission_policy = tool_executor.permission_specs().into_iter().fold(
            PermissionPolicy::new(permission_mode),
            |policy, (tool, mode)| policy.with_tool_requirement(tool, mode),
        );
        Self {
            client,
            model: model.into(),
            reasoning_effort,
            system_prompt: system_prompt.into(),
            session: Session::default(),
            tool_executor,
            permission_policy,
            max_iterations: 128,
        }
    }

    #[must_use]
    pub fn with_session(mut self, session: Session) -> Self {
        self.session = session;
        self
    }

    #[must_use]
    pub fn session(&self) -> &Session {
        &self.session
    }

    #[must_use]
    pub fn message_count(&self) -> usize {
        self.session.messages.len()
    }

    #[must_use]
    pub fn snapshot(&self, id: impl Into<String>) -> SessionSnapshot {
        SessionSnapshot::new(
            id,
            self.model.clone(),
            self.reasoning_effort.as_str(),
            self.system_prompt.clone(),
            self.session.messages.clone(),
        )
    }

    fn build_request(&self) -> MessageRequest {
        MessageRequest {
            model: self.model.clone(),
            max_tokens: 16384,
            messages: self.session.messages.clone(),
            system: Some(self.system_prompt.clone()),
            tools: Some(self.tool_executor.definitions()),
            tool_choice: None,
            stream: false,
            temperature: Some(0.2),
            reasoning_effort: Some(self.reasoning_effort.as_str().to_string()),
            ..Default::default()
        }
    }

    pub async fn run_turn(
        &mut self,
        user_input: impl Into<String>,
        mut prompter: Option<&mut dyn PermissionPrompter>,
    ) -> Result<TurnSummary, RuntimeError> {
        self.session
            .messages
            .push(InputMessage::user_text(user_input));
        let mut summary = TurnSummary::default();

        loop {
            summary.iterations += 1;
            if summary.iterations > self.max_iterations {
                return Err(RuntimeError::new(
                    "conversation loop exceeded the maximum number of iterations",
                ));
            }

            let request = self.build_request();
            let response = self
                .client
                .send_message(&request)
                .await
                .map_err(|e| RuntimeError::new(e.to_string()))?;

            summary.usage.prompt_tokens += response.usage.prompt_tokens;
            summary.usage.completion_tokens += response.usage.completion_tokens;

            // Extract text and tool calls from response content.
            let mut content = String::new();
            let mut tool_uses: Vec<(String, String, Value)> = Vec::new();
            for block in &response.content {
                match block {
                    OutputContentBlock::Text { text } => {
                        if !content.is_empty() {
                            content.push('\n');
                        }
                        content.push_str(text);
                    }
                    OutputContentBlock::ToolUse { id, name, input } => {
                        tool_uses.push((id.clone(), name.clone(), input.clone()));
                    }
                }
            }

            if !content.is_empty() {
                if !summary.assistant_text.is_empty() {
                    summary.assistant_text.push('\n');
                }
                summary.assistant_text.push_str(&content);
            }

            // Record assistant message in session.
            let mut assistant_blocks: Vec<InputContentBlock> = Vec::new();
            if !content.is_empty() {
                assistant_blocks.push(InputContentBlock::Text { text: content });
            }
            for (id, name, input) in &tool_uses {
                assistant_blocks.push(InputContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
            }
            self.session.messages.push(InputMessage {
                role: "assistant".to_string(),
                content: assistant_blocks,
            });

            if tool_uses.is_empty() {
                return Ok(summary);
            }

            // Execute each tool call and record results.
            for (id, name, input) in tool_uses {
                let args_str = input.to_string();
                let p = prompter
                    .as_mut()
                    .map(|r| &mut **r as &mut dyn PermissionPrompter);
                let output = match self.permission_policy.authorize(&name, &args_str, p) {
                    PermissionOutcome::Allow => self
                        .tool_executor
                        .execute(&name, &input)
                        .unwrap_or_else(|e| format!("ERROR: {e}")),
                    PermissionOutcome::Deny { reason } => format!("ERROR: {reason}"),
                };
                summary.tool_results.push((name.clone(), output.clone()));
                self.session
                    .messages
                    .push(InputMessage::user_tool_result(id, output, false));
            }
        }
    }

    /// Run a conversation turn with streaming output.
    pub async fn run_turn_streaming<F>(
        &mut self,
        user_input: impl Into<String>,
        mut prompter: Option<&mut dyn PermissionPrompter>,
        mut on_event: F,
    ) -> Result<TurnSummary, RuntimeError>
    where
        F: FnMut(&StreamEvent),
    {
        self.session
            .messages
            .push(InputMessage::user_text(user_input));
        let mut summary = TurnSummary::default();

        loop {
            summary.iterations += 1;
            if summary.iterations > self.max_iterations {
                return Err(RuntimeError::new(
                    "conversation loop exceeded the maximum number of iterations",
                ));
            }

            let request = self.build_request();
            let mut stream = self
                .client
                .stream_message(&request)
                .await
                .map_err(|e| RuntimeError::new(e.to_string()))?;

            let mut content = String::new();
            let mut tool_uses: BTreeMap<u32, StreamingToolUse> = BTreeMap::new();

            loop {
                match stream
                    .next_event()
                    .await
                    .map_err(|e| RuntimeError::new(e.to_string()))?
                {
                    Some(ref event) => {
                        on_event(event);
                        match event {
                            StreamEvent::ContentBlockStart(start) => {
                                if let OutputContentBlock::ToolUse { id, name, .. } =
                                    &start.content_block
                                {
                                    tool_uses.insert(
                                        start.index,
                                        StreamingToolUse {
                                            id: id.clone(),
                                            name: name.clone(),
                                            input_json: String::new(),
                                        },
                                    );
                                }
                            }
                            StreamEvent::ContentBlockDelta(delta_event) => {
                                if let ContentBlockDelta::TextDelta { text } = &delta_event.delta {
                                    content.push_str(text);
                                } else if let ContentBlockDelta::InputJsonDelta { partial_json } =
                                    &delta_event.delta
                                {
                                    if let Some(tool_use) = tool_uses.get_mut(&delta_event.index) {
                                        tool_use.input_json.push_str(partial_json);
                                    }
                                }
                            }
                            StreamEvent::ContentBlockStop(_) => {
                                // Finalize tool call arguments from accumulated JSON deltas.
                            }
                            StreamEvent::MessageDelta(msg_delta) => {
                                summary.usage.prompt_tokens += msg_delta.usage.prompt_tokens;
                                summary.usage.completion_tokens +=
                                    msg_delta.usage.completion_tokens;
                            }
                            StreamEvent::MessageStart(_) | StreamEvent::MessageStop(_) => {}
                        }
                    }
                    None => break,
                }
            }

            let tool_uses = tool_uses
                .into_values()
                .map(|tool_use| {
                    (
                        tool_use.id,
                        tool_use.name,
                        parse_streaming_tool_input(&tool_use.input_json),
                    )
                })
                .collect::<Vec<_>>();

            if !content.is_empty() {
                if !summary.assistant_text.is_empty() {
                    summary.assistant_text.push('\n');
                }
                summary.assistant_text.push_str(&content);
            }

            // Record assistant message.
            let mut assistant_blocks: Vec<InputContentBlock> = Vec::new();
            if !content.is_empty() {
                assistant_blocks.push(InputContentBlock::Text { text: content });
            }
            for (id, name, input) in &tool_uses {
                assistant_blocks.push(InputContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
            }
            self.session.messages.push(InputMessage {
                role: "assistant".to_string(),
                content: assistant_blocks,
            });

            if tool_uses.is_empty() {
                return Ok(summary);
            }

            for (id, name, input) in tool_uses {
                let args_str = input.to_string();
                let p = prompter
                    .as_mut()
                    .map(|r| &mut **r as &mut dyn PermissionPrompter);
                let output = match self.permission_policy.authorize(&name, &args_str, p) {
                    PermissionOutcome::Allow => self
                        .tool_executor
                        .execute(&name, &input)
                        .unwrap_or_else(|e| format!("ERROR: {e}")),
                    PermissionOutcome::Deny { reason } => format!("ERROR: {reason}"),
                };
                summary.tool_results.push((name.clone(), output.clone()));
                self.session
                    .messages
                    .push(InputMessage::user_tool_result(id, output, false));
            }
        }
    }
}

#[derive(Debug, Clone)]
struct StreamingToolUse {
    id: String,
    name: String,
    input_json: String,
}

fn parse_streaming_tool_input(input_json: &str) -> Value {
    if input_json.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str(input_json)
            .unwrap_or_else(|_| serde_json::json!({ "raw": input_json }))
    }
}

#[must_use]
pub fn default_system_prompt(permission_mode: PermissionMode) -> String {
    [
        "You are Solarcido, a local terminal coding assistant.",
        "Operate like claw: inspect the repository, call tools for file and command work, and continue until the user's task is complete.",
        "Prefer grep_search and glob_search before broad reads.",
        "Prefer edit_file for focused changes and write_file for new files or intentional full-file replacement.",
        "Run verification commands after behavior changes when practical.",
        "All tool calls must stay within the selected working directory.",
        &format!("Current permission mode: {}.", permission_mode.as_str()),
    ]
    .join(" ")
}
