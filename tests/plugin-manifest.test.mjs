import assert from "node:assert/strict";
import test from "node:test";

import { validateManifest } from "../dist/plugins/manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalRaw(overrides = {}) {
  return {
    name: "my-plugin",
    version: "1.0.0",
    description: "A test plugin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("validateManifest: accepts a minimal valid manifest", () => {
  const result = validateManifest(minimalRaw());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.name, "my-plugin");
  assert.equal(result.manifest.version, "1.0.0");
  assert.equal(result.manifest.description, "A test plugin");
  assert.deepEqual(result.manifest.permissions, []);
  assert.equal(result.manifest.defaultEnabled, false);
  assert.deepEqual(result.manifest.hooks.PreToolUse, []);
  assert.deepEqual(result.manifest.tools, []);
  assert.deepEqual(result.manifest.commands, []);
});

test("validateManifest: accepts permissions read/write/execute", () => {
  const result = validateManifest(minimalRaw({ permissions: ["read", "write", "execute"] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.manifest.permissions, ["read", "write", "execute"]);
});

test("validateManifest: accepts defaultEnabled true", () => {
  const result = validateManifest(minimalRaw({ defaultEnabled: true }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.defaultEnabled, true);
});

test("validateManifest: accepts valid tools", () => {
  const result = validateManifest(
    minimalRaw({
      tools: [
        {
          name: "do-thing",
          description: "Does the thing",
          inputSchema: { type: "object" },
          command: "node",
          args: ["tool.js"],
          requiredPermission: "read-only",
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.tools.length, 1);
  assert.equal(result.manifest.tools[0].name, "do-thing");
  assert.equal(result.manifest.tools[0].requiredPermission, "read-only");
});

test("validateManifest: accepts all three tool permission values", () => {
  const permissions = ["read-only", "workspace-write", "danger-full-access"];
  for (const perm of permissions) {
    const result = validateManifest(
      minimalRaw({
        tools: [
          {
            name: "t",
            description: "d",
            inputSchema: {},
            command: "cmd",
            args: [],
            requiredPermission: perm,
          },
        ],
      }),
    );
    assert.equal(result.ok, true, `expected ok for requiredPermission=${perm}`);
  }
});

test("validateManifest: populates hooks from raw object", () => {
  const result = validateManifest(
    minimalRaw({
      hooks: {
        PreToolUse: ["pre.sh"],
        PostToolUse: ["post.sh"],
        PostToolUseFailure: ["fail.sh"],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.manifest.hooks.PreToolUse, ["pre.sh"]);
  assert.deepEqual(result.manifest.hooks.PostToolUse, ["post.sh"]);
  assert.deepEqual(result.manifest.hooks.PostToolUseFailure, ["fail.sh"]);
});

test("validateManifest: accepts valid commands", () => {
  const result = validateManifest(
    minimalRaw({
      commands: [{ name: "/foo", description: "Foo command", command: "node foo.js" }],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.commands.length, 1);
  assert.equal(result.manifest.commands[0].name, "/foo");
});

// ---------------------------------------------------------------------------
// Required field errors
// ---------------------------------------------------------------------------

test("validateManifest: rejects non-object input", () => {
  const result = validateManifest("not an object");
  assert.equal(result.ok, false);
});

test("validateManifest: rejects missing name", () => {
  const result = validateManifest({ version: "1.0.0", description: "d" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "emptyField" && e.field === "name"));
});

test("validateManifest: rejects blank name", () => {
  const result = validateManifest(minimalRaw({ name: "   " }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "emptyField" && e.field === "name"));
});

test("validateManifest: rejects missing version", () => {
  const result = validateManifest({ name: "p", description: "d" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "emptyField" && e.field === "version"));
});

test("validateManifest: rejects missing description", () => {
  const result = validateManifest({ name: "p", version: "1.0.0" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "emptyField" && e.field === "description"));
});

// ---------------------------------------------------------------------------
// Permission errors
// ---------------------------------------------------------------------------

test("validateManifest: rejects unknown permission", () => {
  const result = validateManifest(minimalRaw({ permissions: ["sudo"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "invalidPermission" && e.permission === "sudo"));
});

test("validateManifest: rejects duplicate permission", () => {
  const result = validateManifest(minimalRaw({ permissions: ["read", "read"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "duplicatePermission" && e.permission === "read"));
});

// ---------------------------------------------------------------------------
// Tool errors
// ---------------------------------------------------------------------------

test("validateManifest: rejects tool with empty name", () => {
  const result = validateManifest(
    minimalRaw({
      tools: [{ name: "", description: "d", inputSchema: {}, command: "c", requiredPermission: "read-only" }],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "emptyEntryField" && e.kind === "tool" && e.field === "name"));
});

test("validateManifest: rejects duplicate tool name", () => {
  const tool = { name: "dup", description: "d", inputSchema: {}, command: "c", requiredPermission: "read-only" };
  const result = validateManifest(minimalRaw({ tools: [tool, tool] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "duplicateEntry" && e.kind === "tool" && e.name === "dup"));
});

test("validateManifest: rejects tool with non-object inputSchema", () => {
  const result = validateManifest(
    minimalRaw({
      tools: [{ name: "t", description: "d", inputSchema: "bad", command: "c", requiredPermission: "read-only" }],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "invalidToolInputSchema" && e.toolName === "t"));
});

test("validateManifest: rejects tool with invalid requiredPermission", () => {
  const result = validateManifest(
    minimalRaw({
      tools: [{ name: "t", description: "d", inputSchema: {}, command: "c", requiredPermission: "superpower" }],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some(
      (e) => e.tag === "invalidToolRequiredPermission" && e.toolName === "t" && e.permission === "superpower",
    ),
  );
});

// ---------------------------------------------------------------------------
// Command errors
// ---------------------------------------------------------------------------

test("validateManifest: rejects command with empty name", () => {
  const result = validateManifest(
    minimalRaw({ commands: [{ name: "", description: "d", command: "c" }] }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.tag === "emptyEntryField" && e.kind === "command" && e.field === "name"),
  );
});

test("validateManifest: rejects duplicate command name", () => {
  const cmd = { name: "foo", description: "d", command: "c" };
  const result = validateManifest(minimalRaw({ commands: [cmd, cmd] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.tag === "duplicateEntry" && e.kind === "command" && e.name === "foo"));
});

// ---------------------------------------------------------------------------
// Multiple errors accumulated
// ---------------------------------------------------------------------------

test("validateManifest: accumulates multiple errors in one pass", () => {
  const result = validateManifest({
    name: "",
    version: "",
    description: "",
    permissions: ["bad1", "bad2"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.length >= 5);
});
