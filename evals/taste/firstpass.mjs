// One first-pass edit, end to end, the way a person asks kino for it (evals/taste/README.md, section 4).
// A fresh Claude Code agent gets only the person's one-line ask and the list of files; nobody
// answers it except the runner. When the agent ends its turn without a final MP4 because a kino
// stop waits for the person, the runner replies as a person would (the brief's `replies`, else a
// plain approval); every other time it replies "your call". Nothing here judges the result:
// packet.mjs and judge.mjs do that.
//
//   node evals/taste/firstpass.mjs <brief name or path> [--run-id <id>] [--dry-run]
//
// Env: KINO_FIRSTPASS_MODEL (default: Claude Code's own), KINO_FIRSTPASS_EFFORT (low to max; default:
// Claude Code's own), KINO_FIRSTPASS_MINUTES (default 45),
// KINO_FIRSTPASS_REPLIES (most "your call" replies, default 10), KINO_FIRSTPASS_HOUSE (the house
// memory snapshot in evals/taste/house, default launch-v1; none: an empty house).
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REPLY = "your call";
const TOOLS = "Bash,Read,Agent";

// ---- pure parts (tests/taste-harness.test.mjs) ----------------------------------------------------

/**
 * The person's message: the ask, then the files (none: kino finds the footage and the song), then any notes, then the project's name when
 * there is one. Nothing about kino or taste.
 */
export function promptFor(brief, files, projectId = null) {
  const lines = [brief.ask.trim(), ...(files.length ? ["", "Files:", ...files.map((file) => `- ${file}`)] : [])];
  if (brief.notes) lines.push("", brief.notes.trim());
  if (projectId) lines.push("", `Use ${projectId} as the project id.`);
  return lines.join("\n");
}

/**
 * The id of the project the agent really made, from kino's status line
 * ("kino launch trailer (kino-launch) rev 47 ..."): the id in parentheses before " rev ". null
 * when the line has none (no project open, or the status call failed).
 */
export function projectIdFromStatus(line) {
  return /\(([^()\s]+)\) rev \d/.exec(String(line ?? ""))?.[1] ?? null;
}

/**
 * The run's own project id, from its run id: lowercase letters, digits and dashes, at most 63
 * (kino's project id). Left to itself every agent named its project after the ask (kino-launch),
 * so every run got one deal seed (engine/deck.js projectSeed) and one house-memory family. A
 * number at the end is joined to the word before it (kino-fp-9 is kino-fp9), because familyOf
 * (backend/house-memory.mjs) drops a trailing "-9" and kino-fp-8 and kino-fp-9 would be one family.
 */
export function projectIdFor(runId) {
  let id = String(runId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 63).replace(/^-+|-+$/g, "");
  while (/-v?\d+[a-z]?$/.test(id)) id = id.replace(/-(v?\d+[a-z]?)$/, "$1");
  return id || "firstpass";
}

/** Visible words of an HTML page: no scripts, styles or tags, entities decoded, one line per block. */
export function htmlText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/h\d|\/li|\/div|\/section|\/a|\/button)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&rsquo;/g, "'").replace(/&mdash;/g, "-").replace(/&[a-z]+;/g, " ")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean)
    .filter((line, index, all) => all.indexOf(line) === index).join("\n");
}

/**
 * The MP4 the run made: the newest final render, else the newest draft. Only kino's renders count
 * (`<project>-r<rev>-<quality>-R<n>.mp4`): an agent's own working copies of the footage do not.
 * files: [{path, mtimeMs}].
 */
export function pickMp4(files, since = 0) {
  const render = /-r\d+-[a-z0-9]+-R\d+\.mp4$/i;
  const made = files.filter((file) => render.test(path.basename(file.path)) && file.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const isDraft = (file) => /(^|[-_.])draft([-_.]|$)/i.test(path.basename(file.path));
  const best = made.find((file) => !isDraft(file)) ?? made[0];
  return best ? { path: best.path, final: !isDraft(best) } : null;
}

// ---- stops: what a person says when kino waits for them ------------------------------------------------

/** The plain approval a person gives a stop when the brief gives no reply for it. */
export const APPROVAL = "looks good, keep going";

/**
 * The stop waiting for the person, from kino's dashboard snapshot (GET /api/dashboard/snapshot):
 * { id, kind, askedAt } or null. That route only reads: the status verb would also mark layers as
 * seen, so the agent's next status would show less. kino keeps at most one stop waiting at a time
 * (backend/agent/stops.mjs waitingStop); the open project's stop comes first.
 */
export function waitingFromSnapshot(snapshot) {
  const waiting = snapshot?.agent?.stops?.waiting ?? Object.values(snapshot?.waitingStops ?? {})[0];
  if (!waiting?.id) return null;
  return { id: String(waiting.id), kind: String(waiting.kind ?? "stop"), askedAt: waiting.askedAt ?? null };
}

/**
 * What the brief's `replies` may hold: an object by stop kind, each a string or a list of strings.
 * Throws a sentence naming the first problem; returns the object (or {} when there is none).
 */
export function checkReplies(replies) {
  if (replies === undefined) return {};
  if (!replies || typeof replies !== "object" || Array.isArray(replies)) throw new Error("A brief's replies is an object by stop kind, like {\"board\": [\"make the opening slower\", \"approved\"], \"rough\": \"approved\"}.");
  for (const [kind, wanted] of Object.entries(replies))
    if (!(typeof wanted === "string" && wanted.trim()) && !(Array.isArray(wanted) && wanted.length && wanted.every((text) => typeof text === "string" && text.trim())))
      throw new Error(`A brief's replies.${kind} is a reply or a list of replies, each a non-empty string.`);
  return replies;
}

/**
 * What a person says to a waiting stop. The brief's replies for that kind are used in order, one
 * per stop asked (a string is every time); when they run out, or the brief has none, the person
 * approves in plain words. A stop that is still waiting after the reply (the agent did not record
 * it) gets the same reply again, not the next one. `earlier` is the run's stops list so far.
 */
export function replyFor(stop, brief, earlier = []) {
  const again = earlier.find((entry) => entry.id === stop.id);
  if (again) return again.reply;
  const wanted = brief?.replies?.[stop.kind];
  if (typeof wanted === "string" && wanted.trim()) return wanted.trim();
  const nth = new Set(earlier.filter((entry) => entry.kind === stop.kind).map((entry) => entry.id)).size;
  return Array.isArray(wanted) && typeof wanted[nth] === "string" && wanted[nth].trim() ? wanted[nth].trim() : APPROVAL;
}

/**
 * The runner's next message after the agent ended its turn: a person's reply when a stop waits
 * for them, else "your call". { message, stop } with stop null for "your call".
 */
export function nextMessage(snapshot, brief, earlier = []) {
  const stop = waitingFromSnapshot(snapshot);
  return stop ? { message: replyFor(stop, brief, earlier), stop } : { message: REPLY, stop: null };
}

/**
 * One line of run.json's `stops`: the stop's kind and id, the seconds into the run when the agent
 * asked, the reply sent, and (once the next turn runs) the seconds from the reply to the agent's
 * next tool call. Seconds are the turn's end: the agent ends its turn right after it asks.
 */
export function stopEntry(stop, askedAfter, reply) {
  return { kind: stop.kind, id: stop.id, askedAfter, reply, nextToolAfter: null };
}

/** True for a stream event where the agent itself (not a helper it started) calls a tool. */
export function callsTool(event) {
  return event?.type === "assistant" && !event.parent_tool_use_id && (event.message?.content ?? []).some((part) => part.type === "tool_use");
}

/** Seconds, one decimal, from milliseconds. */
export const seconds1 = (ms) => Math.round(ms / 100) / 10;

/** What one `claude -p --output-format stream-json` run said: its session, cost, tool calls and last words. */
export function summarize(events) {
  const out = { sessionId: null, cost: 0, turns: 0, toolCalls: {}, models: [], finalMessage: "", isError: false };
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") out.sessionId ??= event.session_id ?? null;
    if (event.type === "assistant" && !event.parent_tool_use_id)
      for (const part of event.message?.content ?? []) if (part.type === "tool_use") out.toolCalls[part.name] = (out.toolCalls[part.name] ?? 0) + 1;
    if (event.type === "result") {
      out.cost += event.total_cost_usd ?? 0;
      out.turns += event.num_turns ?? 0;
      out.finalMessage = String(event.result ?? "");
      out.isError = Boolean(event.is_error);
      out.models = [...new Set([...out.models, ...Object.keys(event.modelUsage ?? {})])];
    }
  }
  return out;
}

// ---- the run ----------------------------------------------------------------------------------------

function loadBrief(name) {
  const file = existsSync(name) ? path.resolve(name) : path.join(root, "evals/taste/briefs", `${name.replace(/\.json$/, "")}.json`);
  const brief = JSON.parse(readFileSync(file, "utf8"));
  if (typeof brief.ask !== "string" || !Array.isArray(brief.media)) throw new Error(`${file}: a brief needs ask and media (media may be an empty list: kino finds the material).`);
  try { checkReplies(brief.replies); } catch (error) { throw new Error(`${file}: ${error.message}`); }
  return { ...brief, name: brief.name ?? path.basename(file, ".json") };
}

// The dashboard snapshot of the run's kino server (read only), or null when it cannot be read: the
// runner then says "your call", and run.json counts the failure so a missing stop is not silent.
async function readSnapshot(url) {
  try {
    const response = await fetch(`${url}/api/dashboard/snapshot`, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// Copies the brief's files into the run (the sources are only read), named <n>-<name> so two
// files with one name stay apart; `words` pages become plain text files.
async function copyMaterial(brief, mediaDir) {
  await mkdir(mediaDir, { recursive: true });
  const files = [];
  const all = [...brief.media.map((source) => ({ source })), ...(brief.words ?? []).map((source) => ({ source, words: true }))];
  for (const [index, entry] of all.entries()) {
    const source = path.resolve(root, entry.source);
    const base = (brief.names?.[entry.source] ?? path.basename(source)).replace(/[^\w.-]+/g, "-");
    const target = path.join(mediaDir, `${String(index + 1).padStart(2, "0")}-${entry.words ? base.replace(/\.html?$/i, "") + "-text.txt" : base}`);
    if (entry.words) await writeFile(target, htmlText(readFileSync(source, "utf8")) + "\n");
    else await copyFile(source, target);
    files.push(target);
  }
  return files;
}

// The person's settings for the run: a final render, an export overwrite and a big import go
// ahead without approval (nobody is there to approve them); the stops keep "ask" and get the
// runner's "your call". Renders land in out/. No idle preview drawing. Sound search is on:
// agents may search licensed music (only search words leave the Mac).
async function writeSettings(dataDir, outDir) {
  const approvals = { "final-render": "allow", "overwrite-export": "allow", "large-import": "allow" };
  await mkdir(path.join(dataDir, "agent"), { recursive: true });
  await writeFile(path.join(dataDir, "agent", "dashboard.json"), JSON.stringify({ settings: { approvals, exports: { folder: outDir }, compute: { previewCache: false }, sounds: { search: true } } }, null, 2));
}

/**
 * Seeds the run's house memory (<data>/house, backend/house-memory.mjs) with a fixed snapshot,
 * evals/taste/house/<snapshot>/*.json, so seen_before can fire in an eval: a fresh data folder
 * has no earlier projects. "none" seeds nothing (null). The snapshot never takes in later runs by
 * itself; a new one is a new folder. Gives {snapshot, sha256} of its files for run.json.
 */
export async function seedHouse(dataDir, snapshot, houseRoot = path.join(root, "evals/taste/house")) {
  if (!snapshot || snapshot === "none") return null;
  if (!/^[\w.-]+$/.test(snapshot)) throw new Error(`KINO_FIRSTPASS_HOUSE "${snapshot}": a folder name in evals/taste/house, or none.`);
  const from = path.join(houseRoot, snapshot);
  let names = [];
  try { names = (await readdir(from)).filter((name) => name.endsWith(".json")).sort(); } catch { /* missing */ }
  if (!names.length) throw new Error(`${from}: no house snapshot there (KINO_FIRSTPASS_HOUSE=none runs without one).`);
  const hash = createHash("sha256");
  await mkdir(path.join(dataDir, "house"), { recursive: true });
  for (const name of names) {
    const bytes = readFileSync(path.join(from, name));
    hash.update(`${name}\n`).update(bytes);
    await writeFile(path.join(dataDir, "house", name), bytes);
  }
  return { snapshot, sha256: hash.digest("hex") };
}

function startServer(dataDir, logFile) {
  const env = { ...process.env, MOTION_DATA_DIR: dataDir, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "0" };
  for (const key of ["KINO_PUBLIC_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_DESKTOP", "MOTION_API_URL"]) delete env[key];
  const log = createWriteStream(logFile, { flags: "a" });
  const child = fork(path.join(root, "backend/index.mjs"), [], { env, cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true });
  running.add(child);
  child.once("exit", () => running.delete(child));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The kino server did not start in 60 s (see ${logFile}).`)), 60_000);
    child.on("message", (message) => {
      if (message?.type !== "kino-ready") return;
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${message.port}` });
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The kino server exited (${code}); see ${logFile}.`)); });
  });
}

function stopGroup(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const force = setTimeout(() => kill("SIGKILL"), 5_000);
    child.once("exit", () => { clearTimeout(force); resolve(); });
    kill("SIGTERM");
  });
}

// One `claude -p` call: the first message, or a reply on the same session (--resume).
function runClaude({ message, sessionId, workDir, env, transcript, deadline, model, effort, system, addDirs }) {
  // --restricted: none of your settings, hooks or plugins, file tools kept to the work folder and
  // --add-dir; --strict-mcp-config: none of your MCP servers. Restricted mode also skips project
  // skills, so the kino skill comes in the system prompt (see main).
  const args = ["-p", message, "--restricted", "--tools", TOOLS, "--allowedTools", TOOLS, "--strict-mcp-config",
    "--output-format", "stream-json", "--verbose", "--append-system-prompt", system,
    ...addDirs.flatMap((dir) => ["--add-dir", dir]), ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(sessionId ? ["--resume", sessionId] : [])];
  const child = spawn("claude", args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  running.add(child);
  child.once("exit", () => running.delete(child));
  const events = [];
  const spawnedAt = Date.now();
  let buffer = "", errors = "", firstToolMs = null;
  child.stdout.on("data", (chunk) => {
    transcript.write(chunk);
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        // How long after the message the agent first acts: what a stop's reply cost in waiting.
        if (firstToolMs === null && callsTool(event)) firstToolMs = Date.now() - spawnedAt;
      } catch { /* not JSON */ }
    }
  });
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-4000); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopGroup(child); }, Math.max(1_000, deadline - Date.now()));
  return new Promise((resolve) => child.once("exit", (code) => {
    clearTimeout(timer);
    resolve({ code, timedOut, errors, firstToolMs, ...summarize(events) });
  }));
}

async function listFiles(dir) {
  const found = [];
  async function walk(folder) {
    let entries = [];
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (!/^(node_modules|\.git|render-segments|preview-cache|inspire)$/.test(entry.name)) await walk(full); }
      else if (entry.isFile()) found.push({ path: full, mtimeMs: (await stat(full)).mtimeMs });
    }
  }
  await walk(dir);
  return found;
}

// kino's own check of the open project after the run (the same check that blocks a final render).
async function kinoCheck(url) {
  const { createAgentClient } = await import("../../backend/agent/client.mjs");
  const client = createAgentClient({ url, ownerToken: null, shareToken: null }, { name: "firstpass" });
  try {
    const status = await client.call("status", {});
    const check = await client.call("check", { pixels: false });
    const text = String(check?.text ?? "");
    const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? NaN);
    return { status: String(status?.text ?? "").split("\n")[0], errors: count("err"), warnings: count("warn"), text: text.slice(0, 1500) };
  } catch (error) { return { error: error.message }; }
}

async function probe(file) {
  const { probeMedia } = await import("../../backend/media-probe.mjs");
  try {
    const info = await probeMedia(file);
    return { seconds: info.duration ?? null, width: info.width ?? null, height: info.height ?? null, bytes: (await stat(file)).size };
  } catch (error) { return { error: error.message }; }
}

// The model your own Claude Code sessions use (the "model" in ~/.claude/settings.json): the agent
// runs without your settings, so it is passed with --model. null: Claude Code's built-in default.
function sessionModel() {
  try { return JSON.parse(readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8")).model || null; } catch { return null; }
}

// Children run in their own process groups; Ctrl-C or a kill stops them too.
const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => { for (const child of running) try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } process.exit(130); });

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const name = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--run-id");
  if (!name) throw new Error("Usage: node evals/taste/firstpass.mjs <brief> [--run-id <id>] [--dry-run]");
  const brief = loadBrief(name);
  const minutes = Number(process.env.KINO_FIRSTPASS_MINUTES ?? 45);
  const replyLimit = Number(process.env.KINO_FIRSTPASS_REPLIES ?? 10);
  const model = process.env.KINO_FIRSTPASS_MODEL || sessionModel();
  const effort = process.env.KINO_FIRSTPASS_EFFORT || null;
  const runId = value("--run-id") ?? `${brief.name}-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const runDir = path.join(root, ".local/taste/runs", runId);
  const dataDir = path.join(runDir, "data"), outDir = path.join(runDir, "out"), mediaDir = path.join(runDir, "media");
  await mkdir(outDir, { recursive: true });
  const files = await copyMaterial(brief, mediaDir);
  const askedProjectId = projectIdFor(runId);
  const prompt = promptFor(brief, files, askedProjectId);
  if (args.includes("--dry-run")) { console.log(prompt); return; }
  await writeSettings(dataDir, outDir);
  const house = await seedHouse(dataDir, process.env.KINO_FIRSTPASS_HOUSE || "launch-v1");

  const started = Date.now(), deadline = started + minutes * 60_000;
  const server = await startServer(dataDir, path.join(runDir, "server.log"));
  // The agent's folder is outside this repository, so none of kino's own agent instructions reach
  // it; it holds only the kino skill and a `kino` command pointed at the private server.
  const workDir = await mkdtemp(path.join(os.tmpdir(), "kino-firstpass-"));
  await cp(path.join(root, "skills/kino"), path.join(workDir, ".claude/skills/kino"), { recursive: true });
  await mkdir(path.join(workDir, ".bin"));
  const shim = path.join(workDir, ".bin", "kino");
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "bin/kino.mjs")}" "$@"\n`);
  await chmod(shim, 0o755);
  const env = { ...process.env, PATH: `${path.dirname(shim)}:${process.env.PATH}`, MOTION_API_URL: server.url };
  for (const key of ["KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_PUBLIC_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[key];
  // One agent for the whole run, as in a person's Claude Code session. Each reply here is a new
  // `claude -p` process, so kino saw a new crew member every turn, and the last turn's holds
  // (2 quiet minutes) refused this agent's own edits and renders.
  env.KINO_AGENT_SESSION = `firstpass-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
  const skillDir = path.join(workDir, ".claude/skills/kino");
  const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const system = "kino is running for this session. Its MCP tools are not connected here: use the `kino` command in Bash instead "
    + "(the same verbs and fields as the tools, `kino help`). `kino look` saves its images as PNG files and prints their paths: open them with Read.\n\n"
    + `The kino skill follows (its references/ links are files in ${skillDir}).\n\n${skill}`;
  const transcript = createWriteStream(path.join(runDir, "transcript.jsonl"));
  console.log(`firstpass ${runId}: kino at ${server.url}, agent in ${workDir}, budget ${minutes} min`);

  // `kino look` writes its images into <data>/agent/out; the file tools only reach --add-dir
  // folders, so that one is added too (the rest of the data folder stays out of reach).
  const looksDir = path.join(dataDir, "agent", "out");
  await mkdir(looksDir, { recursive: true });
  const calls = [];
  const stops = [];
  let sessionId = null, message = prompt, made = null, openStop = null, snapshotFailures = 0;
  try {
    for (;;) {
      const call = await runClaude({ message, sessionId, workDir, env, transcript, deadline, model, effort, system, addDirs: [mediaDir, outDir, looksDir] });
      calls.push({ message, code: call.code, timedOut: call.timedOut, cost: call.cost, turns: call.turns, toolCalls: call.toolCalls, models: call.models, finalMessage: call.finalMessage, errors: call.code ? call.errors : undefined });
      // The reply to a stop is done once the agent acts again: how long that took.
      if (openStop) openStop.nextToolAfter = call.firstToolMs === null ? null : seconds1(call.firstToolMs);
      openStop = null;
      sessionId ??= call.sessionId;
      made = pickMp4([...await listFiles(outDir), ...await listFiles(workDir), ...await listFiles(path.join(dataDir, "exports"))], started);
      console.log(`  turn ${calls.length}: ${call.turns} steps, $${call.cost.toFixed(2)}, ${made ? `mp4 ${made.final ? "final" : "draft"}` : "no mp4"}; ${call.finalMessage.replace(/\s+/g, " ").slice(0, 160)}`);
      if (made?.final || call.timedOut || Date.now() >= deadline || !sessionId) break;
      if (calls.length > replyLimit) break;
      // A stop kino holds for the person gets a person's reply; every other turn end is "your call".
      const snapshot = await readSnapshot(server.url);
      if (!snapshot) snapshotFailures += 1;
      const next = nextMessage(snapshot, brief, stops);
      message = next.message;
      if (next.stop) {
        openStop = stopEntry(next.stop, seconds1(Date.now() - started), message);
        stops.push(openStop);
        console.log(`  stop ${next.stop.kind} (${next.stop.id}) waiting: replied "${message}"`);
      }
    }
  } finally {
    transcript.end();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const check = await kinoCheck(server.url);
  await stopGroup(server.child);
  // The agent may ignore the asked id; then the run shares a deal seed with every run of that id.
  const projectId = projectIdFromStatus(check.status);
  if (projectId !== askedProjectId) console.log(`  warning: asked for project id ${askedProjectId}, the agent made ${projectId ?? "no project"}`);
  // A final MP4 the agent wrote elsewhere is copied into out/ so the run folder holds it.
  if (made && !made.path.startsWith(outDir)) {
    const kept = path.join(outDir, path.basename(made.path));
    await copyFile(made.path, kept);
    made = { ...made, path: kept };
  }
  await rm(workDir, { recursive: true, force: true });
  const last = calls.at(-1) ?? {};
  const result = {
    version: 1, runId, askedProjectId, projectId, brief: brief.name, ask: brief.ask, files, model: model ?? "(Claude Code default)", effort: effort ?? "(Claude Code default)", house, models: [...new Set(calls.flatMap((call) => call.models))],
    startedAt: new Date(started).toISOString(), seconds, budgetMinutes: minutes, timedOut: calls.some((call) => call.timedOut) || Date.now() >= deadline,
    mp4: made?.path ?? null, mp4Final: made?.final ?? false, mp4Info: made ? await probe(made.path) : null,
    // replies is every message the runner sent after the first; yourCallReplies are the ones that
    // were "your call", stops the ones that were a person's reply to a waiting stop.
    finalMessage: last.finalMessage ?? "", replies: calls.length - 1, replyText: REPLY, yourCallReplies: calls.length - 1 - stops.length, stops, snapshotFailures,
    // A resumed session's total_cost_usd is the whole session's so far, so the run's cost is the largest.
    costUsd: Math.round(Math.max(0, ...calls.map((call) => call.cost ?? 0)) * 100) / 100,
    check, calls, sessionId, transcript: path.join(runDir, "transcript.jsonl"), serverLog: path.join(runDir, "server.log"),
  };
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`${path.join(runDir, "run.json")}\n  mp4: ${result.mp4 ?? "none"} (${result.mp4Final ? "final" : "not final"}), ${seconds} s, $${result.costUsd}, ${result.replies} replies (${stops.length} to stops, ${result.yourCallReplies} "${REPLY}")`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.stack ?? error.message); process.exit(1); });
