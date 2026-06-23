// Dependency-free markdown -> ANSI terminal renderer.
// Ported from claw-rust/crates/rusty-claude-cli/src/render.rs (pulldown-cmark + syntect).
// Uses ANSI SGR escape codes only; no npm dependencies.

// ANSI SGR helpers
const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function sgr(...codes: number[]): string {
  return `${ESC}${codes.join(";")}m`;
}

// Named ANSI color strings (foreground)
const FG = {
  cyan: sgr(36),
  white: sgr(37),
  blue: sgr(34),
  grey: sgr(90),
  magenta: sgr(35),
  yellow: sgr(33),
  green: sgr(32),
  darkGrey: sgr(90),
  darkCyan: sgr(36),
  red: sgr(31),
} as const;

const BOLD = sgr(1);
const ITALIC = sgr(3);
const UNDERLINE = sgr(4);
// Dim background for code blocks (closest to syntect base16-ocean.dark bg)
const CODE_BG = `${ESC}48;5;236m`;

export interface ColorTheme {
  heading: string;
  emphasis: string;
  strong: string;
  inlineCode: string;
  link: string;
  quote: string;
  tableBorder: string;
  codeBlockBorder: string;
  spinnerActive: string;
  spinnerDone: string;
  spinnerFailed: string;
}

export const DEFAULT_THEME: ColorTheme = {
  heading: FG.cyan,
  emphasis: FG.magenta,
  strong: FG.yellow,
  inlineCode: FG.green,
  link: FG.blue,
  quote: FG.darkGrey,
  tableBorder: FG.darkCyan,
  codeBlockBorder: FG.darkGrey,
  spinnerActive: FG.blue,
  spinnerDone: FG.green,
  spinnerFailed: FG.red,
};

// Strip ANSI escape sequences from a string (for testing / visible-width calc).
export function stripAnsi(input: string): string {
  // Matches ESC [ ... final-byte  (CSI sequences)
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

// ── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export class Spinner {
  private frameIndex = 0;

  /** Returns a string to write to the terminal for the current frame. */
  tick(label: string, theme: ColorTheme = DEFAULT_THEME): string {
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    this.frameIndex++;
    // \r moves to column 0; caller is responsible for flushing / overwriting.
    return `\r${theme.spinnerActive}${frame} ${label}${RESET}`;
  }

  /** Returns a finalising "done" line. Resets the frame index. */
  finish(label: string, theme: ColorTheme = DEFAULT_THEME): string {
    this.frameIndex = 0;
    return `\r${theme.spinnerDone}✔ ${label}${RESET}\n`;
  }

  /** Returns a finalising "failed" line. Resets the frame index. */
  fail(label: string, theme: ColorTheme = DEFAULT_THEME): string {
    this.frameIndex = 0;
    return `\r${theme.spinnerFailed}✘ ${label}${RESET}\n`;
  }
}

// ── Core renderer ──────────────────────────────────────────────────────────

/**
 * Render markdown text to an ANSI-coloured string.
 *
 * Supported constructs:
 *   - ATX headings (#, ##, ###, ####+)
 *   - Bold (**text** or __text__)
 *   - Italic (*text* or _text_)
 *   - Inline code (`code`)
 *   - Fenced code blocks (``` or ~~~)
 *   - Bullet lists (- / * / +)
 *   - Ordered lists (1. 2. …)
 *   - Blockquotes (>)
 *   - Horizontal rules (---, ***, ___)
 *   - Links ([text](url))
 *   - Plain text passes through unchanged.
 */
export function renderMarkdown(md: string, theme: ColorTheme = DEFAULT_THEME): string {
  const lines = md.split("\n");
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ──────────────────────────────────────────────────
    const fenceMatch = /^( {0,3})(```+|~~~+)(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2];
      const lang = fenceMatch[3].trim();
      const label = lang || "code";
      out.push(`${BOLD}${theme.codeBlockBorder}╭─ ${label}${RESET}`);
      i++;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const cl = lines[i];
        // A closing fence uses the same character and length >= opener length.
        const closeMatch = new RegExp(`^\\s*(${fence[0]}{${fence.length},})\\s*$`).exec(cl);
        if (closeMatch) {
          i++;
          break;
        }
        codeLines.push(cl);
        i++;
      }
      // Render code lines with a subtle background.
      for (const codeLine of codeLines) {
        out.push(`${CODE_BG}${codeLine}${RESET}`);
      }
      out.push(`${BOLD}${theme.codeBlockBorder}╰─${RESET}`);
      out.push("");
      continue;
    }

    // ── ATX heading ───────────────────────────────────────────────────────
    const headingMatch = /^(#{1,6}) +(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = renderInline(headingMatch[2], theme);
      const color =
        level === 1
          ? theme.heading
          : level === 2
            ? FG.white
            : level === 3
              ? FG.blue
              : FG.grey;
      const boldPart = level <= 2 ? BOLD : "";
      out.push(`${boldPart}${color}${text}${RESET}`);
      out.push("");
      i++;
      continue;
    }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^[ ]{0,3}([-*_][ \t]*){3,}$/.test(line.trimEnd())) {
      out.push("---");
      i++;
      continue;
    }

    // ── Blockquote ─────────────────────────────────────────────────────────
    if (/^>/.test(line)) {
      // Collect contiguous blockquote lines.
      const qLines: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        qLines.push(lines[i].replace(/^> ?/, ""));
        i++;
      }
      for (const ql of qLines) {
        out.push(`${theme.quote}│ ${renderInline(ql, theme)}${RESET}`);
      }
      continue;
    }

    // ── Unordered list item ────────────────────────────────────────────────
    const ulMatch = /^( *)[-*+] +(.+)$/.exec(line);
    if (ulMatch) {
      const indent = Math.floor(ulMatch[1].length / 2);
      const prefix = "  ".repeat(indent) + "• ";
      out.push(prefix + renderInline(ulMatch[2], theme));
      i++;
      continue;
    }

    // ── Ordered list item ──────────────────────────────────────────────────
    const olMatch = /^( *)(\d+)\. +(.+)$/.exec(line);
    if (olMatch) {
      const indent = Math.floor(olMatch[1].length / 3);
      const prefix = "  ".repeat(indent) + olMatch[2] + ". ";
      out.push(prefix + renderInline(olMatch[3], theme));
      i++;
      continue;
    }

    // ── Blank line ─────────────────────────────────────────────────────────
    if (line.trim() === "") {
      // Collapse multiple blank lines into one.
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      i++;
      continue;
    }

    // ── Plain paragraph / inline markup ────────────────────────────────────
    out.push(renderInline(line, theme));
    i++;
  }

  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }

  return out.join("\n");
}

// ── Inline renderer ────────────────────────────────────────────────────────
// Processes: bold, italic, inline code, links — left-to-right, greedy.

function renderInline(text: string, theme: ColorTheme): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    // ── Inline code `...` ────────────────────────────────────────────────
    if (text[i] === "`") {
      // Count opening backticks.
      let tick = 0;
      while (i + tick < text.length && text[i + tick] === "`") tick++;
      const opener = text.slice(i, i + tick);
      const closeIdx = text.indexOf(opener, i + tick);
      if (closeIdx !== -1 && (closeIdx === i + tick || text[closeIdx - 1] !== "`" || tick === 1)) {
        const code = text.slice(i + tick, closeIdx);
        result += `${theme.inlineCode}\`${code}\`${RESET}`;
        i = closeIdx + tick;
        continue;
      }
    }

    // ── Bold + italic ***text*** or ___text___ ────────────────────────────
    if (i + 2 < text.length && (text.slice(i, i + 3) === "***" || text.slice(i, i + 3) === "___")) {
      const marker = text.slice(i, i + 3);
      const closeIdx = text.indexOf(marker, i + 3);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 3, closeIdx);
        result += `${BOLD}${ITALIC}${theme.strong}${inner}${RESET}`;
        i = closeIdx + 3;
        continue;
      }
    }

    // ── Bold **text** or __text__ ─────────────────────────────────────────
    if (i + 1 < text.length && (text.slice(i, i + 2) === "**" || text.slice(i, i + 2) === "__")) {
      const marker = text.slice(i, i + 2);
      const closeIdx = text.indexOf(marker, i + 2);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 2, closeIdx);
        result += `${BOLD}${theme.strong}${inner}${RESET}`;
        i = closeIdx + 2;
        continue;
      }
    }

    // ── Italic *text* or _text_ ───────────────────────────────────────────
    if (text[i] === "*" || text[i] === "_") {
      const marker = text[i];
      const closeIdx = text.indexOf(marker, i + 1);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 1, closeIdx);
        result += `${ITALIC}${theme.emphasis}${inner}${RESET}`;
        i = closeIdx + 1;
        continue;
      }
    }

    // ── Link [text](url) ─────────────────────────────────────────────────
    if (text[i] === "[") {
      const closeSquare = text.indexOf("]", i + 1);
      if (closeSquare !== -1 && text[closeSquare + 1] === "(") {
        const closeParen = text.indexOf(")", closeSquare + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeSquare);
          const url = text.slice(closeSquare + 2, closeParen);
          result += `${UNDERLINE}${theme.link}[${label}](${url})${RESET}`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    result += text[i];
    i++;
  }

  return result;
}
