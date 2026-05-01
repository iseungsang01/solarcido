use glob::Pattern;
use regex::RegexBuilder;
use serde_json::{json, Value};
use solarcido_api::ToolDefinition;
use solarcido_runtime::{PermissionMode, ToolError, ToolExecutor};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 10 * 1024 * 1024;
const MAX_SLEEP_MS: u64 = 120_000;

#[derive(Debug, Clone)]
pub struct WorkspaceTools {
    cwd: PathBuf,
}

impl WorkspaceTools {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }

    fn resolve_existing(&self, path: &str) -> Result<PathBuf, ToolError> {
        let candidate = self.resolve_candidate(path);
        let resolved = candidate
            .canonicalize()
            .map_err(|error| ToolError::new(format!("{path}: {error}")))?;
        self.ensure_inside(&resolved)?;
        Ok(resolved)
    }

    fn resolve_allow_missing(&self, path: &str) -> Result<PathBuf, ToolError> {
        let candidate = self.resolve_candidate(path);
        let parent = candidate.parent().unwrap_or(&self.cwd);
        let resolved_parent = parent
            .canonicalize()
            .map_err(|error| ToolError::new(format!("{}: {error}", parent.display())))?;
        self.ensure_inside(&resolved_parent)?;
        Ok(resolved_parent.join(
            candidate
                .file_name()
                .ok_or_else(|| ToolError::new("path must include a file name"))?,
        ))
    }

    fn resolve_candidate(&self, path: &str) -> PathBuf {
        let raw = Path::new(path);
        if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.cwd.join(raw)
        }
    }

    fn ensure_inside(&self, path: &Path) -> Result<(), ToolError> {
        let root = self
            .cwd
            .canonicalize()
            .map_err(|error| ToolError::new(format!("{}: {error}", self.cwd.display())))?;
        if path.starts_with(&root) {
            Ok(())
        } else {
            Err(ToolError::new(format!(
                "path {} escapes workspace {}",
                path.display(),
                root.display()
            )))
        }
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

impl ToolExecutor for WorkspaceTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        tool_specs()
            .into_iter()
            .map(|spec| ToolDefinition {
                name: spec.name.to_string(),
                description: Some(spec.description.to_string()),
                input_schema: spec.schema,
            })
            .collect()
    }

    fn permission_specs(&self) -> Vec<(String, PermissionMode)> {
        tool_specs()
            .into_iter()
            .map(|spec| (spec.name.to_string(), spec.permission))
            .collect()
    }

    fn execute(&mut self, tool_name: &str, input: &Value) -> Result<String, ToolError> {
        match tool_name {
            "bash" => self.bash(input),
            "read_file" => self.read_file(input),
            "write_file" => self.write_file(input),
            "edit_file" => self.edit_file(input),
            "glob_search" => self.glob_search(input),
            "grep_search" => self.grep_search(input),
            "Sleep" => self.sleep(input),
            "StructuredOutput" => self.structured_output(input),
            "SendUserMessage" => self.send_user_message(input),
            "ToolSearch" => self.tool_search(input),
            "TodoWrite" => self.todo_write(input),
            other => Err(ToolError::new(format!("unsupported tool: {other}"))),
        }
    }
}

struct ToolSpec {
    name: &'static str,
    description: &'static str,
    schema: Value,
    permission: PermissionMode,
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "bash",
            description: "Execute a shell command in the current workspace.",
            schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout": { "type": "integer", "minimum": 1 },
                    "description": { "type": "string" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            permission: PermissionMode::DangerFullAccess,
        },
        ToolSpec {
            name: "read_file",
            description: "Read a text file from the workspace.",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "write_file",
            description: "Write a text file in the workspace.",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "edit_file",
            description: "Replace text in a workspace file.",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" },
                    "replace_all": { "type": "boolean" }
                },
                "required": ["path", "old_string", "new_string"],
                "additionalProperties": false
            }),
            permission: PermissionMode::WorkspaceWrite,
        },
        ToolSpec {
            name: "glob_search",
            description: "Find files by glob pattern.",
            schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "grep_search",
            description: "Search file contents with a regex pattern.",
            schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" },
                    "glob": { "type": "string" },
                    "output_mode": { "type": "string", "enum": ["files_with_matches", "content", "count"] },
                    "head_limit": { "type": "integer", "minimum": 1 },
                    "offset": { "type": "integer", "minimum": 0 },
                    "-i": { "type": "boolean" },
                    "-n": { "type": "boolean" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "Sleep",
            description: "Pause execution for a specified duration in milliseconds.",
            schema: json!({
                "type": "object",
                "properties": {
                    "duration_ms": { "type": "integer", "minimum": 1 }
                },
                "required": ["duration_ms"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "StructuredOutput",
            description: "Return a structured JSON object to the model.",
            schema: json!({
                "type": "object",
                "properties": {
                    "data": { "type": "object" }
                },
                "required": ["data"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "SendUserMessage",
            description: "Send a user-facing message or status update.",
            schema: json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                    "status": { "type": "string", "enum": ["info", "warning", "error", "success"] }
                },
                "required": ["message"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "ToolSearch",
            description: "Search available tools by name or description keyword.",
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "TodoWrite",
            description: "Create or update a structured task list for the current session.",
            schema: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": { "type": "string" },
                                "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
                                "priority": { "type": "string", "enum": ["high", "medium", "low"] }
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"],
                "additionalProperties": false
            }),
            permission: PermissionMode::ReadOnly,
        },
    ]
}

impl WorkspaceTools {
    fn bash(&self, input: &Value) -> Result<String, ToolError> {
        let command = string_arg(input, "command")?;
        let timeout_ms = input
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(60_000);

        #[cfg(windows)]
        let mut child = Command::new("powershell.exe");
        #[cfg(windows)]
        child.args(["-NoProfile", "-Command", command]);

        #[cfg(not(windows))]
        let mut child = Command::new("/bin/sh");
        #[cfg(not(windows))]
        child.args(["-lc", command]);

        let mut child = child
            .current_dir(&self.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ToolError::new(error.to_string()))?;
        let started = Instant::now();
        loop {
            if child
                .try_wait()
                .map_err(|error| ToolError::new(error.to_string()))?
                .is_some()
            {
                break;
            }
            if started.elapsed() >= Duration::from_millis(timeout_ms) {
                let _ = child.kill();
                return Err(ToolError::new(format!(
                    "command timed out after {timeout_ms} ms"
                )));
            }
            thread::sleep(Duration::from_millis(25));
        }
        let output = child
            .wait_with_output()
            .map_err(|error| ToolError::new(error.to_string()))?;
        let exit_code = output.status.code().unwrap_or(1);
        Ok(json!({
            "exit_code": exit_code,
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr)
        })
        .to_string())
    }

    fn read_file(&self, input: &Value) -> Result<String, ToolError> {
        let path = string_arg(input, "path")?;
        let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = input.get("limit").and_then(Value::as_u64).map(|value| value as usize);
        let resolved = self.resolve_existing(path)?;
        let metadata = std::fs::metadata(&resolved).map_err(|error| ToolError::new(error.to_string()))?;
        if metadata.len() > MAX_READ_BYTES {
            return Err(ToolError::new(format!(
                "file is too large ({} bytes, max {} bytes)",
                metadata.len(),
                MAX_READ_BYTES
            )));
        }
        let content =
            std::fs::read_to_string(&resolved).map_err(|error| ToolError::new(error.to_string()))?;
        let lines = content.lines().collect::<Vec<_>>();
        let end = limit
            .map(|limit| offset.saturating_add(limit).min(lines.len()))
            .unwrap_or(lines.len());
        let selected = if offset <= lines.len() {
            lines[offset..end].join("\n")
        } else {
            String::new()
        };
        Ok(json!({
            "type": "text",
            "file": {
                "filePath": self.relative(&resolved),
                "content": selected,
                "numLines": end.saturating_sub(offset.min(end)),
                "startLine": offset + 1,
                "totalLines": lines.len()
            }
        })
        .to_string())
    }

    fn write_file(&self, input: &Value) -> Result<String, ToolError> {
        let path = string_arg(input, "path")?;
        let content = string_arg(input, "content")?;
        if content.len() > MAX_WRITE_BYTES {
            return Err(ToolError::new(format!(
                "content is too large ({} bytes, max {} bytes)",
                content.len(),
                MAX_WRITE_BYTES
            )));
        }
        let resolved = self.resolve_allow_missing(path)?;
        let original = std::fs::read_to_string(&resolved).ok();
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).map_err(|error| ToolError::new(error.to_string()))?;
        }
        std::fs::write(&resolved, content).map_err(|error| ToolError::new(error.to_string()))?;
        Ok(json!({
            "type": if original.is_some() { "update" } else { "create" },
            "filePath": self.relative(&resolved),
            "originalFile": original
        })
        .to_string())
    }

    fn edit_file(&self, input: &Value) -> Result<String, ToolError> {
        let path = string_arg(input, "path")?;
        let old = string_arg(input, "old_string")?;
        let new = string_arg(input, "new_string")?;
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if old.is_empty() {
            return Err(ToolError::new("old_string must not be empty"));
        }
        let resolved = self.resolve_existing(path)?;
        let original =
            std::fs::read_to_string(&resolved).map_err(|error| ToolError::new(error.to_string()))?;
        let matches = original.matches(old).count();
        if matches == 0 {
            return Err(ToolError::new("old_string not found in file"));
        }
        if matches > 1 && !replace_all {
            return Err(ToolError::new(format!(
                "old_string appears {matches} times; set replace_all true or provide more context"
            )));
        }
        let updated = if replace_all {
            original.replace(old, new)
        } else {
            original.replacen(old, new, 1)
        };
        std::fs::write(&resolved, updated).map_err(|error| ToolError::new(error.to_string()))?;
        Ok(json!({
            "filePath": self.relative(&resolved),
            "oldString": old,
            "newString": new,
            "replaceAll": replace_all,
            "replacements": if replace_all { matches } else { 1 }
        })
        .to_string())
    }

    fn glob_search(&self, input: &Value) -> Result<String, ToolError> {
        let pattern = string_arg(input, "pattern")?;
        let base = input
            .get("path")
            .and_then(Value::as_str)
            .map_or_else(|| Ok(self.cwd.clone()), |path| self.resolve_existing(path))?;
        let search_pattern = base.join(pattern).to_string_lossy().to_string();
        let mut files = Vec::new();
        for entry in glob::glob(&search_pattern).map_err(|error| ToolError::new(error.to_string()))? {
            let entry = entry.map_err(|error| ToolError::new(error.to_string()))?;
            if entry.is_file() {
                self.ensure_inside(&entry)?;
                files.push(self.relative(&entry));
            }
        }
        files.sort();
        let truncated = files.len() > 100;
        files.truncate(100);
        Ok(json!({
            "numFiles": files.len(),
            "filenames": files,
            "truncated": truncated
        })
        .to_string())
    }

    fn grep_search(&self, input: &Value) -> Result<String, ToolError> {
        let pattern = string_arg(input, "pattern")?;
        let base = input
            .get("path")
            .and_then(Value::as_str)
            .map_or_else(|| Ok(self.cwd.clone()), |path| self.resolve_existing(path))?;
        let glob_filter = input
            .get("glob")
            .and_then(Value::as_str)
            .map(Pattern::new)
            .transpose()
            .map_err(|error| ToolError::new(error.to_string()))?;
        let output_mode = input
            .get("output_mode")
            .and_then(Value::as_str)
            .unwrap_or("files_with_matches");
        let head_limit = input
            .get("head_limit")
            .and_then(Value::as_u64)
            .unwrap_or(100) as usize;
        let case_insensitive = input.get("-i").and_then(Value::as_bool).unwrap_or(false);
        let line_numbers = input.get("-n").and_then(Value::as_bool).unwrap_or(true);
        let regex = RegexBuilder::new(pattern)
            .case_insensitive(case_insensitive)
            .build()
            .map_err(|error| ToolError::new(error.to_string()))?;

        let mut filenames = Vec::new();
        let mut content = Vec::new();
        let mut count = 0usize;
        let files = if base.is_file() {
            vec![base]
        } else {
            WalkDir::new(base)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| entry.into_path())
                .collect::<Vec<_>>()
        };

        for file in files {
            if let Some(glob_filter) = &glob_filter {
                if !glob_filter.matches_path(&file) && !glob_filter.matches(&self.relative(&file)) {
                    continue;
                }
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let mut file_matched = false;
            for (index, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    count += 1;
                    file_matched = true;
                    if output_mode == "content" && content.len() < head_limit {
                        let prefix = if line_numbers {
                            format!("{}:{}:", self.relative(&file), index + 1)
                        } else {
                            format!("{}:", self.relative(&file))
                        };
                        content.push(format!("{prefix}{line}"));
                    }
                }
            }
            if file_matched {
                filenames.push(self.relative(&file));
            }
            if filenames.len() >= head_limit && output_mode != "content" {
                break;
            }
        }

        filenames.truncate(head_limit);
        Ok(json!({
            "mode": output_mode,
            "numFiles": filenames.len(),
            "filenames": filenames,
            "content": (output_mode == "content").then(|| content.join("\n")),
            "numMatches": (output_mode == "count").then_some(count)
        })
        .to_string())
    }
}

impl WorkspaceTools {
    fn sleep(&self, input: &Value) -> Result<String, ToolError> {
        let duration_ms = input
            .get("duration_ms")
            .and_then(Value::as_u64)
            .ok_or_else(|| ToolError::new("duration_ms must be a positive integer"))?;
        if duration_ms > MAX_SLEEP_MS {
            return Err(ToolError::new(format!(
                "duration_ms must not exceed {MAX_SLEEP_MS} ms"
            )));
        }
        thread::sleep(Duration::from_millis(duration_ms));
        Ok(json!({ "slept_ms": duration_ms }).to_string())
    }

    fn structured_output(&self, input: &Value) -> Result<String, ToolError> {
        let data = input
            .get("data")
            .ok_or_else(|| ToolError::new("data is required"))?;
        Ok(json!({ "type": "structured_output", "data": data }).to_string())
    }

    fn send_user_message(&self, input: &Value) -> Result<String, ToolError> {
        let message = string_arg(input, "message")?;
        let status = input
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("info");
        Ok(json!({
            "type": "user_message",
            "message": message,
            "status": status
        })
        .to_string())
    }

    fn tool_search(&self, input: &Value) -> Result<String, ToolError> {
        let query = string_arg(input, "query")?.to_lowercase();
        let matches: Vec<Value> = tool_specs()
            .into_iter()
            .filter(|spec| {
                spec.name.to_lowercase().contains(&query)
                    || spec.description.to_lowercase().contains(&query)
            })
            .map(|spec| {
                json!({
                    "name": spec.name,
                    "description": spec.description
                })
            })
            .collect();
        Ok(json!({
            "query": query,
            "numResults": matches.len(),
            "tools": matches
        })
        .to_string())
    }

    fn todo_write(&self, input: &Value) -> Result<String, ToolError> {
        let todos = input
            .get("todos")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::new("todos must be an array"))?;
        // TodoWrite accepts the full list; the model manages state.
        // We persist nothing yet — the result is returned for the model to track.
        let count = todos.len();
        Ok(json!({
            "type": "todo_update",
            "count": count,
            "todos": todos
        })
        .to_string())
    }
}

fn string_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new(format!("{key} must be a string")))
}
