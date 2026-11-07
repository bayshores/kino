// A stand-in for the kino-recorder helper, for tests only. It speaks the helper's serve protocol
// (backend/recorder/kino-recorder.swift: JSON lines, the same methods and folder format) but
// records nothing: start writes a scripted pointer (a slide to 200, 120 and a click there at
// 0.8 s on a 320 × 200 point "display"), mark adds marks, and stop makes a 4 s blue video with
// FFmpeg. Tests set KINO_RECORDER_HELPER to it so the whole record path (the helper, the media
// library, the agent tool, the screen-recording move and the render) runs on Linux CI.
// Environment: KINO_STAND_IN_NO_SCREEN=1 answers that Screen Recording is not allowed.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const FFMPEG = process.env.KINO_FFMPEG || "ffmpeg";
const FRAME = { width: 320, height: 200 };
const SECONDS = 4;
let recording = null;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function start(params) {
  if (recording) throw { code: "state", message: "A recording is already running; stop it first." };
  mkdirSync(params.folder);
  recording = { folder: params.folder, startedAt: Date.now(), target: { kind: "display", displayId: 1, codec: "h264", fps: 30 }, sound: Boolean(params.audio && params.mic) };
  const events = [];
  for (let t = 0; t <= 0.6001; t += 1 / 30) events.push({ t: Math.round(t * 1000) / 1000, type: "move", x: Math.round(40 + 160 * (t / 0.6)), y: Math.round(40 + 80 * (t / 0.6)), cursor: "c1" });
  events.push({ t: 0.8, type: "down", x: 200, y: 120, button: "left", clicks: 1, source: "agent" }, { t: 0.88, type: "up", x: 200, y: 120, button: "left", source: "agent" });
  writeFileSync(path.join(params.folder, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  meta("recording");
  return status();
}

function meta(state, stopped) {
  writeFileSync(path.join(recording.folder, "recording.json"), JSON.stringify({
    version: 1, state, startedAt: recording.startedAt, duration: state === "recording" ? 0 : SECONDS, target: recording.target,
    frame: FRAME, scale: 1, video: { file: "screen.mp4", width: FRAME.width, height: FRAME.height, fps: 30, codec: "h264" },
    audio: { system: false, mic: false }, keys: "off", pauses: [], cursors: { c1: { hotspot: [4, 4], size: [17, 23], shape: "arrow" } },
    ...(stopped ? { stopped } : {}),
  }));
}

function status() {
  return { state: recording ? "recording" : "idle", folder: recording?.folder, seconds: 0, target: recording?.target ?? {}, clicks: 1, keys: 0, marks: 0, events: "tap" };
}

function stop(reason) {
  if (!recording) throw { code: "state", message: "Nothing is recording." };
  // With audio and mic, two sound tracks (the computer's and the microphone's), as the helper writes.
  const sound = recording.sound ? ["-f", "lavfi", "-i", `sine=f=440:d=${SECONDS}`, "-f", "lavfi", "-i", `sine=f=660:d=${SECONDS}`, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:a", "aac"] : [];
  const made = spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x3366cc:s=${FRAME.width}x${FRAME.height}:r=30:d=${SECONDS}`,
    ...sound, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(recording.folder, "screen.mp4")]);
  if (made.status !== 0) throw { code: "encoder", message: String(made.stderr).trim() || "ffmpeg failed" };
  meta("finished", reason);
  const summary = { ...status(), state: "stopped", stopped: reason, seconds: SECONDS };
  recording = null;
  return summary;
}

const methods = {
  version: () => ({ version: "kino-recorder stand-in 1" }),
  permissions: () => ({ screen: process.env.KINO_STAND_IN_NO_SCREEN !== "1", accessibility: true, inputMonitoring: true }),
  requestPermissions: () => methods.permissions(),
  displays: () => ({ displays: [{ id: 1, x: 0, y: 0, ...FRAME, scale: 1, main: true, fps: 30 }] }),
  windows: () => ({ windows: [{ id: 7, app: "Notes", bundleId: "com.example.notes", title: "Plan", x: 10, y: 10, width: 200, height: 120, onScreen: true }] }),
  start,
  status,
  mark: ({ label }) => {
    if (!recording) throw { code: "state", message: "Marks are kept while recording." };
    const t = Math.min(SECONDS - 0.5, (Date.now() - recording.startedAt) / 1000);
    appendFileSync(path.join(recording.folder, "events.jsonl"), `${JSON.stringify({ t, type: "mark", label })}\n`);
    return { t, label };
  },
  pause: () => ({ state: "paused" }),
  resume: () => ({ state: "recording" }),
  stop: ({ reason }) => stop(reason ?? "agent"),
};

if (process.argv[2] !== "serve") { console.error("usage: stand-in serve"); process.exit(2); }
write({ event: "ready", version: "kino-recorder stand-in 1" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  try { write({ id: request.id, result: methods[request.method](request.params ?? {}) }); }
  catch (error) { write({ id: request.id, error: { code: error.code ?? "failed", message: error.message ?? String(error) } }); }
}).on("close", () => {
  if (recording) write({ event: "stopped", summary: stop("agent") });
  process.exit(0);
});
