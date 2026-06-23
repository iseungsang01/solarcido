import assert from "node:assert/strict";
import test from "node:test";

import {
  McpServerManager,
  McpServerSession,
  McpClientError,
} from "../dist/runtime/mcp/client.js";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------
//
// A hermetic, in-memory transport: it records every request it is sent and, for
// each one, looks up a scripted response keyed by JSON-RPC method, then delivers
// it asynchronously to the registered onMessage handler. No subprocess is ever
// spawned.

function mockTransport(script, options = {}) {
  const sent = [];
  let handler;
  let closed = false;
  return {
    sent,
    isClosed: () => closed,
    transport: {
      async send(message) {
        sent.push(message);
        const responder = script[message.method];
        if (responder === undefined) return; // no reply scripted (e.g. notification)
        const make = typeof responder === "function" ? responder : () => responder;
        const body = make(message, sent.filter((m) => m.method === message.method).length - 1);
        if (body === undefined) return; // deliberately drop to exercise timeouts
        const response = { jsonrpc: "2.0", id: message.id, ...body };
        // Deliver on a future tick to mimic real async transports.
        queueMicrotask(() => {
          if (handler && !closed) handler(response);
        });
      },
      onMessage(cb) {
        handler = cb;
      },
      close() {
        closed = true;
        if (options.onClose) options.onClose();
      },
    },
  };
}

const INIT_OK = { result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1" } } };

function echoToolsList() {
  return {
    result: {
      tools: [
        {
          name: "echo",
          description: "Echoes text",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Session-level: initialize, discovery, invoke round-trips
// ---------------------------------------------------------------------------

test("session initializes once and discovers tools", async () => {
  let initCount = 0;
  const mock = mockTransport({
    initialize: () => {
      initCount += 1;
      return INIT_OK;
    },
    "tools/list": echoToolsList(),
  });
  const session = new McpServerSession("alpha", mock.transport);

  const tools = await session.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");

  // A second discovery must not re-initialize.
  await session.listTools();
  assert.equal(initCount, 1);

  // initialize then two tools/list calls were sent.
  assert.equal(mock.sent.filter((m) => m.method === "initialize").length, 1);
  assert.equal(mock.sent.filter((m) => m.method === "tools/list").length, 2);
});

test("session tools/list follows nextCursor pagination", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "tools/list": (req) => {
      if (req.params && req.params.cursor === "page2") {
        return { result: { tools: [{ name: "second" }] } };
      }
      return { result: { tools: [{ name: "first" }], nextCursor: "page2" } };
    },
  });
  const session = new McpServerSession("alpha", mock.transport);
  const tools = await session.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["first", "second"]);
});

test("session callTool round-trips arguments and result", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "tools/call": (req) => ({
      result: {
        content: [{ type: "text", text: `echo:${req.params.arguments.text}` }],
        structuredContent: { echoed: req.params.arguments.text },
        isError: false,
      },
    }),
  });
  const session = new McpServerSession("alpha", mock.transport);
  const result = await session.callTool("echo", { text: "hello" });
  assert.equal(result.content[0].text, "echo:hello");
  assert.deepEqual(result.structuredContent, { echoed: "hello" });
  assert.equal(result.isError, false);
});

test("session surfaces JSON-RPC errors as McpClientError", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "tools/call": { error: { code: -32001, message: "tool failed" } },
  });
  const session = new McpServerSession("alpha", mock.transport);
  await assert.rejects(() => session.callTool("fail", {}), (error) => {
    assert.ok(error instanceof McpClientError);
    assert.equal(error.method, "tools/call");
    assert.match(error.message, /tool failed/);
    return true;
  });
});

test("session surfaces a missing result payload", async () => {
  const mock = mockTransport({ initialize: { jsonrpc: "2.0" } });
  const session = new McpServerSession("alpha", mock.transport, { requestTimeoutMs: 0 });
  await assert.rejects(() => session.listResources(), McpClientError);
});

test("session times out when the transport never replies", async () => {
  const mock = mockTransport({ initialize: () => undefined });
  const session = new McpServerSession("alpha", mock.transport, { requestTimeoutMs: 20 });
  await assert.rejects(() => session.listTools(), (error) => {
    assert.ok(error instanceof McpClientError);
    assert.match(error.message, /timed out/);
    return true;
  });
});

test("session lists and reads resources", async () => {
  const mock = mockTransport({
    initialize: INIT_OK,
    "resources/list": { result: { resources: [{ uri: "file://guide.txt", name: "guide" }] } },
    "resources/read": (req) => ({
      result: { contents: [{ uri: req.params.uri, text: `contents for ${req.params.uri}` }] },
    }),
  });
  const session = new McpServerSession("alpha", mock.transport);
  const list = await session.listResources();
  assert.equal(list.resources[0].uri, "file://guide.txt");
  const read = await session.readResource("file://guide.txt");
  assert.equal(read.contents[0].text, "contents for file://guide.txt");
});

// ---------------------------------------------------------------------------
// Manager-level: routing, multi-server, invoke by qualified name
// ---------------------------------------------------------------------------

test("manager discovers tools across servers and routes invoke by qualified name", async () => {
  const alpha = mockTransport({
    initialize: INIT_OK,
    "tools/list": echoToolsList(),
    "tools/call": (req) => ({ result: { content: [{ type: "text", text: `alpha:${req.params.arguments.text}` }], isError: false } }),
  });
  const beta = mockTransport({
    initialize: INIT_OK,
    "tools/list": { result: { tools: [{ name: "search" }] } },
    "tools/call": () => ({ result: { content: [{ type: "text", text: "beta-result" }], isError: false } }),
  });

  const manager = new McpServerManager();
  manager.registerServer({ serverName: "alpha", transport: alpha.transport });
  manager.registerServer({ serverName: "beta", transport: beta.transport });

  const tools = await manager.discoverTools();
  const names = tools.map((t) => t.qualifiedName).sort();
  assert.deepEqual(names, ["mcp__alpha__echo", "mcp__beta__search"]);
  assert.deepEqual(manager.serverNames(), ["alpha", "beta"]);

  const result = await manager.invoke("mcp__alpha__echo", { text: "hi" });
  assert.equal(result.content[0].text, "alpha:hi");
  // alpha received the tools/call with the RAW tool name, not the qualified one.
  const alphaCall = alpha.sent.find((m) => m.method === "tools/call");
  assert.equal(alphaCall.params.name, "echo");
});

test("manager rejects an unknown qualified tool name", async () => {
  const manager = new McpServerManager();
  await assert.rejects(() => manager.invoke("mcp__nope__missing", {}), (error) => {
    assert.ok(error instanceof McpClientError);
    assert.match(error.message, /unknown MCP tool/);
    return true;
  });
});

test("manager best-effort discovery isolates a failing server", async () => {
  const good = mockTransport({ initialize: INIT_OK, "tools/list": echoToolsList() });
  const bad = mockTransport({ initialize: { error: { code: -1, message: "boom" } } });

  const manager = new McpServerManager();
  manager.registerServer({ serverName: "good", transport: good.transport });
  manager.registerServer({ serverName: "bad", transport: bad.transport, options: { requestTimeoutMs: 0 } });

  const report = await manager.discoverToolsBestEffort();
  assert.deepEqual(report.tools.map((t) => t.qualifiedName), ["mcp__good__echo"]);
  assert.equal(report.failedServers.length, 1);
  assert.equal(report.failedServers[0].serverName, "bad");
  assert.match(report.failedServers[0].error, /boom/);
});

test("manager shutdown closes every session transport", async () => {
  const alpha = mockTransport({ initialize: INIT_OK, "tools/list": echoToolsList() });
  const beta = mockTransport({ initialize: INIT_OK, "tools/list": echoToolsList() });
  const manager = new McpServerManager();
  manager.registerServer({ serverName: "alpha", transport: alpha.transport });
  manager.registerServer({ serverName: "beta", transport: beta.transport });
  await manager.discoverTools();

  manager.shutdown();
  assert.ok(alpha.isClosed());
  assert.ok(beta.isClosed());
  assert.deepEqual(manager.serverNames(), []);
});

test("manager qualify mirrors the naming scheme", () => {
  const manager = new McpServerManager();
  assert.equal(manager.qualify("github.com", "search"), "mcp__github_com__search");
});
