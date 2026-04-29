import { stdin as input, stdout as output } from "node:process";

import { DEFAULT_MODEL, type ReasoningEffort } from "./solar/constants.js";
import { runWorkflow } from "./workflow/run-agent-loop.js";

/**
 * Interactive shell options.
 */
export type InteractiveOptions = {
  cwd: string;
  maxSteps: number;
  reasoningEffort: ReasoningEffort;
  model: string;
  /**
   * When true, suppress assistant messages (only tool output).
   */
  quiet?: boolean;
};

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  yellow: "[38;5;220m",
  amber: "[38;5;214m",
  blue: "[38;5;111m",
  slate: "[38;5;244m",
  panel: "[48;5;236m",
} as const;

const LOGO_LINES = [
  " ███████╗ ██████╗ ██╗      █████╗ ██████╗  ██████╗██╗██████╗  ██████╗ ",
  " ██╔════╝██╔═══██╗██║     ██╔══██╗██╔══██╗██╔════╝██║██╔══██╗██╔═══██╗",
  " ███████╗██║   ██║██║     ███████║██████╔╝██║     ██║██║  ██║██║   ██║",
  " ╚════██║██║   ██║██║     ██╔══██║██╔══██╗██║     ██║██║  ██║██║   ██║",
  " ███████║╚██████╔╝███████╗██║  ██║██║  ██║╚██████╗██║██████╔╝╚██████╔╝",
  " ╚══════╝ ╚═════╝ ╚══════╝╚═╝  ═╝╚═╝  ═╝ ╚═════╝╚═╝╚═════╝  ═════╝ ",
];

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function centerLine(value: string, width = output.columns ?? 100): string {
  const visibleWidth = stripAnsi(value).length;
  const padding = Math.max(0, Math.floor((width - visibleWidth) / 2));
  return `${' '.repeat(padding)}${value}`;
}

function fitText(value: string, width: number): string {
  const clean = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}...` : value;
  return clean.padEnd(width, " ");
}

function printPanel(title: string, lines: string[]): void {
  const terminalWidth = output.columns ?? 100;
  const panelWidth = Math.min(Math.max(terminalWidth - 10, 54), 96);
  const innerWidth = panelWidth - 4;
  const top = centerLine(`${ANSI.blue}╭─ ${title} ${'─'.repeat(Math.max(0, innerWidth - title.length - 2))}╮${ANSI.reset}`, terminalWidth);
  const bottom = centerLine(`${ANSI.blue}╰${'─'.repeat(panelWidth - 2)}╯${ANSI.reset}`, terminalWidth);

  console.log(top);
  for (const line of lines) {
    const row = `${ANSI.blue}│${ANSI.reset} ${ANSI.panel}${fitText(line, innerWidth)}${ANSI.reset} ${ANSI.blue}│${ANSI.reset}`;
    console.log(centerLine(row, terminalWidth));
  }
  console.log(bottom);
}

function printLogo(): void {
  console.log("");
  for (const line of LOGO_LINES) {
    console.log(centerLine(`${ANSI.yellow}${ANSI.bold}${line}${ANSI.reset}`));
  }
  console.log("");
}

function printShellHeader(options: InteractiveOptions): void {
  printLogo();
  printPanel("SOLARCIDO CODE", [
    "Ask for code changes, repo analysis, or execution.",
    "Start a line with / to open command actions.",
    "",
    `model      ${options.model}`,
    `cwd        ${options.cwd}`,
    `reasoning  ${options.reasoningEffort}`,
    `max steps  ${options.maxSteps}`,
    `quiet      ${options.quiet ?? false ? "ON" : "OFF"}`,
  ]);
  console.log("");
}

function printSlashCommands(options: InteractiveOptions): void {
  printPanel("SLASH COMMANDS", [
    "/help                 show CLI help",
    "/run <goal>           run the workflow explicitly",
    "/model                show current model",
    "/model <name>         change model for this session",
    "/cwd                  show working directory",
    "/reasoning            show reasoning level",
    "/max-steps            show max steps",
    "/exit                 quit",
    "/quiet                toggle quiet mode (suppress assistant messages)",
    "/verbose              toggle verbose mode (show all messages)",
    "",
    `active model         ${options.model}`,
    `quiet mode           ${options.quiet ?? false ? "ON" : "OFF"}`,
  ]);
}

const ESC = "";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}

/**
 * Read a line from stdin in raw mode with bracketed-paste support so that
 * a multi-line paste arrives as a single submission rather than being split
 * by embedded newlines.
 */
async function readLine(promptStr: string): Promise<string> {
  output.write(promptStr);

  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let pasteBuf = "";
    let escState: "none" | "esc" | "csi" | "paste" = "none";
    let escSeq = "";

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escState === "paste") {
          pasteBuf += ch;
          if (pasteBuf.endsWith(PASTE_END)) {
            const content = pasteBuf.slice(0, -PASTE_END.length).replace(/\r\n?/g, "\n");
            pasteBuf = "";
            escState = "none";
            buf += content;
            output.write(content);
          }
          continue;
        }

        if (escState === "esc") {
          if (ch === "[") {
            escState = "csi";
            escSeq = "";
          } else {
            escState = "none";
          }
          continue;
        }

        if (escState === "csi") {
          escSeq += ch;
          if (escSeq === "200~") {
            escState = "paste";
            escSeq = "";
            continue;
          }
          if (/[A-Za-z~]/.test(ch)) {
            // Other CSI (arrow keys etc.) — discard.
            escState = "none";
            escSeq = "";
          }
          continue;
        }

        // none state
        if (ch === ESC) {
          escState = "esc";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          output.write("\n");
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === "" || ch === "\b") {
          if (buf.length > 0) {
            const last = buf[buf.length - 1];
            buf = buf.slice(0, -1);
            if (last !== "\n") output.write("\b \b");
          }
          continue;
        }
        if (ch === "") {
          cleanup();
          output.write("^C\n");
          process.exit(130);
        }
        if (ch === "") {
          if (buf.length === 0) {
            cleanup();
            reject(new EOFError());
            return;
          }
          continue;
        }
        if (ch >= " " || ch === "\t") {
          buf += ch;
          output.write(ch);
        }
      }
    };

    input.on("data", onData);
  });
}

const PROMPT = `${ANSI.amber}${ANSI.bold}code${ANSI.reset} ${ANSI.slate}❯${ANSI.reset} `;

/**
 * Collect lines until a sentinel line (EOF) or a slash command.
 * Kept for the explicit `EOF` heredoc-style entry; bracketed paste handles
 * the common multi-line case automatically.
 */
async function collectGoalLines(): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const raw = await readLine(PROMPT);
    const trimmed = raw.trim();

    if (trimmed.startsWith("/")) {
      console.log(`[assistant] ${trimmed}`);
      return "";
    }
    if (trimmed.toUpperCase() === "EOF") break;
    if (trimmed === "") continue;
    lines.push(trimmed);
  }
  return lines.join("\n");
}

export async function startInteractiveShell(options: InteractiveOptions): Promise<void> {
  const session: InteractiveOptions = {
    cwd: options.cwd,
    maxSteps: options.maxSteps,
    reasoningEffort: options.reasoningEffort,
    model: options.model ?? DEFAULT_MODEL,
    quiet: options.quiet ?? false,
  };

  printShellHeader(session);

  output.write(ENABLE_BRACKETED_PASTE);

  try {
    while (true) {
      let raw: string;
      try {
        raw = await readLine(PROMPT);
      } catch (err) {
        if (err instanceof EOFError) break;
        throw err;
      }

      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (trimmed === "/") {
        printSlashCommands(session);
        continue;
      }
      if (trimmed === "/quiet") {
        session.quiet = true;
        console.log("[assistant] Quiet mode enabled.");
        continue;
      }
      if (trimmed === "/verbose") {
        session.quiet = false;
        console.log("[assistant] Verbose mode enabled.");
        continue;
      }
      if (trimmed === "/exit" || trimmed === "/quit") break;

      if (trimmed.toUpperCase() === "EOF") {
        const block = await collectGoalLines();
        if (block) {
          await runWorkflow({
            goal: block,
            cwd: session.cwd,
            maxSteps: session.maxSteps,
            reasoningEffort: session.reasoningEffort,
            model: session.model,
            quiet: session.quiet,
          });
        }
        continue;
      }

      await runWorkflow({
        goal: trimmed,
        cwd: session.cwd,
        maxSteps: session.maxSteps,
        reasoningEffort: session.reasoningEffort,
        model: session.model,
        quiet: session.quiet,
      });
    }
  } finally {
    output.write(DISABLE_BRACKETED_PASTE);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  }
}
