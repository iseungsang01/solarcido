/**
 * Minimal, dependency-free PDF text extraction. Ported from claw-rust
 * crates/tools/src/pdf_extract.rs; FlateDecode is handled with Node's built-in
 * `zlib` (no external dependency). Locates `stream`/`endstream` objects,
 * inflates FlateDecode streams, and extracts text between BT/ET operators.
 *
 * Best-effort: non-text or encrypted PDFs yield an empty string, not an error.
 */
import { promises as fs } from "node:fs";
import zlib from "node:zlib";

/** True when the path looks like a PDF reference (case-insensitive .pdf). */
export function isPdfPath(target: string): boolean {
  return target.toLowerCase().trimEnd().endsWith(".pdf");
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return extractTextFromBytes(bytes);
}

/** Core extraction from raw PDF bytes — pure, no filesystem access. */
export function extractTextFromBytes(data: Uint8Array): string {
  const buf = Buffer.from(data);
  let allText = "";
  let offset = 0;

  while (offset < buf.length) {
    const streamStart = buf.indexOf("stream", offset, "latin1");
    if (streamStart === -1) break;

    const contentStart = skipStreamEol(buf, streamStart + "stream".length);
    const contentEnd = buf.indexOf("endstream", contentStart, "latin1");
    if (contentEnd === -1) break;

    const dictWindow = buf.subarray(Math.max(0, streamStart - 512), streamStart);
    const isFlate = dictWindow.indexOf("FlateDecode", 0, "latin1") !== -1;

    const raw = buf.subarray(contentStart, contentEnd);
    let streamBytes: Buffer | null = raw;
    if (isFlate) {
      streamBytes = inflate(raw);
      if (streamBytes === null) {
        offset = contentEnd + "endstream".length;
        continue;
      }
    }

    const text = extractBtEtText(streamBytes);
    if (text) {
      if (allText) allText += "\n";
      allText += text;
    }

    offset = contentEnd + "endstream".length;
  }

  return allText;
}

function inflate(data: Buffer): Buffer | null {
  try {
    return zlib.inflateSync(data);
  } catch {
    // fall through
  }
  try {
    return zlib.inflateRawSync(data);
  } catch {
    return null;
  }
}

function skipStreamEol(buf: Buffer, pos: number): number {
  if (pos < buf.length && buf[pos] === 0x0d) {
    return pos + 1 < buf.length && buf[pos + 1] === 0x0a ? pos + 2 : pos + 1;
  }
  if (pos < buf.length && buf[pos] === 0x0a) {
    return pos + 1;
  }
  return pos;
}

function extractBtEtText(stream: Buffer): string {
  const text = stream.toString("latin1");
  let result = "";
  let inBt = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "BT") {
      inBt = true;
      continue;
    }
    if (trimmed === "ET") {
      inBt = false;
      continue;
    }
    if (!inBt) continue;

    if (trimmed.endsWith("Tj")) {
      const s = extractParenthesizedString(trimmed);
      if (s !== null) {
        if (result && !result.endsWith("\n")) result += " ";
        result += s;
      }
    } else if (trimmed.endsWith("TJ")) {
      const extracted = extractTjArray(trimmed);
      if (extracted) {
        if (result && !result.endsWith("\n")) result += " ";
        result += extracted;
      }
    } else if (isNewlineShowOperator(trimmed)) {
      const s = extractParenthesizedString(trimmed);
      if (s !== null) {
        if (result) result += "\n";
        result += s;
      }
    }
  }

  return result;
}

function isNewlineShowOperator(trimmed: string): boolean {
  return (trimmed.endsWith("'") && trimmed.length > 1) || (trimmed.endsWith('"') && trimmed.includes("("));
}

function isOctal(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "7";
}

function extractParenthesizedString(input: string): string | null {
  const open = input.indexOf("(");
  if (open === -1) return null;

  let depth = 0;
  let result = "";
  let i = open;

  while (i < input.length) {
    const c = input[i];
    if (c === "(") {
      if (depth > 0) result += "(";
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return result;
      result += ")";
    } else if (c === "\\" && i + 1 < input.length) {
      i += 1;
      const e = input[i];
      if (e === "n") result += "\n";
      else if (e === "r") result += "\r";
      else if (e === "t") result += "\t";
      else if (e === "\\") result += "\\";
      else if (e === "(") result += "(";
      else if (e === ")") result += ")";
      else if (isOctal(e)) {
        let octal = e.charCodeAt(0) - 48;
        for (let k = 0; k < 2; k += 1) {
          if (isOctal(input[i + 1])) {
            i += 1;
            octal = octal * 8 + (input[i].charCodeAt(0) - 48);
          } else {
            break;
          }
        }
        result += String.fromCharCode(octal);
      } else {
        result += e;
      }
    } else {
      result += c;
    }
    i += 1;
  }

  return null; // unbalanced
}

function extractTjArray(input: string): string {
  let result = "";
  const bracketStart = input.indexOf("[");
  const bracketEnd = input.lastIndexOf("]");
  if (bracketStart === -1 || bracketEnd === -1) return result;

  const inner = input.slice(bracketStart + 1, bracketEnd);
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "(") {
      const s = extractParenthesizedString(inner.slice(i));
      if (s !== null) {
        result += s;
        let depth = 0;
        while (i < inner.length) {
          const b = inner[i];
          i += 1;
          if (b === "(") depth += 1;
          else if (b === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        continue;
      }
    }
    i += 1;
  }

  return result;
}
