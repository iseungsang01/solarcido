import assert from "node:assert/strict";
import test from "node:test";

import { McpServerSession } from "../dist/runtime/mcp/server.js";
import { buildMcpServerSpec } from "../dist/workflow/mcp-serve-command.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------
//
// A hermetic, in-memory server transport: the test pushes inbound JSON-RPC
// requests at the session via `inject(...)` and collects the responses the
// session sends back in `responses`. No process is ever spawned, mirroring the
// fake-transport approach in tests/mcp-client.test.mjs.

function fakeTransport() {
  const responses = [];
  let messageHandler;
  let closeHandler;
  let closed = false;
  return {
    responses,
    isClosed: () => closed,
    // Push a parsed request (or `{ kind: "parse-error", error }`) at the session.
    inject(message) {
      const wrapped = message.kind === "parse-error" ? message : { kind: "message", value: message };
      messageHandler?.(wrapped);
    },
    fireClose() {
      closeHandler?.();
    },
    transport: {
      async send(message) {
        responses.push(message);
      },
      onMessage(cb) {
        messageHandler = cb;
      },
      onClose(cb) {
        closeHandler = cb;
      },
      close() {
        closed = true;
      },
    },
  };
}

const request = (id, method, params) => {
  const envelope = { jsonrpc: "2.0", id, method };
  if (params !== undefined) envelope.params = params;
  return envelope;
};

// A spec wired to a fresh builtin-tool registry, sandboxed read-only so no real
// mutation can happen during tests.
function builtinSpec() {
  return buildMcpServerSpec({ root: process.cwd(), approvalPolicy: "never", sandbox: "read-only" });
}

// ---------------------------------------------------------------------------
// initialize handshake
// ---------------------------------------------------------------------------

test("initialize returns protocol version and serverInfo", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject(request(1, "initialize"));
  await tick();

  assert.equal(fake.responses.length, 1);
  const response = fake.responses[0];
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, "2025-03-26");
  assert.equal(response.result.serverInfo.name, "solarcido");
  assert.deepEqual(response.result.capabilities, { tools: {} });
});

// ---------------------------------------------------------------------------
// tools/list derives from the registry
// ---------------------------------------------------------------------------

test("tools/list returns the builtin tools", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject(request(2, "tools/list"));
  await tick();

  const response = fake.responses[0];
  assert.equal(response.error, undefined);
  const names = response.result.tools.map((t) => t.name);
  // A representative slice of the builtin set; the registry owns the full list.
  for (const expected of ["read_file", "write_file", "search_files", "run_command", "finish"]) {
    assert.ok(names.includes(expected), `expected tools/list to include ${expected}`);
  }
  // Tool descriptors carry their JSON schema through as inputSchema.
  const readFile = response.result.tools.find((t) => t.name === "read_file");
  assert.equal(readFile.inputSchema.type, "object");
});

// ---------------------------------------------------------------------------
// tools/call routes through the registry
// ---------------------------------------------------------------------------

test("tools/call routes to a tool and returns its result", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  // list_files is read-only, so it runs under the read-only sandbox.
  fake.inject(request(3, "tools/call", { name: "list_files", arguments: { path: "." } }));
  await waitForResponse(fake); // list_files does real directory I/O — wait for it to settle

  const response = fake.responses[0];
  assert.equal(response.error, undefined);
  assert.equal(response.id, 3);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  assert.equal(typeof response.result.content[0].text, "string");
});

test("tools/call wraps a registry error with isError", async () => {
  const fake = fakeTransport();
  // A write tool under a read-only sandbox is rejected by the registry as
  // `ERROR: ...`, which the server surfaces with isError: true.
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject(request(4, "tools/call", { name: "write_file", arguments: { path: "x.txt", content: "hi" } }));
  await tick();

  const response = fake.responses[0];
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^ERROR:/);
});

test("tools/call with custom handler round-trips name and args", async () => {
  const fake = fakeTransport();
  const spec = {
    serverName: "test",
    serverVersion: "0.0.0",
    tools: [],
    toolHandler: (name, args) => ({ text: `called ${name} with ${JSON.stringify(args)}` }),
  };
  new McpServerSession(spec, fake.transport);

  fake.inject(request(5, "tools/call", { name: "echo", arguments: { text: "hi" } }));
  await tick();

  const response = fake.responses[0];
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].text, 'called echo with {"text":"hi"}');
});

// ---------------------------------------------------------------------------
// error + notification semantics (faithful to mcp_server.rs)
// ---------------------------------------------------------------------------

test("unknown method returns method-not-found (-32601)", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject(request(6, "nonsense"));
  await tick();

  const response = fake.responses[0];
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
});

test("tools/call without params returns invalid-params (-32602)", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject(request(7, "tools/call"));
  await tick();

  assert.equal(fake.responses[0].error.code, -32602);
});

test("a parse error yields a -32700 response with null id", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  fake.inject({ kind: "parse-error", error: "bad json" });
  await tick();

  const response = fake.responses[0];
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
});

test("a notification (no id) receives no reply", async () => {
  const fake = fakeTransport();
  new McpServerSession(builtinSpec(), fake.transport);

  // No `id` field at all -> notification.
  fake.inject({ jsonrpc: "2.0", method: "initialized", params: {} });
  await tick();

  assert.equal(fake.responses.length, 0);
});

test("run() resolves when the transport closes", async () => {
  const fake = fakeTransport();
  const session = new McpServerSession(builtinSpec(), fake.transport);

  const running = session.run();
  fake.fireClose();
  await running; // resolves, does not hang
  assert.ok(true);
});

/** Yield to the microtask/timer queue so async handlers settle. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until at least `count` responses are collected (bounded so a real hang still fails). */
async function waitForResponse(fake, count = 1) {
  for (let i = 0; i < 200 && fake.responses.length < count; i += 1) {
    await tick();
  }
}
