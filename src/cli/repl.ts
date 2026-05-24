import { stdin as input, stdout as output } from "node:process";

import type { ApprovalPolicy, SandboxMode } from "../runtime/config.js";
import { DEFAULT_MODEL, type ReasoningEffort } from "../api/client.js";
import { runWorkflow } from "../workflow/run-agent-loop.js";
import { dispatchSlashCommand } from "../commands/dispatcher.js";
import { matchingSlashCommands, parseSlashCommand } from "../commands/registry.js";

export type InteractiveOptions = {
  cwd: string;
  reasoningEffort: ReasoningEffort;
  model: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  quiet?: boolean;
};

const ESC = "";
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  yellow: `${ESC}[38;5;220m`,
  amber: `${ESC}[38;5;214m`,
  blue: `${ESC}[38;5;111m`,
  cyan: `${ESC}[38;5;87m`,
  slate: `${ESC}[38;5;244m`,
} as const;

const LOGO_LINES = [
  " ███████╗ ██████╗ ██╗      █████╗ ██████╗  ██████╗██╗██████╗  ██████╗ ",
  " ██╔════╝██╔═══██╗██║     ██╔══██╗██╔══██╗██╔════╝██║██╔══██╗██╔═══██╗",
  " ███████╗██║   ██║██║     ███████║██████╔╝██║     ██║██║  ██║██║   ██║",
  " ╚════██║██║   ██║██║     ██╔══██║██╔══██╗██║     ██║██║  ██║██║   ██║",
  " ███████║╚██████╔╝███████╗██║  ██║██║  ██║╚██████╗██║██████╔╝╚██████╔╝",
  " ╚══════╝ ╚═════╝ ╚══════╝╚═╝  ═╝╚═╝  ═╝ ╚═════╝╚═╝╚═════╝  ═════╝ ",
];

const PASTE_END = `${ESC}[201~`;
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

const PROMPT = `${ANSI.amber}${ANSI.bold}❯${ANSI.reset} `;
const PROMPT_VISIBLE_LEN = 2;

class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function centerLine(value: string, width = output.columns ?? 100): string {
  const visibleWidth = stripAnsi(value).length;
  const padding = Math.max(0, Math.floor((width - visibleWidth) / 2));
  return `${" ".repeat(padding)}${value}`;
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
  console.log(`  ${ANSI.cyan}${ANSI.bold}SOLARCIDO CODE${ANSI.reset}`);
  console.log(`  ${ANSI.slate}Ask for code changes, repo analysis, or execution.${ANSI.reset}`);
  console.log(`  ${ANSI.slate}Press ${ANSI.reset}/${ANSI.slate} to open the command menu.${ANSI.reset}`);
  console.log("");
  console.log(`  ${ANSI.slate}model${ANSI.reset}      ${options.model}`);
  console.log(`  ${ANSI.slate}cwd${ANSI.reset}        ${options.cwd}`);
  console.log(`  ${ANSI.slate}reasoning${ANSI.reset}  ${options.reasoningEffort}`);
  console.log(`  ${ANSI.slate}approval${ANSI.reset}   ${options.approvalPolicy ?? "on-failure"}`);
  console.log(`  ${ANSI.slate}sandbox${ANSI.reset}    ${options.sandbox ?? "workspace-write"}`);
  console.log("");
}

function filteredCommands(query: string) {
  return matchingSlashCommands(query);
}

/**
 * Read a line in raw mode with bracketed-paste support and a live
 * slash-command picker. Pressing `/` as the first key opens the picker
 * inline; arrow keys move, Enter selects, Esc cancels.
 */
async function readLine(): Promise<string> {
  output.write(PROMPT);

  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let pasteBuf = "";
    let escState: "none" | "esc" | "csi" | "paste" = "none";
    let escSeq = "";

    let menuOpen = false;
    let menuLines = 0;
    let menuSelected = 0;

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
    };

    const restoreCursorToInputEnd = (clearedLines: number): void => {
      if (clearedLines > 0) output.write(`${ESC}[${clearedLines}A`);
      output.write(`\r${ESC}[${PROMPT_VISIBLE_LEN + buf.length}C`);
    };

    const closeMenu = (): void => {
      if (!menuOpen) return;
      for (let i = 0; i < menuLines; i++) {
        output.write(`\r\n${ESC}[2K`);
      }
      restoreCursorToInputEnd(menuLines);
      menuOpen = false;
      menuLines = 0;
    };

    const drawMenu = (): void => {
      if (menuOpen) {
        for (let i = 0; i < menuLines; i++) {
          output.write(`\r\n${ESC}[2K`);
        }
        if (menuLines > 0) output.write(`${ESC}[${menuLines}A`);
      }
      output.write(`\r${ESC}[K${PROMPT}${buf}`);

      const filtered = filteredCommands(buf);
      if (menuSelected >= filtered.length) menuSelected = Math.max(0, filtered.length - 1);

      let lines = 0;
      if (filtered.length === 0) {
        output.write(`\r\n${ESC}[2K  ${ANSI.dim}no matching commands${ANSI.reset}`);
        lines = 1;
      } else {
        for (let i = 0; i < filtered.length; i++) {
          const c = filtered[i];
          const selected = i === menuSelected;
          const marker = selected ? `${ANSI.amber}❯${ANSI.reset}` : " ";
          const commandName = `/${c.name}`;
          const name = selected
            ? `${ANSI.amber}${ANSI.bold}${commandName.padEnd(12)}${ANSI.reset}`
            : `${ANSI.cyan}${commandName.padEnd(12)}${ANSI.reset}`;
          const desc = `${ANSI.slate}${c.summary}${ANSI.reset}`;
          output.write(`\r\n${ESC}[2K  ${marker} ${name}  ${desc}`);
          lines++;
        }
      }

      restoreCursorToInputEnd(lines);
      menuOpen = true;
      menuLines = lines;
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escState === "paste") {
          pasteBuf += ch;
          if (pasteBuf.endsWith(PASTE_END)) {
            const content = pasteBuf.slice(0, -PASTE_END.length).replace(/\r\n?/g, "\n");
            pasteBuf = "";
            escState = "none";
            if (menuOpen) closeMenu();
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
            if (menuOpen) {
              closeMenu();
              buf = "";
              output.write(`\r${ESC}[K${PROMPT}`);
            }
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
            const seq = escSeq;
            escState = "none";
            escSeq = "";
            if (menuOpen) {
              const filtered = filteredCommands(buf);
              if (seq === "A") {
                menuSelected = Math.max(0, menuSelected - 1);
                drawMenu();
              } else if (seq === "B") {
                menuSelected = Math.min(Math.max(0, filtered.length - 1), menuSelected + 1);
                drawMenu();
              }
            }
          }
          continue;
        }

        if (ch === ESC) {
          escState = "esc";
          continue;
        }

        if (ch === "\r" || ch === "\n") {
          if (menuOpen) {
            const filtered = filteredCommands(buf);
            const choice = filtered[menuSelected];
            closeMenu();
            const result = choice ? `/${choice.name}` : buf;
            output.write(`\r${ESC}[K${PROMPT}${result}\n`);
            cleanup();
            resolve(result);
            return;
          }
          output.write("\n");
          cleanup();
          resolve(buf);
          return;
        }

        if (ch === "" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            output.write("\b \b");
            if (menuOpen) {
              menuSelected = 0;
              if (buf.startsWith("/")) {
                drawMenu();
              } else {
                closeMenu();
              }
            }
          }
          continue;
        }

        if (ch === "") {
          if (menuOpen) closeMenu();
          output.write("^C\n");
          cleanup();
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
          if (ch === "/" && buf === "/") {
            menuSelected = 0;
            drawMenu();
          } else if (menuOpen) {
            menuSelected = 0;
            if (buf.startsWith("/")) {
              drawMenu();
            } else {
              closeMenu();
            }
          }
        }
      }
    };

    input.on("data", onData);
  });
}

async function promptForReasoningLevel(current: ReasoningEffort): Promise<ReasoningEffort | undefined> {
  const choices: ReasoningEffort[] = ["high", "medium", "low"];
  let selectedIndex = Math.max(0, choices.indexOf(current));
  const menuLines = 5;

  return new Promise<ReasoningEffort | undefined>((resolve) => {
    let open = false;
    let finished = false;
    let escState: "none" | "esc" | "csi" = "none";

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
    };

    const clearMenu = () => {
      if (!open) return;
      output.write(`${ESC}[${menuLines}A`);
      for (let line = 0; line < menuLines; line += 1) {
        output.write(`\r${ESC}[K`);
        if (line < menuLines - 1) {
          output.write(`\r\n`);
        }
      }
      output.write(`${ESC}[${menuLines - 1}A`);
      open = false;
    };

    const drawMenu = (): void => {
      if (open) {
        clearMenu();
      }

      const renderChoice = (level: ReasoningEffort, isSelected: boolean, isCurrent: boolean): string => {
        const marker = isSelected ? `${ANSI.amber}>${ANSI.reset}` : " ";
        const label = isSelected ? `${ANSI.bold}${level}${ANSI.reset}` : level;
        const current = isCurrent ? ` ${ANSI.dim}(current)${ANSI.reset}` : "";
        return `  ${marker} ${label}${current}`;
      };

      output.write(`\r${ESC}[K${ANSI.slate}choose reasoning level${ANSI.reset}`);
      output.write(`\r\n${ESC}[K${renderChoice("high", selectedIndex === 0, current === "high")}`);
      output.write(`\r\n${ESC}[K${renderChoice("medium", selectedIndex === 1, current === "medium")}`);
      output.write(`\r\n${ESC}[K${renderChoice("low", selectedIndex === 2, current === "low")}`);
      output.write(`\r\n${ESC}[K  ${ANSI.dim}Use ↑/↓ and Enter. Esc cancels.${ANSI.reset}`);
      open = true;
    };

    const finish = (value: ReasoningEffort | undefined): void => {
      clearMenu();
      output.write("\r\n");
      cleanup();
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escState === "esc") {
          if (ch === "[") {
            escState = "csi";
            continue;
          }

          escState = "none";
          finish(undefined);
          return;
        }

        if (escState === "csi") {
          escState = "none";
          if (ch === "A") {
            selectedIndex = (selectedIndex + choices.length - 1) % choices.length;
            drawMenu();
          } else if (ch === "B") {
            selectedIndex = (selectedIndex + 1) % choices.length;
            drawMenu();
          }
          continue;
        }

        if (ch === ESC) {
          escState = "esc";
          continue;
        }

        if (ch === "\r" || ch === "\n") {
          finish(choices[selectedIndex]);
          return;
        }

        if (ch === "\u0003") {
          if (input.isTTY) input.setRawMode(false);
          process.exit(130);
        }

        if (ch === "\u0004") {
          finish(undefined);
          return;
        }
      }
    };

    drawMenu();
    input.on("data", onData);
  });
}

export async function startInteractiveShell(options: InteractiveOptions): Promise<void> {
  const session: InteractiveOptions = {
    cwd: options.cwd,
    reasoningEffort: options.reasoningEffort,
    model: options.model ?? DEFAULT_MODEL,
    approvalPolicy: options.approvalPolicy ?? "on-failure",
    sandbox: options.sandbox ?? "workspace-write",
    quiet: options.quiet ?? false,
  };

  printShellHeader(session);
  output.write(ENABLE_BRACKETED_PASTE);

  try {
    while (true) {
      let raw: string;
      try {
        raw = await readLine();
      } catch (err) {
        if (err instanceof EOFError) break;
        throw err;
      }

      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        const parsed = parseSlashCommand(trimmed);
        if (!parsed) continue;

        const result = await dispatchSlashCommand(session, parsed, {
          output: {
            writeLine(message: string): void {
              console.log(message);
            },
            clear(): void {
              console.clear();
            },
          },
          promptForReasoningLevel,
          formatLabel(label: string): string {
            return `${ANSI.slate}${label}${ANSI.reset}`;
          },
          formatDim(message: string): string {
            return `${ANSI.dim}${message}${ANSI.reset}`;
          },
        });

        if (result === "exit") break;
        continue;
      }

      await runWorkflow({
        goal: trimmed,
        cwd: session.cwd,
        reasoningEffort: session.reasoningEffort,
        model: session.model,
        approvalPolicy: session.approvalPolicy,
        sandbox: session.sandbox,
        quiet: session.quiet,
      });
    }
  } finally {
    output.write(DISABLE_BRACKETED_PASTE);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  }
}

