// The agent a kino client works for, as its x-kino-session (live.mjs gives each session one
// name, color and crew place, and crew-locks.mjs holds parts per session). The `kino` command and
// the kino MCP server both name the program above them that is not a shell, npm or a sandbox:
// an agent such as Claude Code or Codex starts its MCP server itself and runs each command in a
// new shell, so one agent's CLI and MCP calls are one session, one crew member, and never wait
// for each other's holds. Two agents are two programs, so two sessions.
import { execFileSync } from "node:child_process";
import path from "node:path";

// Programs that only pass a command along (shells, npm, sandboxes): the agent is above them.
const PASSERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "pwsh", "nu", "env", "sandbox-exec", "timeout", "nohup", "nice", "xargs", "npm", "npx", "pnpm", "yarn"]);
const VALID = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * This process's agent session: KINO_AGENT_SESSION when set and valid (an agent kino started,
 * or one that names itself), else "agent-<pid>" of the nearest program above this one that is
 * not a shell, npm or a sandbox (found with `ps`), else `fallback` (Windows, or no `ps`).
 */
export function agentSession({ fallback, env = process.env } = {}) {
  if (VALID.test(env.KINO_AGENT_SESSION ?? "")) return env.KINO_AGENT_SESSION;
  if (process.platform === "win32") return fallback;
  let table;
  try { table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return fallback; }
  const processes = new Map();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), words: match[3].trim().split(/\s+/) });
  }
  const name = (word = "") => path.basename(word).replace(/^-/, "");
  const passes = ({ words }) => PASSERS.has(name(words[0])) || (name(words[0]) === "node" && /^(npm|npx|npm-cli\.js|npx-cli\.js)$/.test(name(words[1])));
  let pid = process.ppid;
  for (let depth = 0; depth < 16 && processes.has(pid) && pid > 1; depth += 1) {
    if (!passes(processes.get(pid))) return `agent-${pid}`;
    pid = processes.get(pid).parent;
  }
  return fallback;
}
