use solarcido_api::{ContentBlockDelta, ReasoningEffort, SolarClient, StreamEvent, DEFAULT_MODEL};
use solarcido_commands::{
    render_slash_command_help_json, resolve_slash_command, slash_command_specs, SlashCommand,
};
use solarcido_runtime::{
    get_config_value, new_session_id, set_config_value, system_prompt_with_memory,
    usage::UsageTracker, ConfigStore, ConversationRuntime, McpToolAdapter, PermissionMode,
    PermissionPrompter, PermissionRequest, RuntimeStatusEvent, SessionStore, SolarcidoConfig,
    DEFAULT_MAX_OUTPUT_TOKENS,
};
use solarcido_tools::WorkspaceTools;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_CYAN: &str = "\x1b[38;5;87m";
const ANSI_SLATE: &str = "\x1b[38;5;244m";
const ANSI_YELLOW_BOLD: &str = "\x1b[38;5;220m\x1b[1m";
const ANSI_AMBER_BOLD: &str = "\x1b[38;5;214m\x1b[1m";
const ANSI_CYAN_BOLD: &str = "\x1b[38;5;87m\x1b[1m";
const SOLAR_PRO_MAX_OUTPUT_TOKENS: u32 = 16_384;

const LOGO_LINES: &[&str] = &[
    "   _____       __               _     __",
    "  / ___/____  / /___ __________(_)___/ /___",
    "  \\__ \\/ __ \\/ / __ `/ ___/ ___/ / __  / __ \\",
    " ___/ / /_/ / / /_/ / /  / /__/ / /_/ / /_/ /",
    "/____/\\____/_/\\__,_/_/   \\___/_/\\__,_/\\____/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Text,
    Json,
}

#[derive(Debug, Clone)]
enum CliAction {
    Prompt {
        prompt: String,
        model: String,
        cwd: PathBuf,
        output_format: OutputFormat,
        permission_mode: PermissionMode,
        reasoning_effort: ReasoningEffort,
        max_output_tokens: u32,
        resume: Option<String>,
    },
    Repl {
        model: String,
        cwd: PathBuf,
        permission_mode: PermissionMode,
        reasoning_effort: ReasoningEffort,
        max_output_tokens: u32,
        resume: Option<String>,
    },
    Status {
        model: String,
        output_format: OutputFormat,
        permission_mode: PermissionMode,
        reasoning_effort: ReasoningEffort,
        max_output_tokens: u32,
    },
    Sandbox {
        output_format: OutputFormat,
        permission_mode: PermissionMode,
    },
    Agents {
        output_format: OutputFormat,
    },
    Mcp {
        output_format: OutputFormat,
    },
    Skills {
        output_format: OutputFormat,
    },
    SystemPrompt {
        output_format: OutputFormat,
        permission_mode: PermissionMode,
    },
    Config {
        action: ConfigAction,
        output_format: OutputFormat,
    },
    Sessions {
        action: SessionsAction,
        cwd: PathBuf,
        output_format: OutputFormat,
    },
    Memory {
        output_format: OutputFormat,
    },
    Init {
        cwd: PathBuf,
        output_format: OutputFormat,
    },
    Help {
        output_format: OutputFormat,
    },
    Version {
        output_format: OutputFormat,
    },
}

#[derive(Debug, Clone)]
enum ConfigAction {
    Get { key: Option<String> },
    Set { key: String, value: String },
    Path,
}

#[derive(Debug, Clone)]
enum SessionsAction {
    List,
    Show { selector: String },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("[error-kind: runtime]\nerror: {error}\n\nRun `solarcido --help` for usage.");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    load_dotenv_if_present();
    let config_store = ConfigStore::from_env()?;
    let config = config_store.load()?;

    match parse_args(std::env::args().skip(1).collect(), &config)? {
        CliAction::Prompt {
            prompt,
            model,
            cwd,
            output_format,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
            resume,
        } => {
            let memory = config_store.load_memory()?;
            run_prompt(
                &prompt,
                &model,
                cwd,
                output_format,
                permission_mode,
                reasoning_effort,
                max_output_tokens,
                resume.as_deref(),
                memory.as_deref(),
            )
            .await?;
        }
        CliAction::Repl {
            model,
            cwd,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
            resume,
        } => {
            let memory = config_store.load_memory()?;
            run_repl(
                &config,
                model,
                cwd,
                permission_mode,
                reasoning_effort,
                max_output_tokens,
                resume.as_deref(),
                memory.as_deref(),
            )
            .await?
        }
        CliAction::Status {
            model,
            output_format,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
        } => print_status(
            &model,
            output_format,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
        )?,
        CliAction::Sandbox {
            output_format,
            permission_mode,
        } => print_sandbox(output_format, permission_mode)?,
        CliAction::Agents { output_format } => print_agents(output_format)?,
        CliAction::Mcp { output_format } => print_mcp(&config, output_format)?,
        CliAction::Skills { output_format } => print_skills(output_format)?,
        CliAction::SystemPrompt {
            output_format,
            permission_mode,
        } => {
            let memory = config_store.load_memory()?;
            print_system_prompt(output_format, permission_mode, memory.as_deref())?
        }
        CliAction::Config {
            action,
            output_format,
        } => handle_config_command(&config_store, &config, action, output_format)?,
        CliAction::Sessions {
            action,
            cwd,
            output_format,
        } => handle_sessions_command(cwd, action, output_format)?,
        CliAction::Memory { output_format } => print_memory(&config_store, output_format)?,
        CliAction::Init { cwd, output_format } => run_init(&cwd, output_format)?,
        CliAction::Help { output_format } => print_help(output_format)?,
        CliAction::Version { output_format } => print_version(output_format)?,
    }
    Ok(())
}

fn load_dotenv_if_present() {
    let Ok(contents) = std::fs::read_to_string(".env") else {
        return;
    };

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }

        std::env::set_var(key, parse_dotenv_value(value.trim()));
    }
}

fn parse_dotenv_value(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }

    value.to_string()
}

fn paint(enabled: bool, style: &str, value: impl AsRef<str>) -> String {
    let value = value.as_ref();
    if enabled {
        format!("{style}{value}{ANSI_RESET}")
    } else {
        value.to_string()
    }
}

fn print_logo(color_enabled: bool) {
    println!();
    for line in LOGO_LINES {
        println!("{}", paint(color_enabled, ANSI_YELLOW_BOLD, line));
    }
    println!();
}

fn print_shell_header(
    model: &str,
    cwd: &std::path::Path,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    color_enabled: bool,
) {
    print_logo(color_enabled);
    println!(
        "  {}",
        paint(color_enabled, ANSI_CYAN_BOLD, "SOLARCIDO CODE")
    );
    println!(
        "  {}",
        paint(
            color_enabled,
            ANSI_SLATE,
            "Ask for code changes, repo analysis, or execution."
        )
    );
    println!(
        "  {}",
        paint(
            color_enabled,
            ANSI_SLATE,
            "Type /help for commands, /exit to quit."
        )
    );
    println!();
    print_shell_setting("model", model, color_enabled);
    print_shell_setting("cwd", cwd.display().to_string(), color_enabled);
    print_shell_setting("reasoning", reasoning_effort.as_str(), color_enabled);
    print_shell_setting("max output", max_output_tokens.to_string(), color_enabled);
    print_shell_setting("permission", permission_mode.as_str(), color_enabled);
    println!();
}

fn print_shell_setting(label: &str, value: impl AsRef<str>, color_enabled: bool) {
    println!(
        "  {}  {}",
        paint(color_enabled, ANSI_SLATE, format!("{label:<10}")),
        value.as_ref()
    );
}

fn shell_prompt(color_enabled: bool) -> String {
    format!("{} ", paint(color_enabled, ANSI_AMBER_BOLD, ">>"))
}

fn format_slash_command_help(color_enabled: bool) -> String {
    let mut out = String::from("Slash commands:\n");
    for spec in slash_command_specs() {
        let command = match spec.argument_hint {
            Some(hint) => format!("/{} {hint}", spec.name),
            None => format!("/{}", spec.name),
        };
        let aliases = if spec.aliases.is_empty() {
            String::new()
        } else {
            format!(" aliases: /{}", spec.aliases.join(", /"))
        };
        out.push_str(&format!(
            "  {:<38} {}{}\n",
            paint(color_enabled, ANSI_CYAN, command),
            paint(color_enabled, ANSI_SLATE, spec.summary),
            paint(color_enabled, ANSI_DIM, aliases),
        ));
    }
    out
}

fn format_repl_status(
    model: &str,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    turns: u32,
    color_enabled: bool,
) -> String {
    [
        format_status_line("model", model, color_enabled),
        format_status_line("permission", permission_mode.as_str(), color_enabled),
        format_status_line("reasoning", reasoning_effort.as_str(), color_enabled),
        format_status_line("max output", max_output_tokens.to_string(), color_enabled),
        format_status_line("turns", turns.to_string(), color_enabled),
    ]
    .join("\n")
}

fn format_status_line(label: &str, value: impl AsRef<str>, color_enabled: bool) -> String {
    format!(
        "  {}  {}",
        paint(color_enabled, ANSI_SLATE, format!("{label:<10}")),
        value.as_ref()
    )
}

fn parse_args(args: Vec<String>, config: &SolarcidoConfig) -> Result<CliAction, String> {
    let mut model = std::env::var("SOLARCIDO_MODEL").unwrap_or_else(|_| config.model.clone());
    let mut cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut output_format = OutputFormat::Text;
    let mut permission_mode = config.sandbox;
    let mut reasoning_effort = config.reasoning_effort;
    let mut max_output_tokens = match std::env::var("SOLARCIDO_MAX_OUTPUT_TOKENS") {
        Ok(value) => parse_max_output_tokens(&value)?,
        Err(_) => DEFAULT_MAX_OUTPUT_TOKENS,
    };
    let mut resume = None;
    let mut positionals = Vec::new();
    let mut index = 0usize;

    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => return Ok(CliAction::Help { output_format }),
            "--version" | "-V" => return Ok(CliAction::Version { output_format }),
            "--model" | "--model-name" => {
                index += 1;
                model = args
                    .get(index)
                    .ok_or("--model requires a value")?
                    .to_string();
            }
            "--cwd" => {
                index += 1;
                cwd = PathBuf::from(args.get(index).ok_or("--cwd requires a value")?);
            }
            "--output-format" => {
                index += 1;
                output_format = parse_output_format(
                    args.get(index).ok_or("--output-format requires a value")?,
                )?;
            }
            value if value.starts_with("--output-format=") => {
                output_format = parse_output_format(value.trim_start_matches("--output-format="))?;
            }
            "--permission-mode" => {
                index += 1;
                permission_mode = PermissionMode::parse(
                    args.get(index)
                        .ok_or("--permission-mode requires a value")?,
                )
                .map_err(|error| error.to_string())?;
            }
            "--dangerously-skip-permissions" => {
                permission_mode = PermissionMode::DangerFullAccess;
            }
            "--reasoning-effort" | "--reasoning" => {
                index += 1;
                reasoning_effort = ReasoningEffort::parse(
                    args.get(index)
                        .ok_or("--reasoning-effort requires a value")?,
                )
                .map_err(|error| error.to_string())?;
            }
            "--max-output-tokens" | "--max-tokens" => {
                index += 1;
                max_output_tokens = parse_max_output_tokens(
                    args.get(index)
                        .ok_or("--max-output-tokens requires a value")?,
                )?;
            }
            "--allowedTools" | "--allowed-tools" => {
                index += 1;
                let _ = args.get(index).ok_or("--allowedTools requires a value")?;
            }
            "--resume" => {
                if args
                    .get(index + 1)
                    .is_some_and(|value| !value.starts_with('-'))
                {
                    index += 1;
                    resume = Some(args[index].clone());
                } else {
                    resume = Some("latest".to_string());
                }
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {other}")),
            other => positionals.push(other.to_string()),
        }
        index += 1;
    }

    if positionals.is_empty() {
        return Ok(CliAction::Repl {
            model,
            cwd,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
            resume,
        });
    }

    match positionals[0].as_str() {
        "prompt" | "run" => {
            let prompt = positionals[1..].join(" ").trim().to_string();
            if prompt.is_empty() {
                return Err("prompt requires text".to_string());
            }
            Ok(CliAction::Prompt {
                prompt,
                model,
                cwd,
                output_format,
                permission_mode,
                reasoning_effort,
                max_output_tokens,
                resume,
            })
        }
        "status" => Ok(CliAction::Status {
            model,
            output_format,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
        }),
        "sandbox" => Ok(CliAction::Sandbox {
            output_format,
            permission_mode,
        }),
        "agents" => Ok(CliAction::Agents { output_format }),
        "mcp" => Ok(CliAction::Mcp { output_format }),
        "skills" => Ok(CliAction::Skills { output_format }),
        "system-prompt" => Ok(CliAction::SystemPrompt {
            output_format,
            permission_mode,
        }),
        "config" => parse_config_action(&positionals[1..], output_format),
        "sessions" => parse_sessions_action(&positionals[1..], cwd, output_format),
        "memory" => Ok(CliAction::Memory { output_format }),
        "init" => Ok(CliAction::Init { cwd, output_format }),
        "help" => Ok(CliAction::Help { output_format }),
        "version" => Ok(CliAction::Version { output_format }),
        other => Err(format!("unknown command: {other}")),
    }
}

fn parse_output_format(value: &str) -> Result<OutputFormat, String> {
    match value {
        "text" => Ok(OutputFormat::Text),
        "json" => Ok(OutputFormat::Json),
        other => Err(format!(
            "invalid output format `{other}`; expected text or json"
        )),
    }
}

fn parse_config_action(args: &[String], output_format: OutputFormat) -> Result<CliAction, String> {
    match args.first().map(String::as_str) {
        None | Some("get") => Ok(CliAction::Config {
            action: ConfigAction::Get {
                key: args.get(1).cloned(),
            },
            output_format,
        }),
        Some("set") => {
            let key = args
                .get(1)
                .ok_or("Usage: solarcido config set <key> <value>")?
                .clone();
            let value = args
                .get(2)
                .ok_or("Usage: solarcido config set <key> <value>")?
                .clone();
            if args.len() > 3 {
                return Err("Usage: solarcido config set <key> <value>".to_string());
            }
            Ok(CliAction::Config {
                action: ConfigAction::Set { key, value },
                output_format,
            })
        }
        Some("path") => Ok(CliAction::Config {
            action: ConfigAction::Path,
            output_format,
        }),
        Some(_) => Err(
            "Usage: solarcido config get [key] | config set <key> <value> | config path"
                .to_string(),
        ),
    }
}

fn parse_sessions_action(
    args: &[String],
    cwd: PathBuf,
    output_format: OutputFormat,
) -> Result<CliAction, String> {
    match args.first().map(String::as_str) {
        None | Some("list") => Ok(CliAction::Sessions {
            action: SessionsAction::List,
            cwd,
            output_format,
        }),
        Some("show") => {
            let selector = args
                .get(1)
                .ok_or("Usage: solarcido sessions show <id|latest|path>")?
                .clone();
            if args.len() > 2 {
                return Err("Usage: solarcido sessions show <id|latest|path>".to_string());
            }
            Ok(CliAction::Sessions {
                action: SessionsAction::Show { selector },
                cwd,
                output_format,
            })
        }
        Some(_) => {
            Err("Usage: solarcido sessions list | sessions show <id|latest|path>".to_string())
        }
    }
}

fn parse_max_output_tokens(value: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("invalid max output tokens `{value}`; expected a positive integer"))?;
    if parsed == 0 {
        return Err("max output tokens must be greater than zero".to_string());
    }
    if parsed > SOLAR_PRO_MAX_OUTPUT_TOKENS {
        return Err(format!(
            "max output tokens must be at most {SOLAR_PRO_MAX_OUTPUT_TOKENS} for Solar Pro"
        ));
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// One-shot prompt
// ---------------------------------------------------------------------------

async fn run_prompt(
    prompt: &str,
    model: &str,
    cwd: PathBuf,
    output_format: OutputFormat,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    resume: Option<&str>,
    memory: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = SolarClient::from_env()?;
    let canonical_cwd = cwd.canonicalize()?;
    let session_store = SessionStore::for_workspace(&canonical_cwd);
    let loaded = resume
        .map(|selector| session_store.load(selector))
        .transpose()?;
    let session_id = loaded
        .as_ref()
        .map_or_else(new_session_id, |snapshot| snapshot.id.clone());
    let tools = WorkspaceTools::new(&canonical_cwd);
    let mut runtime = ConversationRuntime::new(
        client,
        model,
        reasoning_effort,
        system_prompt_with_memory(permission_mode, memory),
        tools,
        permission_mode,
    )
    .with_max_output_tokens(max_output_tokens);
    if let Some(snapshot) = loaded {
        runtime = runtime.with_session(snapshot.session());
    }
    let mut prompter = CliPermissionPrompter;
    let use_streaming = output_format == OutputFormat::Text;

    let summary = if use_streaming {
        runtime
            .run_turn_streaming_with_status(
                prompt,
                Some(&mut prompter),
                |event| {
                    if let StreamEvent::ContentBlockDelta(ref delta) = event {
                        if let ContentBlockDelta::TextDelta { ref text } = delta.delta {
                            print!("{text}");
                            let _ = io::stdout().flush();
                        }
                    }
                },
                |event| print_api_status(event, model, reasoning_effort),
            )
            .await?
    } else {
        runtime
            .run_turn_with_status(prompt, Some(&mut prompter), |_| {})
            .await?
    };
    let session_path = session_store.save(&runtime.snapshot(&session_id))?;

    match output_format {
        OutputFormat::Text => {
            if !summary.assistant_text.is_empty() {
                println!();
            }
            eprintln!(
                "[usage] prompt={} completion={} total={}",
                summary.usage.prompt_tokens,
                summary.usage.completion_tokens,
                summary.usage.total_tokens()
            );
            eprintln!("[session] {}", session_path.display());
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "type": "result",
                "session_id": session_id,
                "session_path": session_path.to_string_lossy(),
                "assistant": summary.assistant_text,
                "iterations": summary.iterations,
                "usage": {
                    "prompt_tokens": summary.usage.prompt_tokens,
                    "completion_tokens": summary.usage.completion_tokens,
                    "total_tokens": summary.usage.total_tokens()
                }
            }))?
        ),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------

async fn run_repl(
    config: &SolarcidoConfig,
    model: String,
    cwd: PathBuf,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    resume: Option<&str>,
    memory: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let color_enabled = io::stdout().is_terminal();
    print_shell_header(
        &model,
        &cwd,
        permission_mode,
        reasoning_effort,
        max_output_tokens,
        color_enabled,
    );

    let client = SolarClient::from_env()?;
    let canonical_cwd = cwd.canonicalize()?;
    let session_store = SessionStore::for_workspace(&canonical_cwd);
    let loaded = resume
        .map(|selector| session_store.load(selector))
        .transpose()?;
    let session_id = loaded
        .as_ref()
        .map_or_else(new_session_id, |snapshot| snapshot.id.clone());
    let tools = WorkspaceTools::new(&canonical_cwd);
    let mut runtime = ConversationRuntime::new(
        client,
        &model,
        reasoning_effort,
        system_prompt_with_memory(permission_mode, memory),
        tools,
        permission_mode,
    )
    .with_max_output_tokens(max_output_tokens);
    if let Some(snapshot) = loaded {
        runtime = runtime.with_session(snapshot.session());
        print_shell_setting("session", format!("resumed {session_id}"), color_enabled);
    } else {
        print_shell_setting("session", &session_id, color_enabled);
    }
    println!();
    let mut prompter = CliPermissionPrompter;
    let mut usage_tracker = UsageTracker::new();

    loop {
        print!("{}", shell_prompt(color_enabled));
        io::stdout().flush()?;
        let mut line = String::new();
        if io::stdin().read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Slash command dispatch.
        if trimmed == "/" {
            println!("{}", format_slash_command_help(color_enabled));
            continue;
        }

        if trimmed.starts_with('/') {
            if let Some(cmd) = SlashCommand::parse(trimmed) {
                let handled = handle_slash_command(
                    config,
                    &cmd.name,
                    &cmd.args,
                    &model,
                    permission_mode,
                    reasoning_effort,
                    max_output_tokens,
                    &usage_tracker,
                    color_enabled,
                );
                match handled {
                    SlashResult::Output(text) => {
                        println!("{text}");
                        continue;
                    }
                    SlashResult::Exit => break,
                    SlashResult::Unhandled => {
                        // Fall through to send as prompt.
                    }
                }
            }
        }

        let summary = runtime
            .run_turn_streaming_with_status(
                trimmed,
                Some(&mut prompter),
                |event| {
                    if let StreamEvent::ContentBlockDelta(ref delta) = event {
                        if let ContentBlockDelta::TextDelta { ref text } = delta.delta {
                            print!("{text}");
                            let _ = io::stdout().flush();
                        }
                    }
                },
                |event| print_api_status(event, &model, reasoning_effort),
            )
            .await?;

        usage_tracker.record(solarcido_runtime::usage::TokenUsage {
            input_tokens: summary.usage.prompt_tokens,
            output_tokens: summary.usage.completion_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        });

        if !summary.assistant_text.is_empty() {
            println!();
        }
        let session_path = session_store.save(&runtime.snapshot(&session_id))?;
        eprintln!("[session] {}", session_path.display());
    }
    Ok(())
}

fn print_api_status(event: RuntimeStatusEvent, model: &str, reasoning_effort: ReasoningEffort) {
    match event {
        RuntimeStatusEvent::ApiRequestStarted { iteration } => eprintln!(
            "[status] Sending request to Solar API (model={model}, reasoning={}, iteration={iteration})...",
            reasoning_effort.as_str()
        ),
        RuntimeStatusEvent::ApiRequestWaiting { elapsed, .. } => eprintln!(
            "[status] Waiting for Solar response ({} elapsed)...",
            format_elapsed(elapsed)
        ),
        RuntimeStatusEvent::ApiRequestFinished { elapsed, .. } => eprintln!(
            "[status] Solar response received after {}.",
            format_elapsed(elapsed)
        ),
    }
}

fn format_elapsed(duration: std::time::Duration) -> String {
    let total_seconds = duration.as_secs();
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;

    if minutes == 0 {
        format!("{seconds}s")
    } else {
        format!("{minutes}m {seconds}s")
    }
}

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

enum SlashResult {
    Output(String),
    Exit,
    Unhandled,
}

fn handle_slash_command(
    config: &SolarcidoConfig,
    name: &str,
    args: &[String],
    model: &str,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    usage_tracker: &UsageTracker,
    color_enabled: bool,
) -> SlashResult {
    // Resolve through the registry so aliases work.
    let canonical = resolve_slash_command(&format!("/{name}"))
        .map(|spec| spec.name)
        .unwrap_or(name);

    match canonical {
        "help" => SlashResult::Output(format_slash_command_help(color_enabled)),
        "status" => SlashResult::Output(format_repl_status(
            model,
            permission_mode,
            reasoning_effort,
            max_output_tokens,
            usage_tracker.turns(),
            color_enabled,
        )),
        "sandbox" => SlashResult::Output(format!(
            "permission_mode: {}\nos_sandbox: not available",
            permission_mode.as_str()
        )),
        "compact" => SlashResult::Output("session compaction not yet implemented".to_string()),
        "model" => {
            if args.is_empty() {
                SlashResult::Output(format!("current model: {model}"))
            } else {
                SlashResult::Output(format!(
                    "model switching in REPL not yet implemented (requested: {})",
                    args[0]
                ))
            }
        }
        "permissions" => {
            if args.is_empty() {
                SlashResult::Output(format!(
                    "current permission mode: {}",
                    permission_mode.as_str()
                ))
            } else {
                SlashResult::Output(format!(
                    "permission switching in REPL not yet implemented (requested: {})",
                    args[0]
                ))
            }
        }
        "clear" => {
            // Print ANSI clear; actual session reset deferred.
            SlashResult::Output("\x1b[2J\x1b[H".to_string())
        }
        "cost" => {
            let cu = usage_tracker.cumulative_usage();
            let lines = cu.summary_lines_for_model("session", Some(model));
            SlashResult::Output(lines.join("\n"))
        }
        "resume" => SlashResult::Output("session resume not yet implemented".to_string()),
        "config" => {
            if args.is_empty() {
                SlashResult::Output("config inspection not yet implemented".to_string())
            } else {
                SlashResult::Output(format!("config section `{}` not yet implemented", args[0]))
            }
        }
        "mcp" => SlashResult::Output(format_mcp_servers(config, color_enabled)),
        "memory" => SlashResult::Output("memory inspection not yet implemented".to_string()),
        "init" => SlashResult::Output("use `solarcido init` from the CLI instead".to_string()),
        "diff" => SlashResult::Output("diff display not yet implemented".to_string()),
        "version" => SlashResult::Output(env!("CARGO_PKG_VERSION").to_string()),
        "session" => SlashResult::Output("session management not yet implemented".to_string()),
        "plugin" => SlashResult::Output("plugin management not yet implemented".to_string()),
        "agents" => SlashResult::Output("agent listing not yet implemented".to_string()),
        "skills" => SlashResult::Output("skill management not yet implemented".to_string()),
        "doctor" => SlashResult::Output("diagnostics not yet implemented".to_string()),
        "hooks" => SlashResult::Output("hooks not yet implemented".to_string()),
        "exit" => SlashResult::Exit,
        _ => SlashResult::Unhandled,
    }
}

// ---------------------------------------------------------------------------
// Direct CLI subcommands
// ---------------------------------------------------------------------------

fn print_status(
    model: &str,
    output_format: OutputFormat,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido status");
            println!("model: {model}");
            println!("provider: Upstage Solar OpenAI-compatible");
            println!("permission_mode: {}", permission_mode.as_str());
            println!("reasoning_effort: {}", reasoning_effort.as_str());
            println!("max_output_tokens: {max_output_tokens}");
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "model": model,
                "provider": "upstage-solar",
                "permission_mode": permission_mode.as_str(),
                "reasoning_effort": reasoning_effort.as_str(),
                "max_output_tokens": max_output_tokens
            }))?
        ),
    }
    Ok(())
}

fn print_sandbox(
    output_format: OutputFormat,
    permission_mode: PermissionMode,
) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido sandbox status");
            println!("permission_mode: {}", permission_mode.as_str());
            println!("os_sandbox: not available");
            println!(
                "note: OS-level sandboxing is not yet implemented. \
                 Permission enforcement is handled by the permission mode."
            );
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "permission_mode": permission_mode.as_str(),
                "os_sandbox": false,
                "note": "OS-level sandboxing not yet implemented"
            }))?
        ),
    }
    Ok(())
}

fn print_agents(output_format: OutputFormat) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido agents");
            println!("No agents configured. Agent support is not yet implemented.");
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "agents": [],
                "note": "Agent support not yet implemented"
            }))?
        ),
    }
    Ok(())
}

fn print_mcp(
    config: &SolarcidoConfig,
    output_format: OutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    let adapter = McpToolAdapter::from_config(&config.mcp);
    let servers = solarcido_runtime::mcp_server_summaries(&adapter);
    let server_count = servers.len();
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido MCP servers");
            if servers.is_empty() {
                println!("No MCP servers configured.");
            } else {
                for server in &servers {
                    println!(
                        "{}  transport={}  {}",
                        server.name, server.transport, server.summary
                    );
                }
            }
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "servers": servers
                    .iter()
                    .map(|server| serde_json::json!({
                        "name": server.name,
                        "transport": server.transport,
                        "summary": server.summary
                    }))
                    .collect::<Vec<_>>(),
                "count": server_count
            }))?
        ),
    }
    Ok(())
}

fn format_mcp_servers(config: &SolarcidoConfig, color_enabled: bool) -> String {
    let adapter = McpToolAdapter::from_config(&config.mcp);
    let servers = solarcido_runtime::mcp_server_summaries(&adapter);
    if servers.is_empty() {
        return "No MCP servers configured.".to_string();
    }

    let mut out = String::from("Configured MCP servers:\n");
    for server in servers {
        out.push_str(&format!(
            "  {}  {}  {}\n",
            paint(color_enabled, ANSI_CYAN, server.name),
            paint(
                color_enabled,
                ANSI_SLATE,
                format!("transport={}", server.transport)
            ),
            paint(color_enabled, ANSI_SLATE, server.summary),
        ));
    }
    out.trim_end().to_string()
}

fn print_skills(output_format: OutputFormat) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido skills");
            println!("No skills installed. Skill support is not yet implemented.");
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "skills": [],
                "note": "Skill support not yet implemented"
            }))?
        ),
    }
    Ok(())
}

fn print_system_prompt(
    output_format: OutputFormat,
    permission_mode: PermissionMode,
    memory: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let prompt = system_prompt_with_memory(permission_mode, memory);
    match output_format {
        OutputFormat::Text => println!("{prompt}"),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "system_prompt": prompt
            }))?
        ),
    }
    Ok(())
}

fn handle_config_command(
    store: &ConfigStore,
    config: &SolarcidoConfig,
    action: ConfigAction,
    output_format: OutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ConfigAction::Get { key } => {
            let value = get_config_value(config, key.as_deref())?;
            match output_format {
                OutputFormat::Text | OutputFormat::Json => {
                    println!("{}", serde_json::to_string_pretty(&value)?);
                }
            }
        }
        ConfigAction::Set { key, value } => {
            let updated = set_config_value(config.clone(), &key, &value)?;
            store.save(&updated)?;
            match output_format {
                OutputFormat::Text => println!("Saved config to {}", store.config_path().display()),
                OutputFormat::Json => println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "saved": true,
                        "path": store.config_path().to_string_lossy(),
                        "config": updated
                    }))?
                ),
            }
        }
        ConfigAction::Path => match output_format {
            OutputFormat::Text => println!("{}", store.config_path().display()),
            OutputFormat::Json => println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "path": store.config_path().to_string_lossy()
                }))?
            ),
        },
    }
    Ok(())
}

fn handle_sessions_command(
    cwd: PathBuf,
    action: SessionsAction,
    output_format: OutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    let canonical_cwd = cwd.canonicalize()?;
    let store = SessionStore::for_workspace(&canonical_cwd);
    match action {
        SessionsAction::List => {
            let sessions = store.list()?;
            match output_format {
                OutputFormat::Text => {
                    if sessions.is_empty() {
                        println!("No sessions found in {}", canonical_cwd.display());
                    } else {
                        for session in sessions {
                            println!(
                                "{}  model={} reasoning={} messages={} updated_at_ms={}",
                                session.id,
                                session.model,
                                session.reasoning_effort,
                                session.message_count,
                                session.updated_at_ms
                            );
                        }
                    }
                }
                OutputFormat::Json => println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "sessions": sessions
                    }))?
                ),
            }
        }
        SessionsAction::Show { selector } => {
            let path = store.resolve_selector(&selector)?;
            let snapshot = store.load(&selector)?;
            let value = serde_json::json!({
                "id": snapshot.id,
                "path": path.to_string_lossy(),
                "model": snapshot.model,
                "reasoning_effort": snapshot.reasoning_effort,
                "created_at_ms": snapshot.created_at_ms,
                "updated_at_ms": snapshot.updated_at_ms,
                "message_count": snapshot.messages.len()
            });
            match output_format {
                OutputFormat::Text => {
                    println!("session: {}", value["id"].as_str().unwrap_or(""));
                    println!("path: {}", path.display());
                    println!("model: {}", value["model"].as_str().unwrap_or(""));
                    println!(
                        "reasoning_effort: {}",
                        value["reasoning_effort"].as_str().unwrap_or("")
                    );
                    println!(
                        "messages: {}",
                        value["message_count"].as_u64().unwrap_or_default()
                    );
                    println!(
                        "updated_at_ms: {}",
                        value["updated_at_ms"].as_u64().unwrap_or_default()
                    );
                }
                OutputFormat::Json => println!("{}", serde_json::to_string_pretty(&value)?),
            }
        }
    }
    Ok(())
}

fn print_memory(
    store: &ConfigStore,
    output_format: OutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    let memory = store.load_memory()?;
    match output_format {
        OutputFormat::Text => {
            println!("memory_path: {}", store.memory_path().display());
            if let Some(memory) = memory {
                println!("{memory}");
            } else {
                println!("No memory file found.");
            }
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "path": store.memory_path().to_string_lossy(),
                "memory": memory
            }))?
        ),
    }
    Ok(())
}

fn run_init(
    cwd: &std::path::Path,
    output_format: OutputFormat,
) -> Result<(), Box<dyn std::error::Error>> {
    let solarcido_dir = cwd.join(".solarcido");
    if !solarcido_dir.exists() {
        std::fs::create_dir_all(&solarcido_dir)?;
    }
    std::fs::create_dir_all(solarcido_dir.join("sessions"))?;

    let config_file = cwd.join(".solarcido.json");
    if !config_file.exists() {
        std::fs::write(
            &config_file,
            serde_json::to_string_pretty(&serde_json::json!({
                "$schema": "https://solarcido.dev/schema/config.json",
                "model": DEFAULT_MODEL
            }))?,
        )?;
    }

    match output_format {
        OutputFormat::Text => {
            println!("Initialized Solarcido in {}", cwd.display());
            println!(
                "Created .solarcido/ directory, sessions directory, and .solarcido.json config."
            );
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "initialized": true,
                "cwd": cwd.to_string_lossy(),
                "config": ".solarcido.json",
                "directory": ".solarcido/",
                "sessions": ".solarcido/sessions/"
            }))?
        ),
    }
    Ok(())
}

fn print_help(output_format: OutputFormat) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!(
                "solarcido [OPTIONS] [COMMAND]\n\n\
                 Commands:\n\
                 \x20 prompt <text>        Run one prompt\n\
                 \x20 run <text>           Compatibility alias for prompt\n\
                 \x20 status               Print runtime status\n\
                 \x20 sandbox              Print sandbox isolation status\n\
                 \x20 agents               List configured agents\n\
                 \x20 mcp                  List MCP servers\n\
                 \x20 skills               List installed skills\n\
                 \x20 system-prompt        Print the active system prompt\n\
                 \x20 config               Get, set, or locate persistent config\n\
                 \x20 sessions             List or show workspace sessions\n\
                 \x20 memory               Show global memory used in prompts\n\
                 \x20 init                 Initialize Solarcido for this repository\n\
                 \x20 help                 Print help\n\
                 \x20 version              Print version\n\n\
                 Options:\n\
                 \x20 --model MODEL\n\
                 \x20 --output-format text|json\n\
                 \x20 --permission-mode read-only|workspace-write|danger-full-access\n\
                 \x20 --dangerously-skip-permissions\n\
                 \x20 --reasoning-effort low|medium|high\n\
                 \x20 --max-output-tokens N\n\
                 \x20 --resume [SESSION.jsonl|session-id|latest]\n\
                 \x20 --cwd PATH\n\
                 \x20 --allowedTools TOOLS\n\
                 \x20 --version, -V\n\
                 \x20 --help, -h"
            );
        }
        OutputFormat::Json => {
            let commands_json = render_slash_command_help_json();
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "commands": ["prompt", "run", "status", "sandbox", "agents", "mcp", "skills", "system-prompt", "config", "sessions", "memory", "init", "help", "version"],
                    "options": ["--model", "--output-format", "--permission-mode", "--dangerously-skip-permissions", "--reasoning-effort", "--max-output-tokens", "--resume", "--cwd", "--allowedTools"],
                    "slash_commands": commands_json["commands"]
                }))?
            );
        }
    }
    Ok(())
}

fn print_version(output_format: OutputFormat) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => println!("{}", env!("CARGO_PKG_VERSION")),
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "version": env!("CARGO_PKG_VERSION")
            }))?
        ),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Permission prompter
// ---------------------------------------------------------------------------

struct CliPermissionPrompter;

impl PermissionPrompter for CliPermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> bool {
        eprintln!(
            "Tool `{}` requires {} permission while current mode is {}.",
            request.tool_name,
            request.required_mode.as_str(),
            request.current_mode.as_str()
        );
        eprint!("Allow? [y/N] ");
        let _ = io::stderr().flush();
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).is_ok()
            && matches!(answer.trim(), "y" | "Y" | "yes" | "YES")
    }
}
