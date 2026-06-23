import assert from "node:assert/strict";
import test from "node:test";

import {
  LspClientSession,
  LspClientError,
  uriToPath,
} from "../dist/runtime/lsp/client.js";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------
//
// A hermetic, in-memory LSP transport. It records every envelope sent and, for
// each *request* (has an `id`), looks up a scripted response keyed by method and
// delivers it asynchronously to the registered onMessage handler. Notifications
// (no `id`, e.g. `initialized`, `textDocument/didOpen`) are recorded only.
//
// A scripted responder may also return `{ notify: [...] }` to have the transport
// push server-originated notifications (e.g. textDocument/publishDiagnostics)
// back to the client — this is how we exercise the push-driven diagnostics path.
// No subprocess is ever spawned.

function mockTransport(script) {
  const sent = [];
  let handler;
  let closed = false;

  function deliver(message) {
    queueMicrotask(() => {
      if (handler && !closed) handler(message);
    });
  }

  return {
    sent,
    isClosed: () => closed,
    // Allow a test to push an unsolicited server notification at any time.
    pushNotification: (method, params) => deliver({ jsonrpc: "2.0", method, params }),
    transport: {
      async send(message) {
        sent.push(message);
        // `shutdown` is a standard request every server answers; auto-reply so
        // `session.shutdown()` in test teardown never blocks, unless a test
        // explicitly scripts its own `shutdown` behavior.
        let responder = script[message.method];
        if (responder === undefined && message.method === "shutdown") {
          responder = { result: null };
        }
        if (responder === undefined) return; // unscripted (notification or ignored)
        const make = typeof responder === "function" ? responder : () => responder;
        const calls = sent.filter((m) => m.method === message.method).length - 1;
        const body = make(message, calls);
        if (body === undefined) return; // deliberately drop to exercise timeouts

        // Optionally fan out server-originated notifications first.
        if (Array.isArray(body.notify)) {
          for (const n of body.notify) deliver({ jsonrpc: "2.0", method: n.method, params: n.params });
        }

        // Then the response to the request itself (requests carry an id).
        if (message.id !== undefined && (body.result !== undefined || body.error !== undefined)) {
          deliver({ jsonrpc: "2.0", id: message.id, result: body.result, error: body.error });
        }
      },
      onMessage(cb) {
        handler = cb;
      },
      close() {
        closed = true;
      },
    },
  };
}

const INIT_OK = {
  result: { capabilities: {}, serverInfo: { name: "fake-ls", version: "1" } },
};

const ROOT_URI = "file:///workspace";
const FILE_URI = "file:///workspace/src/main.ts";

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

test("initialize performs the request then the initialized notification", async () => {
  const mock = mockTransport({ initialize: INIT_OK });
  const session = new LspClientSession(mock.transport);

  await session.initialize(ROOT_URI);

  const init = mock.sent.find((m) => m.method === "initialize");
  assert.ok(init, "initialize request was sent");
  assert.equal(init.params.rootUri, ROOT_URI);
  assert.ok(init.id !== undefined, "initialize is a request (has id)");

  const initialized = mock.sent.find((m) => m.method === "initialized");
  assert.ok(initialized, "initialized notification was sent");
  assert.equal(initialized.id, undefined, "initialized is a notification (no id)");

  // A second initialize is a no-op.
  await session.initialize(ROOT_URI);
  assert.equal(mock.sent.filter((m) => m.method === "initialize").length, 1);

  await session.shutdown();
});

// ---------------------------------------------------------------------------
// didOpen + publishDiagnostics push
// ---------------------------------------------------------------------------

test("didOpen surfaces a publishDiagnostics notification via diagnostics(uri)", async () => {
  const mock = mockTransport({ initialize: INIT_OK });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);

  // No diagnostics yet.
  assert.deepEqual(session.diagnostics(FILE_URI), []);

  await session.didOpen(FILE_URI, "typescript", "const x: number = 'oops';\n");

  const didOpen = mock.sent.find((m) => m.method === "textDocument/didOpen");
  assert.ok(didOpen, "didOpen notification was sent");
  assert.equal(didOpen.id, undefined);
  assert.equal(didOpen.params.textDocument.uri, FILE_URI);
  assert.equal(didOpen.params.textDocument.languageId, "typescript");
  assert.equal(didOpen.params.textDocument.version, 1);

  // Server pushes diagnostics for the opened file.
  mock.pushNotification("textDocument/publishDiagnostics", {
    uri: FILE_URI,
    diagnostics: [
      {
        range: { start: { line: 0, character: 17 }, end: { line: 0, character: 23 } },
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
        source: "ts",
      },
      {
        range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
        severity: 2,
        message: "'foo' is declared but never used.",
      },
    ],
  });
  // Let the microtask deliver the notification.
  await Promise.resolve();
  await Promise.resolve();

  const diags = session.diagnostics(FILE_URI);
  assert.equal(diags.length, 2);
  assert.equal(diags[0].severity, "error");
  assert.equal(diags[0].line, 0);
  assert.equal(diags[0].character, 17);
  assert.match(diags[0].message, /not assignable/);
  assert.equal(diags[0].source, "ts");
  assert.equal(diags[1].severity, "warning");
  assert.equal(diags[1].source, undefined);
  // Path was mapped from the file:// URI.
  assert.match(diags[0].path, /src\/main\.ts$/);

  // A re-open bumps the version.
  await session.didOpen(FILE_URI, "typescript", "fixed\n");
  const reopens = mock.sent.filter((m) => m.method === "textDocument/didOpen");
  assert.equal(reopens[1].params.textDocument.version, 2);

  await session.shutdown();
});

// ---------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------

test("hover round-trips and flattens MarkupContent", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/hover": (req) => {
      assert.equal(req.params.textDocument.uri, FILE_URI);
      assert.deepEqual(req.params.position, { line: 2, character: 6 });
      return {
        result: {
          contents: { kind: "markdown", value: "```ts\nconst x: number\n```" },
          range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } },
        },
      };
    },
  });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);

  const hover = await session.hover(FILE_URI, { line: 2, character: 6 });
  assert.ok(hover);
  assert.match(hover.content, /const x: number/);
  assert.equal(hover.language, undefined);

  await session.shutdown();
});

test("hover flattens a MarkedString array and captures the language", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/hover": {
      result: {
        contents: [
          { language: "typescript", value: "function foo(): void" },
          "Does the thing.",
        ],
      },
    },
  });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);

  const hover = await session.hover(FILE_URI, { line: 0, character: 0 });
  assert.ok(hover);
  assert.match(hover.content, /function foo/);
  assert.match(hover.content, /Does the thing/);
  assert.equal(hover.language, "typescript");

  await session.shutdown();
});

test("hover returns null when the server reports no hover", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/hover": { result: null },
  });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);

  const hover = await session.hover(FILE_URI, { line: 9, character: 9 });
  assert.equal(hover, null);

  await session.shutdown();
});

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

test("definition normalizes a single Location, an array, and LocationLinks", async () => {
  // Single Location.
  const single = mockTransport({
    initialize: INIT_OK,
    "textDocument/definition": {
      result: {
        uri: "file:///workspace/src/dep.ts",
        range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } },
      },
    },
  });
  const s1 = new LspClientSession(single.transport);
  await s1.initialize(ROOT_URI);
  const locs1 = await s1.definition(FILE_URI, { line: 2, character: 6 });
  assert.equal(locs1.length, 1);
  assert.match(locs1[0].path, /src\/dep\.ts$/);
  assert.equal(locs1[0].line, 10);
  assert.equal(locs1[0].character, 4);
  assert.equal(locs1[0].endLine, 10);
  assert.equal(locs1[0].endCharacter, 12);
  await s1.shutdown();

  // LocationLink[] (linkSupport) — targetSelectionRange wins over targetRange.
  const links = mockTransport({
    initialize: INIT_OK,
    "textDocument/definition": {
      result: [
        {
          targetUri: "file:///workspace/src/a.ts",
          targetRange: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
          targetSelectionRange: { start: { line: 3, character: 9 }, end: { line: 3, character: 14 } },
        },
      ],
    },
  });
  const s2 = new LspClientSession(links.transport);
  await s2.initialize(ROOT_URI);
  const locs2 = await s2.definition(FILE_URI, { line: 1, character: 1 });
  assert.equal(locs2.length, 1);
  assert.match(locs2[0].path, /src\/a\.ts$/);
  assert.equal(locs2[0].line, 3);
  assert.equal(locs2[0].character, 9);
  await s2.shutdown();
});

test("definition returns an empty array when the server returns null", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/definition": { result: null },
  });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);
  assert.deepEqual(await session.definition(FILE_URI, { line: 0, character: 0 }), []);
  await session.shutdown();
});

// ---------------------------------------------------------------------------
// Error + timeout surfacing
// ---------------------------------------------------------------------------

test("a JSON-RPC error response surfaces as LspClientError", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/hover": { error: { code: -32603, message: "internal error" } },
  });
  const session = new LspClientSession(mock.transport);
  await session.initialize(ROOT_URI);

  await assert.rejects(
    () => session.hover(FILE_URI, { line: 0, character: 0 }),
    (error) => {
      assert.ok(error instanceof LspClientError);
      assert.equal(error.method, "textDocument/hover");
      assert.match(error.message, /internal error/);
      return true;
    },
  );
  await session.shutdown();
});

test("a request times out when the transport never replies", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "textDocument/definition": () => undefined, // never reply
  });
  const session = new LspClientSession(mock.transport, { requestTimeoutMs: 20 });
  await session.initialize(ROOT_URI);

  await assert.rejects(
    () => session.definition(FILE_URI, { line: 0, character: 0 }),
    (error) => {
      assert.ok(error instanceof LspClientError);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
  await session.shutdown();
});

// ---------------------------------------------------------------------------
// uriToPath helper
// ---------------------------------------------------------------------------

test("uriToPath maps file:// URIs (incl. Windows drive + percent-encoding) and passes through bare paths", () => {
  assert.equal(uriToPath("file:///workspace/src/main.ts"), "/workspace/src/main.ts");
  assert.equal(uriToPath("file:///C:/Users/x/a.ts"), "C:/Users/x/a.ts");
  assert.equal(uriToPath("file:///path/with%20space.ts"), "/path/with space.ts");
  assert.equal(uriToPath("/already/a/path.ts"), "/already/a/path.ts");
});
