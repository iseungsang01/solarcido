use serde::{Deserialize, Serialize};
use solarcido_api::InputMessage;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::RuntimeError;

const SESSION_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    #[serde(default)]
    pub messages: Vec<InputMessage>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub version: u32,
    pub id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub system_prompt: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub messages: Vec<InputMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub path: PathBuf,
    pub model: String,
    pub reasoning_effort: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub message_count: usize,
}

impl SessionSnapshot {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        model: impl Into<String>,
        reasoning_effort: impl Into<String>,
        system_prompt: impl Into<String>,
        messages: Vec<InputMessage>,
    ) -> Self {
        let now = now_ms();
        Self {
            version: SESSION_VERSION,
            id: id.into(),
            model: model.into(),
            reasoning_effort: reasoning_effort.into(),
            system_prompt: system_prompt.into(),
            created_at_ms: now,
            updated_at_ms: now,
            messages,
        }
    }

    #[must_use]
    pub fn session(&self) -> Session {
        Session {
            messages: self.messages.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionRecord {
    Metadata {
        version: u32,
        id: String,
        model: String,
        reasoning_effort: String,
        system_prompt: String,
        created_at_ms: u64,
        updated_at_ms: u64,
    },
    Message {
        message: InputMessage,
    },
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    root: PathBuf,
}

impl SessionStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Self {
        Self::new(workspace.as_ref().join(".solarcido").join("sessions"))
    }

    pub fn save(&self, snapshot: &SessionSnapshot) -> Result<PathBuf, RuntimeError> {
        fs::create_dir_all(&self.root).map_err(|error| {
            RuntimeError::new(format!("failed to create session directory: {error}"))
        })?;
        let path = self.path_for_id(&snapshot.id);
        save_snapshot(&path, snapshot)?;
        let latest = self.root.join("latest");
        fs::write(&latest, &snapshot.id).map_err(|error| {
            RuntimeError::new(format!("failed to update latest session pointer: {error}"))
        })?;
        Ok(path)
    }

    pub fn load(&self, selector: &str) -> Result<SessionSnapshot, RuntimeError> {
        let path = self.resolve_selector(selector)?;
        load_snapshot(&path)
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>, RuntimeError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(RuntimeError::new(format!(
                    "failed to read session directory: {error}"
                )));
            }
        };
        let mut sessions = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| RuntimeError::new(format!("failed to read session: {error}")))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let snapshot = load_snapshot(&path)?;
            sessions.push(SessionSummary {
                id: snapshot.id,
                path,
                model: snapshot.model,
                reasoning_effort: snapshot.reasoning_effort,
                created_at_ms: snapshot.created_at_ms,
                updated_at_ms: snapshot.updated_at_ms,
                message_count: snapshot.messages.len(),
            });
        }
        sessions.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
        Ok(sessions)
    }

    pub fn resolve_selector(&self, selector: &str) -> Result<PathBuf, RuntimeError> {
        let path = Path::new(selector);
        if path.is_absolute() || selector.ends_with(".jsonl") {
            return Ok(path.to_path_buf());
        }
        if selector == "latest" {
            let id = fs::read_to_string(self.root.join("latest")).map_err(|error| {
                RuntimeError::new(format!("failed to read latest session pointer: {error}"))
            })?;
            return Ok(self.path_for_id(id.trim()));
        }
        Ok(self.path_for_id(selector))
    }

    #[must_use]
    pub fn path_for_id(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.jsonl"))
    }
}

pub fn save_snapshot(path: &Path, snapshot: &SessionSnapshot) -> Result<(), RuntimeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            RuntimeError::new(format!("failed to create session directory: {error}"))
        })?;
    }
    let mut file = File::create(path)
        .map_err(|error| RuntimeError::new(format!("failed to write session: {error}")))?;
    let metadata = SessionRecord::Metadata {
        version: snapshot.version,
        id: snapshot.id.clone(),
        model: snapshot.model.clone(),
        reasoning_effort: snapshot.reasoning_effort.clone(),
        system_prompt: snapshot.system_prompt.clone(),
        created_at_ms: snapshot.created_at_ms,
        updated_at_ms: now_ms(),
    };
    write_record(&mut file, &metadata)?;
    for message in &snapshot.messages {
        write_record(
            &mut file,
            &SessionRecord::Message {
                message: message.clone(),
            },
        )?;
    }
    Ok(())
}

pub fn load_snapshot(path: &Path) -> Result<SessionSnapshot, RuntimeError> {
    let file = File::open(path)
        .map_err(|error| RuntimeError::new(format!("failed to read session: {error}")))?;
    let reader = BufReader::new(file);
    let mut metadata = None;
    let mut messages = Vec::new();
    for line in reader.lines() {
        let line =
            line.map_err(|error| RuntimeError::new(format!("failed to read session: {error}")))?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionRecord>(&line)
            .map_err(|error| RuntimeError::new(format!("invalid session record: {error}")))?
        {
            SessionRecord::Metadata {
                version,
                id,
                model,
                reasoning_effort,
                system_prompt,
                created_at_ms,
                updated_at_ms,
            } => {
                metadata = Some((
                    version,
                    id,
                    model,
                    reasoning_effort,
                    system_prompt,
                    created_at_ms,
                    updated_at_ms,
                ));
            }
            SessionRecord::Message { message } => messages.push(message),
        }
    }
    let Some((version, id, model, reasoning_effort, system_prompt, created_at_ms, updated_at_ms)) =
        metadata
    else {
        return Err(RuntimeError::new("session is missing metadata"));
    };
    if version != SESSION_VERSION {
        return Err(RuntimeError::new(format!(
            "unsupported session version {version}; expected {SESSION_VERSION}"
        )));
    }
    Ok(SessionSnapshot {
        version,
        id,
        model,
        reasoning_effort,
        system_prompt,
        created_at_ms,
        updated_at_ms,
        messages,
    })
}

#[must_use]
pub fn new_session_id() -> String {
    format!("session-{}", now_ms())
}

fn write_record(file: &mut File, record: &SessionRecord) -> Result<(), RuntimeError> {
    let line = serde_json::to_string(record)
        .map_err(|error| RuntimeError::new(format!("failed to encode session: {error}")))?;
    writeln!(file, "{line}")
        .map_err(|error| RuntimeError::new(format!("failed to write session: {error}")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use solarcido_api::InputMessage;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        std::env::temp_dir().join(format!(
            "solarcido-session-test-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn roundtrips_jsonl_session_snapshot() {
        let dir = unique_test_dir("roundtrip");
        let path = dir.join("sample.jsonl");
        let snapshot = SessionSnapshot::new(
            "sample",
            "solar-pro3-260323",
            "medium",
            "system",
            vec![InputMessage::user_text("hello")],
        );

        save_snapshot(&path, &snapshot).unwrap();
        let loaded = load_snapshot(&path).unwrap();

        assert_eq!(loaded.id, "sample");
        assert_eq!(loaded.messages.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn latest_selector_resolves_to_pointer_id() {
        let dir = unique_test_dir("latest");
        let store = SessionStore::new(&dir);
        let snapshot = SessionSnapshot::new(
            "abc",
            "solar-pro3-260323",
            "medium",
            "system",
            vec![InputMessage::user_text("hello")],
        );

        let saved = store.save(&snapshot).unwrap();
        let resolved = store.resolve_selector("latest").unwrap();

        assert_eq!(resolved, saved);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_sessions_newest_first() {
        let dir = unique_test_dir("list");
        let store = SessionStore::new(&dir);
        store
            .save(&SessionSnapshot::new(
                "first",
                "solar-pro3-260323",
                "medium",
                "system",
                vec![InputMessage::user_text("hello")],
            ))
            .unwrap();
        store
            .save(&SessionSnapshot::new(
                "second",
                "solar-pro3-260323",
                "medium",
                "system",
                vec![InputMessage::user_text("hello")],
            ))
            .unwrap();

        let sessions = store.list().unwrap();

        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|session| session.id == "first"));
        assert!(sessions.iter().any(|session| session.id == "second"));
        let _ = fs::remove_dir_all(dir);
    }
}
