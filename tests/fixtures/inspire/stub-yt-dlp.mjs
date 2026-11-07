#!/usr/bin/env node
// A stand-in for yt-dlp in the tests (backend/inspire.test.mjs): it never goes online.
//   search (ytsearchN:…)       prints the recorded search beside this file, N results at most
//   Shorts search (youtube.com/results?…)  prints the recorded Shorts search, --playlist-end at most
//   download (--download-sections)  copies STUB_YTDLP_VIDEO (a file, or one from a folder) to the -o path
//   one video's description (--skip-download --dump-json <link>)  prints it as one JSON line
// Every run appends its arguments, one JSON list a line, to STUB_YTDLP_LOG when that is set.
// STUB_YTDLP_FAIL=search|shorts|lookup|download|bot makes that step fail as yt-dlp does (an ERROR line, exit 1);
// bot is YouTube's "Sign in to confirm you're not a bot".
import { appendFileSync, copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (process.env.STUB_YTDLP_LOG) appendFileSync(process.env.STUB_YTDLP_LOG, `${JSON.stringify(args)}\n`);
const target = args.at(-1) ?? "";
const fail = process.env.STUB_YTDLP_FAIL;

if (target.startsWith("ytsearch")) {
  if (fail === "search") { process.stderr.write("ERROR: Unable to download API page: HTTP Error 429\n"); process.exit(1); }
  const count = Number(/^ytsearch(\d+):/.exec(target)?.[1] ?? 1);
  // STUB_YTDLP_LONG: only the results over a minute long.
  const lines = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "ytsearch-fast-cut-walking-edit.jsonl"), "utf8").trim().split("\n")
    .filter((line) => !process.env.STUB_YTDLP_LONG || JSON.parse(line).duration > 60);
  // STUB_YTDLP_SLOW_QUERY: that one query answers after a minute (a search still running).
  const slow = process.env.STUB_YTDLP_SLOW_QUERY && target.endsWith(`:${process.env.STUB_YTDLP_SLOW_QUERY}`);
  setTimeout(() => process.stdout.write(`${lines.slice(0, count).join("\n")}\n`), slow ? 60_000 : 0);
} else if (target.startsWith("https://www.youtube.com/results?")) {
  // YouTube's search page with the Shorts filter: the recorded Shorts, --playlist-end of them at most.
  if (fail === "shorts") { process.stderr.write("ERROR: Unable to download API page: HTTP Error 429\n"); process.exit(1); }
  const end = args.includes("--playlist-end") ? Number(args[args.indexOf("--playlist-end") + 1]) : Infinity;
  const lines = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "shorts-app-launch-animation.jsonl"), "utf8").trim().split("\n");
  process.stdout.write(`${lines.slice(0, end).join("\n")}\n`);
} else if (args.includes("--skip-download")) {
  // One video's description (a link the person gave): the recorded search's line for that id when
  // it has one, else a made-up public video. A full description's url is the file's own address.
  if (fail === "lookup") { process.stderr.write("ERROR: [youtube] Video unavailable. This video is private\n"); process.exit(1); }
  const id = /v=([\w-]{11})/.exec(target)?.[1] ?? "";
  const lines = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "ytsearch-fast-cut-walking-edit.jsonl"), "utf8").trim().split("\n");
  const recorded = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === id);
  const entry = recorded ?? { id, title: `Stub video ${id}`, channel: "Stub channel", duration: 57, thumbnails: [] };
  process.stdout.write(`${JSON.stringify({ ...entry, _type: "video", live_status: "not_live", url: "https://rr1---sn-stub.googlevideo.com/videoplayback?id=stub" })}\n`);
} else if (args.includes("--download-sections")) {
  if (fail === "download") { process.stderr.write("ERROR: [youtube] Video unavailable\n"); process.exit(1); }
  if (fail === "bot") { process.stderr.write("ERROR: [youtube] tgEWNHVbk3U: Sign in to confirm you’re not a bot. This helps protect our community.\n"); process.exit(1); }
  const out = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4");
  const delay = Number(process.env.STUB_YTDLP_DELAY_MS ?? 0);
  // STUB_YTDLP_VIDEO may be a folder of .mp4 files: each video id gets one of them.
  let video = process.env.STUB_YTDLP_VIDEO;
  if (statSync(video).isDirectory()) {
    const files = readdirSync(video).filter((name) => name.endsWith(".mp4")).sort();
    const id = /v=([\w-]{11})/.exec(target)?.[1] ?? "";
    video = path.join(video, files[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % files.length]);
  }
  setTimeout(() => copyFileSync(video, out), delay);
} else {
  process.stderr.write(`ERROR: the stub does not know ${target}\n`);
  process.exit(2);
}
