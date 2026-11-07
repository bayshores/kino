import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { meterTools } from "./meter.mjs";
import { agentSession } from "./agent/agent-session.mjs";
import { connectAgentClient, createAgentClient, DEFAULT_URL } from "./agent/client.mjs";
import { AGENT_INSTRUCTIONS, compactToolList, registerAgentTools } from "./agent/tools.mjs";
import { followServerTools } from "./agent/tool-sync.mjs";

// MOTION_API_URL points the tools at another kino server (tests, a second copy).
const apiUrl = new URL(process.env.MOTION_API_URL || "http://127.0.0.1:4781");
if (!/^https?:$/.test(apiUrl.protocol) || apiUrl.username || apiUrl.password)
  throw new Error("MOTION_API_URL must be an HTTP(S) URL without embedded credentials.");

/**
 * The kino MCP server, with the ten agent tools (status, edit, check, look, inspect, render,
 * library, history, notes, project). client is injectable for tests.
 */
export function createKinoMcpServer({ client, channels = false } = {}) {
  // The instructions go to the agent at the start of every session, before any tool is loaded.
  // D5: with the dashboard's channels switch on, Claude Code can receive notes as they arrive.
  const instructions = [AGENT_INSTRUCTIONS, channels ? CHANNEL_INSTRUCTIONS : ""].filter(Boolean).join("\n\n");
  const server = new McpServer({ name: "kino", version: "0.2.0" }, {
    ...(channels ? { capabilities: { experimental: { "claude/channel": {} } } } : {}),
    instructions,
  });
  compactToolList(server);
  meterTools(server);
  const agent = client ?? createAgentClient({
    url: process.env.MOTION_API_URL ? `${apiUrl.origin}${apiUrl.pathname.replace(/\/$/, "")}` : DEFAULT_URL,
    ownerToken: process.env.KINO_OWNER_TOKEN || null,
    shareToken: process.env.KINO_SHARE_TOKEN || null,
  });
  // After kino is updated, this process reloads the newer tools (agent/tool-sync.mjs).
  followServerTools(server, agent);
  registerAgentTools(server, agent);
  return server;
}

const CHANNEL_INSTRUCTIONS = "Notes from the person watching the kino dashboard arrive as <channel source=\"kino\" project=\"…\" note_id=\"N1\">. Read the note, act on it with the kino tools, then answer with notes {action:\"reply\" or \"resolve\", id, project}.";

/**
 * Pushes each new note from the person into the connected Claude Code session
 * (notifications/claude/channel), then tells kino it was sent. Runs until `signal` aborts;
 * reconnects after a dropped stream.
 */
export async function forwardNotesToChannel(server, client, { signal } = {}) {
  const sent = new Set();
  while (!signal?.aborted) {
    try {
      await client.stream(async (event) => {
        const note = event.note;
        if (event.type !== "note" || !note || note.status !== "new" || note.channelAt || sent.has(`${event.projectId}/${note.id}`)) return;
        const key = `${event.projectId}/${note.id}`;
        sent.add(key);
        const where = [note.urgent ? "urgent" : "", note.time != null ? `at ${note.time}s` : "", note.layerId ? `layer ${note.layerId}` : ""].filter(Boolean).join(", ");
        // The stream does not wait for this, so a send that fails (the session's transport closed)
        // is caught here: otherwise it would be an unhandled rejection that ends this process.
        // It is forgotten, so the note is sent again with its next event.
        try {
          await server.server.notification({
            method: "notifications/claude/channel",
            params: { content: `${note.text}${where ? ` (${where})` : ""}`, meta: { project: event.projectId, note_id: note.id } },
          });
        } catch {
          sent.delete(key);
          return;
        }
        await client.post("channel-sent", { project: event.projectId, note: note.id }).catch(() => {});
      }, { signal });
    } catch (error) {
      if (signal?.aborted) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000).unref?.());
  }
}

/** Starts the ten-tool MCP server on stdio; turns channels on when the dashboard setting says so. */
export async function startKinoMcp() {
  // An agent kino started (backend/crew-mcp.mjs) keeps the session kino gave it, so every call is
  // that crew member's; any other MCP server names the agent that started it, as the kino command
  // does, so one agent's MCP and CLI calls are one crew member (made up when `ps` cannot tell).
  const session = agentSession();
  // It follows the app: after the app restarts (new port and token) the next call reconnects.
  const client = await connectAgentClient(process.env, { name: "mcp", session });
  const channels = await client.read("settings").then((value) => value?.settings?.channels === true, () => false);
  const server = createKinoMcpServer({ client, channels });
  await server.connect(new StdioServerTransport());
  if (channels) forwardNotesToChannel(server, client);
}

async function main() {
  await startKinoMcp();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `[kino MCP] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
