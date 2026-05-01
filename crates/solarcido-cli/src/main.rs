use solarcido_api::{ContentBlockDelta, ReasoningEffort, SolarClient, StreamEvent, DEFAULT_MODEL};
use solarcido_runtime::{
    default_system_prompt, ConversationRuntime, PermissionMode, PermissionPrompter,
    PermissionRequest,
};
use solarcido_tools::WorkspaceTools;
use std::io::{self, Write};
use std::path::PathBuf;

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
    },
    Repl {
        model: String,
        cwd: PathBuf,
        permission_mode: PermissionMode,
        reasoning_effort: ReasoningEffort,
    },
    Status {
        model: String,
        output_format: OutputFormat,
        permission_mode: PermissionMode,
        reasoning_effort: ReasoningEffort,
    },
    Help {
        output_format: OutputFormat,
    },
    Version {
        output_format: OutputFormat,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("[error-kind: runtime]\nerror: {error}\n\nRun `solarcido --help` for usage.");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    match parse_args(std::env::args().skip(1).collect())? {
        CliAction::Prompt {
            prompt,
            model,
            cwd,
            output_format,
            permission_mode,
            reasoning_effort,
        } => run_prompt(&prompt, &model, cwd, output_format, permission_mode, reasoning_effort)
            .await?,
        CliAction::Repl {
            model,
            cwd,
            permission_mode,
            reasoning_effort,
        } => run_repl(model, cwd, permission_mode, reasoning_effort).await?,
        CliAction::Status {
            model,
            output_format,
            permission_mode,
            reasoning_effort,
        } => print_status(&model, output_format, permission_mode, reasoning_effort)?,
        CliAction::Help { output_format } => print_help(output_format)?,
        CliAction::Version { output_format } => print_version(output_format)?,
    }
    Ok(())
}

fn parse_args(args: Vec<String>) -> Result<CliAction, String> {
    let mut model = std::env::var("SOLARCIDO_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
    let mut cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut output_format = OutputFormat::Text;
    let mut permission_mode = PermissionMode::DangerFullAccess;
    let mut reasoning_effort = ReasoningEffort::Medium;
    let mut positionals = Vec::new();
    let mut index = 0usize;

    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => return Ok(CliAction::Help { output_format }),
            "--version" | "-V" => return Ok(CliAction::Version { output_format }),
            "--model" => {
                index += 1;
                model = args
                    .get(index)
                    .ok_or("--model requires a value")?
                    .to_string();
            }
            "--model-name" => {
                index += 1;
                model = args
                    .get(index)
                    .ok_or("--model-name requires a value")?
                    .to_string();
            }
            "--cwd" => {
                index += 1;
                cwd = PathBuf::from(args.get(index).ok_or("--cwd requires a value")?);
            }
            "--output-format" => {
                index += 1;
                output_format = parse_output_format(args.get(index).ok_or("--output-format requires a value")?)?;
            }
            value if value.starts_with("--output-format=") => {
                output_format = parse_output_format(value.trim_start_matches("--output-format="))?;
            }
            "--permission-mode" => {
                index += 1;
                permission_mode = PermissionMode::parse(
                    args.get(index).ok_or("--permission-mode requires a value")?,
                )
                .map_err(|error| error.to_string())?;
            }
            "--dangerously-skip-permissions" => {
                permission_mode = PermissionMode::DangerFullAccess;
            }
            "--reasoning-effort" | "--reasoning" => {
                index += 1;
                reasoning_effort = ReasoningEffort::parse(
                    args.get(index).ok_or("--reasoning-effort requires a value")?,
                )
                .map_err(|error| error.to_string())?;
            }
            "--allowedTools" | "--allowed-tools" => {
                index += 1;
                let _ = args.get(index).ok_or("--allowedTools requires a value")?;
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
            })
        }
        "status" => Ok(CliAction::Status {
            model,
            output_format,
            permission_mode,
            reasoning_effort,
        }),
        "help" => Ok(CliAction::Help { output_format }),
        "version" => Ok(CliAction::Version { output_format }),
        other => Err(format!("unknown command: {other}")),
    }
}

fn parse_output_format(value: &str) -> Result<OutputFormat, String> {
    match value {
        "text" => Ok(OutputFormat::Text),
        "json" => Ok(OutputFormat::Json),
        other => Err(format!("invalid output format `{other}`; expected text or json")),
    }
}

async fn run_prompt(
    prompt: &str,
    model: &str,
    cwd: PathBuf,
    output_format: OutputFormat,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = SolarClient::from_env()?;
    let tools = WorkspaceTools::new(cwd.canonicalize()?);
    let mut runtime = ConversationRuntime::new(
        client,
        model,
        reasoning_effort,
        default_system_prompt(permission_mode),
        tools,
        permission_mode,
    );
    let mut prompter = CliPermissionPrompter;
    let use_streaming = output_format == OutputFormat::Text;

    let summary = if use_streaming {
        runtime
            .run_turn_streaming(prompt, Some(&mut prompter), |event| {
                if let StreamEvent::ContentBlockDelta(ref delta) = event {
                    if let ContentBlockDelta::TextDelta { ref text } = delta.delta {
                        print!("{text}");
                        let _ = io::stdout().flush();
                    }
                }
            })
            .await?
    } else {
        runtime.run_turn(prompt, Some(&mut prompter)).await?
    };

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
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "type": "result",
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

async fn run_repl(
    model: String,
    cwd: PathBuf,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("solarcido");
    println!("model: {model}");
    println!("cwd: {}", cwd.display());
    println!("permission: {}", permission_mode.as_str());
    println!("Type /help for commands, /exit to quit.");

    let client = SolarClient::from_env()?;
    let tools = WorkspaceTools::new(cwd.canonicalize()?);
    let mut runtime = ConversationRuntime::new(
        client,
        model,
        reasoning_effort,
        default_system_prompt(permission_mode),
        tools,
        permission_mode,
    );
    let mut prompter = CliPermissionPrompter;

    loop {
        print!("> ");
        io::stdout().flush()?;
        let mut line = String::new();
        if io::stdin().read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match trimmed {
            "/exit" | "/quit" => break,
            "/help" | "/" => {
                println!("/help /status /exit /quit");
                continue;
            }
            "/status" => {
                println!("permission: {}", permission_mode.as_str());
                println!("reasoning: {}", reasoning_effort.as_str());
                continue;
            }
            _ => {}
        }
        let summary = runtime
            .run_turn_streaming(trimmed, Some(&mut prompter), |event| {
                if let StreamEvent::ContentBlockDelta(ref delta) = event {
                    if let ContentBlockDelta::TextDelta { ref text } = delta.delta {
                        print!("{text}");
                        let _ = io::stdout().flush();
                    }
                }
            })
            .await?;
        if !summary.assistant_text.is_empty() {
            println!();
        }
    }
    Ok(())
}

fn print_status(
    model: &str,
    output_format: OutputFormat,
    permission_mode: PermissionMode,
    reasoning_effort: ReasoningEffort,
) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!("Solarcido status");
            println!("model: {model}");
            println!("provider: Upstage Solar OpenAI-compatible");
            println!("permission_mode: {}", permission_mode.as_str());
            println!("reasoning_effort: {}", reasoning_effort.as_str());
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "model": model,
                "provider": "upstage-solar",
                "permission_mode": permission_mode.as_str(),
                "reasoning_effort": reasoning_effort.as_str()
            }))?
        ),
    }
    Ok(())
}

fn print_help(output_format: OutputFormat) -> Result<(), Box<dyn std::error::Error>> {
    match output_format {
        OutputFormat::Text => {
            println!(
                "solarcido [OPTIONS] [COMMAND]\n\nCommands:\n  prompt <text>        Run one prompt\n  run <text>           Compatibility alias for prompt\n  status               Print runtime status\n  help                 Print help\n  version              Print version\n\nOptions:\n  --model MODEL\n  --output-format text|json\n  --permission-mode read-only|workspace-write|danger-full-access\n  --dangerously-skip-permissions\n  --reasoning-effort low|medium|high\n  --cwd PATH\n  --allowedTools TOOLS\n  --version, -V\n  --help, -h"
            );
        }
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "commands": ["prompt", "run", "status", "help", "version"],
                "options": ["--model", "--output-format", "--permission-mode", "--dangerously-skip-permissions", "--reasoning-effort", "--cwd", "--allowedTools"]
            }))?
        ),
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

