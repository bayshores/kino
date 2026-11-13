// One-click links that add kino's MCP server to Cursor and VS Code without anyone editing a settings
// file. They are built from the block GET /api/mcp-config returns ({ mcpServers: { kino: { command,
// args, env } } }), so they start the server the same way every other agent does.
//
// Cursor (docs: cursor.com/docs/context/mcp/install-links):
//   cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the server's JSON>
// VS Code (docs: code.visualstudio.com/api/extension-guides/ai/mcp, "Install an MCP server from
// configuration"): vscode:mcp/install?<URL-encoded JSON with name, type, command, args, env>

/** The `[name, server]` to link: the one named `name`, else the first. Null when there is none. */
export function mcpServerOf(config, name = "kino") {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const key = servers[name] ? name : Object.keys(servers)[0];
  const server = key ? servers[key] : null;
  return server && typeof server.command === "string" && server.command ? [key, server] : null;
}

// The server's fields as the install links carry them.
const serverFields = (server) => ({
  command: server.command,
  ...(Array.isArray(server.args) && server.args.length ? { args: server.args.map(String) } : {}),
  ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
});

// Standard base64 of the text's UTF-8 bytes (btoa alone refuses non-Latin-1 characters).
const base64 = (text) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));

/** The Cursor install link for an MCP config block, or "" when it has no server. */
export function cursorInstallLink(config, name = "kino") {
  const found = mcpServerOf(config, name);
  if (!found) return "";
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64(JSON.stringify(serverFields(found[1]))))}`;
}

/** The VS Code install link for an MCP config block, or "" when it has no server. */
export function vscodeInstallLink(config, name = "kino") {
  const found = mcpServerOf(config, name);
  if (!found) return "";
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "stdio", ...serverFields(found[1]) }))}`;
}
