#!/usr/bin/env node
// Hand-run proof (not part of npm test): which steps an agent that only follows `next:` walks
// through, from a new project with a one-line ask and 2 small clips, with someone at the kino app
// and without. It starts its own kino server on a new temporary folder (removed afterwards),
// reads status, sends status's `next:` call as written (angle-bracket placeholders filled with
// fixed simple values), and prints each step and the call's verb.
//
// No web requests: a call that would search the web (inspire, soundtrack, footage) is not sent.
// For the references the script sends the skip the order_needed refusal names instead
// (waive_check reference) and says so; at the song finder the run stops.
//
//   node scripts/next-path.mjs            both runs (app off, then app on)
//   node scripts/next-path.mjs on         only the run with the app signal on
//
// It makes its clips with FFmpeg, one at a time: run it only when `pgrep -x ffmpeg` prints nothing.
import { execFileSync, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentClient } from "../backend/agent/client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASK = "make a ~40 s launch trailer for our street photo app from these clips";
const MOST_STEPS = 30;

function startServer(dataDir) {
  const env = { ...process.env, MOTION_DATA_DIR: dataDir, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "0", KINO_SONG_SEARCH: "0", KINO_VOICE_DOWNLOAD: "0" };
  for (const key of ["KINO_PUBLIC_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_DESKTOP", "MOTION_API_URL"]) delete env[key];
  const child = fork(path.join(root, "backend/index.mjs"), [], { env, cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("kino did not start in 60 s")), 60_000);
    child.on("message", (message) => {
      if (message?.type !== "kino-ready") return;
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${message.port}` });
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`kino exited (${code})`)); });
  });
}

// Fixed simple values for the placeholders; numbered words keep 5 treatments apart.
function filler(files) {
  let count = 0;
  const word = (inside) => {
    if (/from the chat|must say|their message/.test(inside)) return ASK;
    if (/their words|the subject/.test(inside)) return "street photo app";
    if (/title> by <artist|^title$/.test(inside)) return "Test Song by Test Band";
    if (/^family$|^font/.test(inside)) return "Inter";
    if (/project file/.test(inside)) return files[0];
    if (/A, B or C/.test(inside)) return "A";
    if (/their reply/.test(inside)) return "your call";
    count += 1;
    return `${inside.split(/[:,(]/)[0].replace(/[^a-z ]/gi, "").trim().split(" ").slice(0, 2).join(" ") || "word"} ${count}`;
  };
  const fill = (value) => {
    if (typeof value === "string") {
      const whole = /^<([^<>]*)>$/.exec(value);
      if (whole && /0 to 1/.test(whole[1])) return 0.5;
      if (whole && /^px$|index/.test(whole[1])) return /px/.test(whole[1]) ? 64 : 0;
      return value.replace(/<([^<>]*)>/g, (_, inside) => word(inside));
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
    return value;
  };
  return fill;
}

// The status answer's step words and its `next:` call ({tool, input}).
function readStatus(text) {
  const lines = text.split("\n");
  const nextLine = lines.findLast((line) => line.startsWith("next: "));
  const step = lines.find((line) => /^(step|next step|→)/i.test(line.trim())) ?? lines.find((line) => line.startsWith("direction:")) ?? "";
  const raw = nextLine?.slice(6).trim() ?? "";
  const at = raw.indexOf(" ");
  let call = null;
  try { call = at > 0 ? { tool: raw.slice(0, at), input: JSON.parse(raw.slice(at + 1)) } : raw ? { tool: raw, input: {} } : null; } catch { call = null; }
  return { step: step.trim(), call, raw };
}

const reachesWeb = (call) => call?.tool === "library" && ["inspire", "soundtrack", "footage"].includes(call.input?.topic)
  || (call?.tool === "look" && call.input?.mode === "reference");

async function run(appOn, clips) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kino-next-path-"));
  const server = await startServer(dataDir);
  const client = createAgentClient({ url: server.url, ownerToken: null, source: "script" }, { name: "script" });
  // The app's own read: a same-origin request from its window (dashboard-routes.mjs fromAppWindow).
  const appRead = () => fetch(`${server.url}/api/dashboard/snapshot`, { headers: { "sec-fetch-site": "same-origin", origin: server.url } }).then((response) => response.text());
  const steps = [];
  try {
    await client.call("project", { action: "create", name: "next path", why: "proof", next: "import" });
    const names = [];
    for (const clip of clips) { const media = await client.importFile(clip); names.push(media?.media?.name ?? media?.name ?? path.basename(clip)); }
    const fill = filler(names);
    let last = "";
    let repeats = 0;
    for (let index = 0; index < MOST_STEPS; index += 1) {
      if (appOn) await appRead();
      const status = await client.call("status", {});
      const { step, call, raw } = readStatus(status.text);
      if (!call) { steps.push({ step, verb: "(no next call)", raw }); break; }
      const verb = `${call.tool} ${call.input?.action ?? call.input?.topic ?? call.input?.mode ?? (call.input?.ops ? call.input.ops.map((op) => op.op).join("+") : "")}`.trim();
      repeats = raw === last ? repeats + 1 : 0;
      last = raw;
      if (repeats >= 2) { steps.push({ step, verb, note: "the same call a third time: stopped" }); break; }
      if (reachesWeb(call)) {
        if (call.input?.topic === "soundtrack" || call.input?.topic === "footage") { steps.push({ step, verb, note: `not sent (web): ${raw.slice(0, 160)}` }); break; }
        steps.push({ step, verb, note: "not sent (web); sent the refusal's skip: edit waive_check reference" });
        await client.call("edit", { ops: [{ op: "waive_check", code: "reference", target: "*", reason: "offline proof script: no web search" }] });
        continue;
      }
      const sent = await client.call(call.tool, fill(call.input ?? {}));
      const entry = { step, verb };
      if (call.tool === "notes" && call.input?.action === "try") {
        entry.note = `answer: ${sent.text.split("\n").slice(0, 3).join(" | ").slice(0, 400)}`;
        steps.push(entry);
        break;
      }
      if (sent.isError) entry.note = `refused: ${sent.text.split("\n")[0].slice(0, 200)}`;
      steps.push(entry);
    }
  } finally {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => server.child.once("exit", resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
  return steps;
}

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), "kino-next-path-clips-"));
  try {
    const clips = ["street.mp4", "desk.mp4"].map((name) => path.join(work, name));
    // One FFmpeg at a time: two 3 s test pictures with a tone.
    for (const [index, clip] of clips.entries())
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=3`, "-f", "lavfi", "-i", `sine=frequency=${300 + index * 200}:duration=3`,
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
    const which = process.argv[2];
    for (const appOn of which === "on" ? [true] : which === "off" ? [false] : [false, true]) {
      const steps = await run(appOn, clips);
      console.log(`\napp signal ${appOn ? "ON" : "OFF"}:`);
      for (const [index, entry] of steps.entries()) console.log(`${String(index + 1).padStart(2)}. ${entry.step || "(no step line)"}  ->  ${entry.verb}${entry.note ? `  [${entry.note}]` : ""}`);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error.stack ?? error.message); process.exit(1); });
