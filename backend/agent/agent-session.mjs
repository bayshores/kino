// The agent a kino client works for, as its x-kino-session (live.mjs gives each session one
// name, color and crew place, and crew-locks.mjs holds parts per session). The `kino` command and
// the kino MCP server both name the program above them that is not a shell, npm, a sandbox or a
// per-call launcher: an agent such as Claude Code or Codex starts its MCP server itself and runs
// each command in a new shell, so one agent's CLI and MCP calls are one session, one crew member,
// and never wait for each other's holds. Two agents are two programs, so two sessions.
//
// A per-call launcher (`/usr/bin/time -p env ... kino edit`, `caffeinate`, a `perl -e` one-liner)
// lives only for one command, so naming the session after it gave each call a new name and the
// next call waited 2 minutes for the hold the last one took (stems study, 2026-11-12). Those are
// walked past like shells; the session is the program that outlives the command.
import { execFileSync } from "node:child_process";
import path from "node:path";

// Programs that only pass a command along (shells, npm, sandboxes, per-call launchers): the agent is above them.
const PASSERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "pwsh", "nu", "env", "sandbox-exec", "timeout", "nohup", "nice", "xargs", "npm", "npx", "pnpm", "yarn",
  "time", "gtime", "caffeinate", "stdbuf", "unbuffer", "script", "arch", "sudo", "doas", "flock", "ionice", "taskset", "chrt", "gtimeout", "setsid"]);
const VALID = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * The process table as `ps -A -o pid=,ppid=,args=` prints it: Map(pid → {parent, words}).
 */
export function parseProcessTable(table) {
  const processes = new Map();
  for (const line of String(table ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), words: match[3].trim().split(/\s+/) });
  }
  return processes;
}

const name = (word = "") => path.basename(word).replace(/^-/, "");
// A program that passes the command on: a shell or launcher, node running npm, or a perl/python/ruby one-liner (-e, -c).
const passes = ({ words }) => PASSERS.has(name(words[0]))
  || (name(words[0]) === "node" && /^(npm|npx|npm-cli\.js|npx-cli\.js)$/.test(name(words[1])))
  || (/^(perl|python3?|ruby)$/.test(name(words[0])) && /^-[ec]$/.test(words[1] ?? ""));

/**
 * The chain of programs above `ppid` in `processes` (parseProcessTable), nearest first:
 * [{pid, program, passes}] up to 16 deep. What the session is named after is the first that does not pass.
 */
export function processChain(processes, ppid) {
  const chain = [];
  let pid = ppid;
  for (let depth = 0; depth < 16 && processes.has(pid) && pid > 1; depth += 1) {
    const entry = processes.get(pid);
    chain.push({ pid, program: name(entry.words[0]), passes: passes(entry) });
    pid = entry.parent;
  }
  return chain;
}

/**
 * This process's agent session: KINO_AGENT_SESSION when set and valid (an agent kino started,
 * or one that names itself), else "agent-<pid>" of the nearest program above this one that is
 * not a shell, npm, a sandbox or a per-call launcher (found with `ps`), else `fallback` (Windows,
 * or no `ps`). `table` and `ppid` are for tests (a stubbed `ps` answer).
 */
export function agentSession({ fallback, env = process.env, table = null, ppid = process.ppid, platform = process.platform } = {}) {
  if (VALID.test(env.KINO_AGENT_SESSION ?? "")) return env.KINO_AGENT_SESSION;
  if (platform === "win32" && table == null) return fallback;
  if (table == null) {
    try { table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return fallback; }
  }
  const agent = processChain(parseProcessTable(table), ppid).find((entry) => !entry.passes);
  return agent ? `agent-${agent.pid}` : fallback;
}
