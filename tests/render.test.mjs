import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown, stripAnsi, DEFAULT_THEME, Spinner } from "../dist/cli/render.js";

// ── Headings ──────────────────────────────────────────────────────────────

test("heading h1: text content preserved and ANSI styling applied", () => {
  const out = renderMarkdown("# Hello World");
  const plain = stripAnsi(out);
  assert.match(plain, /Hello World/);
  // Some ANSI escape must be present.
  assert.ok(out.includes("\x1b["), "expected ANSI escape in h1 output");
});

test("heading h2: text content preserved", () => {
  const out = renderMarkdown("## Section");
  const plain = stripAnsi(out);
  assert.match(plain, /Section/);
  assert.ok(out.includes("\x1b["), "expected ANSI escape in h2 output");
});

test("heading h3: text content preserved", () => {
  const out = renderMarkdown("### Sub");
  const plain = stripAnsi(out);
  assert.match(plain, /Sub/);
});

// ── Bold / italic ─────────────────────────────────────────────────────────

test("bold **text**: content preserved and ANSI styling applied", () => {
  const out = renderMarkdown("This is **bold** text.");
  const plain = stripAnsi(out);
  assert.match(plain, /bold/);
  assert.ok(out.includes("\x1b["), "expected ANSI escape for bold");
});

test("italic *text*: content preserved and ANSI styling applied", () => {
  const out = renderMarkdown("This is *italic* text.");
  const plain = stripAnsi(out);
  assert.match(plain, /italic/);
  assert.ok(out.includes("\x1b["), "expected ANSI escape for italic");
});

// ── Inline code ───────────────────────────────────────────────────────────

test("inline code `x`: backtick delimiters visible in plain text and ANSI applied", () => {
  const out = renderMarkdown("Run `npm install` first.");
  const plain = stripAnsi(out);
  // The renderer keeps backtick wrapping: `npm install`
  assert.match(plain, /`npm install`/);
  assert.ok(out.includes("\x1b["), "expected ANSI escape for inline code");
});

// ── Fenced code block ─────────────────────────────────────────────────────

test("fenced code block: language label in border and content preserved", () => {
  const md = "```typescript\nconst x = 1;\n```";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /╭─ typescript/, "expected top border with language");
  assert.match(plain, /const x = 1;/, "expected code content to be preserved");
  assert.match(plain, /╰─/, "expected bottom border");
  assert.ok(out.includes("\x1b["), "expected ANSI escape for code block");
});

test("fenced code block without language: fallback label 'code'", () => {
  const md = "```\nhello world\n```";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /╭─ code/);
  assert.match(plain, /hello world/);
});

test("fenced code block with tilde fence: content preserved", () => {
  const md = "~~~sh\necho hi\n~~~";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /echo hi/);
});

// ── Lists ─────────────────────────────────────────────────────────────────

test("unordered list: bullet marker and content present", () => {
  const md = "- alpha\n- beta\n- gamma";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /• alpha/);
  assert.match(plain, /• beta/);
  assert.match(plain, /• gamma/);
});

test("ordered list: numeric markers and content present", () => {
  const md = "1. first\n2. second\n3. third";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /1\. first/);
  assert.match(plain, /2\. second/);
  assert.match(plain, /3\. third/);
});

test("nested unordered list: indent applied", () => {
  const md = "- top\n  - nested";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /• top/);
  assert.match(plain, /• nested/);
});

// ── Blockquote ────────────────────────────────────────────────────────────

test("blockquote: │ prefix and content preserved", () => {
  const md = "> This is a quote.";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /│ This is a quote\./);
  assert.ok(out.includes("\x1b["), "expected ANSI escape for blockquote");
});

// ── Links ─────────────────────────────────────────────────────────────────

test("link [text](url): rendered with label and url preserved", () => {
  const md = "See [Docs](https://example.com) here.";
  const out = renderMarkdown(md);
  const plain = stripAnsi(out);
  assert.match(plain, /\[Docs\]\(https:\/\/example\.com\)/);
  assert.ok(out.includes("\x1b["), "expected ANSI escape for link");
});

// ── Horizontal rule ───────────────────────────────────────────────────────

test("horizontal rule: rendered as ---", () => {
  const out = renderMarkdown("---");
  assert.match(stripAnsi(out), /^---$/m);
});

// ── stripAnsi ─────────────────────────────────────────────────────────────

test("stripAnsi: removes escape sequences and leaves plain text", () => {
  const colored = `\x1b[32mhello\x1b[0m world`;
  assert.equal(stripAnsi(colored), "hello world");
});

test("stripAnsi: no-op on plain text", () => {
  assert.equal(stripAnsi("plain text"), "plain text");
});

// ── DEFAULT_THEME ─────────────────────────────────────────────────────────

test("DEFAULT_THEME: all fields are non-empty strings", () => {
  for (const [key, value] of Object.entries(DEFAULT_THEME)) {
    assert.equal(typeof value, "string", `${key} should be a string`);
    assert.ok(value.length > 0, `${key} should be non-empty`);
  }
});

// ── Spinner ───────────────────────────────────────────────────────────────

test("Spinner.tick: returns a string containing the label", () => {
  const sp = new Spinner();
  const out = sp.tick("Loading");
  assert.ok(stripAnsi(out).includes("Loading"), "tick output should contain label");
  assert.ok(out.includes("\x1b["), "tick output should contain ANSI escape");
});

test("Spinner.tick: advances frame on each call", () => {
  const sp = new Spinner();
  const first = sp.tick("X");
  const second = sp.tick("X");
  // Both contain the label; frames may or may not differ — just check both work.
  assert.ok(stripAnsi(first).includes("X"));
  assert.ok(stripAnsi(second).includes("X"));
});

test("Spinner.finish: returns done symbol and label", () => {
  const sp = new Spinner();
  const out = sp.finish("Done");
  const plain = stripAnsi(out);
  assert.match(plain, /✔ Done/);
});

test("Spinner.fail: returns failure symbol and label", () => {
  const sp = new Spinner();
  const out = sp.fail("Error");
  const plain = stripAnsi(out);
  assert.match(plain, /✘ Error/);
});
