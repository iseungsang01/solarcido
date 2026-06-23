export type SlashCommandSpec = {
  name: string;
  aliases: string[];
  summary: string;
  argumentHint?: string;
  resumeSupported: boolean;
};

export const SLASH_COMMAND_SPECS: SlashCommandSpec[] = [
  {
    name: "help",
    aliases: [""],
    summary: "show available commands",
    resumeSupported: true,
  },
  {
    name: "status",
    aliases: [],
    summary: "show current session settings",
    resumeSupported: true,
  },
  {
    name: "model",
    aliases: [],
    summary: "show or set model",
    argumentHint: "[name]",
    resumeSupported: true,
  },
  {
    name: "reasoning",
    aliases: [],
    summary: "show or set reasoning level",
    argumentHint: "[low|medium|high]",
    resumeSupported: true,
  },
  {
    name: "approval",
    aliases: [],
    summary: "show or set approval policy",
    argumentHint: "[never|on-failure|on-request]",
    resumeSupported: true,
  },
  {
    name: "sandbox",
    aliases: [],
    summary: "show or set sandbox mode",
    argumentHint: "[read-only|workspace-write]",
    resumeSupported: true,
  },
  {
    name: "cwd",
    aliases: [],
    summary: "show working directory",
    resumeSupported: true,
  },
  {
    name: "clear",
    aliases: [],
    summary: "clear the terminal",
    resumeSupported: true,
  },
  {
    name: "quiet",
    aliases: [],
    summary: "suppress assistant messages",
    resumeSupported: true,
  },
  {
    name: "verbose",
    aliases: [],
    summary: "show assistant messages",
    resumeSupported: true,
  },
  {
    name: "exit",
    aliases: ["quit"],
    summary: "quit",
    resumeSupported: false,
  },
  {
    name: "config",
    aliases: [],
    summary: "show config command usage",
    argumentHint: "get|set|path",
    resumeSupported: true,
  },
  {
    name: "sessions",
    aliases: [],
    summary: "show sessions command usage",
    argumentHint: "list|show",
    resumeSupported: true,
  },
  {
    name: "version",
    aliases: [],
    summary: "show version and build info",
    resumeSupported: true,
  },
  {
    name: "diff",
    aliases: [],
    summary: "show working-tree git diff",
    resumeSupported: true,
  },
  {
    name: "init",
    aliases: [],
    summary: "scaffold project guidance (CLAUDE.md, .gitignore)",
    resumeSupported: false,
  },
];

