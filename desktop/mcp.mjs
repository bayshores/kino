// Run with Electron's supported Node mode. This process never opens a window
// or competes with the desktop app's Chromium profile.
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const runtimeFile = process.env.KINO_RUNTIME_FILE || path.join(homedir(), "Library/Application Support/kino/runtime.json");
try {
  const info = await lstat(runtimeFile);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error("The kino connection file must be a private file owned by your user.");
  let runtime;
  try { runtime = JSON.parse(await readFile(runtimeFile, "utf8")); }
  catch { throw new Error("The kino connection file could not be read."); }
  const url = new URL(runtime.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !url.port || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Invalid local kino connection.");
  if (runtime.version !== 1 || typeof runtime.ownerToken !== "string" || !/^[a-f0-9]{64}$/.test(runtime.ownerToken))
    throw new Error("Invalid local kino connection.");
  const response = await fetch(`${url.origin}/api/projects`, { headers: { "X-Kino-Owner": runtime.ownerToken }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Open kino before connecting an agent.");
  // The tools' client reads the connection file again after the app restarts (new port and
  // token), so it never goes stale.
  process.env.KINO_RUNTIME_FILE = runtimeFile;
  const { createKinoMcpServer } = await import("../backend/mcp.mjs");
  const { connectAgentClient } = await import("../backend/agent/client.mjs");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const client = await connectAgentClient(process.env, { name: "mcp" });
  await createKinoMcpServer({ client }).connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`kino MCP: ${error.code === "ENOENT" ? "Open kino before connecting an agent." : error.message}\n`);
  process.exitCode = 1;
}
