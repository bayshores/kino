// Continue: kino starts the person's agent again, in the background, in the chat session that last
// worked on a project. An agent cannot be woken through MCP (it only answers calls), so the
// dashboard's Continue button runs the agent app's own command instead.
//
// - What kino knows: the kino MCP server that Claude Code starts gets CLAUDE_CODE_SESSION_ID and
//   CLAUDE_PROJECT_DIR in its environment. It sends them with every call (header x-kino-app, see
//   appSession and client.mjs); the server keeps the last one per project in the project's agent
//   state as `appSession` {app, session, folder, at} (remember). A call from another MCP client
//   without one (an agent kino cannot continue) clears it, so Continue never wakes an older chat.
//   Only Claude Code is supported: Codex gives its MCP server no session id, and kino never
//   guesses one ("the most recent conversation" could be any chat).
// - The command: `claude -p "<the continue sentence>" --resume <session> --allowedTools
//   mcp__kino,mcp__plugin_kino_kino`, in the session's folder, in its own process group, with the
//   person's environment (the app's own login; kino reads no token or credential). Only kino's
//   tools are allowed without asking, as an MCP server or as the plugin; anything else that would
//   need a permission is refused, since nobody can answer in print mode.
// - A chat that is still open (its kino MCP server, `pid`, is alive) is not written to from two
//   places: the run continues a copy of it (--fork-session --session-id <new id>), and that copy
//   is the chat kino continues next time.
// - What the agent said at the end (print mode prints only that) is kept as the run's `reply`,
//   so the dashboard can show it: nobody reads a log file.
// - One run per project: starting (started, kino not called yet), running (it called kino),
//   ended, failed (with one plain sentence why). Stop ends its process group; so does kino quitting.
// - What it printed goes to <data>/agent/resume/<project>.log.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { continuePrompt } from "../../engine/continuePrompt.js";
import { agentEnvironment, findProgram } from "./launcher.mjs";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT = /^[A-Za-z0-9_-]{3,32}$/;
const APPS = Object.freeze({ "claude-code": { command: "claude" } });
const STOP_GRACE_MS = 3000;
// A parent Claude Code's own variables (when kino itself was started from one) describe that
// session, not the one being continued.
const PARENT_SESSION = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR"];

/**
 * The agent session this kino MCP server works for, from its environment: {app, session, folder},
 * or null when the app gives none (only Claude Code does).
 */
export function appSession(env = process.env, cwd = process.cwd()) {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session) return null;
  return checkedSession({ app: "claude-code", session, folder: env.CLAUDE_PROJECT_DIR || cwd, pid: process.pid });
}

/**
 * `value` when it is a valid {app, session, folder, pid?} (a known app, an id, an absolute folder,
 * the process id of the chat's kino MCP server), else null.
 */
export function checkedSession(value) {
  if (!value || typeof value !== "object" || !APPS[value.app]) return null;
  if (typeof value.session !== "string" || !SESSION.test(value.session)) return null;
  if (typeof value.folder !== "string" || !path.isAbsolute(value.folder) || value.folder.length > 1024 || /[\0\n\r]/.test(value.folder)) return null;
  const pid = Number.isInteger(value.pid) && value.pid > 1 && value.pid < 2 ** 31 ? { pid: value.pid } : {};
  // `agent`: the kino session (x-kino-session) of that chat, added by the server (remember).
  const agent = typeof value.agent === "string" && AGENT.test(value.agent) ? { agent: value.agent } : {};
  return { app: value.app, session: value.session, folder: value.folder, ...pid, ...agent };
}

/** The x-kino-app header's value (URI-encoded JSON, so any folder name fits in a header). */
export const appHeader = (session) => encodeURIComponent(JSON.stringify(session));

/** The x-kino-app header back to {app, session, folder}, or null. */
export function readAppHeader(value) {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  try { return checkedSession(JSON.parse(decodeURIComponent(value))); } catch { return null; }
}

/** The command line that continues `session` with `prompt`; `copy` is the new id of a copy of an open chat. */
export function resumeArgs(session, prompt, copy = null) {
  return ["-p", prompt, "--resume", session.session, ...(copy ? ["--fork-session", "--session-id", copy] : []), "--allowedTools", "mcp__kino,mcp__plugin_kino_kino"];
}

// True while process `pid` runs (the chat's kino MCP server: the chat is open in the agent app).
function isRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (cause) { return cause?.code === "EPERM"; }
}

// What the agent said at the end, as plain text (no markdown marks), 1,200 characters at most.
function replyWords(output) {
  return String(output ?? "").replace(/[*_`#>]+/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(-1200);
}

const isFolder = (folder) => { try { return statSync(folder).isDirectory(); } catch { return false; } };

// The last line the agent printed, as one plain sentence about why it stopped.
function failureWords(output, code) {
  const line = String(output ?? "").split("\n").map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
  if (/log ?in|sign(ed)? ?in|auth|credential|api key/i.test(line)) return "Your agent is not signed in. Open it once to sign in.";
  if (/no conversation found|session.*not found/i.test(line)) return "Your agent's chat could not be found.";
  const said = line.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, "").slice(0, 160);
  return said ? `Your agent stopped: ${said.replace(/[.!?]?$/, ".")}` : `Your agent stopped (exit code ${code}).`;
}

/**
 * The runs. `agentState` is the per-project agent state store, `directory` <data>/agent/resume,
 * `publish(event)` the dashboard's stream, `projectName(id)` a project's name.
 */
export function createResumer({ agentState, directory, publish = () => {}, projectName = async () => "", env = process.env, spawnProcess = spawn, now = Date.now, chatOpen = isRunning }) {
  const runs = new Map();
  const iso = () => new Date(now()).toISOString();
  const alive = (run) => run?.state === "starting" || run?.state === "running";
  const shown = (run) => (run ? { state: run.state, called: run.called, stopped: run.stopped, error: run.error, reply: run.reply ?? null, startedAt: run.startedAt, endedAt: run.endedAt } : null);

  async function stored(projectId) {
    const state = await agentState.read(projectId).catch(() => null);
    return checkedSession(state?.appSession);
  }

  /** {possible, run}: whether Continue can start the project's agent here, and its last run. */
  async function view(projectId) {
    const session = PROJECT.test(projectId ?? "") ? await stored(projectId) : null;
    // KINO_CONTINUE=0 turns Continue off (a test run whose own runner answers the agent).
    const possible = Boolean(env.KINO_CONTINUE !== "0" && session && isFolder(session.folder) && findProgram(session.app, env));
    return { possible, run: shown(runs.get(projectId)) };
  }

  async function tell(projectId) {
    publish({ type: "resume", projectId, resume: await view(projectId) });
  }

  /**
   * An agent called kino about `projectId` (not the person, not the kino command line). `session`
   * is its {app, session, folder}, or null when its app gives none: then it is the agent that last
   * worked here and kino cannot continue it. `agent` is its kino session (x-kino-session): a run
   * kino starts keeps it, so the continued chat is the same agent on the dashboard, not a new one.
   */
  async function remember(projectId, session, agent = null) {
    if (!PROJECT.test(projectId ?? "")) return;
    const next = checkedSession(session ? { ...session, agent } : null);
    const run = runs.get(projectId);
    let changed = false;
    if (alive(run) && next?.session === run.session && !run.called) {
      run.called = true;
      run.state = "running";
      changed = true;
    }
    const before = await stored(projectId);
    if (["session", "folder", "pid", "agent"].some((key) => before?.[key] !== next?.[key])) {
      await agentState.update(projectId, (state) => { state.appSession = next ? { ...next, at: iso() } : null; });
      changed = true;
    }
    if (changed) await tell(projectId);
  }

  function signalGroup(pid, signal) {
    try { process.kill(-pid, signal); } catch {
      try { process.kill(pid, signal); } catch { /* it ended already */ }
    }
  }

  async function failed(projectId, error) {
    runs.set(projectId, { state: "failed", called: false, stopped: false, error, startedAt: iso(), endedAt: iso() });
    await tell(projectId);
    return view(projectId);
  }

  /** Starts the project's agent in its last session. Answers view(projectId). */
  async function start(projectId) {
    if (!PROJECT.test(projectId ?? "")) throw new Error("Continue needs a project id.");
    if (alive(runs.get(projectId))) return view(projectId);
    const session = env.KINO_CONTINUE === "0" ? null : await stored(projectId);
    if (!session) return failed(projectId, "kino does not know your agent's chat for this project.");
    const program = findProgram(session.app, env);
    if (!program) return failed(projectId, `The ${APPS[session.app].command} command was not found on this computer.`);
    if (!isFolder(session.folder)) return failed(projectId, "Your agent's folder is gone.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const log = path.join(directory, `${projectId}.log`);
    const prompt = continuePrompt(await projectName(projectId).catch(() => ""), projectId);
    const childEnv = agentEnvironment(env);
    for (const name of PARENT_SESSION) delete childEnv[name];
    // The chat's kino MCP server keeps the agent's kino session (backend/mcp.mjs reads both).
    if (session.agent) Object.assign(childEnv, { KINO_AGENT_SESSION: session.agent, KINO_CONTINUED: "1" });
    const out = openSync(log, "w", 0o600);
    let child;
    // An open chat is continued as a copy with an id chosen here, so its first call is known.
    const copy = chatOpen(session.pid) ? randomUUID() : null;
    try {
      child = spawnProcess(program, resumeArgs(session, prompt, copy), { cwd: session.folder, env: childEnv, detached: true, stdio: ["ignore", out, out] });
    } finally { closeSync(out); }
    const run = { state: "starting", called: false, stopped: false, error: null, reply: null, startedAt: iso(), endedAt: null, session: copy ?? session.session, child };
    runs.set(projectId, run);
    child.once("error", async () => {
      if (runs.get(projectId) !== run || !alive(run)) return;
      Object.assign(run, { state: "failed", error: `The ${APPS[session.app].command} command could not start.`, endedAt: iso(), child: null });
      await tell(projectId);
    });
    child.once("exit", async (code) => {
      run.child = null;
      if (runs.get(projectId) !== run || !alive(run)) return;
      // Marked at once (stop waits for this exit), then the log says why when it failed.
      const ok = run.stopped || code === 0;
      Object.assign(run, { state: ok ? "ended" : "failed", error: ok ? null : `Your agent stopped (exit code ${code}).`, endedAt: iso() });
      const output = await readFile(log, "utf8").catch(() => "");
      if (!ok) run.error = failureWords(output, code);
      else if (run.called && !run.stopped) run.reply = replyWords(output) || null;
      await tell(projectId);
    });
    await tell(projectId);
    return view(projectId);
  }

  /** Stops the project's run (its whole process group). Answers view(projectId). */
  async function stop(projectId) {
    const run = runs.get(projectId);
    if (!alive(run) || !run.child) return view(projectId);
    run.stopped = true;
    const child = run.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    signalGroup(child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    return view(projectId);
  }

  /** Ends every run (kino is quitting). */
  function stopAll() {
    for (const run of runs.values()) if (alive(run) && run.child) { run.stopped = true; signalGroup(run.child.pid, "SIGTERM"); }
  }

  return { view, remember, start, stop, stopAll };
}
