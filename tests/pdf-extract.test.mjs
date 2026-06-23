import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { extractTextFromBytes, isPdfPath } from "../dist/runtime/pdf-extract.js";

function rawPdf(content) {
  return Buffer.from(
    `%PDF-1.4\n2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF\n`,
    "latin1",
  );
}

function flatePdf(text) {
  const content = Buffer.from(`BT\n/F1 12 Tf\n(${text}) Tj\nET`, "latin1");
  const compressed = zlib.deflateSync(content);
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

test("extracts uncompressed text from a minimal PDF", () => {
  assert.equal(extractTextFromBytes(rawPdf("BT\n/F1 12 Tf\n(Hello World) Tj\nET")), "Hello World");
});

test("extracts text from a FlateDecode-compressed stream", () => {
  assert.equal(extractTextFromBytes(flatePdf("Compressed PDF Text")), "Compressed PDF Text");
});

test("handles the TJ array operator", () => {
  assert.equal(extractTextFromBytes(rawPdf("BT\n[ (Hello) -120 ( World) ] TJ\nET")), "Hello World");
});

test("handles escaped parentheses", () => {
  assert.equal(extractTextFromBytes(rawPdf("BT\n(Hello \\(World\\)) Tj\nET")), "Hello (World)");
});

test("returns empty string for non-PDF data", () => {
  assert.equal(extractTextFromBytes(Buffer.from("This is not a PDF file at all", "latin1")), "");
});

test("isPdfPath detects .pdf references case-insensitively", () => {
  assert.equal(isPdfPath("docs/report.pdf"), true);
  assert.equal(isPdfPath("FILE.PDF"), true);
  assert.equal(isPdfPath("notes.txt"), false);
});
