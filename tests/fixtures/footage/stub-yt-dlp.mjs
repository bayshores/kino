#!/usr/bin/env node
// A stand-in for yt-dlp in the footage finder's end-to-end test (backend/footage-finder.test.mjs):
// it never goes online, and serves one generated clip as the found video.
//   search (ytsearchN:...)            prints one usable result and one edit the finder drops
//   one video's description (-j)      prints its length, picture sizes and that it can play
//   download (--download-sections)    cuts each *start-end section of STUB_YTDLP_VIDEO with FFmpeg
//                                     to the -o path (%(section_start)s and %(ext)s filled in)
// Every run appends its arguments, one JSON list a line, to STUB_YTDLP_LOG when that is set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.STUB_YTDLP_LOG) appendFileSync(process.env.STUB_YTDLP_LOG, `${JSON.stringify(args)}\n`);
const target = args.at(-1) ?? "";
const seconds = Number(process.env.STUB_YTDLP_SECONDS ?? 8);
const VIDEO = { id: "stubFight01", title: "Stub Series episode 1 fight scene", channel: "Stub Studio", channel_is_verified: true, channel_follower_count: 120000, duration: seconds, view_count: 50000 };

if (target.startsWith("ytsearch")) {
  const lines = [VIDEO, { id: "stubAmvEdit", title: "Stub Series AMV edit", channel: "Fan", duration: 60, view_count: 900 }];
  process.stdout.write(`${lines.map((line) => JSON.stringify({ ...line, url: `https://www.youtube.com/watch?v=${line.id}` })).join("\n")}\n`);
} else if (args.includes("--skip-download")) {
  process.stdout.write(`${JSON.stringify({ ...VIDEO, live_status: "not_live", availability: "public", formats: [{ vcodec: "avc1", height: 360 }, { vcodec: "avc1", height: 1080 }] })}\n`);
} else if (args.includes("--download-sections")) {
  const out = args[args.indexOf("-o") + 1];
  args.forEach((arg, index) => {
    if (args[index - 1] !== "--download-sections") return;
    const [start, end] = arg.replace(/^\*/, "").split("-").map(Number);
    const file = out.replace("%(section_start)s", String(start)).replace("%(ext)s", "mp4");
    execFileSync(process.env.KINO_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", String(start), "-i", process.env.STUB_YTDLP_VIDEO, "-t", String(end - start),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", file]);
  });
} else {
  process.stderr.write(`ERROR: the stub does not know ${target}\n`);
  process.exit(2);
}
