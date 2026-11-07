// kino's MCP server for an agent that kino started (backend/agent/launcher.mjs). Its one argument
// is the agent's private agent.json: where kino is, the owner token when kino has one, and the
// agent's session, which tells kino which crew member every call comes from. Reading them from a
// file keeps the token off command lines (other programs can read those).
import { lstat, readFile } from "node:fs/promises";

try {
  const file = process.argv[2];
  if (!file) throw new Error("kino crew MCP: the agent file is missing.");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error("kino crew MCP: the agent file must be a private file owned by your user.");
  const agent = JSON.parse(await readFile(file, "utf8"));
  const url = new URL(agent.url);
  if (agent.version !== 1 || !["http:", "https:"].includes(url.protocol) || url.username || url.password || typeof agent.session !== "string")
    throw new Error("kino crew MCP: the agent file is not valid.");
  process.env.MOTION_API_URL = url.origin;
  if (agent.ownerToken) process.env.KINO_OWNER_TOKEN = agent.ownerToken;
  else delete process.env.KINO_OWNER_TOKEN;
  delete process.env.KINO_SHARE_TOKEN;
  process.env.KINO_AGENT_SESSION = agent.session;
  const { startKinoMcp } = await import("./mcp.mjs");
  await startKinoMcp();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
