// Tests what an agent sees of the kino MCP server before its first call: the server
// instructions, and a tools/list answer that is compact, valid JSON Schema 2020-12, and the
// same byte for byte in every server process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKinoMcpServer, forwardNotesToChannel } from "./mcp.mjs";
import { AGENT_INSTRUCTIONS, compactSchema, compactTool } from "./agent/tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_CODE_INSTRUCTIONS_LIMIT = 4_096;
const fakeClient = { async call() { return { text: "ok" }; }, async importFile() { return {}; } };

// Starts backend/mcp.mjs as Claude Code does (stdio) and returns the raw JSON-RPC lines it sends
// back for initialize and tools/list, exactly as written. A closed port and a missing runtime
// file keep it away from any running kino app.
async function rawSession(env = {}) {
  const child = spawn(process.execPath, [path.join(root, "backend/mcp.mjs")], {
    env: { ...process.env, MOTION_API_URL: "http://127.0.0.1:9", KINO_RUNTIME_FILE: path.join(root, ".local/no-runtime.json"), KINO_METER_FILE: "", ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const lines = [];
    let buffer = "";
    const answered = new Promise((resolve, reject) => {
      child.on("exit", (code) => reject(new Error(`server exited (${code}) before answering`)));
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          lines.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (lines.length === 2) resolve();
        }
      });
    });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "surface-test", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    await answered;
    return { initialize: lines[0], toolsList: lines[1] };
  } finally {
    child.kill();
  }
}

async function inMemory(options) {
  const server = createKinoMcpServer({ client: fakeClient, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "surface-test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() };
  } finally {
    await client.close();
    await server.close();
  }
}

test("tools/list is byte-identical across server restarts, and KINO_MCP_LEGACY no longer changes it", async () => {
  const first = await rawSession();
  const second = await rawSession();
  assert.equal(second.toolsList, first.toolsList);
  const tools = JSON.parse(first.toolsList).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["status", "edit", "check", "look", "inspect", "render", "library", "history", "notes", "project"]);
  // One fixed key order in every entry.
  for (const tool of tools) assert.deepEqual(Object.keys(tool).filter((key) => key !== "_meta"), ["name", "title", "description", "inputSchema", "annotations"]);

  // The older tool set was removed (plan D4): its switch is ignored.
  assert.equal((await rawSession({ KINO_MCP_LEGACY: "1" })).toolsList, first.toolsList);
});

test("two servers in one process list the same tools, whatever their agent client", async () => {
  const one = await inMemory({});
  const two = await inMemory({ client: { async call() { return { text: "other" }; }, async importFile() { return {}; } } });
  assert.equal(JSON.stringify(two.tools), JSON.stringify(one.tools));
});

test("tool schemas keep their real limits and lose the words that change nothing", async () => {
  const { tools } = await inMemory({});
  const text = JSON.stringify(tools);
  assert.doesNotMatch(text, /"\$schema"/, "no $schema in any tool");
  assert.doesNotMatch(text, /9007199254740991/, "no whole-number bounds from zod");
  assert.doesNotMatch(text, /"taskSupport":"forbidden"/, "no default execution field");
  assert.doesNotMatch(text, /"propertyNames":\{"type":"string"\}/);
  assert.doesNotMatch(text, /"additionalProperties":\{\}/);
  // Claude Code checks schemas without $schema against JSON Schema 2020-12 and leaves out
  // any tool that fails; every kino tool passes.
  const ajv = new Ajv2020({ strict: false });
  for (const tool of tools) assert.ok(ajv.validateSchema(tool.inputSchema), `${tool.name}: ${ajv.errorsText(ajv.errors)}`);
  const tool = (name) => tools.find((entry) => entry.name === name).inputSchema;
  assert.deepEqual(tool("edit").required, undefined);
  assert.deepEqual(tool("project").required, ["action"]);
  assert.deepEqual([tool("edit").properties.ops.minItems, tool("edit").properties.ops.maxItems], [1, 200]);
  assert.deepEqual(tool("check").properties.fps, { type: "number", description: "Frame rate to judge judder at (default 30)", minimum: 1, maximum: 120 });
  assert.deepEqual(tool("status").properties.page, { type: "integer", minimum: 1 });
  assert.deepEqual(tool("look").properties.mode.enum, ["sheet", "review", "frame", "frames", "motion", "zoom", "strip", "compare", "changed", "variants", "source", "board", "reference", "versus", "viewer", "critique"]);
  // project is described in full once (status); the server's instructions say once for the
  // other tools that it defaults to the open one (room in the budget for why and next).
  assert.equal(tool("status").properties.project.description, "Id or name; default: the open one");
  for (const name of ["edit", "check", "look", "inspect", "render", "history", "notes"])
    assert.equal(tool(name).properties.project.description, undefined, name);
  const { AGENT_INSTRUCTIONS } = await import("./agent/tools.mjs");
  assert.match(AGENT_INSTRUCTIONS, /project defaults to the open one/);
  // Every tool takes why and next, plain strings the person watching sees.
  for (const entry of tools) assert.deepEqual([entry.inputSchema.properties.why, entry.inputSchema.properties.next], [{ type: "string" }, { type: "string" }], entry.name);
});

test("schema clean-up keeps data values and property order, and drops only the default task field", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    properties: {
      maximum: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
      options: { type: "object", propertyNames: { type: "string" }, additionalProperties: {}, default: { $schema: "kept", maximum: 9007199254740991 } },
      strict: { type: "object", additionalProperties: false },
    },
    type: "object",
  };
  assert.deepEqual(compactSchema(schema), {
    type: "object",
    properties: {
      maximum: { type: "integer" },
      options: { type: "object", default: { $schema: "kept", maximum: 9007199254740991 } },
      strict: { type: "object", additionalProperties: false },
    },
  });
  assert.deepEqual(Object.keys(compactSchema(schema).properties), ["maximum", "options", "strict"]);
  assert.deepEqual(compactTool({ _meta: { a: 1 }, execution: { taskSupport: "forbidden" }, name: "x", inputSchema: { type: "object" } }), { name: "x", inputSchema: { type: "object" }, _meta: { a: 1 } });
  assert.deepEqual(compactTool({ name: "x", execution: { taskSupport: "optional" } }).execution, { taskSupport: "optional" });
});

test("instructions are always sent, fit Claude Code's limit, and open with what kino is and the loop", async () => {
  const plain = await inMemory({ channels: false });
  const channels = await inMemory({ channels: true });
  assert.equal(plain.instructions, AGENT_INSTRUCTIONS);
  assert.ok(channels.instructions.startsWith(`${AGENT_INSTRUCTIONS}\n\n`));
  assert.match(channels.instructions, /<channel source="kino"/);
  for (const { instructions } of [plain, channels]) {
    assert.ok(instructions.length < CLAUDE_CODE_INSTRUCTIONS_LIMIT, `instructions are ${instructions.length} characters`);
    // The first 512 characters stand on their own: what kino is, when to use it, the loop.
    const opening = instructions.slice(0, 512);
    assert.match(opening, /motion video/i);
    for (const name of ["status", "edit", "check", "look", "render"]) assert.match(opening, new RegExp(`mcp__kino__${name}\\b`));
    assert.ok(opening.includes("→"), "the loop is spelled out");
    // Nothing that goes stale: dates, versions, tool counts.
    assert.doesNotMatch(instructions, /\b20\d\d\b|\bv?\d+\.\d+\.\d+\b|\bten tools\b/i);
  }
  // Over stdio, as Claude Code starts it (channels off when no kino app answers).
  const { initialize } = await rawSession();
  assert.equal(JSON.parse(initialize).result.instructions, AGENT_INSTRUCTIONS);
});

test("a channel note the session cannot take (transport closed) is not an unhandled rejection, and is tried again later", async (t) => {
  const unhandled = [];
  const note = (error) => unhandled.push(error);
  process.on("unhandledRejection", note);
  t.after(() => process.off("unhandledRejection", note));
  const controller = new AbortController();
  const tries = [];
  const server = { server: { notification: async (message) => { tries.push(message.params.meta.note_id); throw new Error("Not connected"); } } };
  const event = { type: "note", projectId: "p1", note: { id: "N1", status: "new", text: "Bigger title" } };
  // Like the real client, stream calls onEvent for each event without waiting for it.
  const client = { post: async () => true, async stream(onEvent) {
    onEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    onEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    throw new Error("stream closed");
  } };
  await forwardNotesToChannel(server, client, { signal: controller.signal });
  assert.deepEqual(unhandled, []);
  assert.deepEqual(tries, ["N1", "N1"], "a failed send is forgotten, so the next event with the note sends it again");
});

test("a share-link comment reaches the channel once, as its inbox line", async () => {
  const controller = new AbortController();
  const sent = [];
  const server = { server: { notification: async (message) => { sent.push(message.params); } } };
  const event = { type: "comment", projectId: "p1", comment: { id: "c1", text: 'comment from Ann on Intro Logo @1 "Bigger"' } };
  const client = { post: async () => true, async stream(onEvent) {
    await onEvent(event);
    await onEvent(event);
    controller.abort();
    throw new Error("stream closed");
  } };
  await forwardNotesToChannel(server, client, { signal: controller.signal });
  assert.deepEqual(sent, [{ content: event.comment.text, meta: { project: "p1", comment_id: "c1" } }]);
});
