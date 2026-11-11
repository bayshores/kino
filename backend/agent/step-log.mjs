// The time log of a video's making: per step, how many minutes and how many kino tool calls.
// kino could not tell a person how long a step takes because nothing recorded it. The service
// names the step open when each agent call arrives (stepNameOf, from the same `step:` line status
// shows) and adds the call here (logCall); the log lives in the project's agent state
// (state.stepLog). Pure functions, so tests call them directly. The one file read is
// finishedLogs, which turns the logs of finished videos in the data folder into ranges.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The steps, in the order a video meets them. These are the words of kino's own `step:` line:
// brief, references (find and study), treatments (write and pick), signature (and spine), lock
// (direction lock past a rough pass), needs, footage (the found-footage step), the stops (board,
// rough, color, sound), build, then the passes before the final render.
export const STEP_NAMES = Object.freeze(["brief", "references", "treatments", "signature", "lock", "needs", "footage",
  "board", "rough", "color", "sound", "build", "viewer", "critic", "review", "final"]);

// A gap longer than this between two calls of one step is the person's time, not kino's.
export const WAIT_GAP_MS = 10 * 60 * 1000;
// A range needs this many finished videos before a plan card may promise it.
export const MIN_RUNS = 5;

// The stop each stop kind is called here; the critic's stop is the critic's step.
const STOP_STEP = { board: "board", rough: "rough", color: "color", sound: "sound", critique: "critic" };
// The agent supplies the checkpoint id, so only the table's own keys count: an id such as
// "__proto__" or "toString" must not come back as a function where a step name goes.
const stopStep = (id) => (typeof id === "string" && Object.hasOwn(STOP_STEP, id) ? STOP_STEP[id] : null);

// The brief-phase `step:` texts (brief.mjs nextMove, orderSteps, lockNeeded; footage-finder/step.mjs;
// stops.mjs statusMove), by what they start with. A text that matches none is the build.
const TEXT_STEPS = [
  [/\bask board\b/, "board"],
  [/^new video\?|^ask about |^guess |^save their fix|^play the brief back/, "brief"],
  [/^find \d+ (?:more )?references?|^study /, "references"],
  [/^write \d+ treatments|^pick a treatment|^ask their treatment pick/, "treatments"],
  [/^save the signature|^add the spine/, "signature"],
  [/^lock direction|^play spine/, "lock"],
  [/^check material/, "needs"],
  [/^import found shots|^scan the found footage|^found footage used up|^no clips of theirs/, "footage"],
];
// "ask rough again", "check, then ask color again", "fix what they named, check, ask sound again".
const ASK_STOP = /^(?:fix what they named, |check, then |check, )*ask (rough|color|sound)\b/;

// After the brief steps, the agent chooses the order of the passes before the final render, so
// the call itself names the step: a viewer, a critic, a review or the final render, else the build.
function buildStepOf(verb, input) {
  if (verb === "look") {
    if (input?.mode === "viewer") return "viewer";
    if (input?.mode === "critique") return "critic";
    if (input?.mode === "review" || input?.mode === "versus") return "review";
  }
  if (verb === "notes") {
    if (input?.action === "viewer" || input?.action === "intents") return "viewer";
    if (input?.action === "critique") return "critic";
  }
  if (verb === "render" && input?.quality === "final") return "final";
  return "build";
}

/**
 * The step open when a call arrives. move: statusMove's { step } (the words of status's `step:`
 * line); waiting: the kind of the stop that waits for the person, if one does; verb and input: the
 * call itself. A waiting stop and the call that asks a stop name that stop.
 */
export function stepNameOf(move, { waiting = null, verb = "", input = {} } = {}) {
  if (waiting) return stopStep(waiting) ?? "build";
  if (verb === "notes" && input?.action === "checkpoint" && stopStep(input.id)) return stopStep(input.id);
  const text = String(move?.step ?? "");
  for (const [pattern, name] of TEXT_STEPS) if (pattern.test(text)) return name;
  const ask = ASK_STOP.exec(text);
  return ask ? ask[1] : buildStepOf(verb, input);
}

const round1 = (number) => Math.round(number * 10) / 10;
// A log read from disk may be damaged by hand: keep only the parts that have the right shape.
const copyLog = (log) => {
  const steps = log && typeof log.steps === "object" && log.steps ? log.steps : {};
  const order = Array.isArray(log?.order) ? log.order : [];
  return {
    steps: Object.fromEntries(Object.entries(steps).map(([name, entry]) => [name, { ...entry }])),
    order: order.filter((name) => typeof name === "string"),
    ...(Number.isFinite(log?.lastEnd) ? { lastEnd: log.lastEnd } : {}),
    ...(log?.finishedAt ? { finishedAt: log.finishedAt } : {}),
  };
};
const entryOf = (log, name) => {
  if (!log.steps[name]) { log.steps[name] = { calls: 0, seconds: 0, waitSeconds: 0 }; log.order.push(name); }
  return log.steps[name];
};

/**
 * The log with one call added: a call that arrived at `startMs` and ended at `endMs`, in the step
 * `name` (a name outside STEP_NAMES is left out, so a bad name never reaches the saved state).
 * Counts the call toward the step. The call is charged the time since the last call ended (the
 * agent thinking about this step) plus its own running time, so a step the agent comes back to
 * between other steps still gets its thinking time. A gap of more than WAIT_GAP_MS is the person's
 * time (waitSeconds), kept apart. Returns a new log.
 */
export function logCall(log, name, startMs, endMs = startMs) {
  const next = copyLog(log);
  if (!STEP_NAMES.includes(name) || !Number.isFinite(startMs)) return next;
  const end = Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs);
  const entry = entryOf(next, name);
  const gap = next.lastEnd === undefined ? 0 : Math.max(0, startMs - next.lastEnd);
  // Calls that overlap the last one are charged only the part that runs past its end.
  const running = Math.max(0, end - Math.max(startMs, next.lastEnd ?? startMs));
  if (gap > WAIT_GAP_MS) entry.waitSeconds = round1(entry.waitSeconds + gap / 1000);
  entry.seconds = round1(entry.seconds + ((gap > WAIT_GAP_MS ? 0 : gap) + running) / 1000);
  entry.calls += 1;
  next.lastEnd = Math.max(next.lastEnd ?? end, end);
  return next;
}

/** The log marked finished (the final render came out). */
export const finishLog = (log, atIso) => ({ ...copyLog(log), finishedAt: atIso });
/** True for the log of a video whose final render came out. */
export const isFinished = (log) => Boolean(log?.finishedAt);

/** Rows [{name, calls, seconds, waitSeconds}] in the order the steps began. */
export function stepRows(log) {
  const view = copyLog(log);
  return view.order.map((name) => ({ name, ...view.steps[name] })).filter((row) => row.calls > 0);
}

const minutes = (seconds) => (seconds < 30 ? "<1 min" : `${Math.round(seconds / 60)} min`);
const calls = (count) => `${count} call${count === 1 ? "" : "s"}`;
// What the person did not cost kino: "waited 52 min" (only when a minute or more).
const waited = (row) => (row.waitSeconds >= 60 ? `waited ${minutes(row.waitSeconds)}` : "");

/** One line for the final render receipt: "steps: brief 2 min 6 calls · references 5 min 14 calls · ...". "" when empty. */
export function stepsLine(log) {
  const rows = stepRows(log);
  if (!rows.length) return "";
  return `steps: ${rows.map((row) => `${row.name} ${minutes(row.seconds)} ${calls(row.calls)}${waited(row) ? ` (${waited(row)})` : ""}`).join(" · ")}`;
}

/** The table `history` prints: one row per step, then the totals. [] when nothing is logged. */
export function stepsTable(log) {
  const rows = stepRows(log);
  if (!rows.length) return [];
  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => `  ${row.name.padEnd(width)}  ${minutes(row.seconds).padStart(6)}  ${calls(row.calls).padStart(9)}${waited(row) ? `  ${waited(row)}` : ""}`);
  const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  return ["steps (kino's time and calls; time waiting on the person is apart):", ...lines, `  total  ${minutes(seconds)}, ${calls(total)}`];
}

/**
 * A range per step from the logs of videos (finished ones only): { runs, enough, steps, text }.
 * steps: { name: { runs, min, max } } with min and max in minutes of kino's time (waiting left
 * out). enough is false under MIN_RUNS finished videos, and the text then says how many runs it
 * rests on, so a plan card never promises a range two videos cannot support.
 */
export function stepRanges(logs) {
  const finished = (logs ?? []).filter(isFinished);
  const per = {};
  for (const log of finished) for (const row of stepRows(log)) (per[row.name] ??= []).push(row.seconds / 60);
  const steps = {};
  for (const name of STEP_NAMES) {
    const list = per[name];
    if (list?.length) steps[name] = { runs: list.length, min: round1(Math.min(...list)), max: round1(Math.max(...list)) };
  }
  const enough = finished.length >= MIN_RUNS;
  const basis = `from ${finished.length} finished run${finished.length === 1 ? "" : "s"}`;
  const body = Object.entries(steps).map(([name, range]) => `${name} ${range.min} to ${range.max} min`).join(" · ");
  const text = enough ? `${body} (${basis})` : `${basis}, too few for a range (${MIN_RUNS} needed)${body ? `: ${body}` : ""}`;
  return { runs: finished.length, enough, steps, text };
}

/** The step logs of every project in a data folder (<data>/agent/projects/*.json); unreadable files are left out. */
export async function readStepLogs(dataRoot) {
  const directory = path.join(dataRoot, "agent", "projects");
  let names;
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const logs = [];
  for (const name of names) {
    try {
      const log = JSON.parse(await readFile(path.join(directory, name), "utf8")).stepLog;
      if (log?.steps && Array.isArray(log.order)) logs.push(log);
    } catch { /* a file that cannot be read is left out */ }
  }
  return logs;
}

/** The ranges of this data folder's finished videos (stepRanges over readStepLogs). */
export async function dataRanges(dataRoot) {
  return stepRanges(await readStepLogs(dataRoot));
}
