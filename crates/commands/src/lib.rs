//! Slash command registry, parsing, help rendering, and JSON/text output.
//!
//! Ported from `claw-rust/crates/commands`. Full command handler bodies are
//! deferred to Phase 5 (CLI/REPL parity). This crate currently provides the
//! registry, specs, and help rendering that the CLI crate depends on.

use serde_json::{json, Value};

/// A slash command specification describing its name, aliases, and summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommandSpec {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub summary: &'static str,
    pub argument_hint: Option<&'static str>,
    pub resume_supported: bool,
}

/// All slash commands supported by the Solarcido REPL.
pub const SLASH_COMMAND_SPECS: &[SlashCommandSpec] = &[
    SlashCommandSpec {
        name: "help",
        aliases: &[],
        summary: "Show available slash commands",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "status",
        aliases: &[],
        summary: "Show current session status",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "sandbox",
        aliases: &[],
        summary: "Show sandbox isolation status",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "compact",
        aliases: &[],
        summary: "Compact local session history",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "model",
        aliases: &[],
        summary: "Show or switch the active model",
        argument_hint: Some("[model]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "permissions",
        aliases: &[],
        summary: "Show or switch the active permission mode",
        argument_hint: Some("[read-only|workspace-write|danger-full-access]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "clear",
        aliases: &[],
        summary: "Clear terminal and reset session context",
        argument_hint: None,
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "cost",
        aliases: &[],
        summary: "Show cumulative token usage and cost estimate",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "resume",
        aliases: &[],
        summary: "Resume a saved session",
        argument_hint: Some("<session-path|session-id|latest>"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "config",
        aliases: &[],
        summary: "Show or edit config sections",
        argument_hint: Some("[env|hooks|model|plugins]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "mcp",
        aliases: &[],
        summary: "List or inspect MCP servers",
        argument_hint: Some("[list|show <server>|help]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "memory",
        aliases: &[],
        summary: "Show or edit in-context memory",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "init",
        aliases: &[],
        summary: "Initialize Solarcido for this repository",
        argument_hint: None,
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "diff",
        aliases: &[],
        summary: "Show workspace git diff",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "version",
        aliases: &[],
        summary: "Print solarcido version",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "session",
        aliases: &[],
        summary: "Manage sessions",
        argument_hint: Some("[list|switch <session-id>|fork [branch]|delete <session-id>]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "plugin",
        aliases: &["plugins", "marketplace"],
        summary: "Manage plugins",
        argument_hint: Some(
            "[list|install <path>|enable <name>|disable <name>|uninstall <id>|update <id>]",
        ),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "agents",
        aliases: &[],
        summary: "List or inspect sub-agents",
        argument_hint: Some("[list|help]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "skills",
        aliases: &["skill"],
        summary: "Manage and invoke skills",
        argument_hint: Some("[list|install <path>|help|<skill> [args]]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "doctor",
        aliases: &[],
        summary: "Run diagnostics",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "hooks",
        aliases: &[],
        summary: "List or run lifecycle hooks",
        argument_hint: Some("[list|run <hook>]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "exit",
        aliases: &["quit"],
        summary: "Exit the REPL",
        argument_hint: None,
        resume_supported: false,
    },
];

/// Returns all slash command specs.
#[must_use]
pub fn slash_command_specs() -> &'static [SlashCommandSpec] {
    SLASH_COMMAND_SPECS
}

/// Resolve a raw REPL input token to a slash command spec if it matches any
/// command name or alias.
#[must_use]
pub fn resolve_slash_command(token: &str) -> Option<&'static SlashCommandSpec> {
    let name = token.trim_start_matches('/');
    SLASH_COMMAND_SPECS
        .iter()
        .find(|spec| spec.name == name || spec.aliases.iter().any(|a| *a == name))
}

/// A parsed slash command invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub args: Vec<String>,
}

impl SlashCommand {
    /// Parse a REPL input line starting with `/` into a `SlashCommand`.
    #[must_use]
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        if !trimmed.starts_with('/') {
            return None;
        }
        let mut parts = trimmed.splitn(2, ' ');
        let name = parts.next()?.trim_start_matches('/').trim().to_lowercase();
        if name.is_empty() {
            return None;
        }
        let args: Vec<String> = parts
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        Some(Self { name, args })
    }
}

/// Render slash command help text in plain text format.
#[must_use]
pub fn render_slash_command_help() -> String {
    let mut out = String::from("Slash commands:\n");
    for spec in SLASH_COMMAND_SPECS {
        let hint = spec
            .argument_hint
            .map_or(String::new(), |h| format!(" {h}"));
        let aliases = if spec.aliases.is_empty() {
            String::new()
        } else {
            format!(" (aliases: /{})", spec.aliases.join(", /"))
        };
        out.push_str(&format!(
            "  /{}{hint:<30} {}{}\n",
            spec.name, spec.summary, aliases,
        ));
    }
    out
}

/// Render slash command help text in JSON format.
#[must_use]
pub fn render_slash_command_help_json() -> Value {
    let commands: Vec<Value> = SLASH_COMMAND_SPECS
        .iter()
        .map(|spec| {
            json!({
                "name": spec.name,
                "aliases": spec.aliases,
                "summary": spec.summary,
                "argument_hint": spec.argument_hint,
                "resume_supported": spec.resume_supported,
            })
        })
        .collect();
    json!({ "commands": commands })
}

/// Validate that the slash command input is parseable and recognized.
#[must_use]
pub fn validate_slash_command_input(input: &str) -> bool {
    SlashCommand::parse(input)
        .map(|cmd| resolve_slash_command(&format!("/{}", cmd.name)).is_some())
        .unwrap_or(false)
}

/// Return the list of slash commands that support session resume.
#[must_use]
pub fn resume_supported_slash_commands() -> Vec<&'static str> {
    SLASH_COMMAND_SPECS
        .iter()
        .filter(|s| s.resume_supported)
        .map(|s| s.name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_slash_help() {
        let cmd = SlashCommand::parse("/help").unwrap();
        assert_eq!(cmd.name, "help");
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn parse_slash_model_with_arg() {
        let cmd = SlashCommand::parse("/model solar-pro3-260323").unwrap();
        assert_eq!(cmd.name, "model");
        assert_eq!(cmd.args, vec!["solar-pro3-260323"]);
    }

    #[test]
    fn non_slash_returns_none() {
        assert!(SlashCommand::parse("hello").is_none());
    }

    #[test]
    fn resolve_alias() {
        let spec = resolve_slash_command("/quit");
        assert!(spec.is_some());
        assert_eq!(spec.unwrap().name, "exit");
    }
}
