// The render preview chat apps can show beside a tool answer (MCP Apps). The render tool names a
// ui:// page (PREVIEW_URI); a chat app that supports MCP Apps loads that page in a sandboxed
// frame and hands it the tool's answer. The agent's text stays the same: the answer's _meta gets
// only a few facts and a preview id. The page then calls the app-only tool PREVIEW_TOOL with
// that id for the video (the MCP Apps guidance: heavy assets go through a tool the page calls,
// not the result). Chat apps without MCP Apps (and command-line agents) get neither.
//
// The page cannot reach the network or this computer, so every byte it plays arrives through
// that tool: a small copy of the render (320 px, at most PREVIEW_MAX_CHARS as base64), never the file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
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
 * The most the preview video's answer may be, in characters. Chat apps cut a tool answer at
 * about 150,000 characters; the MCP Apps guidance says to stay near 130,000.
 */
export const PREVIEW_MAX_CHARS = 130_000;
// What the video may take of that: base64 makes 3 bytes into 4 characters, with room to spare.
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
 * Adds the preview's facts to a finished render's answer when the chat app shows MCP Apps
 * pages: { name, duration, bytes, link, id }, a few hundred characters. The video itself is not
 * in the answer: the page asks PREVIEW_TOOL for it by id. The answer's content (what the agent
 * reads) is never changed. A render with no video file is left as it is.
 */
export async function withRenderPreview(server, reply, result) {
  if (result.isError || !clientShowsApps(server)) return result;
  const preview = await renderPreview(reply?.data).catch(() => null);
  return preview ? { ...result, _meta: { ...result._meta, [PREVIEW_META_KEY]: preview } } : result;
}

// The renders this process finished and told a chat app about, by preview id. An id is a random
// word kino made, never a path: PREVIEW_TOOL refuses any other. The oldest is forgotten first.
const PREVIEWS_KEPT = 20;
const previews = new Map();

/** { name, duration, bytes, link, id } for a done render's first video file, or null. */
export async function renderPreview(data) {
  if (data?.status !== "done") return null;
  const file = data.path ?? data.files?.[0]?.path;
  if (typeof file !== "string" || !VIDEO_KINDS[path.extname(file).toLowerCase()]) return null;
  const { probeMedia } = await import("../media-probe.mjs");
  const facts = await probeMedia(file);
  if (!facts.hasVideo || !(facts.duration > 0)) return null;
  const id = randomBytes(6).toString("hex");
  previews.set(id, { file, duration: facts.duration, hasAudio: facts.hasAudio, video: null });
  if (previews.size > PREVIEWS_KEPT) previews.delete(previews.keys().next().value);
  const bytes = data.size ?? data.files?.[0]?.size ?? (await stat(file)).size;
  return { name: path.basename(file), duration: Math.round(facts.duration * 100) / 100, bytes, link: APP_LINK, id };
}

/**
 * The small copy for a preview id, as a data: address of at most PREVIEW_MAX_CHARS, made the
 * first time it is asked for and kept for the next. Throws for an id kino did not give out.
 */
export async function previewVideo(id, { encode = encodePreview } = {}) {
  const entry = typeof id === "string" ? previews.get(id) : undefined;
  if (!entry) throw new Error("Unknown preview id: ask for the preview of a render this kino finished.");
  entry.video ??= encode(entry.file, { duration: entry.duration, hasAudio: entry.hasAudio, maxBytes: VIDEO_MAX_BYTES })
    .then((video) => (video && video.length <= VIDEO_MAX_BYTES ? `data:video/mp4;base64,${video.toString("base64")}` : null));
  const video = await entry.video.catch(() => null);
  if (!video) { entry.video = null; throw new Error("The preview copy could not be made."); }
  return video;
}

/** The helper tool the preview page calls for the video; the model never sees it. */
export const PREVIEW_TOOL = "render_preview";

/**
 * Registers PREVIEW_TOOL once the client has said what it can do, and only for a chat app that
 * shows MCP Apps pages (the MCP Apps library's own pattern: register in oninitialized). Every
 * other client keeps the ten tools, byte for byte, and a call to it answers "not found".
 * Registering after the start sends tools/list_changed (McpServer.registerTool).
 */
export function registerPreviewTool(server) {
  const before = server.server.oninitialized;
  let registered = false;
  server.server.oninitialized = () => {
    before?.();
    if (registered || !clientShowsApps(server)) return;
    registered = true;
    server.registerTool(PREVIEW_TOOL, {
      title: "Preview video",
      description: "The kino preview page's video for a render, by preview id.",
      inputSchema: { id: z.string().max(32) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PREVIEW_URI, visibility: ["app"] } },
    }, async ({ id }) => {
      try {
        return { content: [{ type: "text", text: await previewVideo(id) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    });
  };
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
