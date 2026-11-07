// Screen recordings for agents (project {action:"record"}), on this Mac only.
//
// What happens, in order:
//   1. start: kino runs the kino-recorder helper (kino-recorder.swift) once, in serve mode, and
//      sends it JSON lines. It records into <data>/recordings/<id>.kinorec: screen.mp4 without
//      the pointer, events.jsonl (pointer, clicks, keys, marks, caret) and recording.json.
//   2. The agent works (clicks, types, runs a browser) and sends mark {label} at each step.
//   3. stop, or a stop rule (maxSeconds, idleSeconds, the window closed): the helper finishes
//      the files; kino adds screen.mp4 to the media library, keeps the pointer and click data
//      (engine/recording.js compactRecording) next to it as <media id>.recording.json, and
//      deletes the folder. The screen-recording move then builds the edit from that data.
//
// A recording a crash or a quit left behind (recording.json still says "recording") is finished
// the next time kino starts a recording or lists them: the video is fragmented every 2 s, so all
// but the last moments play.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactRecording } from "../../engine/recording.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = path.join(ROOT, "backend", "recorder", "kino-recorder.swift");
export const RECORD_STEPS = Object.freeze(["start", "mark", "pause", "resume", "stop", "status", "windows", "displays", "permissions"]);
// Fields start passes to the helper (kino-recorder schema has their meanings).
const START_FIELDS = ["target", "fps", "size", "codec", "audio", "mic", "keys", "caret", "maxSeconds", "idleSeconds", "excludeApps"];

/**
 * The kino-recorder helper, or null off macOS. KINO_RECORDER_HELPER names one; then the Mac
 * app's bundled one; then one built by npm run desktop:tools; else, on a Mac with the Swift
 * compiler, kino builds it from the source once into the temporary folder (named by its hash).
 */
export async function recorderHelperPath({ build = true } = {}) {
  const candidates = [
    process.env.KINO_RECORDER_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, "bin", "kino-recorder"),
    path.join(ROOT, ".local", "macos-tools", "dist", "bin", "kino-recorder"),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (found || !build || process.platform !== "darwin" || !existsSync(SOURCE)) return found ?? null;
  return buildFromSource();
}

let building = null;
function buildFromSource() {
  building ??= (async () => {
    if (spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0) return null;
    const hash = createHash("sha256").update(await readFile(SOURCE)).digest("hex").slice(0, 16);
    const folder = path.join(os.tmpdir(), `kino-recorder-helper-${hash}`);
    const binary = path.join(folder, "kino-recorder");
    if (existsSync(binary)) return binary;
    await mkdir(folder, { recursive: true });
    const partial = `${binary}.${process.pid}`;
    const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
    const made = await new Promise((resolve) => spawn("xcrun", ["swiftc", "-O", "-target", target, SOURCE, "-o", partial], { stdio: "ignore" }).once("close", resolve));
    if (made !== 0) return null;
    await chmod(partial, 0o755);
    await rename(partial, binary);
    return binary;
  })();
  return building;
}

/** The helper in serve mode: call(method, params) resolves to its result or rejects with its error. */
export function helperProcess(helper, { onEvent } = {}) {
  const child = spawn(helper, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let next = 1, pending = "", stderr = "", closed = false;
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.event === "ready") { resolve(); continue; }
        if (message.event) { onEvent?.(message); continue; }
        const entry = waiting.get(message.id);
        if (!entry) continue;
        waiting.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else entry.resolve(message.result);
      }
    });
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", () => {});
  child.once("close", (code) => {
    closed = true;
    const why = stderr.trim().split("\n").at(-1) || `the recorder stopped (exit ${code})`;
    for (const entry of waiting.values()) entry.reject(new Error(why));
    waiting.clear();
    onEvent?.({ event: "exit", code });
  });
  return {
    get closed() { return closed; },
    async call(method, params = {}) {
      await ready;
      if (closed) throw new Error("The recorder is not running.");
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    // Closing stdin makes the helper finish a running recording and quit.
    end() { if (!closed) child.stdin.end(); },
  };
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

/** recording.json and the events of a recording folder; a cut-off last line is skipped. */
export async function readRecordingFolder(folder) {
  const meta = await readJson(path.join(folder, "recording.json"));
  if (!meta) throw new Error(`${folder} has no recording.json.`);
  let text = "";
  try { text = await readFile(path.join(folder, "events.jsonl"), "utf8"); } catch { /* no events yet */ }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* the line being written when it stopped */ }
  }
  return { meta, events };
}

const seconds = (value) => `${Math.round(value * 10) / 10} s`;

/**
 * The recorder the agent service uses (deps.recorder). addMedia(file, {name, mime, extra}) adds a
 * made file to the media library (backend/index.mjs addGeneratedMedia); onChange(state) tells
 * the dashboard (null when nothing records).
 */
export function createRecorder({ dataRoot, mediaRoot, addMedia, onChange = () => {}, helperPath = recorderHelperPath }) {
  const folderRoot = path.join(dataRoot, "recordings");
  let helper = null;
  let active = null; // {id, folder, name, project, startedAt}
  let finishing = null;
  let recovered = false;
  // The last recording a stop rule finished, answered to the stop or status that comes after.
  let lastDone = null;

  async function connect() {
    if (helper && !helper.closed) return helper;
    if (process.platform !== "darwin" && helperPath === recorderHelperPath && !process.env.KINO_RECORDER_HELPER) throw new Error("Screen recording is only on macOS.");
    const binary = await helperPath();
    if (!binary) throw new Error("The kino-recorder helper is not built: install the Xcode command line tools (xcode-select --install), or run npm run desktop:tools.");
    helper = helperProcess(binary, {
      onEvent(message) {
        if (message.event === "stopped" && active) finish(message.summary).catch(() => {});
        if (message.event === "exit" && active) finish({ state: "stopped", stopped: "error", error: "the recorder stopped" }).catch(() => {});
      },
    });
    return helper;
  }

  // Adds a finished folder to the media library and deletes the folder.
  async function keep(folder, { name, summary = {} } = {}) {
    const { meta, events } = await readRecordingFolder(folder);
    const file = path.join(folder, meta.video?.file ?? "screen.mp4");
    if (!existsSync(file)) throw new Error("The recording has no video.");
    const compact = compactRecording(meta, events);
    const clicks = compact.clicks.length, marks = compact.marks.map(([t, label]) => ({ t, label }));
    const record = await addMedia(file, { name: `${name ?? "Screen recording"}.mp4`, mime: "video/mp4",
      extra: { recording: { seconds: compact.duration, frame: compact.frame, clicks, keys: compact.keys.length, marks: marks.length, stopped: meta.stopped ?? summary.stopped ?? null } } });
    await writeFile(path.join(mediaRoot, `${record.id}.recording.json`), JSON.stringify(compact));
    await rm(folder, { recursive: true, force: true });
    return { record, compact, marks, stopped: meta.stopped ?? summary.stopped ?? null, error: meta.error ?? summary.error ?? null };
  }

  function finish(summary) {
    finishing ??= (async () => {
      const current = active;
      try {
        if (!current) return null;
        const kept = await keep(current.folder, { name: current.name, summary });
        lastDone = { ...kept, id: current.id, project: current.project };
        return lastDone;
      } finally {
        active = null;
        finishing = null;
        onChange(null);
      }
    })();
    return finishing;
  }

  // Folders a crash left behind: the helper rewrites recording.json on stop, so "recording"
  // there means it never finished.
  async function recover() {
    if (recovered) return [];
    recovered = true;
    let names = [];
    try { names = await readdir(folderRoot); } catch { return []; }
    const kept = [];
    for (const name of names.filter((entry) => entry.endsWith(".kinorec"))) {
      const folder = path.join(folderRoot, name);
      if (active?.folder === folder) continue;
      const meta = await readJson(path.join(folder, "recording.json"));
      if (!meta || !existsSync(path.join(folder, "screen.mp4"))) { await rm(folder, { recursive: true, force: true }); continue; }
      if (meta.state === "recording") {
        const { events } = await readRecordingFolder(folder);
        meta.state = "recovered";
        meta.stopped = "error";
        meta.duration = Math.max(meta.duration ?? 0, ...events.map((event) => event.t ?? 0));
        await writeFile(path.join(folder, "recording.json"), JSON.stringify(meta));
      }
      try { kept.push((await keep(folder, { name: "Recovered screen recording" })).record); } catch { /* an empty video: left for the person */ }
    }
    return kept;
  }

  function describeTarget(target = {}) {
    if (target.kind === "window") return `the ${target.app || "app"} window`;
    if (target.kind === "area") return "an area of the screen";
    return `display ${target.displayId ?? ""}`.trim();
  }

  async function step(options = {}, { project } = {}) {
    const name = options.step ?? "status";
    if (!RECORD_STEPS.includes(name)) throw new Error(`step is one of ${RECORD_STEPS.join(", ")}.`);
    if (name === "permissions") {
      const found = await (await connect()).call("permissions");
      const words = { screen: "Screen Recording", inputMonitoring: "Input Monitoring (tells an agent's clicks from a person's; keys)", accessibility: "Accessibility (the text caret)" };
      return { ...found, text: Object.entries(words).map(([key, label]) => `${found[key] ? "yes" : "no "} ${label}`).join("\n") };
    }
    if (name === "displays") {
      const found = await (await connect()).call("displays");
      return { ...found, text: found.displays.map((display) => `display ${display.id}${display.main ? " (main)" : ""}: ${display.width}×${display.height} pt at ${display.scale}x, ${display.fps} Hz`).join("\n") };
    }
    if (name === "windows") {
      const found = await (await connect()).call("windows", { ...(options.app ? { app: String(options.app) } : {}), ...(options.all ? { all: true } : {}) });
      const lines = found.windows.map((window) => `${window.id}: ${window.app}${window.title ? ` "${window.title}"` : ""} ${Math.round(window.width)}×${Math.round(window.height)} pt${window.onScreen ? "" : " (hidden)"}`);
      return { ...found, text: lines.length ? `${lines.join("\n")}\nrecord one with options:{step:"start", target:{window:<id>}} or target:{app:"<name>"}` : "no windows to record" };
    }
    if (name === "start") {
      if (active) throw new Error(`A recording is already running (${active.id}); stop it first: project {action:"record", options:{step:"stop"}}.`);
      const found = await recover();
      const recorder = await connect();
      const permissions = await recorder.call("permissions");
      if (!permissions.screen) {
        await recorder.call("requestPermissions", { permissions: ["screen"] });
        throw Object.assign(new Error("kino needs Screen Recording permission. macOS has asked the person: System Settings > Privacy & Security > Screen Recording, turn kino on (macOS may ask to reopen kino), then start again."), { code: "permission" });
      }
      const id = `rec-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
      await mkdir(folderRoot, { recursive: true });
      const folder = path.join(folderRoot, `${id}.kinorec`);
      const params = { folder };
      for (const key of START_FIELDS) if (options[key] !== undefined) params[key] = options[key];
      if (options.keys !== undefined && options.keys !== "off" && !permissions.inputMonitoring && !permissions.accessibility)
        await recorder.call("requestPermissions", { permissions: ["inputMonitoring"] });
      const status = await recorder.call("start", params);
      active = { id, folder, name: String(options.name ?? id).slice(0, 120), project, startedAt: Date.now() };
      onChange({ id, target: status.target, startedAt: active.startedAt, project });
      const missing = status.events === "polling" ? " Clicks are seen without telling an agent's from a person's (no Input Monitoring permission)." : "";
      const rules = [`stops itself after ${seconds(params.maxSeconds ?? 600)}`, ...(params.idleSeconds ? [`or ${seconds(params.idleSeconds)} without input`] : [])].join(" ");
      return { ...status, id, recovered: found.length,
        text: `recording ${id}: ${describeTarget(status.target)} (${rules}).${missing} Mark each step with project {action:"record", options:{step:"mark", label:"<what happens>"}}; stop with options:{step:"stop"}.` };
    }
    if (!active && finishing) await finishing;
    if (!active && (name === "stop" || name === "status") && lastDone) {
      const done = lastDone;
      lastDone = null;
      return describeDone(done);
    }
    if (name === "status" && !active) return { state: "idle", text: "nothing is recording" };
    if (!active) throw new Error("Nothing is recording; start with project {action:\"record\", options:{step:\"start\"}}.");
    const recorder = await connect();
    if (name === "mark") {
      const label = String(options.label ?? "").trim();
      if (!label) throw new Error("mark needs label: a few words for what happens now (\"open Export\").");
      const mark = await recorder.call("mark", { label });
      return { ...mark, text: `mark "${mark.label}" at ${seconds(mark.t ?? 0)}: a cue and a zoom target` };
    }
    if (name === "pause" || name === "resume") {
      const answer = await recorder.call(name);
      return { ...answer, text: name === "pause" ? "paused: this part is cut out of the video; resume with options:{step:\"resume\"}" : "recording again" };
    }
    if (name === "status") {
      const status = await recorder.call("status");
      return { ...status, text: `${status.state} ${seconds(status.seconds ?? 0)}: ${status.clicks ?? 0} clicks, ${status.marks ?? 0} marks` };
    }
    // stop
    const summary = await recorder.call("stop", { reason: options.by === "person" ? "person" : "agent" });
    const done = await finish(summary);
    // A person's stop is told to the agent at its next status or stop.
    if (options.by !== "person") lastDone = null;
    return describeDone(done);
  }

  function describeDone(done) {
    if (!done) return { state: "idle", text: "nothing was recording" };
    const { record, compact, marks, stopped, error } = done;
    const why = { agent: "stopped", person: "stopped by the person", maxSeconds: "reached its time limit", idle: "stopped after no input", windowClosed: "stopped when the window closed", error: "stopped by an error" }[stopped] ?? "stopped";
    return {
      id: done.id, src: record.src, mediaId: record.id, seconds: compact.duration, frame: compact.frame, clicks: compact.clicks.length, keys: compact.keys.length, marks,
      ...(error ? { error } : {}),
      text: `recording ${done.id} ${why}: ${seconds(compact.duration)}, ${compact.frame[0]}×${compact.frame[1]} pt, ${compact.clicks.length} clicks, ${marks.length} marks${error ? ` (${error})` : ""}; src ${record.src}. Add it as a video layer, then {op:"move", name:"screen-recording", layer} adds the pointer, clicks and zooms (library guide recording).`,
    };
  }

  return {
    step,
    recover,
    // The dashboard's Stop button.
    // The dashboard's Stop button: the agent's next status or stop answers what was kept.
    async stopByPerson() { return active ? step({ step: "stop", by: "person" }) : null; },
    active: () => (active ? { id: active.id, startedAt: active.startedAt, project: active.project } : null),
    // kino is quitting: closing the helper's stdin makes it finish the files; kino keeps the
    // recording when the helper says it stopped (at most 5 s).
    async close() {
      if (!active) { helper?.end(); return; }
      const kept = new Promise((resolve) => { const check = setInterval(() => { if (!active) { clearInterval(check); resolve(); } }, 50); setTimeout(() => { clearInterval(check); resolve(); }, 5000); });
      helper?.end();
      await kept;
    },
  };
}

/** The compact recording kept next to a library video, or null when it has none. */
export async function recordingFor(mediaRoot, mediaId) {
  return readJson(path.join(mediaRoot, `${mediaId}.recording.json`));
}
