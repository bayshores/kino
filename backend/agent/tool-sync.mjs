// Keeps a long-running MCP server's tools in step with the kino it talks to.
//
// Claude Code or Codex starts `kino mcp` when its session starts, and that process builds its
// tool schemas once, from its own copy of the code. When kino is updated and the app restarts,
// the old process would keep refusing new values (a new look mode, a new notes action) that
// the running kino accepts. So:
// - kino sends a hash of its tool list on every agent answer (the x-kino-tools header) and the
//   whole list at GET /api/agent/tools (backend/index.mjs);
// - after each call, this MCP server compares that hash with its own. On a mismatch it loads
//   kino's list, serves it from then on (calls go straight to kino, which checks every value
//   itself, as for the kino command line) and sends notifications/tools/list_changed so the
//   agent's client fetches the new tools;
// - a call its old schema refuses asks kino for the list first, so the first call with a new
//   value already works;
// - when the list cannot be loaded, every answer says to reconnect the MCP server.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { compactToolList, registerAgentTools, runAgentTool, schemaRefusal } from "./tools.mjs";

export const RELOADED_LINE = "kino was updated: its tools were reloaded, so new modes and actions work now.";
export const RECONNECT_LINE = "kino was updated; reconnect the kino MCP server (/mcp in Claude Code) to get the new tools. Until then the kino command takes the same call (kino look mode=critique).";

export const toolsHash = (tools) => createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);

let ownList = null;
/**
 * This code's tools/list answer and its hash: { hash, tools }. Built once per process by
 * listing the tools of an in-memory MCP server, so it is exactly what an agent's client sees.
 */
export function agentToolList() {
  ownList ??= (async () => {
    const server = new McpServer({ name: "kino", version: "0.2.0" });
    compactToolList(server);
    registerAgentTools(server, {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "kino-tool-list", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const { tools } = await client.listTools();
      return { hash: toolsHash(tools), tools };
    } finally {
      await client.close();
      await server.close();
    }
  })();
  return ownList;
}

const withLine = (result, line) => ({ ...result, content: [...(result.content ?? []), { type: "text", text: line }] });
const refusedBySchema = (result) => result?.isError === true && /Input validation error/.test(result.content?.[0]?.text ?? "");

/**
 * Makes `server` follow kino's tool list (see the top of this file). Call it before the first
 * registerTool, as compactToolList: it wraps the tools/list and tools/call handlers the SDK
 * installs then. `client` needs toolsHash (the last x-kino-tools header) and tools().
 */
export function followServerTools(server, client) {
  const lowLevel = server.server;
  // kino's newer list once loaded ({ hash, tools }), and whether loading it failed.
  let live = null;
  let outdated = false;
  const ownHash = () => agentToolList().then((list) => list.hash, () => null);
  const differs = async (hash) => Boolean(hash) && hash !== (live?.hash ?? await ownHash());

  // Loads kino's list and tells the agent's client; true when it worked.
  async function reload() {
    try {
      const list = await client.tools();
      if (!list?.hash || !Array.isArray(list.tools)) throw new Error("no tool list");
      live = list;
      outdated = false;
    } catch {
      outdated = true;
      return false;
    }
    // The new list is served even if this notice cannot be sent (a client that has gone away).
    // McpServer.sendToolListChanged drops the promise, so a failed send would be an unhandled
    // rejection; the low-level one returns it.
    if (server.isConnected()) await lowLevel.sendToolListChanged().catch(() => {});
    return true;
  }

  async function callLive(request, extra) {
    const { name, arguments: input } = request.params;
    if (!live.tools.some((tool) => tool.name === name)) return { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true };
    return runAgentTool(server, client, name, input ?? {}, extra);
  }

  const setRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);
  lowLevel.setRequestHandler = (schema, handler) => {
    if (schema === ListToolsRequestSchema)
      return setRequestHandler(schema, async (request, extra) => (live ? { tools: live.tools } : handler(request, extra)));
    if (schema !== CallToolRequestSchema) return setRequestHandler(schema, handler);
    const answer = async (request, extra) => {
      const result = live ? await callLive(request, extra) : await handler(request, extra);
      // A value this process's old schema refused: ask kino whether its tools changed.
      let hash = client.toolsHash;
      if (!live && refusedBySchema(result) && typeof client.tools === "function")
        hash = await client.tools().then((list) => list?.hash, () => null);
      if (!(await differs(hash))) return outdated ? withLine(result, RECONNECT_LINE) : result;
      if (!(await reload())) return withLine(result, RECONNECT_LINE);
      // The refused call goes to kino now, which checks the value itself.
      return refusedBySchema(result) ? callLive(request, extra) : withLine(result, RELOADED_LINE);
    };
    // A value the schema refused reads as kino's own refusals do (schemaRefusal).
    return setRequestHandler(schema, async (request, extra) => {
      const result = await answer(request, extra);
      return refusedBySchema(result) ? schemaRefusal(result, request.params) : result;
    });
  };
}
