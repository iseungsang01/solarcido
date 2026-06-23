import assert from "node:assert/strict";
import test from "node:test";

import { validateConfigDiagnostics } from "../dist/runtime/config-validate.js";

const KNOWN_KEYS = ["model", "reasoningEffort", "approvalPolicy", "sandbox", "quiet"];

// ---------------------------------------------------------------------------
// unknown-key diagnostics
// ---------------------------------------------------------------------------

test("unknown key 'modle' → suggestion 'model'", () => {
  const diags = validateConfigDiagnostics({ modle: "solar-pro" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "unknown-key");
  assert.equal(diags[0].key, "modle");
  assert.equal(diags[0].suggestion, "model");
});

test("unknown key with no close match → no suggestion", () => {
  const diags = validateConfigDiagnostics({ zzzzz: "value" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "unknown-key");
  assert.equal(diags[0].key, "zzzzz");
  assert.equal("suggestion" in diags[0] ? diags[0].suggestion : undefined, undefined);
});

// ---------------------------------------------------------------------------
// wrong-type diagnostics
// ---------------------------------------------------------------------------

test("sandbox 'danger-full-access' → wrong-type (not one of the 2 valid modes)", () => {
  const diags = validateConfigDiagnostics({ sandbox: "danger-full-access" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "wrong-type");
  assert.equal(diags[0].key, "sandbox");
  assert.ok("expected" in diags[0] && diags[0].expected.includes("read-only"));
  assert.ok("expected" in diags[0] && diags[0].expected.includes("workspace-write"));
});

test("sandbox 'read-only' → valid, no diagnostics", () => {
  const diags = validateConfigDiagnostics({ sandbox: "read-only" }, KNOWN_KEYS);
  assert.equal(diags.length, 0);
});

test("sandbox 'workspace-write' → valid, no diagnostics", () => {
  const diags = validateConfigDiagnostics({ sandbox: "workspace-write" }, KNOWN_KEYS);
  assert.equal(diags.length, 0);
});

test("quiet 'yes' (string) → wrong-type expected boolean", () => {
  const diags = validateConfigDiagnostics({ quiet: "yes" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "wrong-type");
  assert.equal(diags[0].key, "quiet");
  assert.ok("expected" in diags[0] && diags[0].expected === "boolean");
  assert.ok("got" in diags[0] && diags[0].got === "string");
});

test("quiet true → valid, no diagnostics", () => {
  const diags = validateConfigDiagnostics({ quiet: true }, KNOWN_KEYS);
  assert.equal(diags.length, 0);
});

test("model 123 (number) → wrong-type expected string", () => {
  const diags = validateConfigDiagnostics({ model: 123 }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "wrong-type");
  assert.equal(diags[0].key, "model");
  assert.ok("expected" in diags[0] && diags[0].expected === "string");
});

test("reasoningEffort 'ultra' → wrong-type (not low|medium|high)", () => {
  const diags = validateConfigDiagnostics({ reasoningEffort: "ultra" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "wrong-type");
  assert.equal(diags[0].key, "reasoningEffort");
});

test("reasoningEffort 'high' → valid, no diagnostics", () => {
  const diags = validateConfigDiagnostics({ reasoningEffort: "high" }, KNOWN_KEYS);
  assert.equal(diags.length, 0);
});

test("approvalPolicy 'always' → wrong-type", () => {
  const diags = validateConfigDiagnostics({ approvalPolicy: "always" }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "wrong-type");
  assert.equal(diags[0].key, "approvalPolicy");
});

// ---------------------------------------------------------------------------
// deprecated diagnostics
// ---------------------------------------------------------------------------

test("maxSteps → deprecated, no replacement", () => {
  const diags = validateConfigDiagnostics({ maxSteps: 20 }, KNOWN_KEYS);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, "deprecated");
  assert.equal(diags[0].key, "maxSteps");
  // no replacement defined
  assert.equal("replacement" in diags[0] ? diags[0].replacement : null, undefined);
});

// ---------------------------------------------------------------------------
// valid config → no diagnostics
// ---------------------------------------------------------------------------

test("fully valid config → no diagnostics", () => {
  const diags = validateConfigDiagnostics(
    {
      model: "solar-pro3-260323",
      reasoningEffort: "high",
      approvalPolicy: "on-failure",
      sandbox: "workspace-write",
      quiet: false,
    },
    KNOWN_KEYS,
  );
  assert.equal(diags.length, 0);
});

// ---------------------------------------------------------------------------
// multiple issues in one object
// ---------------------------------------------------------------------------

test("multiple issues → all reported", () => {
  const diags = validateConfigDiagnostics(
    {
      model: 42,           // wrong-type
      modle: "x",         // unknown-key with suggestion
      maxSteps: 10,       // deprecated
    },
    KNOWN_KEYS,
  );
  assert.equal(diags.length, 3);

  const kinds = diags.map((d) => d.kind);
  assert.ok(kinds.includes("wrong-type"));
  assert.ok(kinds.includes("unknown-key"));
  assert.ok(kinds.includes("deprecated"));
});
