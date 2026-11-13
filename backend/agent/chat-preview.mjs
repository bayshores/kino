// The render preview chat apps can show beside a tool answer (MCP Apps). The render tool names a
// ui:// page (PREVIEW_URI); a chat app that supports MCP Apps loads that page in a sandboxed
// frame and hands it the tool's answer. The agent's text stays the same: the video rides in the
// answer's _meta, which the model is not shown. Chat apps without MCP Apps (and command-line
// agents) ignore both, and kino skips the encode for them.
//
// The page cannot reach the network or this computer, so every byte it plays arrives in the
// answer: a small copy of the render (320 px, at most PREVIEW_MAX_CHARS as base64), never the file.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";

export const PREVIEW_URI = "ui://kino/preview";
export const PREVIEW_MIME = RESOURCE_MIME_TYPE; // "text/html;profile=mcp-app"
export const PREVIEW_META_KEY = "kino/preview";
/** Bare kino link: brings the kino app forward (desktop/main.mjs), with no file access. */
export const APP_LINK = "kino://open";
/**
 * The most the preview may add to an answer, in characters. Chat apps cut a tool answer at
 * about 150,000 characters; the MCP Apps guidance says to stay near 130,000.
 */
export const PREVIEW_MAX_CHARS = 130_000;
// What the video may take of that: base64 makes 3 bytes into 4 characters, and the name, link
// and numbers beside it take well under 2,000.
const VIDEO_MAX_BYTES = Math.floor(((PREVIEW_MAX_CHARS - 2_000) * 3) / 4);
const VIDEO_KINDS = { ".mp4": true, ".mov": true, ".webm": true, ".gif": true };

const require = createRequire(import.meta.url);
const PAGE_FILE = fileURLToPath(new URL("./chat-preview.html", import.meta.url));
let page = null;

/**
 * The page with the MCP Apps browser library inlined (the sandbox blocks scripts from anywhere
 * else). The library ends in `export{a as App,…}`; that line becomes globalThis.ExtApps={…}.
 */
export function previewPage() {
  if (page) return page;
  const bundle = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8")
    .replace(/export\{([^}]+)\};?\s*$/, (_, body) => `globalThis.ExtApps={${body.split(",").map((pair) => {
      const [local, exported] = pair.split(" as ").map((part) => part.trim());
      return `${exported ?? local}:${local}`;
    }).join(",")}};`);
  // A function as the replacement: the library is full of "$" sequences a string would expand.
  page = readFileSync(PAGE_FILE, "utf8").replace("/*__EXT_APPS_BUNDLE__*/", () => bundle);
  return page;
}

/** Serves the page as the ui:// resource the render tool names. */
export function registerPreviewResource(server) {
  registerAppResource(server, "kino preview", PREVIEW_URI, { description: "Plays a render in the chat" },
    async () => ({ contents: [{ uri: PREVIEW_URI, mimeType: PREVIEW_MIME, text: previewPage() }] }));
}

/** True when the connected chat app said at the start that it shows MCP Apps pages. */
export function clientShowsApps(server) {
  return Boolean(server.server?.getClientCapabilities?.()?.extensions?.[EXTENSION_ID]);
}

/**
 * Adds the preview to a finished render's answer when the chat app shows MCP Apps pages.
 * The answer's content (what the agent reads) is never changed. A preview that cannot be made
 * (no file, no FFmpeg, too big) is left out.
 */
export async function withRenderPreview(server, reply, result, { encode = encodePreview } = {}) {
  if (result.isError || !clientShowsApps(server)) return result;
  const preview = await renderPreview(reply?.data, { encode }).catch(() => null);
  return preview ? { ...result, _meta: { ...result._meta, [PREVIEW_META_KEY]: preview } } : result;
}

/** { name, duration, bytes, link, video } for a done render's first video file, or null. */
export async function renderPreview(data, { encode = encodePreview } = {}) {
  if (data?.status !== "done") return null;
  const file = data.path ?? data.files?.[0]?.path;
  if (typeof file !== "string" || !VIDEO_KINDS[path.extname(file).toLowerCase()]) return null;
  const { probeMedia } = await import("../media-probe.mjs");
  const facts = await probeMedia(file);
  if (!facts.hasVideo || !(facts.duration > 0)) return null;
  const video = await encode(file, { duration: facts.duration, hasAudio: facts.hasAudio, maxBytes: VIDEO_MAX_BYTES });
  if (!video || video.length > VIDEO_MAX_BYTES) return null;
  const bytes = data.size ?? data.files?.[0]?.size ?? (await stat(file)).size;
  const preview = { name: path.basename(file), duration: Math.round(facts.duration * 100) / 100, bytes, link: APP_LINK,
    video: `data:video/mp4;base64,${video.toString("base64")}` };
  return JSON.stringify(preview).length <= PREVIEW_MAX_CHARS ? preview : null;
}

/**
 * A small H.264 copy of a video (longer side 320 px, 12 frames a second, mono sound at 24 kb/s),
 * at most maxBytes. The bit rate is spread over the whole video down to a floor; a video too long
 * for the floor gets its opening stretch. A copy that still comes out too big (the encoder
 * overshoots at low rates) is made again, shorter by the overshoot, up to three FFmpeg runs in
 * all, one after another, in a temporary folder.
 */
export async function encodePreview(file, { duration, hasAudio, maxBytes }) {
  const { runMediaTool } = await import("../media-probe.mjs");
  const folder = await mkdtemp(path.join(os.tmpdir(), "kino-preview-"));
  try {
    const out = path.join(folder, "preview.mp4");
    const audioKbps = hasAudio ? 24 : 0;
    // 85% of the limit for the pictures and sound; the rest for the file's index and overshoot.
    const budgetBits = maxBytes * 8 * 0.85;
    const videoKbps = Math.max(48, Math.floor(budgetBits / duration / 1000) - audioKbps);
    let seconds = Math.min(duration, budgetBits / ((videoKbps + audioKbps) * 1000));
    for (let run = 0; run < 3; run += 1) {
      await runMediaTool("ffmpeg", [
        "-v", "error", "-y", "-i", file, "-t", seconds.toFixed(2),
        "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-ac", "1", "-b:a", `${audioKbps}k`] : ["-an"]),
        "-vf", "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)',fps=12",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
        "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`,
        "-movflags", "+faststart", out,
      ], { timeoutMs: 60_000 });
      const video = await readFile(out);
      if (video.length <= maxBytes) return video;
      seconds *= (maxBytes * 0.9) / video.length;
    }
    return null;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
