// Tests the ten MCP agent tools: their size budget, flags, and how they pass work to the agent client.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKinoMcpServer } from "./mcp.mjs";
import { measureToolDefinitions } from "./meter.mjs";
import { TOOL_LIST_TOKEN_BUDGET } from "./agent/tools.mjs";
import { NOTES_ACTIONS } from "./agent/actions.mjs";
import { agentToolList, RECONNECT_LINE, RELOADED_LINE, toolsHash } from "./agent/tool-sync.mjs";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const AGENT_TOOL_NAMES = ["status", "edit", "check", "look", "inspect", "render", "library", "history", "notes", "project"];
// A real 1×1 PNG, so the image content is valid base64.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Stands in for createAgentClient: records every call and answers with a canned reply per verb.
function fakeClient(replies = {}) {
  const calls = [];
  const imports = [];
  return {
    calls,
    imports,
    async call(verb, input, options) {
      calls.push({ verb, input, options });
      const reply = replies[verb] ?? { text: `${verb} ok` };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async importFile(file, options) {
      imports.push({ file, options });
      return { media: { name: "logo.png", mime: "image/png", src: "/media/logo-1.png", width: 64, height: 32 } };
    },
  };
}

// Connects an MCP client to a fresh kino MCP server in memory (no network, no child process).
async function connect(options) {
  const server = createKinoMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-mcp-test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

test("the default server lists exactly the ten agent tools within the size budget", async () => {
  const { client, close } = await connect({ client: fakeClient() });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), AGENT_TOOL_NAMES);

    // The same measure as scripts/mcp-budget.mjs: every definition as JSON, summed, in
    // estimated Claude tokens.
    const report = measureToolDefinitions(tools);
    assert.ok(report.definitionTokens <= TOOL_LIST_TOKEN_BUDGET,
      `tool list is about ${report.definitionTokens} tokens, ${report.definitionChars} characters (budget ${TOOL_LIST_TOKEN_BUDGET} tokens)`);
    for (const tool of tools)
      assert.ok(tool.description.length <= 1_000, `${tool.name} description is ${tool.description.length} characters (limit 1,000)`);
  } finally {
    await close();
  }
});

test("every tool has a title and all four behaviour hints; only status, edit, check and look load up front", async () => {
  const { client, close } = await connect({ client: fakeClient() });
  try {
    const { tools } = await client.listTools();
    const alwaysLoad = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true).map((tool) => tool.name);
    assert.deepEqual(alwaysLoad, ["status", "edit", "check", "look"]);
    for (const tool of tools) {
      assert.ok(tool.title && !new RegExp(`^(kino )?${tool.name}$`, "i").test(tool.title), `${tool.name} has a title that says more than its name: ${tool.title}`);
      // Set explicitly: a hint left out means the cautious default (destructive, open world).
      assert.deepEqual(Object.keys(tool.annotations), ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"], tool.name);
      for (const hint of Object.values(tool.annotations)) assert.equal(typeof hint, "boolean", tool.name);
      assert.equal(tool.annotations.openWorldHint, false, `${tool.name}: kino works on this computer only`);
    }
    const hinted = (hint) => tools.filter((tool) => tool.annotations[hint]).map((tool) => tool.name);
    // check is not read-only: check {fix:"auto"} saves its fixes.
    assert.deepEqual(hinted("readOnlyHint"), ["status", "look", "inspect", "library"]);
    // render can overwrite an export file; project manage can delete a trashed project forever.
    assert.deepEqual(hinted("destructiveHint"), ["render", "project"]);
    assert.deepEqual(hinted("idempotentHint"), ["status", "look", "inspect", "library"]);
  } finally {
    await close();
  }
});

test("a tool call sends its input unchanged to client.call(verb, input) and returns the reply text", async () => {
  const agent = fakeClient({ edit: { text: '{"rev":4,"created":{"title":"L1"}}' } });
  const { client, close } = await connect({ client: agent });
  try {
    const input = {
      ops: [{ op: "add_layer", layerType: "text", name: "Title", properties: { text: "Hi", x: 10 } }],
      rev: 3,
      project: "demo",
      request_id: "step-1",
    };
    const result = await client.callTool({ name: "edit", arguments: input });
    assert.deepEqual(result.content, [{ type: "text", text: '{"rev":4,"created":{"title":"L1"}}' }]);
    assert.equal(result.isError, undefined);

    await client.callTool({ name: "status", arguments: {} });
    await client.callTool({ name: "inspect", arguments: { targets: ["text[fontSize>40]"], fields: ["x"] } });
    // Fields the CLI takes reach the service from MCP too: media pages, inspire kind and count, deck swap.
    const search = { topic: "inspire", search: "app launch", kind: "shorts", count: 6, page: 2 };
    const swap = { action: "deck", swap: { out: "particles", in: "light-sweep", why: "no room" } };
    await client.callTool({ name: "library", arguments: search });
    await client.callTool({ name: "notes", arguments: swap });
    assert.deepEqual(agent.calls.map(({ verb, input }) => [verb, input]), [
      ["edit", input],
      ["status", {}],
      ["inspect", { targets: ["text[fontSize>40]"], fields: ["x"] }],
      ["library", search],
      ["notes", swap],
    ]);
    // The request's cancel signal is passed along so a long render can stop.
    assert.ok(agent.calls[0].options.signal instanceof AbortSignal);
  } finally {
    await close();
  }
});

test("input that breaks a tool's schema never reaches the client", async () => {
  const agent = fakeClient();
  const { client, close } = await connect({ client: agent });
  try {
    let refused;
    try {
      const result = await client.callTool({ name: "look", arguments: { mode: "shet", t: 2 } });
      refused = result.isError === true && /mode/.test(result.content[0].text);
      // Read as kino's own refusals: the field, the closest choice and the call with it.
      assert.deepEqual(JSON.parse(result.content[0].text).next, 'look {"mode":"sheet","t":2}');
    } catch (error) {
      refused = /mode/.test(error.message);
    }
    assert.ok(refused, "a bad look mode is refused with a message naming mode");
    assert.deepEqual(agent.calls, []);
    // Every notes action the service takes passes the schema (one list: actions.mjs).
    for (const action of NOTES_ACTIONS) assert.equal((await client.callTool({ name: "notes", arguments: { action } })).isError, undefined, action);
    assert.equal(agent.calls.length, NOTES_ACTIONS.length);
  } finally {
    await close();
  }
});

test("images in a reply become MCP image content; images without data are left out", async () => {
  const agent = fakeClient({
    look: {
      text: "sheet s1 · 12 frames",
      images: [
        { path: "/tmp/sheet.png", mime: "image/png", data: TINY_PNG },
        { path: "/tmp/saved-only.png", mime: "image/png" },
      ],
    },
  });
  const { client, close } = await connect({ client: agent });
  try {
    const result = await client.callTool({ name: "look", arguments: { mode: "sheet" } });
    assert.deepEqual(result.content, [
      { type: "text", text: "sheet s1 · 12 frames" },
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
    ]);
    assert.deepEqual(agent.calls[0].input, { mode: "sheet" });
  } finally {
    await close();
  }
});

test("after kino is updated, an old MCP server reloads its tools, says list_changed and passes new values", async () => {
  // kino's newer list: look has one more mode. Until reloaded, this process's schema refuses it.
  const { tools: own, hash } = await agentToolList();
  const newer = own.map((tool) => tool.name !== "look" ? tool : structuredClone(tool));
  newer.find((tool) => tool.name === "look").inputSchema.properties.mode.enum.push("newmode");
  const newerList = { hash: toolsHash(newer), tools: newer };
  for (const firstCall of ["status", "look"]) {
    const agent = fakeClient();
    let serverHash = hash;
    agent.tools = async () => newerList;
    Object.defineProperty(agent, "toolsHash", { get: () => serverHash });
    const { client, close } = await connect({ client: agent });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed += 1; });
    try {
      assert.equal((await client.callTool({ name: "status", arguments: {} })).content.length, 1, "same hash: no extra line");
      serverHash = newerList.hash; // the app restarted on newer code
      const first = firstCall === "status"
        ? await client.callTool({ name: "status", arguments: {} })
        // A value the old schema refuses: kino is asked, and the call goes through.
        : await client.callTool({ name: "look", arguments: { mode: "newmode" } });
      assert.equal(first.isError, undefined, JSON.stringify(first));
      if (firstCall === "status") assert.equal(first.content.at(-1).text, RELOADED_LINE);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(changed, 1);
      assert.ok((await client.listTools()).tools.find((tool) => tool.name === "look").inputSchema.properties.mode.enum.includes("newmode"));
      await client.callTool({ name: "look", arguments: { mode: "newmode", project: "p" } });
      assert.deepEqual(agent.calls.at(-1).input, { mode: "newmode", project: "p" });
    } finally {
      await close();
    }
  }
  // kino's list cannot be loaded: every answer says to reconnect.
  const agent = fakeClient();
  agent.tools = async () => { throw new Error("offline"); };
  Object.defineProperty(agent, "toolsHash", { get: () => "0000000000000000" });
  const { client, close } = await connect({ client: agent });
  try {
    for (let call = 0; call < 2; call += 1)
      assert.equal((await client.callTool({ name: "status", arguments: {} })).content.at(-1).text, RECONNECT_LINE);
  } finally {
    await close();
  }
});

test("an error reply stays an error, and a client that throws becomes an error reply", async () => {
  const agent = fakeClient({
    check: { text: 'unknown project "dmo". Did you mean: demo?', isError: true },
    render: new Error("could not reach kino at http://127.0.0.1:4781"),
  });
  const { client, close } = await connect({ client: agent });
  try {
    const refused = await client.callTool({ name: "check", arguments: { project: "dmo" } });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.content, [{ type: "text", text: 'unknown project "dmo". Did you mean: demo?' }]);

    const thrown = await client.callTool({ name: "render", arguments: { action: "start" } });
    assert.equal(thrown.isError, true);
    assert.deepEqual(thrown.content, [{ type: "text", text: "could not reach kino at http://127.0.0.1:4781" }]);
  } finally {
    await close();
  }
});

test("project import uploads the file through importFile; other project actions go to the service", async () => {
  const agent = fakeClient();
  const { client, close } = await connect({ client: agent });
  try {
    const imported = await client.callTool({ name: "project", arguments: { action: "import", file: "/Users/someone/logo.png" } });
    assert.equal(imported.isError, undefined);
    assert.deepEqual(imported.content, [{
      type: "text",
      text: 'imported logo.png (64×32) as /media/logo-1.png. Add it: edit {ops:[{op:"add_layer", layerType:"image", name, properties:{src:"/media/logo-1.png", x:0, y:0, width:64, height:32}}]}',
    }]);
    assert.deepEqual(agent.imports.map(({ file }) => file), ["/Users/someone/logo.png"]);
    assert.ok(agent.imports[0].options.signal instanceof AbortSignal);

    const missing = await client.callTool({ name: "project", arguments: { action: "import" } });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.content, [{ type: "text", text: "import needs file: an absolute path." }]);
    assert.equal(agent.imports.length, 1);

    // Importing never goes through client.call; listing does.
    assert.deepEqual(agent.calls, []);
    await client.callTool({ name: "project", arguments: { action: "list" } });
    assert.deepEqual(agent.calls.map(({ verb, input }) => [verb, input]), [["project", { action: "list" }]]);
  } finally {
    await close();
  }
});

test("an output folder starting with ~ is sent as an absolute folder in the home folder; others are sent as typed", async () => {
  // A made-up home folder, so the test never uses the real one.
  const homeBefore = process.env.HOME;
  process.env.HOME = "/fake-home/someone";
  const agent = fakeClient();
  const { client, close } = await connect({ client: agent });
  try {
    const { tools } = await client.listTools();
    assert.match(tools.find((tool) => tool.name === "render").inputSchema.properties.out.description, /^Absolute folder/);
    await client.callTool({ name: "render", arguments: { action: "start", quality: "final", out: "~/Movies" } });
    await client.callTool({ name: "render", arguments: { action: "start", out: "~" } });
    await client.callTool({ name: "render", arguments: { action: "start", out: "/Volumes/Work/renders" } });
    await client.callTool({ name: "render", arguments: { action: "start", out: "~other/renders" } });
    await client.callTool({ name: "project", arguments: { action: "manage", options: { resource: "exports", action: "start", out: "~/Exports" } } });
    await client.callTool({ name: "project", arguments: { action: "manage", options: { resource: "folders", action: "create", name: "~/not a path" } } });
    assert.deepEqual(agent.calls.map(({ verb, input }) => [verb, input]), [
      ["render", { action: "start", quality: "final", out: "/fake-home/someone/Movies" }],
      ["render", { action: "start", out: "/fake-home/someone" }],
      ["render", { action: "start", out: "/Volumes/Work/renders" }],
      // Only ~ alone or ~/ is the home folder; the service refuses this one as not absolute.
      ["render", { action: "start", out: "~other/renders" }],
      ["project", { action: "manage", options: { resource: "exports", action: "start", out: "/fake-home/someone/Exports" } }],
      ["project", { action: "manage", options: { resource: "folders", action: "create", name: "~/not a path" } }],
    ]);
  } finally {
    await close();
    if (homeBefore === undefined) delete process.env.HOME;
    else process.env.HOME = homeBefore;
  }
});
