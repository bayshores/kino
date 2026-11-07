// Starts Claude Code (`claude -p`) or Codex (`codex exec`) for the crew (crew.mjs), from the
// person's own installs, with kino's MCP server configured for that agent's identity.
//
// - Each agent gets a folder <data>/agent/crew/<id>/: `work/` is its working folder, `agent.json`
//   (private) tells its kino MCP server where kino is and which session it is (crew-mcp.mjs reads
//   it, so no secret goes on a command line), `out.log` and `err.log` hold what it printed, and
//   `last.txt` its final message (Codex writes it there).
// - Claude Code: `claude -p <prompt> --mcp-config <folder>/mcp.json --strict-mcp-config
//   --allowedTools mcp__kino --output-format json`: only kino's tools load and are allowed (it
//   cannot ask for permission in print mode); its final message is the JSON answer's `result`.
// - Codex: `codex exec --skip-git-repo-check -C <work> -o <folder>/last.txt -c mcp_servers.kino…
//   <prompt>`, with kino's tools approved (`codex exec` cannot ask either).
// - The agent runs with the person's environment and home (their own login), minus kino's own
//   variables (the owner token never reaches it), in its own process group, so stop ends it and
//   everything it started.
// - Where the programs are: KINO_CLAUDE / KINO_CODEX when set, else the PATH, then the usual
//   install folders (an app opened from the Finder has a short PATH).
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, closeSync, existsSync, openSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CREW_MCP = path.join(root, "backend", "crew-mcp.mjs");
const PROGRAMS = Object.freeze({ "claude-code": { name: "claude", variable: "KINO_CLAUDE" }, codex: { name: "codex", variable: "KINO_CODEX" } });
const FOUND_FOR_MS = 30_000;
const STOP_GRACE_MS = 3000;
const MESSAGE_LIMIT = 4000;

/** The usual folders an agent's program is installed in, after the PATH. */
export function searchFolders(env = process.env, home = env.HOME || homedir()) {
  const listed = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const usual = [path.join(home, ".local/bin"), path.join(home, ".claude/local"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return [...new Set([...listed, ...usual])];
}

function executable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/** The program for a kind ("claude-code" or "codex") on this computer, or null. */
export function findProgram(kind, env = process.env) {
  const program = PROGRAMS[kind];
  if (!program) return null;
  const configured = env[program.variable];
  if (configured) return executable(configured) ? configured : null;
  for (const folder of searchFolders(env)) {
    const file = path.join(folder, program.name);
    if (executable(file)) return file;
  }
  return null;
}

// The environment an agent runs with: the person's, without kino's own variables, and with the
// usual install folders on the PATH (its program may need node from there).
export function agentEnvironment(env = process.env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(KINO_|MOTION_|OPEN_MOTION_|ELECTRON_RUN_AS_NODE$)/.test(name)));
  kept.PATH = searchFolders(env).join(path.delimiter);
  return kept;
}

const tomlString = (text) => JSON.stringify(String(text));
const tomlTable = (values) => `{${Object.entries(values).map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}}`;

/** The command line for an agent (kind, program, the files in its folder, kino's MCP server). */
export function agentCommand(kind, { program, prompt, folder, mcp }) {
  if (kind === "claude-code") {
    return { program, args: ["-p", prompt, "--mcp-config", path.join(folder, "mcp.json"), "--strict-mcp-config", "--allowedTools", "mcp__kino", "--output-format", "json"] };
  }
  const settings = [
    `mcp_servers.kino.command=${tomlString(mcp.command)}`,
    `mcp_servers.kino.args=[${mcp.args.map(tomlString).join(",")}]`,
    ...(Object.keys(mcp.env).length ? [`mcp_servers.kino.env=${tomlTable(mcp.env)}`] : []),
    'mcp_servers.kino.default_tools_approval_mode="approve"',
  ];
  return { program, args: ["exec", "--skip-git-repo-check", "-C", path.join(folder, "work"), "-o", path.join(folder, "last.txt"), ...settings.flatMap((setting) => ["-c", setting]), prompt] };
}

/**
 * The agent's final message: Codex's last.txt, else the `result` of Claude Code's JSON answer,
 * else the end of what it printed.
 */
export async function finalMessage(folder) {
  const last = await readFile(path.join(folder, "last.txt"), "utf8").catch(() => "");
  if (last.trim()) return last.trim().slice(-MESSAGE_LIMIT);
  const out = (await readFile(path.join(folder, "out.log"), "utf8").catch(() => "")).trim();
  for (const line of out.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.result === "string") return parsed.result.trim().slice(-MESSAGE_LIMIT);
    } catch { /* not the JSON answer */ }
  }
  return out.slice(-MESSAGE_LIMIT);
}

/**
 * The launcher. `directory` is <data>/agent/crew; `connection()` is {url, ownerToken} of this
 * kino; `onExit(id, {code, signal, message})` hears each agent's end.
 */
export function createLauncher({ directory, connection, onExit = () => {}, env = process.env, spawnProcess = spawn, now = Date.now }) {
  const children = new Map();
  let found = null;
  let foundAt = 0;

  /** Which kinds of agents this computer can start now: {"claude-code": bool, codex: bool}. */
  function available() {
    if (!found || now() - foundAt > FOUND_FOR_MS) {
      found = Object.fromEntries(Object.keys(PROGRAMS).map((kind) => [kind, Boolean(findProgram(kind, env))]));
      foundAt = now();
    }
    return { ...found };
  }

  // kino's MCP server for the agent: the same program the app's own agent connection uses
  // (Electron in node mode in the desktop app, node otherwise), running crew-mcp.mjs.
  function mcpServer(agentFile) {
    const extra = env.KINO_MCP_ENV ? JSON.parse(env.KINO_MCP_ENV) : {};
    return {
      command: env.KINO_MCP_COMMAND || process.execPath,
      args: [CREW_MCP, agentFile],
      env: extra.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    };
  }

  /** Starts the agent `member` with `prompt`. Returns its process facts {pid, folder, …}. */
  async function start(member, { binary, prompt }) {
    const folder = path.join(directory, member.id);
    await mkdir(path.join(folder, "work"), { recursive: true, mode: 0o700 });
    const { url, ownerToken } = connection();
    const agentFile = path.join(folder, "agent.json");
    await writeFile(agentFile, JSON.stringify({ version: 1, url, ownerToken: ownerToken ?? null, session: member.session }), { mode: 0o600 });
    const mcp = mcpServer(agentFile);
    await writeFile(path.join(folder, "mcp.json"), JSON.stringify({ mcpServers: { kino: mcp } }), { mode: 0o600 });
    await writeFile(path.join(folder, "last.txt"), "", { mode: 0o600 });
    const { program, args } = agentCommand(member.kind, { program: binary, prompt, folder, mcp });
    const out = openSync(path.join(folder, "out.log"), "w", 0o600);
    const err = openSync(path.join(folder, "err.log"), "w", 0o600);
    let child;
    try {
      child = spawnProcess(program, args, { cwd: path.join(folder, "work"), env: agentEnvironment(env), detached: true, stdio: ["ignore", out, err] });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    children.set(member.id, child);
    child.once("exit", async (code, signal) => {
      children.delete(member.id);
      const message = await finalMessage(folder).catch(() => "");
      await onExit(member.id, { code, signal, message });
    });
    return { pid: child.pid, folder, log: path.join(folder, "out.log"), program: path.basename(program), startedAt: new Date(now()).toISOString(), exitedAt: null, exitCode: null };
  }

  function signalGroup(pid, signal) {
    try { process.kill(-pid, signal); return true; } catch {
      try { process.kill(pid, signal); return true; } catch { return false; }
    }
  }

  /** Ends an agent's process group: TERM, then KILL after 3 s. Resolves when it has exited. */
  async function stop(id) {
    const child = children.get(id);
    if (!child) return false;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    return true;
  }

  /**
   * An agent kino started before it restarted, recorded as still running: its process group is
   * ended when that process is still the agent (its command names the agent's own folder).
   */
  async function adopt(member) {
    const pid = member.process?.pid;
    const folder = member.process?.folder;
    if (!Number.isSafeInteger(pid) || !folder || !existsSync(folder)) return;
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return; }
    if (command.includes(folder)) signalGroup(pid, "SIGTERM");
  }

  /** Ends every agent kino started (kino is quitting). */
  function stopAll() {
    for (const child of children.values()) signalGroup(child.pid, "SIGTERM");
  }

  /** The end of an agent's output log (at most `bytes`). */
  async function log(id, bytes = 8192) {
    const text = await readFile(path.join(directory, id, "out.log"), "utf8").catch(() => "");
    const errors = await readFile(path.join(directory, id, "err.log"), "utf8").catch(() => "");
    return { out: text.slice(-bytes), err: errors.slice(-bytes) };
  }

  return { available, find: async (kind) => findProgram(kind, env), start, stop, stopAll, adopt, log, running: (id) => children.has(id) };
}
