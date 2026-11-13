// How an agent starts kino's MCP server through the Mac app: the app's own Electron run as Node,
// on desktop/mcp.mjs. main.mjs puts the result in KINO_MCP_COMMAND, KINO_MCP_ARGS and KINO_MCP_ENV
// (GET /api/mcp-config returns it), and the Claude Desktop bundle (mcpb.mjs) is checked against it.
import path from "node:path";

/** `execPath` is the app's executable, `root` the app's code folder, `runtimeFile` the connection file. */
export function mcpLaunch({ execPath, root, runtimeFile }) {
  return {
    command: execPath,
    args: [path.join(root, "desktop/mcp.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1", KINO_RUNTIME_FILE: runtimeFile },
  };
}
