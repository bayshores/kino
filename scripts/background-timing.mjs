// Hand-run timing (not part of npm test): how long importing a long clip takes on a private
// kino server, alone and while an Inspire search's results are measured in the background
// (render-activity.mjs: background steps wait for agent calls). One YouTube search per run.
//
//   node scripts/background-timing.mjs --clip <file.mp4> [--search "<words>"] [--settle 20] [--offline <ref.mp4>]
//
// --offline: yt-dlp is the tests' stub (tests/fixtures/inspire/stub-yt-dlp.mjs), which answers
// the search from a recording and "downloads" <ref.mp4> for every result: nothing goes online.
// Without --search it times the import on a quiet server. With it, the search runs first, kino
// downloads and measures its results, and the import starts --settle seconds later. It prints the
// import's seconds and what Inspire's queue is doing before and after. The data folder is a new
// temporary one, deleted at the end; the clip is only read.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback = null) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const clip = option("clip");
const search = option("search");
const settle = Number(option("settle", "20"));
const offline = option("offline");
const stub = offline ? { KINO_YTDLP: path.join(root, "tests/fixtures/inspire/stub-yt-dlp.mjs"), STUB_YTDLP_VIDEO: path.resolve(offline) } : {};
if (!clip) throw new Error("Give --clip <file>.");

const data = await mkdtemp(path.join(tmpdir(), "kino-timing-"));
const server = spawn(process.execPath, [path.join(root, "backend/index.mjs")], {
  env: { ...process.env, MOTION_DATA_DIR: data, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "0", KINO_INSPIRE_THUMBS: "off", KINO_PREVIEW_CACHE: "off", ...stub },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stderr.on("data", (chunk) => { log = (log + chunk).slice(-4000); });
const url = await new Promise((resolve, reject) => {
  let out = "";
  server.stdout.on("data", (chunk) => { out += chunk; const found = out.match(/kino service: (http:\/\/\S+)/); if (found) resolve(found[1]); });
  server.once("exit", (code) => reject(new Error(`The server stopped (${code}): ${log}`)));
});

function kino(...words) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bin/kino.mjs"), ...words], { env: { ...process.env, MOTION_API_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("exit", () => resolve({ text, seconds: (Date.now() - started) / 1000 }));
  });
}
const queueLine = async () => {
  const lines = (await kino("library", "topic=inspire")).text.split("\n");
  return lines.find((line) => /measuring|waiting/i.test(line)) ?? lines.slice(0, 3).join(" | ").slice(0, 300);
};
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

try {
  await kino("project", "create", "id=timing", "name=timing", "width=1920", "height=1080", "duration=30");
  if (search) {
    const found = await kino("library", "topic=inspire", `search=${search}`);
    console.log(`search answered in ${found.seconds.toFixed(1)} s`);
    await sleep(settle);
    console.log(`before the import: ${await queueLine()}`);
  }
  const imported = await kino("project", "import", path.resolve(clip));
  console.log(`import: ${imported.seconds.toFixed(1)} s (${imported.text.split("\n")[0].slice(0, 120)})`);
  if (search) console.log(`after the import: ${await queueLine()}`);
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(data, { recursive: true, force: true });
}
