import assert from "node:assert/strict";
import test from "node:test";
import { cursorInstallLink, vscodeInstallLink } from "./agentLinks.js";

// What GET /api/mcp-config returns in the Mac app (a path with a space and a non-ASCII name).
const config = { mcpServers: { kino: {
  command: "/Applications/kino.app/Contents/MacOS/kino",
  args: ["/Applications/kino.app/Contents/Resources/app.asar/desktop/mcp.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1", KINO_RUNTIME_FILE: "/Users/Zoë/Library/Application Support/kino/runtime.json" },
} } };

test("the Cursor link carries the server's command, args and env as base64 JSON", () => {
  const link = cursorInstallLink(config);
  const url = new URL(link);
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, "cursor://anysphere.cursor-deeplink/mcp/install");
  assert.equal(url.searchParams.get("name"), "kino");
  assert.deepEqual(JSON.parse(Buffer.from(url.searchParams.get("config"), "base64").toString("utf8")), config.mcpServers.kino);
});

test("the VS Code link is vscode:mcp/install with the URL-encoded JSON of a stdio server", () => {
  const link = vscodeInstallLink(config);
  assert.ok(link.startsWith("vscode:mcp/install?"));
  assert.deepEqual(JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length))), { name: "kino", type: "stdio", ...config.mcpServers.kino });
});

test("a config without a server makes no link, and a server with a different name is still linked", () => {
  assert.equal(cursorInstallLink({}), "");
  assert.equal(vscodeInstallLink({ mcpServers: {} }), "");
  assert.equal(cursorInstallLink(null), "");
  assert.notEqual(vscodeInstallLink({ mcpServers: { other: { command: "node" } } }), "");
});
