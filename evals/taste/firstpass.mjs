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
//
// Person mode (KINO_FIRSTPASS_PERSON=1): someone sits at the kino desktop app during the run. The
// runner starts the app instead of its own server, and waits for the person at a try round (their
// pick) and at the first final MP4 (their watch). KINO_FIRSTPASS_PERSON_MINUTES (default 30) is the most it
// waits for one of those; KINO_FIRSTPASS_PERSON_HIDDEN=1 (test only) keeps the app invisible and silent.
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRITIQUE_STOP, STOP_KINDS } from "../../backend/agent/stops.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REPLY = "your call";
const TOOLS = "Bash,Read,Agent";
// All of kino's MCP tools (`kino setup` registers the server as "kino", so they are mcp__kino__<verb>).
const MCP_TOOLS = "mcp__kino";

// ---- pure parts (tests/taste-harness.test.mjs) ----------------------------------------------------

/**
 * The MCP config a person gets from `kino setup` (`claude mcp add kino -- node bin/kino.mjs mcp`),
 * pointed at the run's kino: `url` is the private server (MOTION_API_URL), `runtimeFile` the app's
 * runtime.json (person mode, KINO_RUNTIME_FILE, which also holds the owner token). Claude Code
 * starts an MCP server with only a few env vars, so the server gets its own here.
 */
export function mcpConfig({ repoRoot, nodePath, url = null, runtimeFile = null, session }) {
  const env = { ...(runtimeFile ? { KINO_RUNTIME_FILE: runtimeFile } : { MOTION_API_URL: url }), KINO_AGENT_SESSION: session };
  return { mcpServers: { kino: { command: nodePath, args: [path.join(repoRoot, "bin/kino.mjs"), "mcp"], env } } };
}

/**
 * The `claude -p` arguments for one call. `mcpFile` set (the default surface): kino's MCP server
 * from that file only, and its tools allowed beside Bash, Read and Agent. null (KINO_FIRSTPASS_CLI=1):
 * no MCP server at all, the agent drives kino through the `kino` command in Bash.
 */
export function agentArgs({ message, system, addDirs, model = null, effort = null, sessionId = null, mcpFile = null }) {
  return ["-p", message, "--restricted", "--tools", TOOLS, "--allowedTools", mcpFile ? `${TOOLS},${MCP_TOOLS}` : TOOLS,
    ...(mcpFile ? ["--mcp-config", mcpFile] : []), "--strict-mcp-config",
    "--output-format", "stream-json", "--verbose", "--append-system-prompt", system,
    ...addDirs.flatMap((dir) => ["--add-dir", dir]), ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(sessionId ? ["--resume", sessionId] : [])];
}

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
  // A kind kino never asks (a typo, a wrong case) would never match: the reply would be dropped without a word.
  const kinds = [...STOP_KINDS, CRITIQUE_STOP];
  for (const kind of Object.keys(replies))
    if (!kinds.includes(kind)) throw new Error(`A brief's replies.${kind} is not a stop kind: use ${kinds.join(", ")}.`);
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
 * Seconds into the run when the agent asked: the stop's stored `askedAt` (an ISO time) against the
 * run's start. When `askedAt` is missing or unreadable (or says a time outside the run), the turn's
 * end is used: the agent ends its turn right after it asks.
 */
export function askedAfter(stop, startedMs, nowMs) {
  const at = Date.parse(stop?.askedAt ?? "");
  return seconds1(Number.isFinite(at) && at >= startedMs && at <= nowMs ? at - startedMs : nowMs - startedMs);
}

/**
 * One line of run.json's `stops`: the stop's kind and id, the seconds into the run when the agent
 * asked (askedAfter), the reply sent, and (once the next turn runs) the seconds from the reply to
 * the agent's next tool call.
 */
export function stopEntry(stop, askedAfter, reply) {
  return { kind: stop.kind, id: stop.id, askedAfter, reply, nextToolAfter: null };
}

// ---- person mode: someone sits at the app (KINO_FIRSTPASS_PERSON=1) -----------------------------------

export const PICK_REPLY = "I picked in the app.";
export const WATCH_REPLY = "I watched it in the app.";
/** The watch is over once the person's last reaction is this old. */
export const WATCH_QUIET_MS = 20_000;
/** Polls every this long; gives up on an unreadable server after this many reads in a row. */
export const POLL_MS = 2_000;
export const POLL_FAILURES = 5;

/**
 * The try round the person has still to pick in, from the dashboard snapshot (agent.tries.rounds,
 * backend/agent/tries.mjs triesView): { id, question, status } or null. A round is "rendering"
 * while its clips are made and "waiting" once the person can pick; both count, because the agent
 * ends its turn right after asking and the person picks as soon as the clips are ready.
 */
export function pendingPick(snapshot, id = null) {
  const round = (snapshot?.agent?.tries?.rounds ?? []).find((entry) => (entry.status === "waiting" || entry.status === "rendering") && (id === null || entry.id === id));
  return round ? { id: String(round.id), question: String(round.question ?? ""), status: round.status } : null;
}

/** How a try round stands now ("picked", "skipped", "failed" ...), or null when it is gone. */
export const roundStatus = (snapshot, id) => (snapshot?.agent?.tries?.rounds ?? []).find((entry) => String(entry.id) === String(id))?.status ?? null;

/**
 * What the runner does when the agent's turn ends in person mode, from the snapshot and the run so
 * far (`hasMp4`: a render exists in the run, `watchStarted`: the watch already happened):
 *   stop   a kino stop waits: the runner's plain approval or the brief's reply (as without person mode)
 *   pick   a try round waits for the person's pick
 *   watch  the first final MP4 exists: the person watches it in the app and marks moments
 *   reply  nothing waits: "your call"
 * Stops come first: answering one takes no time. { action, message, ... }.
 */
export function personStep(snapshot, { brief, stops = [], hasMp4 = false, watchStarted = false } = {}) {
  const stop = waitingFromSnapshot(snapshot);
  if (stop) return { action: "stop", stop, message: replyFor(stop, brief, stops) };
  const round = pendingPick(snapshot);
  if (round) return { action: "pick", round, message: PICK_REPLY, line: `waiting for your pick in the app: ${round.question}` };
  if (hasMp4 && !watchStarted && snapshot?.projectId)
    return { action: "watch", projectId: snapshot.projectId, message: WATCH_REPLY, line: "watch it in the app, mark good and bad moments; I continue when you stop" };
  return { action: "reply", message: REPLY };
}

/**
 * Whether the person is done watching: the project's reactions (agent state, reactions.entries,
 * each with an ISO `at`) hold at least one entry newer than the agent's turn end (`turnEndMs`) and
 * the newest one is `quietMs` old. Reactions arrive in batches when playing stops, so a quiet
 * stretch after one means they stopped.
 */
export function watchOver(entries, turnEndMs, nowMs, quietMs = WATCH_QUIET_MS) {
  const times = (entries ?? []).map((entry) => Date.parse(entry?.at ?? "")).filter((time) => Number.isFinite(time) && time > turnEndMs);
  return times.length > 0 && nowMs - Math.max(...times) >= quietMs;
}

/**
 * Calls `check()` every `everyMs` until it answers true (done), "stop" (give up, counted as timed
 * out) or `limitMs` pass. Gives { seconds, timedOut }. now and sleep are injectable for tests.
 */
export async function pollUntil(check, { limitMs, everyMs = POLL_MS, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const begun = now();
  for (;;) {
    const answer = await check();
    if (answer === true) return { seconds: seconds1(now() - begun), timedOut: false };
    if (answer === "stop" || now() - begun >= limitMs) return { seconds: seconds1(now() - begun), timedOut: true };
    await sleep(Math.min(everyMs, Math.max(1, limitMs - (now() - begun))));
  }
}

/** One line of run.json's person.waits. */
export const waitEntry = (kind, wait) => ({ kind, seconds: wait.seconds, timedOut: wait.timedOut });

/** What the app is started with: the electron program, its arguments and the one env var it needs. */
export function appCommand({ repoRoot, dataDir, profileDir, electronPath }) {
  return { command: electronPath, args: [repoRoot, `--user-data-dir=${profileDir}`], env: { MOTION_DATA_DIR: dataDir } };
}

/** The file the app keeps a project's agent state in (backend/agent/state.mjs). */
export const agentStateFile = (dataDir, projectId) => path.join(dataDir, "agent", "projects", `${encodeURIComponent(projectId)}.json`);

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
// `where` is { url, ownerToken } (the private server has no token; the app's server needs its owner token).
export async function readSnapshot(where) {
  try {
    const response = await fetch(`${where.url}/api/dashboard/snapshot`, { headers: where.ownerToken ? { "X-Kino-Owner": where.ownerToken } : {}, signal: AbortSignal.timeout(15_000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// ---- person mode: the desktop app ---------------------------------------------------------------

/**
 * Starts the kino desktop app from this checkout on the run's data folder, with its own new
 * temporary profile (so it never takes over your open app or its runtime.json). Gives
 * { pid, profileDir, runtimeFile, close() }. Visible: a plain detached process that outlives the
 * runner; a small shell watches it and removes the profile when it exits. Hidden (test-only,
 * KINO_FIRSTPASS_PERSON_HIDDEN=1): started through Playwright like scripts/desktop-shot.mjs, every
 * window invisible, muted, unfocusable and passing mouse clicks through (an invisible window still took a click on its Hold button); close() quits it and removes the profile.
 */
export async function launchApp({ dataDir, logFile, hidden = false }) {
  // Without the built dashboard the window is empty, kino sees no one at the app and the run quietly takes the no-person path.
  if (!existsSync(path.join(root, "dist/client/index.html"))) throw new Error(`person mode needs the built dashboard: run "npm run build" in ${root} first.`);
  const electronPath = createRequire(import.meta.url)("electron");
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "kino-firstpass-profile-"));
  const spec = appCommand({ repoRoot: root, dataDir, profileDir, electronPath });
  const env = { ...process.env, ...spec.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "KINO_PUBLIC_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "MOTION_API_URL", "MOTION_API_PORT"]) delete env[key];
  const runtimeFile = path.join(profileDir, "runtime.json");
  if (hidden) {
    const { _electron } = await import("playwright-core");
    const app = await _electron.launch({ executablePath: spec.command, args: spec.args, env });
    hiddenApp = app;
    await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      for (const each of BrowserWindow.getAllWindows()) { each.setFocusable(false); each.blur(); each.setOpacity(0); each.setIgnoreMouseEvents(true); each.webContents.setAudioMuted(true); }
    });
    return { pid: app.process().pid, profileDir, runtimeFile, hidden: true, close: async () => { hiddenApp = null; await app.close().catch(() => {}); await rm(profileDir, { recursive: true, force: true }); } };
  }
  const log = openSync(logFile, "a");
  const child = spawn(spec.command, spec.args, { env, cwd: root, stdio: ["ignore", log, log], detached: true });
  child.unref();
  // The app may be closed long after the runner is gone: a shell waits for it, then removes the profile.
  spawn("/bin/sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 5; done; rm -rf "$2"', "sh", String(child.pid), profileDir], { detached: true, stdio: "ignore" }).unref();
  return { pid: child.pid, profileDir, runtimeFile, hidden: false, close: async () => { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } } };
}

// Where the app's kino server is now, from the runtime file the app writes (origin and owner
// token). Read again each time: a restarted service has a new port and token. null: not there.
export async function appConnection(runtimeFile) {
  const { resolveConnection } = await import("../../backend/agent/client.mjs");
  const connection = await resolveConnection({ KINO_RUNTIME_FILE: runtimeFile });
  return connection.source === "desktop app" ? connection : null;
}

export async function waitForApp(runtimeFile, limitMs = 90_000) {
  const begun = Date.now();
  while (Date.now() - begun < limitMs) {
    const connection = await appConnection(runtimeFile);
    if (connection && await readSnapshot(connection)) return connection;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The kino app did not write ${runtimeFile} and answer within ${limitMs / 1000} s.`);
}

// The person's reactions for a project: the app keeps them in the project's agent state file
// (the dashboard snapshot holds only the good and bad marks, without times).
export async function readReactions(dataDir, projectId) {
  try { return JSON.parse(await readFile(agentStateFile(dataDir, projectId), "utf8"))?.reactions?.entries ?? []; } catch { return []; }
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
function runClaude({ message, sessionId, workDir, env, transcript, deadline, model, effort, system, addDirs, mcpFile }) {
  // --restricted: none of your settings, hooks or plugins, file tools kept to the work folder and
  // --add-dir; --strict-mcp-config: none of your MCP servers, only kino's from mcpFile (see
  // agentArgs). Restricted mode also skips project skills, so the kino skill comes in the system
  // prompt (see main).
  const args = agentArgs({ message, system, addDirs, model, effort, sessionId, mcpFile });
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
async function kinoCheck(where) {
  const { createAgentClient } = await import("../../backend/agent/client.mjs");
  const client = createAgentClient({ url: where.url, ownerToken: where.ownerToken ?? null, shareToken: null }, { name: "firstpass" });
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
// The hidden test app (launchApp), closed with the runner; a visible app is left open on purpose.
let hiddenApp = null;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => { for (const child of running) try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } try { hiddenApp?.process().kill("SIGTERM"); } catch { /* gone */ } process.exit(130); });

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
  const person = process.env.KINO_FIRSTPASS_PERSON === "1";
  const personMs = Number(process.env.KINO_FIRSTPASS_PERSON_MINUTES ?? 30) * 60_000;
  const hidden = process.env.KINO_FIRSTPASS_PERSON_HIDDEN === "1";
  // The surface the agent drives kino through: the MCP tools a person gets from `kino setup`
  // (default), or the `kino` command alone (KINO_FIRSTPASS_CLI=1, for comparison).
  const surface = process.env.KINO_FIRSTPASS_CLI === "1" ? "cli" : "mcp";
  // One agent for the whole run, as in a person's Claude Code session (see KINO_AGENT_SESSION below).
  const session = `firstpass-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
  const mcpFile = path.join(runDir, "mcp.json");
  if (args.includes("--dry-run")) {
    console.log(prompt);
    if (surface === "mcp") {
      const config = mcpConfig({ repoRoot: root, nodePath: process.execPath, session, ...(person ? { runtimeFile: "<profile>/runtime.json" } : { url: "<the private server's address, picked at start>" }) });
      console.log(`\nsurface: mcp. Would write ${mcpFile}:\n${JSON.stringify(config, null, 2)}\n`
        + `  and start the agent with: --mcp-config ${mcpFile} --strict-mcp-config --allowedTools ${TOOLS},${MCP_TOOLS} (the kino command stays on its PATH too)`);
    } else console.log("\nsurface: cli (KINO_FIRSTPASS_CLI=1). No MCP server: the agent uses the `kino` command in Bash.");
    if (person) {
      const spec = appCommand({ repoRoot: root, dataDir, profileDir: "<a new temporary folder, removed when the app exits>", electronPath: createRequire(import.meta.url)("electron") });
      console.log(`\nperson mode: no private server. Would start the kino app${hidden ? " (hidden, test only)" : ""}:\n  ${spec.command} ${spec.args.join(" ")}\n  env MOTION_DATA_DIR=${spec.env.MOTION_DATA_DIR}\n`
        + `  the agent reaches it through KINO_RUNTIME_FILE=<profile>/runtime.json; picks and the watch wait up to ${personMs / 60_000} min each (the run's ${minutes} min budget stops while it waits).`);
    }
    return;
  }
  await writeSettings(dataDir, outDir);
  const house = await seedHouse(dataDir, process.env.KINO_FIRSTPASS_HOUSE || "launch-v1");

  const started = Date.now();
  let deadline = started + minutes * 60_000;
  // Person mode: the app is the server (it forks backend/index.mjs on this data folder, which reads
  // the settings written above). `where()` is where it is now: its port and token change on a restart.
  let app = null, where, server = null;
  if (person) {
    app = await launchApp({ dataDir, logFile: path.join(runDir, "app.log"), hidden });
    where = await waitForApp(app.runtimeFile);
  } else {
    server = await startServer(dataDir, path.join(runDir, "server.log"));
    where = { url: server.url, ownerToken: null };
  }
  const connection = async () => { if (person) where = (await appConnection(app.runtimeFile)) ?? where; return where; };
  // The agent's folder is outside this repository, so none of kino's own agent instructions reach
  // it; it holds only the kino skill and a `kino` command pointed at the private server.
  const workDir = await mkdtemp(path.join(os.tmpdir(), "kino-firstpass-"));
  await cp(path.join(root, "skills/kino"), path.join(workDir, ".claude/skills/kino"), { recursive: true });
  await mkdir(path.join(workDir, ".bin"));
  const shim = path.join(workDir, ".bin", "kino");
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "bin/kino.mjs")}" "$@"\n`);
  await chmod(shim, 0o755);
  // Person mode: the `kino` command finds the app's server (and its owner token) in the app's runtime file.
  const env = { ...process.env, PATH: `${path.dirname(shim)}:${process.env.PATH}`, ...(person ? { KINO_RUNTIME_FILE: app.runtimeFile } : { MOTION_API_URL: where.url }) };
  for (const key of ["KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_PUBLIC_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", ...(person ? ["MOTION_API_URL"] : [])]) delete env[key];
  // One agent for the whole run, as in a person's Claude Code session. Each reply here is a new
  // `claude -p` process, so kino saw a new crew member every turn, and the last turn's holds
  // (2 quiet minutes) refused this agent's own edits and renders.
  env.KINO_AGENT_SESSION = session;
  // The MCP surface: the config `kino setup` would register, pointed at this run's kino. The server
  // is read when each `claude -p` starts, so a restarted app is found again through its runtime file.
  if (surface === "mcp") {
    await writeFile(mcpFile, JSON.stringify(mcpConfig({ repoRoot: root, nodePath: process.execPath, session, ...(person ? { runtimeFile: app.runtimeFile } : { url: where.url }) }), null, 2) + "\n");
  }
  const skillDir = path.join(workDir, ".claude/skills/kino");
  const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  const how = surface === "mcp"
    ? "kino is running for this session and its MCP tools are connected (mcp__kino__status, mcp__kino__edit and the rest); the `kino` command is also in Bash (the same verbs and fields)."
    : "kino is running for this session. Its MCP tools are not connected here: use the `kino` command in Bash instead (the same verbs and fields as the tools, `kino help`). `kino look` saves its images as PNG files and prints their paths: open them with Read.";
  const system = `${how}\n\nThe kino skill follows (its references/ links are files in ${skillDir}).\n\n${skill}`;
  const transcript = createWriteStream(path.join(runDir, "transcript.jsonl"));
  console.log(`firstpass ${runId}: kino ${person ? `app (pid ${app.pid}) ` : ""}at ${where.url}, agent in ${workDir}, budget ${minutes} min${person ? `, person mode (up to ${personMs / 60_000} min per pick or watch)` : ""}`);

  // `kino look` writes its images into <data>/agent/out; the file tools only reach --add-dir
  // folders, so that one is added too (the rest of the data folder stays out of reach).
  const looksDir = path.join(dataDir, "agent", "out");
  await mkdir(looksDir, { recursive: true });
  const calls = [];
  const stops = [];
  let sessionId = null, message = prompt, made = null, openStop = null, snapshotFailures = 0;
  // Person mode: every wait for the person (run.json person.waits), and whether the watch happened.
  const waits = [];
  let watchStarted = false, watchEnded = false, personReplies = 0;
  // A wait for the person does not use the agent's time budget: the deadline moves by it.
  const waitFor = async (kind, check) => {
    const wait = await pollUntil(check, { limitMs: personMs });
    deadline += wait.seconds * 1000;
    waits.push(waitEntry(kind, wait));
    return wait;
  };
  try {
    for (;;) {
      const call = await runClaude({ message, sessionId, workDir, env, transcript, deadline, model, effort, system, addDirs: [mediaDir, outDir, looksDir], mcpFile: surface === "mcp" ? mcpFile : null });
      calls.push({ message, code: call.code, timedOut: call.timedOut, cost: call.cost, turns: call.turns, toolCalls: call.toolCalls, models: call.models, finalMessage: call.finalMessage, errors: call.code ? call.errors : undefined });
      // The reply to a stop is done once the agent acts again: how long that took.
      if (openStop) openStop.nextToolAfter = call.firstToolMs === null ? null : seconds1(call.firstToolMs);
      openStop = null;
      sessionId ??= call.sessionId;
      made = pickMp4([...await listFiles(outDir), ...await listFiles(workDir), ...await listFiles(path.join(dataDir, "exports"))], started);
      console.log(`  turn ${calls.length}: ${call.turns} steps, $${call.cost.toFixed(2)}, ${made ? `mp4 ${made.final ? "final" : "draft"}` : "no mp4"}; ${call.finalMessage.replace(/\s+/g, " ").slice(0, 160)}`);
      if ((!person && made?.final) || call.timedOut || Date.now() >= deadline || !sessionId) break;
      if (calls.length > replyLimit) break;
      // A stop kino holds for the person gets a person's reply; every other turn end is "your call".
      const turnEnd = Date.now();
      const snapshot = await readSnapshot(await connection());
      if (!snapshot) snapshotFailures += 1;
      // Without person mode: a stop or "your call". With it, also the person's pick and watch.
      const step = person ? personStep(snapshot, { brief, stops, hasMp4: Boolean(made?.final), watchStarted }) : (({ message: said, stop }) => ({ action: stop ? "stop" : "reply", message: said, stop }))(nextMessage(snapshot, brief, stops));
      // The run ends at the first turn end with an MP4 once the person has watched (or the watch timed out).
      if (person && step.action === "reply" && made && watchEnded) break;
      message = step.message;
      if (step.action === "stop") {
        openStop = stopEntry(step.stop, askedAfter(step.stop, started, Date.now()), message);
        stops.push(openStop);
        console.log(`  stop ${step.stop.kind} (${step.stop.id}) waiting: replied "${message}"`);
      } else if (step.action === "pick") {
        console.log(`  ${step.line}`);
        let failures = 0, ended = null;
        const wait = await waitFor("pick", async () => {
          const now = await readSnapshot(await connection());
          if (!now) { snapshotFailures += 1; failures += 1; return failures >= POLL_FAILURES ? "stop" : false; }
          failures = 0;
          ended = roundStatus(now, step.round.id);
          return !pendingPick(now, step.round.id);
        });
        // Only a real pick is answered as one: a skipped or failed round, or no pick in time, is "your call".
        if (wait.timedOut || ended !== "picked") { message = REPLY; console.log(`  no pick after ${wait.seconds} s (round ${ended ?? "gone"}): replied "${REPLY}"`); }
        else { personReplies += 1; console.log(`  picked after ${wait.seconds} s`); }
      } else if (step.action === "watch") {
        console.log(`  ${step.line}`);
        watchStarted = true;
        const wait = await waitFor("watch", async () => watchOver(await readReactions(dataDir, step.projectId), turnEnd, Date.now()));
        watchEnded = true;
        // Out of time: the run just ends. Otherwise the agent may revise.
        if (wait.timedOut) { console.log(`  no watch after ${wait.seconds} s: the run ends`); break; }
        personReplies += 1;
        console.log(`  watched for ${wait.seconds} s`);
      }
    }
  } finally {
    transcript.end();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const check = await kinoCheck(await connection());
  if (server) await stopGroup(server.child);
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
    version: 1, runId, surface, askedProjectId, projectId, brief: brief.name, ask: brief.ask, files, model: model ?? "(Claude Code default)", effort: effort ?? "(Claude Code default)", house, models: [...new Set(calls.flatMap((call) => call.models))],
    startedAt: new Date(started).toISOString(), seconds, budgetMinutes: minutes, timedOut: calls.some((call) => call.timedOut) || Date.now() >= deadline,
    mp4: made?.path ?? null, mp4Final: made?.final ?? false, mp4Info: made ? await probe(made.path) : null,
    // replies is every message the runner sent after the first; yourCallReplies are the ones that
    // were "your call", stops the ones that were a person's reply to a waiting stop.
    // In person mode a pick or watch the person answered is a reply too (person.waits), and not "your call".
    finalMessage: last.finalMessage ?? "", replies: calls.length - 1, replyText: REPLY, yourCallReplies: calls.length - 1 - stops.length - personReplies, stops, snapshotFailures,
    // The person's time, measured: each wait for a pick or a watch, its seconds, and whether it ran out.
    person: person ? { mode: true, waits } : { mode: false },
    // A resumed session's total_cost_usd is the whole session's so far, so the run's cost is the largest.
    costUsd: Math.round(Math.max(0, ...calls.map((call) => call.cost ?? 0)) * 100) / 100,
    check, calls, sessionId, transcript: path.join(runDir, "transcript.jsonl"), serverLog: path.join(runDir, person ? "app.log" : "server.log"),
  };
  await writeFile(path.join(runDir, "run.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`${path.join(runDir, "run.json")}\n  mp4: ${result.mp4 ?? "none"} (${result.mp4Final ? "final" : "not final"}), ${seconds} s, $${result.costUsd}, ${result.replies} replies (${stops.length} to stops, ${result.yourCallReplies} "${REPLY}"${person ? `, ${personReplies} to your picks and watch` : ""})`);
  if (app?.hidden) { await app.close(); console.log("  the hidden test app is closed."); }
  else if (app) console.log(`  the kino app stays open (pid ${app.pid}), in case you are still watching. Close it with Cmd+Q in the app, or: kill ${app.pid}\n  Its temporary profile (${app.profileDir}) is removed when it exits.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.stack ?? error.message); try { hiddenApp?.process().kill("SIGTERM"); } catch { /* gone */ } process.exit(1); });
