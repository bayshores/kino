// The thin client that the MCP tools and the kino command line share. It finds the running
// kino server, sends one verb to POST /api/agent/<verb>, and uploads local files for
// `project import`. All the work happens in the server's agent service (service.mjs).
//
// Where the server is, in this order:
// 1. MOTION_API_URL (with KINO_OWNER_TOKEN when the server needs one), as set by the
//    desktop app's agent launcher or by you;
// 2. kino's own desktop connection file (written by the kino app while it is open);
// 3. the development server at http://127.0.0.1:4781.
// It reads no other application's files.
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readExplicitMediaFile } from "../media-file.mjs";
import { makeWorkingCopy } from "../media-working-copy.mjs";
import { MAX_UPLOAD_BYTES } from "../../engine/schema.js";
import { inlineCaptionFiles } from "./caption-file.mjs";
import { shotsLine } from "../shot-detection.mjs";

export const DEFAULT_URL = "http://127.0.0.1:4781";

/** Where the kino desktop app writes its connection (origin and owner token) while it is open. */
export const runtimeFilePath = (env = process.env) => env.KINO_RUNTIME_FILE || path.join(homedir(), "Library/Application Support/kino/runtime.json");

async function desktopConnection(env) {
  const file = runtimeFilePath(env);
  let info;
  try { info = await lstat(file); } catch { return null; }
  // Same rules as desktop/mcp.mjs: a small private file owned by this user.
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return null;
  try {
    const runtime = JSON.parse(await readFile(file, "utf8"));
    const url = new URL(runtime.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || runtime.version !== 1 || !/^[a-f0-9]{64}$/.test(runtime.ownerToken ?? "")) return null;
    return { url: url.origin, ownerToken: runtime.ownerToken, source: "desktop app" };
  } catch { return null; }
}

/** Where to reach kino: { url, ownerToken?, shareToken?, source }. */
export async function resolveConnection(env = process.env) {
  if (env.MOTION_API_URL) {
    const url = new URL(env.MOTION_API_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("MOTION_API_URL must be an HTTP(S) URL without embedded credentials.");
    return { url: url.origin + url.pathname.replace(/\/$/, ""), ownerToken: env.KINO_OWNER_TOKEN || null, shareToken: env.KINO_SHARE_TOKEN || null, source: "MOTION_API_URL" };
  }
  return (await desktopConnection(env)) ?? { url: DEFAULT_URL, ownerToken: env.KINO_OWNER_TOKEN || null, source: "default" };
}

/**
 * A client that follows kino when it restarts (for the MCP server, which outlives the app): it
 * finds the connection again from `env` after a failed call or a changed connection file.
 */
export async function connectAgentClient(env = process.env, options = {}) {
  return createAgentClient(await resolveConnection(env), { ...options, reconnect: () => resolveConnection(env), runtimeFile: env.MOTION_API_URL ? null : runtimeFilePath(env) });
}

const NOT_RUNNING = "kino is not running. Open the kino app, or run `npm run dev` (or `npm start`) in the kino folder, then try again.";
// kino took the call, then the connection closed before its answer came.
const dropped = (error) => `The connection to kino closed before it answered (${error?.code || error?.message || "no reason given"}). kino was reached, so it may still be working on this call, or it quit or restarted. Call status to see where things stand before you send the call again.`;

// Sends one request with node:http and answers a fetch Response. fetch (undici) gives up
// after 300 s without an answer ("fetch failed"), but a check or render of a long video can
// take minutes, so there is no time limit here: kino is local, and `signal` still stops a call.
// A failed request carries `connected`: false when kino could not be reached at all.
function request(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let connected = false;
    // agent:false opens a new connection per call, so no reused connection that kino closed.
    const req = (target.protocol === "https:" ? https : http).request(target, { method, headers, agent: false, signal }, (res) => {
      const empty = method === "HEAD" || [204, 205, 304].includes(res.statusCode);
      const answer = new Headers();
      for (const [key, value] of Object.entries(res.headers)) for (const one of [].concat(value)) answer.append(key, one);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: answer }));
    });
    req.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once("connect", () => { connected = true; });
    });
    req.on("error", (error) => { error.connected ??= connected; reject(error); });
    if (isStream(body)) body.on("error", (error) => req.destroy(error)).pipe(req);
    else req.end(body);
  });
}

/**
 * A client for one connection. `name` labels the caller in kino's activity log
 * (such as "mcp" or "cli"). `session` tells this client's calls apart from other agents' in the
 * dashboard's live view: every call sends it as the x-kino-session header, and kino gives each
 * session its own name and color (agent/live.mjs). It is made up here when not given (one per
 * MCP server process); agents themselves send nothing for it.
 */
//
// `reconnect` (optional) finds the connection again, such as () => resolveConnection(). The MCP
// server lives as long as the agent's session, but the kino app gets a new port and token each
// time it starts. With `reconnect`, a call that cannot reach kino, or that kino refuses (an old
// token), looks again and retries once on the new connection; and a change to the desktop
// connection file (`runtimeFile`) is noticed before the next call. So the agent never has to
// restart its MCP server after the app restarts.
// maxUploadBytes: the upload limit (kino's server takes MAX_UPLOAD_BYTES; tests set it lower).
export function createAgentClient(connection, { name = "mcp", session, reconnect, runtimeFile, maxUploadBytes = MAX_UPLOAD_BYTES } = {}) {
  const sessionId = session ?? randomUUID().replace(/-/g, "").slice(0, 16);
  let current = connection;
  // The hash of kino's tool list from its last agent answer (x-kino-tools; agent/tool-sync.mjs).
  let toolsHash = null;
  const headersFor = (target) => target.shareToken ? { "x-kino-share": target.shareToken }
    : target.ownerToken ? { "x-kino-owner": target.ownerToken } : {};
  // The connection file's inode, size and time when the connection was last found.
  let stamp = null;
  async function fileStamp() {
    if (!runtimeFile) return null;
    try {
      const info = await stat(runtimeFile);
      return `${info.ino}/${info.size}/${info.mtimeMs}`;
    } catch { return "missing"; }
  }
  const same = (a, b) => a.url === b.url && (a.ownerToken ?? null) === (b.ownerToken ?? null) && (a.shareToken ?? null) === (b.shareToken ?? null);
  // Looks for the connection again; true when it changed.
  async function refresh() {
    if (!reconnect) return false;
    let next;
    try { next = await reconnect(); } catch { return false; }
    stamp = await fileStamp();
    if (!next?.url || same(next, current)) return false;
    current = next;
    return true;
  }
  const ready = reconnect && runtimeFile ? fileStamp().then((value) => { stamp ??= value; }) : Promise.resolve();
  const stopped = (error) => error?.name === "AbortError" || error?.name === "TimeoutError";

  async function send(route, options) {
    await ready;
    // The desktop app wrote a new connection file (it restarted): use it from this call on.
    if (reconnect && runtimeFile && (await fileStamp()) !== stamp) await refresh();
    const attempt = () => request(`${current.url}${route}`, { ...options, headers: { ...headersFor(current), ...options.headers } });
    // "Not running" only when kino could not be reached; otherwise say what happened.
    const failure = (error) => new Error(error?.connected ? dropped(error) : NOT_RUNNING, { cause: error });
    let response;
    try {
      response = await attempt();
    } catch (error) {
      if (stopped(error)) throw error;
      // kino may have restarted somewhere else: look again and retry once. A streamed body (an
      // upload) cannot be sent twice.
      if (!isStream(options.body) && await refresh()) {
        try { return await attempt(); } catch (again) {
          if (stopped(again)) throw again;
          throw failure(again);
        }
      }
      throw failure(error);
    }
    // An old token: kino restarted on the same port with a new one.
    if ((response.status === 401 || response.status === 403) && !isStream(options.body) && await refresh()) return attempt();
    return response;
  }

  /** Runs one verb. Returns the service reply { text, data?, images?, isError? }. */
  async function call(verb, input = {}, { by, signal, client } = {}) {
    // add_captions {file}: the caption file is read here and sent as text (caption-file.mjs).
    if (verb === "edit" && Array.isArray(input.ops)) {
      try { input = { ...input, ops: await inlineCaptionFiles(input.ops) }; }
      catch (error) { return { isError: true, text: error.message }; }
    }
    const response = await send(`/api/agent/${encodeURIComponent(verb)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kino-session": sessionId },
      body: JSON.stringify({ ...input, client: client || name, ...(by ? { by } : {}) }),
      signal,
    });
    if (response.status === 403) return { isError: true, text: "kino refused: this connection is not the project owner. Use the owner link or the desktop app's agent connection." };
    toolsHash = response.headers.get("x-kino-tools") ?? toolsHash;
    if (!response.ok) return { isError: true, text: `kino answered ${response.status}: ${(await response.text()).slice(0, 500)}` };
    return response.json();
  }

  /**
   * Uploads a local file (absolute path) to kino's media library. It first asks the
   * service, which may hold the call or ask the person to approve a large file; then
   * it returns { refused: reply } instead of uploading. A .json or .motion project file
   * becomes a new project instead.
   */
  async function importFile(filePath, { signal, client, input = {} } = {}) {
    // openverse:<id> (library sounds), archive:<id> (a soundtrack song), yt:<id> (a measured inspire sound effect), sfx:<id> or music:<id> (the built-in library),
    // and found footage (F1, F1.37 or clip:<id>, with options {shots} or from/to) come in through kino itself, checked before the file system: {reply} is its answer.
    if (KINO_IMPORT.test(String(filePath ?? "").trim())) {
      const asked = Object.fromEntries(["project", "options", "from", "to"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
      return { reply: await call("project", { ...asked, action: "import", file: String(filePath).trim() }, { signal, client }) };
    }
    if ([".json", ".motion"].includes(path.extname(String(filePath)).toLowerCase())) {
      if (!path.isAbsolute(filePath)) throw new Error("Choose a project file by its absolute local path.");
      const actual = await realpath(filePath);
      const details = await stat(actual);
      if (!details.isFile() || details.size > 100 * 1024 * 1024) throw new Error("Choose a regular project file smaller than 100 MB.");
      const document = JSON.parse(await readFile(actual, "utf8"));
      // Import creates an independent file, as the native editor's import does.
      document.id = randomUUID();
      const reply = await call("project", { action: "manage", options: { resource: "document", action: "import", document } }, { signal, client });
      // Held, or a stop waits for the person's answer ({waiting}): nothing was imported.
      if (reply.isError || reply.data?.held || reply.data?.waiting) return { refused: reply };
      return reply.data;
    }
    const file = await readExplicitMediaFile(String(filePath ?? ""), { maxBytes: maxUploadBytes });
    const size = (await lstat(file.actualPath)).size;
    const check = await call("project", { action: "import", name: file.name, size }, { signal, client });
    if (!check?.data?.ok) return { refused: check };
    // Over the limit: kino's own smaller copy goes up instead (media-working-copy.mjs).
    const copy = file.tooLarge ? await makeWorkingCopy(file, { maxBytes: maxUploadBytes, signal }) : null;
    try {
      // The open project (from the check) owns the upload, as the app's own imports do.
      const project = typeof check.data.project === "string" ? `?project=${encodeURIComponent(check.data.project)}` : "";
      const response = await send(`/api/media${project}`, {
        method: "POST",
        headers: { "content-type": copy?.mime ?? file.mime, "x-file-name": file.name, "x-kino-agent": "1" },
        body: createReadStream(copy?.path ?? file.actualPath),
        signal,
      });
      if (!response.ok) {
        const text = await response.text();
        // kino's own refusals are {error: "why"}, such as a video without FFmpeg's shot filters.
        let reason = null;
        try { reason = JSON.parse(text).error; } catch { /* another body: shown as it came */ }
        throw new Error(typeof reason === "string" ? `kino refused the file: ${reason}` : `kino refused the file (${response.status}): ${text.slice(0, 500)}`);
      }
      const media = await response.json();
      return copy ? { ...media, note: copy.note } : media;
    } finally { await copy?.cleanup(); }
  }

  /** Reads a dashboard route (GET /api/dashboard/<route>) as JSON. */
  async function read(route, { signal } = {}) {
    const response = await send(`/api/dashboard/${route}`, { method: "GET", headers: {}, signal });
    if (!response.ok) throw new Error(`kino answered ${response.status}`);
    return response.json();
  }

  /** Posts JSON to a dashboard route that needs no review key. */
  async function post(route, value, { signal } = {}) {
    const response = await send(`/api/dashboard/${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal,
    });
    return response.ok;
  }

  /** Opens the dashboard event stream; calls onEvent(event) for each event until signal aborts. */
  async function stream(onEvent, { signal, since } = {}) {
    const response = await send(`/api/dashboard/stream${since == null ? "" : `?since=${since}`}`, { method: "GET", headers: { accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) throw new Error(`kino answered ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) { try { onEvent(JSON.parse(data)); } catch { /* skip a broken event */ } }
      }
    }
  }

  /** kino's own tools/list answer and its hash: { hash, tools } (GET /api/agent/tools). */
  async function tools({ signal } = {}) {
    const response = await send("/api/agent/tools", { method: "GET", headers: {}, signal });
    if (!response.ok) throw new Error(`kino answered ${response.status}`);
    const list = await response.json();
    toolsHash = list?.hash ?? toolsHash;
    return list;
  }

  return { call, importFile, read, post, stream, tools, get toolsHash() { return toolsHash; }, get connection() { return current; } };
}

// Imports kino makes itself rather than a local file: sounds, songs and found footage codes.
const KINO_IMPORT = /^(?:(?:openverse|archive|yt|sfx|music|clip):|F\d{1,3}(?:\.\d+)?$)/i;

// A body fetch reads as it sends (a file upload): it can be sent only once.
const isStream = (body) => Boolean(body) && typeof body.pipe === "function";

// What `project {action:"import", file}` answers, after the upload. It gives the picture
// size, and for video and audio the duration kino measured (in seconds), which the add_layer
// example passes on as mediaSourceDuration. The example places a picture at its own size from
// the top-left corner (without a size a layer is 320×180), so in a scratch project the clip's
// size it fills the frame. A video's answer ends with its shots, in file seconds (shotsLine).
export function importedText(media) {
  if (media?.project) return `imported ${media.name} as project ${media.project} rev ${media.revision}; project open {id:"${media.project}"} opens it.`;
  const record = media?.media ?? media;
  const kind = String(record?.mime ?? record?.type ?? "").split("/")[0];
  const layerType = { image: "image", video: "video", audio: "audio" }[kind];
  const timed = kind === "video" || kind === "audio";
  // Rounded to the millisecond; 0 when kino could not measure the file.
  const duration = record?.duration > 0 ? Math.round(record.duration * 1000) / 1000 : 0;
  const facts = [
    record?.width && record?.height ? `${record.width}×${record.height}` : "",
    duration ? `duration ${duration}s` : timed ? "duration unknown" : "",
  ].filter(Boolean).join(", ");
  const sourceDuration = timed && duration ? `, mediaSourceDuration:${duration}` : "";
  const size = layerType !== "audio" && record?.width > 0 && record?.height > 0 ? `, x:0, y:0, width:${record.width}, height:${record.height}` : "";
  // Log footage (media-probe.mjs footageLogOf) is added with its conversion to Rec.709 set.
  const log = layerType === "video" && typeof record?.log === "string" ? `, log:"${record.log}"` : "";
  const logNote = log ? `. Log footage found (${record.logWhy ?? record.log}), so it looks flat and gray as recorded: the add_layer below sets log:"${record.log}" to show it as Rec.709 (log:null shows the file as recorded)` : "";
  const text = `imported ${record?.name ?? "file"}${facts ? ` (${facts})` : ""} as ${record?.src ?? record?.id}${logNote}${layerType
    ? `. Add it: edit {ops:[{op:"add_layer", layerType:"${layerType}", name, properties:{src:"${record?.src}"${size}${sourceDuration}${log}}}]}`
    : kind === "font" ? ". It is now in library fonts; set_font uses it."
    : record?.lut ? `, a ${record.lut.type.toUpperCase()} LUT of size ${record.lut.size}. Grade a layer with it: edit {ops:[{op:"add_animation", layer, effect:"lut", parameters:{lut:"${record?.src}"}}]}` : ""}`;
  const note = typeof media?.note === "string" ? `\n${media.note}` : "";
  return `${kind === "video" ? `${text}\n${shotsLine(record)}` : text}${note}`;
}
