use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use mock_solar_service::{MockSolarService, SCENARIO_PREFIX};
use serde_json::{json, Value};
use solarcido_api::InputContentBlock;
use solarcido_runtime::{SessionSnapshot, SessionStore};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)]
async fn clean_env_cli_reaches_mock_solar_service_across_scripted_parity_scenarios() {
    let manifest_entries = load_scenario_manifest();
    let manifest = manifest_entries
        .iter()
        .cloned()
        .map(|entry| (entry.name.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let service = MockSolarService::spawn()
        .await
        .expect("mock service should start");
    let base_url = service.base_url();

    let cases = [
        ScenarioCase {
            name: "streaming_text",
            permission_mode: "read-only",
            output_format: OutputFormat::Text,
            stdin: None,
            prepare: prepare_noop,
            assert: assert_streaming_text,
        },
        ScenarioCase {
            name: "read_file_roundtrip",
            permission_mode: "read-only",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_read_fixture,
            assert: assert_read_file_roundtrip,
        },
        ScenarioCase {
            name: "grep_chunk_assembly",
            permission_mode: "read-only",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_grep_fixture,
            assert: assert_grep_chunk_assembly,
        },
        ScenarioCase {
            name: "write_file_allowed",
            permission_mode: "workspace-write",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_write_fixture,
            assert: assert_write_file_allowed,
        },
        ScenarioCase {
            name: "write_file_denied",
            permission_mode: "read-only",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_noop,
            assert: assert_write_file_denied,
        },
        ScenarioCase {
            name: "multi_tool_turn_roundtrip",
            permission_mode: "read-only",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_multi_tool_fixture,
            assert: assert_multi_tool_turn_roundtrip,
        },
        ScenarioCase {
            name: "bash_stdout_roundtrip",
            permission_mode: "danger-full-access",
            output_format: OutputFormat::Json,
            stdin: None,
            prepare: prepare_noop,
            assert: assert_bash_stdout_roundtrip,
        },
        ScenarioCase {
            name: "bash_permission_prompt_approved",
            permission_mode: "workspace-write",
            output_format: OutputFormat::Json,
            stdin: Some("y\n"),
            prepare: prepare_noop,
            assert: assert_bash_permission_prompt_approved,
        },
        ScenarioCase {
            name: "bash_permission_prompt_denied",
            permission_mode: "workspace-write",
            output_format: OutputFormat::Json,
            stdin: Some("n\n"),
            prepare: prepare_noop,
            assert: assert_bash_permission_prompt_denied,
        },
    ];

    let case_names = cases.iter().map(|case| case.name).collect::<Vec<_>>();
    let manifest_names = manifest_entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        case_names, manifest_names,
        "manifest and harness cases must stay aligned"
    );

    let mut scenario_reports = Vec::new();

    for case in cases {
        let workspace = HarnessWorkspace::new(unique_temp_dir(case.name));
        workspace.create().expect("workspace should exist");

        let run = run_case(case, &workspace, &base_url);
        (case.assert)(&workspace, &run);

        let manifest_entry = manifest
            .get(case.name)
            .unwrap_or_else(|| panic!("missing manifest entry for {}", case.name));
        scenario_reports.push(build_scenario_report(
            case.name,
            manifest_entry,
            &run,
        ));

        fs::remove_dir_all(&workspace.root).expect("workspace cleanup should succeed");
    }

    let captured = service.captured_requests().await;
    let messages_only: Vec<_> = captured
        .iter()
        .filter(|request| request.path.ends_with("/chat/completions"))
        .collect();
    assert_eq!(messages_only.len(), 17);
    assert!(messages_only
        .first()
        .is_some_and(|request| request.stream));
    assert!(messages_only.iter().skip(1).all(|request| !request.stream));

    let scenarios = messages_only
        .iter()
        .map(|request| request.scenario.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        scenarios,
        vec![
            "streaming_text",
            "read_file_roundtrip",
            "read_file_roundtrip",
            "grep_chunk_assembly",
            "grep_chunk_assembly",
            "write_file_allowed",
            "write_file_allowed",
            "write_file_denied",
            "write_file_denied",
            "multi_tool_turn_roundtrip",
            "multi_tool_turn_roundtrip",
            "bash_stdout_roundtrip",
            "bash_stdout_roundtrip",
            "bash_permission_prompt_approved",
            "bash_permission_prompt_approved",
            "bash_permission_prompt_denied",
            "bash_permission_prompt_denied",
        ]
    );

    let mut request_counts = BTreeMap::new();
    for request in &captured {
        *request_counts
            .entry(request.scenario.as_str())
            .or_insert(0_usize) += 1;
    }
    for report in &mut scenario_reports {
        report.request_count = *request_counts
            .get(report.name.as_str())
            .unwrap_or_else(|| panic!("missing request count for {}", report.name));
    }

    maybe_write_report(&scenario_reports);
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_latest_session_roundtrip_keeps_the_previous_session_id() {
    let service = MockSolarService::spawn()
        .await
        .expect("mock service should start");
    let workspace = HarnessWorkspace::new(unique_temp_dir("session_resume"));
    workspace.create().expect("workspace should exist");

    let first = run_prompt(
        &workspace,
        &service.base_url(),
        &format!("{SCENARIO_PREFIX}streaming_text"),
        "read-only",
        OutputFormat::Json,
        None,
        None,
        prepare_noop,
    );
    let first = first.expect("first prompt should run");
    let first_session_id = first.session.id.clone();

    let resumed = run_prompt(
        &workspace,
        &service.base_url(),
        &format!("{SCENARIO_PREFIX}streaming_text"),
        "read-only",
        OutputFormat::Json,
        Some(first_session_id.as_str()),
        None,
        prepare_noop,
    )
    .expect("resumed prompt should run");

    let resumed_session_id = resumed
        .response
        .as_ref()
        .and_then(|value| value.get("session_id"))
        .and_then(Value::as_str)
        .expect("resumed session id");
    assert_eq!(resumed_session_id, first_session_id);
    assert_eq!(resumed.session.id, first_session_id);
    assert_eq!(resumed.session.messages.len(), 4);

    fs::remove_dir_all(&workspace.root).expect("workspace cleanup should succeed");
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_command_lists_configured_servers_from_config() {
    let service = MockSolarService::spawn()
        .await
        .expect("mock service should start");
    let workspace = HarnessWorkspace::new(unique_temp_dir("mcp"));
    workspace.create().expect("workspace should exist");
    write_mcp_config(&workspace, &service.base_url());

    let output = Command::new(env!("CARGO_BIN_EXE_solarcido"))
        .current_dir(&workspace.root)
        .env("SOLARCIDO_HOME", &workspace.home)
        .env("HOME", &workspace.home)
        .env("USERPROFILE", &workspace.home)
        .env("NO_COLOR", "1")
        .args([
            "--model",
            "solar-pro3-260323",
            "--permission-mode",
            "read-only",
            "--output-format",
            "json",
            "mcp",
        ])
        .output()
        .expect("solarcido should launch");
    assert_success(&output);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = parse_json_output(&stdout);
    assert_eq!(json["count"], 1);
    assert_eq!(json["servers"][0]["name"], "alpha");
    assert_eq!(json["servers"][0]["transport"], "http");
    assert!(
        json["servers"][0]["summary"]
            .as_str()
            .is_some_and(|summary| summary.contains(&service.base_url()))
    );

    fs::remove_dir_all(&workspace.root).expect("workspace cleanup should succeed");
}

#[derive(Clone, Copy)]
struct ScenarioCase {
    name: &'static str,
    permission_mode: &'static str,
    output_format: OutputFormat,
    stdin: Option<&'static str>,
    prepare: fn(&HarnessWorkspace),
    assert: fn(&HarnessWorkspace, &ScenarioRun),
}

#[derive(Clone, Copy)]
enum OutputFormat {
    Text,
    Json,
}

struct HarnessWorkspace {
    root: PathBuf,
    config_home: PathBuf,
    home: PathBuf,
}

impl HarnessWorkspace {
    fn new(root: PathBuf) -> Self {
        Self {
            config_home: root.join("config-home"),
            home: root.join("home"),
            root,
        }
    }

    fn create(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.config_home)?;
        fs::create_dir_all(&self.home)?;
        Ok(())
    }
}

struct ScenarioRun {
    stdout: String,
    stderr: String,
    response: Option<Value>,
    session: SessionSnapshot,
}

#[derive(Debug, Clone)]
struct ScenarioManifestEntry {
    name: String,
    category: String,
    description: String,
    parity_refs: Vec<String>,
}

#[derive(Debug)]
struct ScenarioReport {
    name: String,
    category: String,
    description: String,
    parity_refs: Vec<String>,
    iterations: u64,
    request_count: usize,
    tool_uses: Vec<String>,
    tool_error_count: usize,
    final_message: String,
}

fn run_case(case: ScenarioCase, workspace: &HarnessWorkspace, base_url: &str) -> ScenarioRun {
    let prompt = format!("{SCENARIO_PREFIX}{}", case.name);
    run_prompt(
        workspace,
        base_url,
        &prompt,
        case.permission_mode,
        case.output_format,
        None,
        case.stdin,
        case.prepare,
    )
    .expect("scenario should run")
}

fn run_prompt(
    workspace: &HarnessWorkspace,
    base_url: &str,
    prompt: &str,
    permission_mode: &str,
    output_format: OutputFormat,
    resume: Option<&str>,
    stdin: Option<&str>,
    prepare: fn(&HarnessWorkspace),
) -> Result<ScenarioRun, String> {
    (prepare)(workspace);

    let mut command = Command::new(env!("CARGO_BIN_EXE_solarcido"));
    command
        .current_dir(&workspace.root)
        .env("UPSTAGE_API_KEY", "test-parity-key")
        .env("UPSTAGE_BASE_URL", base_url)
        .env("SOLARCIDO_HOME", &workspace.home)
        .env("HOME", &workspace.home)
        .env("USERPROFILE", &workspace.home)
        .env("NO_COLOR", "1")
        .args([
            "--model",
            "solar-pro3-260323",
            "--permission-mode",
            permission_mode,
        ]);

    match output_format {
        OutputFormat::Text => {
            command.args(["--output-format", "text"]);
        }
        OutputFormat::Json => {
            command.args(["--output-format", "json"]);
        }
    }

    if let Some(resume) = resume {
        command.args(["--resume", resume]);
    }

    command.arg("prompt").arg(prompt);

    let output = if let Some(stdin) = stdin {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("solarcido should launch: {error}"))?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "stdin should be piped".to_string())?
            .write_all(stdin.as_bytes())
            .map_err(|error| format!("stdin should write: {error}"))?;
        child
            .wait_with_output()
            .map_err(|error| format!("solarcido should finish: {error}"))?
    } else {
        command
            .output()
            .map_err(|error| format!("solarcido should launch: {error}"))?
    };

    assert_success(&output);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let response = match output_format {
        OutputFormat::Json => Some(parse_json_output(&stdout)),
        OutputFormat::Text => None,
    };
    let session = load_latest_session(workspace)?;
    Ok(ScenarioRun {
        stdout,
        stderr,
        response,
        session,
    })
}

#[allow(dead_code)]
fn run_command(
    workspace: &HarnessWorkspace,
    extra_args: &[&str],
    command_name: &str,
    output_format: &str,
    permission_mode: &str,
    stdin: Option<&str>,
) -> Result<ScenarioRun, String> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_solarcido"));
    command
        .current_dir(&workspace.root)
        .env("UPSTAGE_API_KEY", "test-parity-key")
        .env("SOLARCIDO_HOME", &workspace.home)
        .env("HOME", &workspace.home)
        .env("USERPROFILE", &workspace.home)
        .env("NO_COLOR", "1")
        .args([
            "--model",
            "solar-pro3-260323",
            "--permission-mode",
            permission_mode,
            "--output-format",
            output_format,
        ]);
    for arg in extra_args {
        command.arg(arg);
    }
    command.arg(command_name);

    let output = if let Some(stdin) = stdin {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("solarcido should launch: {error}"))?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "stdin should be piped".to_string())?
            .write_all(stdin.as_bytes())
            .map_err(|error| format!("stdin should write: {error}"))?;
        child
            .wait_with_output()
            .map_err(|error| format!("solarcido should finish: {error}"))?
    } else {
        command
            .output()
            .map_err(|error| format!("solarcido should launch: {error}"))?
    };

    assert_success(&output);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let response = (output_format == "json").then(|| parse_json_output(&stdout));
    let session = load_latest_session(workspace)?;
    Ok(ScenarioRun {
        stdout,
        stderr,
        response,
        session,
    })
}

fn load_latest_session(workspace: &HarnessWorkspace) -> Result<SessionSnapshot, String> {
    let store = SessionStore::for_workspace(&workspace.root);
    store
        .load("latest")
        .map_err(|error| format!("failed to load latest session: {error}"))
}

fn prepare_noop(_: &HarnessWorkspace) {}

fn prepare_read_fixture(workspace: &HarnessWorkspace) {
    fs::write(workspace.root.join("fixture.txt"), "alpha parity line\n")
        .expect("fixture should write");
}

fn prepare_grep_fixture(workspace: &HarnessWorkspace) {
    fs::write(
        workspace.root.join("fixture.txt"),
        "alpha parity line\nbeta line\ngamma parity line\n",
    )
    .expect("grep fixture should write");
}

fn prepare_multi_tool_fixture(workspace: &HarnessWorkspace) {
    fs::write(
        workspace.root.join("fixture.txt"),
        "alpha parity line\nbeta line\ngamma parity line\n",
    )
    .expect("multi tool fixture should write");
}

fn prepare_write_fixture(workspace: &HarnessWorkspace) {
    fs::create_dir_all(workspace.root.join("generated")).expect("generated dir should write");
}

#[allow(dead_code)]
fn prepare_plugin_fixture(workspace: &HarnessWorkspace) {
    let plugin_root = workspace
        .root
        .join("external-plugins")
        .join("parity-plugin");
    let tool_dir = plugin_root.join("tools");
    let manifest_dir = plugin_root.join(".solarcido-plugin");
    fs::create_dir_all(&tool_dir).expect("plugin tools dir");
    fs::create_dir_all(&manifest_dir).expect("plugin manifest dir");

    let script_path = tool_dir.join("echo-json.sh");
    fs::write(
        &script_path,
        "#!/bin/sh\nINPUT=$(cat)\nprintf '{\"plugin\":\"%s\",\"tool\":\"%s\",\"input\":%s}\\n' \"$SOLARCIDO_PLUGIN_ID\" \"$SOLARCIDO_TOOL_NAME\" \"$INPUT\"\n",
    )
    .expect("plugin script should write");

    fs::write(
        manifest_dir.join("plugin.json"),
        r#"{
  "name": "parity-plugin",
  "version": "1.0.0",
  "description": "mock parity plugin",
  "tools": [
    {
      "name": "plugin_echo",
      "description": "Echo JSON input",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      },
      "command": "./tools/echo-json.sh",
      "requiredPermission": "workspace-write"
    }
  ]
}"#,
    )
    .expect("plugin manifest should write");

    fs::write(
        workspace.config_home.join("settings.json"),
        json!({
            "enabledPlugins": {
                "parity-plugin@external": true
            },
            "plugins": {
                "externalDirectories": [plugin_root.parent().expect("plugin parent").display().to_string()]
            }
        })
        .to_string(),
    )
    .expect("plugin settings should write");
}

fn write_mcp_config(workspace: &HarnessWorkspace, base_url: &str) {
    fs::write(
        workspace.home.join("config.json"),
        json!({
            "mcp": {
                "servers": {
                    "alpha": {
                        "type": "http",
                        "url": base_url
                    }
                }
            }
        })
        .to_string(),
    )
    .expect("mcp config should write");
}

fn assert_streaming_text(_: &HarnessWorkspace, run: &ScenarioRun) {
    assert_eq!(
        run.stdout.trim_end(),
        "Mock streaming says hello from the parity harness."
    );
    assert!(run.stderr.contains("[status]"));
    assert_eq!(run.session.messages.len(), 2);
}

fn assert_read_file_roundtrip(workspace: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    assert!(response["assistant"]
        .as_str()
        .expect("assistant text")
        .contains("alpha parity line"));
    assert_eq!(run.session.messages.len(), 4);
    let assistant = assistant_message(&run.session);
    assert!(assistant.iter().any(|block| matches!(
        block,
        InputContentBlock::ToolUse { name, .. } if name == "read_file"
    )));
    assert!(workspace.root.join("fixture.txt").exists());
}

fn assert_grep_chunk_assembly(_: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    assert!(response["assistant"]
        .as_str()
        .expect("assistant text")
        .contains("2 occurrences"));
    assert!(!latest_tool_result_is_error(&run.session).expect("tool result"));
}

fn assert_write_file_allowed(workspace: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    let generated = workspace.root.join("generated").join("output.txt");
    assert!(
        generated.exists(),
        "generated file should exist; session: {:#?}",
        run.session
    );
    let contents = fs::read_to_string(&generated).expect("generated file should exist");
    assert_eq!(contents, "created by mock service\n");
    assert!(response["assistant"]
        .as_str()
        .expect("assistant text")
        .contains("generated/output.txt"));
}

fn assert_write_file_denied(workspace: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    assert!(response["assistant"]
        .as_str()
        .expect("assistant text")
        .contains("denied as expected"));
    assert!(!workspace.root.join("generated").join("denied.txt").exists());
    assert!(latest_tool_result_text(&run.session)
        .as_deref()
        .is_some_and(|text| text.starts_with("ERROR:")));
}

fn assert_multi_tool_turn_roundtrip(_: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    let assistant = assistant_message(&run.session);
    let tool_use_names = assistant
        .iter()
        .filter_map(|block| match block {
            InputContentBlock::ToolUse { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(tool_use_names, vec!["read_file", "grep_search"]);
    assert!(run
        .response
        .as_ref()
        .and_then(|value| value["assistant"].as_str())
        .is_some_and(|text| text.contains("alpha parity line")));
}

fn assert_bash_stdout_roundtrip(_: &HarnessWorkspace, run: &ScenarioRun) {
    let response = run.response.as_ref().expect("json response");
    assert_eq!(response["iterations"], Value::from(2));
    assert!(response["assistant"]
        .as_str()
        .expect("assistant text")
        .contains("alpha from bash"));
}

fn assert_bash_permission_prompt_approved(_: &HarnessWorkspace, run: &ScenarioRun) {
    assert!(run.stderr.contains("Tool `bash` requires"));
    assert!(run.stderr.contains("Allow? [y/N]"));
    assert!(run
        .response
        .as_ref()
        .and_then(|value| value["assistant"].as_str())
        .is_some_and(|text| text.contains("approved and executed")));
}

fn assert_bash_permission_prompt_denied(_: &HarnessWorkspace, run: &ScenarioRun) {
    assert!(run.stderr.contains("Tool `bash` requires"));
    assert!(run.stderr.contains("Allow? [y/N]"));
    assert!(run
        .response
        .as_ref()
        .and_then(|value| value["assistant"].as_str())
        .is_some_and(|text| text.contains("denied as expected")));
    assert!(latest_tool_result_text(&run.session)
        .as_deref()
        .is_some_and(|text| text.starts_with("ERROR:")));
}

#[allow(dead_code)]
fn assert_plugin_tool_roundtrip(_: &HarnessWorkspace, run: &ScenarioRun) {
    let assistant = assistant_message(&run.session);
    let tool_use = assistant
        .iter()
        .find_map(|block| match block {
            InputContentBlock::ToolUse { name, input, .. } if name == "plugin_echo" => {
                Some((name.clone(), input.clone()))
            }
            _ => None,
        })
        .expect("plugin tool use");
    assert_eq!(tool_use.0, "plugin_echo");
    assert_eq!(tool_use.1["message"], Value::String("hello from plugin parity".to_string()));
}

fn assistant_message(session: &SessionSnapshot) -> &[InputContentBlock] {
    session
        .messages
        .iter()
        .find(|message| message.role == "assistant")
        .map(|message| message.content.as_slice())
        .expect("assistant message")
}

fn latest_tool_result_is_error(session: &SessionSnapshot) -> Option<bool> {
    session.messages.iter().rev().find_map(|message| {
        message.content.iter().rev().find_map(|block| match block {
            InputContentBlock::ToolResult {
                content,
                is_error,
                ..
            } => Some(
                *is_error
                    || content.iter().any(|content_block| match content_block {
                        solarcido_api::ToolResultContentBlock::Text { text } => {
                            text.starts_with("ERROR:")
                        }
                        solarcido_api::ToolResultContentBlock::Json { value } => value
                            .get("error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }),
            ),
            _ => None,
        })
    })
}

fn latest_tool_result_text(session: &SessionSnapshot) -> Option<String> {
    session.messages.iter().rev().find_map(|message| {
        message.content.iter().rev().find_map(|block| match block {
            InputContentBlock::ToolResult { content, .. } => content.iter().rev().find_map(|content_block| match content_block {
                solarcido_api::ToolResultContentBlock::Text { text } => Some(text.clone()),
                solarcido_api::ToolResultContentBlock::Json { value } => Some(value.to_string()),
            }),
            _ => None,
        })
    })
}

fn build_scenario_report(
    name: &str,
    manifest_entry: &ScenarioManifestEntry,
    run: &ScenarioRun,
) -> ScenarioReport {
    ScenarioReport {
        name: name.to_string(),
        category: manifest_entry.category.clone(),
        description: manifest_entry.description.clone(),
        parity_refs: manifest_entry.parity_refs.clone(),
        iterations: run
            .response
            .as_ref()
            .and_then(|value| value.get("iterations"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                if run.stdout.trim().is_empty() {
                    0
                } else {
                    1
                }
            }),
        request_count: 0,
        tool_uses: run
            .session
            .messages
            .iter()
            .flat_map(|message| message.content.iter())
            .filter_map(|block| match block {
                InputContentBlock::ToolUse { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect(),
        tool_error_count: run
            .session
            .messages
            .iter()
            .flat_map(|message| message.content.iter())
            .filter_map(|block| match block {
                InputContentBlock::ToolResult { content, is_error, .. } => Some(
                    *is_error
                        || content.iter().any(|content_block| match content_block {
                            solarcido_api::ToolResultContentBlock::Text { text } => {
                                text.starts_with("ERROR:")
                            }
                            solarcido_api::ToolResultContentBlock::Json { value } => value
                                .get("error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        }),
                ),
                _ => None,
            })
            .filter(|is_error| *is_error)
            .count(),
        final_message: run
            .response
            .as_ref()
            .and_then(|value| value.get("assistant"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| run.stdout.trim_end().to_string()),
    }
}

fn maybe_write_report(reports: &[ScenarioReport]) {
    let Some(path) = std::env::var_os("MOCK_PARITY_REPORT_PATH") else {
        return;
    };

    let payload = json!({
        "scenario_count": reports.len(),
        "request_count": reports.iter().map(|report| report.request_count).sum::<usize>(),
        "scenarios": reports.iter().map(scenario_report_json).collect::<Vec<_>>(),
    });
    fs::write(
        path,
        serde_json::to_vec_pretty(&payload).expect("report json should serialize"),
    )
    .expect("report should write");
}

fn load_scenario_manifest() -> Vec<ScenarioManifestEntry> {
    let manifest_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mock_parity_scenarios.json");
    let manifest = fs::read_to_string(&manifest_path).expect("scenario manifest should exist");
    serde_json::from_str::<Vec<Value>>(&manifest)
        .expect("scenario manifest should parse")
        .into_iter()
        .map(|entry| ScenarioManifestEntry {
            name: entry["name"]
                .as_str()
                .expect("scenario name should be a string")
                .to_string(),
            category: entry["category"]
                .as_str()
                .expect("scenario category should be a string")
                .to_string(),
            description: entry["description"]
                .as_str()
                .expect("scenario description should be a string")
                .to_string(),
            parity_refs: entry["parity_refs"]
                .as_array()
                .expect("parity refs should be an array")
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .expect("parity ref should be a string")
                        .to_string()
                })
                .collect(),
        })
        .collect()
}

fn scenario_report_json(report: &ScenarioReport) -> Value {
    json!({
        "name": report.name,
        "category": report.category,
        "description": report.description,
        "parity_refs": report.parity_refs,
        "iterations": report.iterations,
        "request_count": report.request_count,
        "tool_uses": report.tool_uses,
        "tool_error_count": report.tool_error_count,
        "final_message": report.final_message,
    })
}

fn parse_json_output(stdout: &str) -> Value {
    serde_json::from_str(stdout).unwrap_or_else(|error| {
        panic!("failed to parse JSON response from stdout: {error}\n{stdout}")
    })
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout:\n{}\n\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn unique_temp_dir(label: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after epoch")
        .as_millis();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "solarcido-mock-parity-{label}-{}-{millis}-{counter}",
        std::process::id()
    ))
}
