// The dashboard's side of the server (plan §5): your settings, the approval queue, hold,
// review keys, what you point at, and one numbered event stream that every open dashboard
// reads.
//
// - Settings, approvals and hold are saved in <data>/agent/dashboard.json (written atomically).
//   Reading it is forgiving (loadSettings): an unknown or invalid setting is dropped with one
//   warning and every other setting, approval and the hold are kept. A change you make (PUT) is
//   strict: anything unknown or invalid is refused with a plain message.
// - Events are numbered (seq). The last EVENTS_KEPT stay in memory, so a dashboard that
//   reconnects gets exactly what it missed ("replayed 14 events"). One that missed too much,
//   or that reconnects to a restarted server (a new boot id), re-reads the snapshot instead.
// - A review key is what an open dashboard window holds to answer approvals, hold agent
//   writes and change settings. The agent's MCP tools and the kino command never get one.
// - A share link's URL is a secret. An allowed share-link approval saves, shows and tells the
//   agent's inbox only SHARE_LINK_RESULT; the URL waits in memory for the agent's
//   render {action:"wait", job:"Q…"}, which takes it once.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { documentChanges } from "../../engine/documentChanges.js";
import { fpsLabel, parseFps } from "../../engine/frameRate.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { hideShareSecrets, sameSecret } from "../shares.mjs";
import { pointingText } from "./labels.mjs";

// D3: what needs your approval, with the words the dashboard shows.
export const APPROVAL_KINDS = Object.freeze({
  "final-render": "final renders above the frame limit",
  "delete-scene": "deleting a scene",
  "delete-project": "archiving a project",
  "overwrite-export": "overwriting an export file",
  "large-import": "imports above the size limit",
  "share-link": "creating a share link",
  // An agent past its budget (crew.mjs): allow gives it the start rules' budget again, deny stops it.
  "crew-budget": "agents going past their budget",
});
export const POLICIES = Object.freeze(["ask", "allow", "deny"]);
// The stops (backend/agent/stops.mjs, direction plan §6): each asks or is allowed, never denied,
// and is skipped for a video shorter than its skip-under length (seconds; 0 never skips).
export const STOP_APPROVAL_KINDS = Object.freeze({
  "checkpoint-board": "the storyboard stop",
  "checkpoint-rough": "the rough cut stop",
  "checkpoint-color": "the color pass stop",
  "checkpoint-sound": "the sound pass stop",
});
export const STOP_POLICIES = Object.freeze(["ask", "allow"]);
const SKIP_UNDER = Object.freeze({ skipBoardUnder: "storyboard", skipRoughUnder: "rough cut", skipColorUnder: "color pass", skipSoundUnder: "sound pass" });
const SKIP_SECONDS = { min: 0, max: 3600 };
export const EXPORT_FORMATS = Object.freeze(["mp4", "webm", "mov", "gif"]);
// 23.976 and 29.97 are kept as frames a second (24000/1001, 30000/1001: engine/frameRate.js).
export const EXPORT_FPS = Object.freeze([24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60]);
export const DRAFT_WIDTHS = Object.freeze([480, 640, 960]);
// Render settings (MP4 only for the encoder and quality). "software" is libx264; the others are
// a hardware encoder family, used only where this computer has it.
export const VIDEO_ENCODERS = Object.freeze(["auto", "software", "videotoolbox", "nvenc", "qsv", "amf", "vaapi"]);
export const VIDEO_QUALITIES = Object.freeze(["small", "standard", "high"]);
// The sections and the fields inside each one. A saved file may only hold these.
const SETTING_FIELDS = Object.freeze({
  limits: ["finalRenderFrames", "importMegabytes", ...Object.keys(SKIP_UNDER)],
  exports: ["format", "fps", "folder", "videoEncoder", "videoQuality"],
  compute: ["draftWidth", "frameCacheMegabytes", "graphics", "framesAtOnce", "keepFreePercent", "renderCacheMegabytes", "previewCache", "previewCacheMegabytes"],
  notify: ["quiet"],
  sounds: ["search", "freesoundKey"],
});
const EVENTS_KEPT = 1000;
const APPROVALS_KEPT = 200;
const REVIEW_KEYS_KEPT = 16;
const SHARE_LINK_RESULT = "Created sharing link (secret omitted)";
const FRAME_LIMIT = { min: 1, max: 100_000 };
const IMPORT_LIMIT = { min: 1, max: 100_000 };
const CACHE_LIMIT = { min: 64, max: 65_536 };
const FRAMES_AT_ONCE = { min: 1, max: 8 };
const KEEP_FREE_PERCENT = { min: 5, max: 60 };
const GRAPHICS_NAME_LENGTH = 120;

export function defaultSettings() {
  return {
    approvals: Object.fromEntries([...Object.keys(APPROVAL_KINDS), ...Object.keys(STOP_APPROVAL_KINDS)].map((kind) => [kind, "ask"])),
    // The stops ask for videos of 15 s or more; the storyboard (footage only) from 8 s.
    limits: { finalRenderFrames: 600, importMegabytes: 200, skipBoardUnder: 8, skipRoughUnder: 15, skipColorUnder: 15, skipSoundUnder: 15 },
    exports: { format: "mp4", fps: 30, folder: "", videoEncoder: "auto", videoQuality: "standard" },
    // graphics: "auto", "processor" (no graphics card) or a card's name. framesAtOnce: how many
    // raster workers draw at once (1 to 8, or "auto"). keepFreePercent: the memory a render
    // leaves free. renderCacheMegabytes: the most the render cache (finished segments) holds.
    // previewCache: draw draft segments while idle for smooth playback (backend/preview-scheduler.mjs);
    // previewCacheMegabytes: the most they hold on disk.
    compute: { draftWidth: 960, frameCacheMegabytes: 1024, graphics: "auto", framesAtOnce: 1, keepFreePercent: 20, renderCacheMegabytes: 512,
      previewCache: true, previewCacheMegabytes: 2048 },
    // D5: push notes into a Claude Code session started with the channel flag. Off by default.
    channels: false,
    // quiet: a silent notification when an agent goes quiet for 30 s while the dashboard window
    // is in the background (milestone LIVE). Off by default; the agent never sees it.
    notify: { quiet: false },
    // search: library sounds and Openverse imports (backend/sound-search.mjs). Off by default: it
    // sends the agent's search words to Openverse (direction plan fix 8).
    sounds: { search: false },
  };
}

function settingsError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function wholeNumber(value, { min, max }, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw settingsError(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// A graphics card setting: "auto", "processor", or a card's name as the device list shows it.
function graphicsSetting(value) {
  if (typeof value !== "string" || !value.trim() || value.length > GRAPHICS_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw settingsError(`The graphics card is "auto", "processor", or a card's name (1 to ${GRAPHICS_NAME_LENGTH} characters, on one line).`);
  return value;
}

/** Applies a settings change (only the fields it names) and returns the whole new settings. */
export function mergeSettings(current, change) {
  if (!isObject(change)) throw settingsError("Settings must be a JSON object.");
  const next = structuredClone(current);
  for (const key of Object.keys(change))
    if (!["approvals", "limits", "exports", "compute", "channels", "notify", "sounds"].includes(key)) throw settingsError(`Unknown setting "${key}".`);
  for (const [section, fields] of Object.entries(SETTING_FIELDS)) {
    if (change[section] === undefined) continue;
    if (!isObject(change[section])) throw settingsError(`"${section}" must be an object of settings.`);
    for (const key of Object.keys(change[section]))
      if (!fields.includes(key)) throw settingsError(`Unknown setting "${section}.${key}". The ${section} settings are ${fields.join(", ")}.`);
  }
  if (change.approvals !== undefined && !isObject(change.approvals)) throw settingsError('"approvals" must be an object of approval rules.');
  for (const [kind, policy] of Object.entries(change.approvals ?? {})) {
    if (Object.hasOwn(STOP_APPROVAL_KINDS, kind)) {
      if (!STOP_POLICIES.includes(policy)) throw settingsError("A stop is ask or allow.");
    } else if (!Object.hasOwn(APPROVAL_KINDS, kind)) throw settingsError(`Unknown approval kind "${kind}".`);
    else if (!POLICIES.includes(policy)) throw settingsError("An approval rule is ask, allow or deny.");
    next.approvals[kind] = policy;
  }
  if (change.limits) {
    if (change.limits.finalRenderFrames !== undefined) next.limits.finalRenderFrames = wholeNumber(change.limits.finalRenderFrames, FRAME_LIMIT, "The final-render frame limit");
    if (change.limits.importMegabytes !== undefined) next.limits.importMegabytes = wholeNumber(change.limits.importMegabytes, IMPORT_LIMIT, "The import size limit");
    for (const [field, label] of Object.entries(SKIP_UNDER)) {
      if (change.limits[field] === undefined) continue;
      const value = change.limits[field];
      if (!Number.isSafeInteger(value) || value < SKIP_SECONDS.min || value > SKIP_SECONDS.max)
        throw settingsError(`The ${label} skip-under length is a whole number of seconds from ${SKIP_SECONDS.min} to ${SKIP_SECONDS.max}.`);
      next.limits[field] = value;
    }
  }
  if (change.exports) {
    const { format, fps, folder, videoEncoder, videoQuality } = change.exports;
    if (format !== undefined) {
      if (!EXPORT_FORMATS.includes(format)) throw settingsError(`The export format is one of ${EXPORT_FORMATS.join(", ")}.`);
      next.exports.format = format;
    }
    if (fps !== undefined) {
      const rate = parseFps(fps);
      if (!EXPORT_FPS.includes(rate)) throw settingsError(`The export frame rate is one of ${EXPORT_FPS.map(fpsLabel).join(", ")}.`);
      next.exports.fps = rate;
    }
    if (folder !== undefined) {
      if (typeof folder !== "string" || folder.length > 1024 || /[\u0000-\u001f]/.test(folder) || (folder && !path.isAbsolute(folder)))
        throw settingsError("The output folder is an absolute path, or empty for kino's own folder.");
      next.exports.folder = folder;
    }
    if (videoEncoder !== undefined) {
      if (!VIDEO_ENCODERS.includes(videoEncoder)) throw settingsError(`The video encoder is one of ${VIDEO_ENCODERS.join(", ")}.`);
      next.exports.videoEncoder = videoEncoder;
    }
    if (videoQuality !== undefined) {
      if (!VIDEO_QUALITIES.includes(videoQuality)) throw settingsError(`The video quality is one of ${VIDEO_QUALITIES.join(", ")}.`);
      next.exports.videoQuality = videoQuality;
    }
  }
  if (change.compute) {
    const { draftWidth, frameCacheMegabytes, graphics, framesAtOnce, keepFreePercent, renderCacheMegabytes, previewCache, previewCacheMegabytes } = change.compute;
    if (draftWidth !== undefined) {
      if (!DRAFT_WIDTHS.includes(draftWidth)) throw settingsError(`The draft width is one of ${DRAFT_WIDTHS.join(", ")}.`);
      next.compute.draftWidth = draftWidth;
    }
    if (frameCacheMegabytes !== undefined) next.compute.frameCacheMegabytes = wholeNumber(frameCacheMegabytes, CACHE_LIMIT, "The frame cache size");
    if (graphics !== undefined) next.compute.graphics = graphicsSetting(graphics);
    if (framesAtOnce !== undefined) {
      if (framesAtOnce !== "auto" && (!Number.isSafeInteger(framesAtOnce) || framesAtOnce < FRAMES_AT_ONCE.min || framesAtOnce > FRAMES_AT_ONCE.max))
        throw settingsError(`Frames at once is a whole number from ${FRAMES_AT_ONCE.min} to ${FRAMES_AT_ONCE.max}, or "auto".`);
      next.compute.framesAtOnce = framesAtOnce;
    }
    if (keepFreePercent !== undefined) next.compute.keepFreePercent = wholeNumber(keepFreePercent, KEEP_FREE_PERCENT, "The memory to leave free (a percent)");
    if (renderCacheMegabytes !== undefined) next.compute.renderCacheMegabytes = wholeNumber(renderCacheMegabytes, CACHE_LIMIT, "The render cache size (in megabytes)");
    if (previewCache !== undefined) {
      if (typeof previewCache !== "boolean") throw settingsError("compute.previewCache is true or false.");
      next.compute.previewCache = previewCache;
    }
    if (previewCacheMegabytes !== undefined) next.compute.previewCacheMegabytes = wholeNumber(previewCacheMegabytes, CACHE_LIMIT, "The preview cache size (in megabytes)");
  }
  if (change.channels !== undefined) {
    if (typeof change.channels !== "boolean") throw settingsError("channels is true or false.");
    next.channels = change.channels;
  }
  if (change.notify?.quiet !== undefined) {
    if (typeof change.notify.quiet !== "boolean") throw settingsError("notify.quiet is true or false.");
    next.notify.quiet = change.notify.quiet;
  }
  if (change.sounds?.search !== undefined) {
    if (typeof change.sounds.search !== "boolean") throw settingsError("sounds.search is true or false.");
    next.sounds.search = change.sounds.search;
  }
  // An optional free Freesound API key (backend/sound-search.mjs); "" removes it.
  if (change.sounds?.freesoundKey !== undefined) {
    const key = change.sounds.freesoundKey;
    if (typeof key !== "string" || (key !== "" && !/^[A-Za-z0-9]{8,64}$/.test(key))) throw settingsError("sounds.freesoundKey is a Freesound API key (letters and digits) or \"\" to remove it.");
    if (key) next.sounds.freesoundKey = key; else delete next.sounds.freesoundKey;
  }
  return next;
}

/**
 * Settings read from a saved dashboard.json, field by field: every valid field is kept, and each
 * unknown or invalid one is dropped (its default stays). A file written by a newer or older kino
 * therefore keeps everything this version understands. Returns { settings, dropped }, where
 * dropped lists "<field>: <why>" for the one warning the caller prints.
 */
export function loadSettings(stored) {
  let settings = defaultSettings();
  const dropped = [];
  const take = (name, change) => {
    try { settings = mergeSettings(settings, change); }
    catch (error) { dropped.push(`${name}: ${error.message.replace(/\.$/, "")}`); }
  };
  if (stored === undefined || stored === null) return { settings, dropped };
  if (!isObject(stored)) return { settings, dropped: ["settings: not a JSON object"] };
  for (const [key, value] of Object.entries(stored)) {
    if (key === "channels") take(key, { channels: value });
    else if (key === "approvals" || Object.hasOwn(SETTING_FIELDS, key)) {
      if (!isObject(value)) { dropped.push(`${key}: not an object of settings`); continue; }
      for (const [field, fieldValue] of Object.entries(value)) {
        if (key !== "approvals" && !SETTING_FIELDS[key].includes(field)) dropped.push(`${key}.${field}: not a setting this version of kino knows`);
        else take(`${key}.${field}`, { [key]: { [field]: fieldValue } });
      }
    } else dropped.push(`${key}: not a setting this version of kino knows`);
  }
  return { settings, dropped };
}

// What an agent edit was about, for "follow agent": the first scene it touched, the layers it
// created or changed there, and a time when those layers are on screen. `range` is the time the
// changed animations there span ([earliest start, latest end] in scene seconds), or null.
export function editFocus(before, after) {
  if (!after?.scenes?.length) return null;
  const changes = documentChanges(before, after);
  const touched = new Set([...changes.created, ...changes.changed]);
  if (!touched.size) return null;
  for (const scene of after.scenes) {
    const layerIds = [];
    let time = null;
    let range = null;
    for (const layer of scene.layers ?? []) {
      const entries = animationTreeEntries(layer.animations ?? []);
      const touchedAnimation = entries.find(({ stored }) => stored && touched.has(stored.id));
      if (!touched.has(layer.id) && !touchedAnimation) continue;
      layerIds.push(layer.id);
      for (const { stored, offset } of entries) {
        if (!stored || !touched.has(stored.id) || stored.kind === "composed" || !Number.isFinite(stored.start)) continue;
        const start = stored.start + offset;
        const end = start + (Number(stored.duration) || 0);
        range = range ? [Math.min(range[0], start), Math.max(range[1], end)] : [start, end];
      }
      if (time === null) {
        // The end of the changed animation, or of the layer's entrance, or the middle of the scene.
        const entrance = touchedAnimation ?? entries.find(({ stored }) => stored?.kind === "in");
        time = entrance ? (entrance.stored.start ?? 0) + entrance.offset + (entrance.stored.duration ?? 0) : null;
      }
    }
    if (layerIds.length || touched.has(scene.id)) {
      const duration = Number(scene.duration) || 0;
      const at = time === null ? duration / 2 : Math.min(duration, Math.max(0, time + 0.05));
      const span = range && [Math.max(0, Math.round(range[0] * 100) / 100), Math.min(duration, Math.round(range[1] * 100) / 100)];
      return { sceneId: scene.id, layerIds: layerIds.slice(0, 20), time: Math.round(at * 100) / 100, range: span && span[1] > span[0] ? span : null };
    }
  }
  return null;
}

const RANGE_LIMIT = 36_000;
// A pointed time range: null when none is given, [start, end] rounded to 0.01 s, or a refusal.
function pointedRange(value) {
  if (value === undefined || value === null) return null;
  const valid = Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  const [start, end] = valid ? value.map((seconds) => Math.round(seconds * 100) / 100) : [];
  if (!valid || start < 0 || end > RANGE_LIMIT || start >= end) throw settingsError("range is [start, end] in seconds, start before end.");
  return [start, end];
}

/**
 * The dashboard state. `agentDirectory` holds dashboard.json; `agentState` (state.mjs) is used
 * to hand approval answers and hold notices to the agent through its inbox.
 */
export async function createDashboard({ agentDirectory, agentState, now = Date.now }) {
  const file = path.join(agentDirectory, "dashboard.json");
  let saved = { settings: defaultSettings(), approvals: [], nextApproval: 1, hold: { on: false, since: null, note: "" } };
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    // Settings are read field by field, so one bad or unknown field never costs the approvals,
    // the approval numbers or the hold.
    const { settings, dropped } = loadSettings(stored?.settings);
    if (dropped.length) console.warn(`[kino] Some saved dashboard settings were not used, so their defaults apply: ${dropped.join("; ")}`);
    const approvals = Array.isArray(stored?.approvals) ? stored.approvals : [];
    // The next approval number never reuses one already in the list.
    const highest = Math.max(0, ...approvals.map((entry) => Number(/^Q(\d+)$/.exec(entry?.id ?? "")?.[1] ?? 0)));
    saved = {
      settings,
      approvals,
      nextApproval: Math.max(Number.isSafeInteger(stored?.nextApproval) ? stored.nextApproval : 1, highest + 1),
      hold: { on: stored?.hold?.on === true, since: stored?.hold?.since ?? null, note: String(stored?.hold?.note ?? "") },
    };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`[kino] The dashboard settings could not be read, so the defaults are used: ${error.message}`);
  }
  let writing = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(saved);
    writing = writing.catch(() => {}).then(async () => {
      await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, file);
    });
    return writing;
  }

  // ---- the event stream -------------------------------------------------------------------
  const boot = randomUUID().slice(0, 8);
  const events = [];
  const listeners = new Set();
  let seq = 0;
  function publish(event) {
    const entry = { seq: ++seq, at: new Date(now()).toISOString(), ...event };
    events.push(entry);
    if (events.length > EVENTS_KEPT) events.shift();
    for (const listener of listeners) {
      try { listener(entry); } catch { /* one broken stream must not stop the others */ }
    }
    return entry;
  }
  // The events after `since`, or null when they are no longer all kept (or the server restarted).
  function replay(since, bootId) {
    if (bootId !== boot || !Number.isSafeInteger(since) || since < 0 || since > seq) return null;
    const oldest = events[0]?.seq ?? seq + 1;
    if (since < oldest - 1) return null;
    return events.filter((entry) => entry.seq > since);
  }
  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---- review keys ------------------------------------------------------------------------
  const reviewKeys = [];
  function mintReviewKey() {
    const key = randomBytes(32).toString("base64url");
    reviewKeys.push(key);
    if (reviewKeys.length > REVIEW_KEYS_KEPT) reviewKeys.shift();
    return key;
  }
  const validReviewKey = (value) => typeof value === "string" && reviewKeys.some((key) => sameSecret(key, value));

  // ---- approvals --------------------------------------------------------------------------
  // The dashboard and its stream get neither the stored call nor the ids a delete names.
  const publicApproval = ({ input, targets, ...approval }) => approval;
  // Approval id → the share link an allowed approval made ({url, desktopUrl}), in memory only.
  const shareLinks = new Map();
  const sameCall = (approval, { kind, projectId, match }) => approval.kind === kind && approval.projectId === projectId && approval.match === match;

  /**
   * Asks for an approval. `kinds` lists what the call does that may need one ({kind, summary,
   * targets?}). `targets` are the ids of the scenes or projects a delete names; they are kept
   * with the approval, so the approved call can check it deletes nothing else. `rev` is the
   * project revision a render would draw: the same call at a newer revision replaces the
   * request still waiting for the older one (its status becomes "replaced").
   * Returns { status: "allowed" } to go ahead, { status: "denied", kind } when your rules deny
   * it, or { status: "pending", id, rev?, replaced? } (one approval for the whole call).
   */
  async function request({ kinds, projectId, verb, input, client, agent, rev }) {
    const settings = saved.settings;
    const denied = kinds.find((entry) => settings.approvals[entry.kind] === "deny");
    if (denied) return { status: "denied", kind: denied.kind, summary: denied.summary };
    const asking = kinds.filter((entry) => settings.approvals[entry.kind] !== "allow");
    if (!asking.length) return { status: "allowed" };
    const kind = asking[0].kind;
    const match = JSON.stringify([verb, input]);
    // An allowed import is used once: the agent sends the same import again after you allow it.
    const allowed = saved.approvals.find((approval) => approval.status === "allowed" && !approval.used && approval.resend && sameCall(approval, { kind, projectId, match }));
    if (allowed) {
      allowed.used = true;
      await persist();
      return { status: "allowed", id: allowed.id };
    }
    const pending = saved.approvals.find((approval) => approval.status === "pending" && sameCall(approval, { kind, projectId, match }));
    if (pending && pending.rev === rev) return { status: "pending", id: pending.id, summary: pending.summary, ...(rev === undefined ? {} : { rev }) };
    const targets = Object.fromEntries(asking.filter((entry) => Array.isArray(entry.targets)).map((entry) => [entry.kind, entry.targets]));
    const approval = {
      id: `Q${saved.nextApproval++}`, kind, kinds: asking.map((entry) => entry.kind), projectId, verb, input, match, client: client ?? null, agent: agent ?? null,
      ...(Object.keys(targets).length ? { targets } : {}), ...(rev === undefined ? {} : { rev }),
      summary: asking.map((entry) => entry.summary).join("; ").slice(0, 300), status: "pending",
      // A render's facts for the dashboard (seconds, frames, fps, format, size), when it has them.
      ...(asking.find((entry) => entry.spec)?.spec ? { spec: asking.find((entry) => entry.spec).spec } : {}),
      resend: verb === "project" && input?.action === "import", createdAt: new Date(now()).toISOString(), answeredAt: null, note: "", result: null,
    };
    // The same call for an older revision no longer waits for you: this one replaces it.
    if (pending) close(pending, "replaced", `${approval.id} asks ${rev === undefined ? "again" : `for rev ${rev}`} instead`);
    saved.approvals.push(approval);
    saved.approvals = saved.approvals.slice(-APPROVALS_KEPT);
    await persist();
    if (pending) publish({ type: "approval", projectId, approval: publicApproval(pending) });
    publish({ type: "approval", projectId, approval: publicApproval(approval) });
    return { status: "pending", id: approval.id, summary: approval.summary, ...(rev === undefined ? {} : { rev }), ...(pending ? { replaced: pending.id } : {}) };
  }

  // Ends a request nobody answered: "canceled" (the agent withdrew it) or "replaced".
  function close(approval, status, text) {
    approval.status = status;
    approval.answeredAt = new Date(now()).toISOString();
    approval.result = { text, isError: false, job: null };
  }

  /** The agent withdraws a request still waiting for you. Returns it, or null when it was not waiting. */
  async function cancel(id) {
    const approval = saved.approvals.find((entry) => entry.id.toLowerCase() === String(id).toLowerCase());
    if (approval?.status !== "pending") return null;
    close(approval, "canceled", "the agent withdrew it");
    await persist();
    publish({ type: "approval", projectId: approval.projectId, approval: publicApproval(approval) });
    return publicApproval(approval);
  }

  function getApproval(id) {
    const approval = saved.approvals.find((entry) => entry.id.toLowerCase() === String(id).toLowerCase());
    return approval ? structuredClone(approval) : null;
  }

  async function tellAgent(projectId, text) {
    // An agent past its budget before it opened a project has no project inbox.
    if (!projectId) return;
    await agentState.update(projectId, (state) => { state.inbox.push({ kind: "approval", text }); }).catch(() => {});
  }

  /**
   * Your answer to an approval. `run(approval)` makes the approved call (not for imports, which
   * the agent sends again) and returns the reply. The agent hears the answer in its inbox.
   */
  async function answer(id, { decision, always = false, note = "", via = "dashboard", words = "" }, run) {
    if (!["allow", "deny"].includes(decision)) throw settingsError("decision is allow or deny.");
    // Told to the agent in the chat: the person's own words are kept with the answer, and only
    // the dashboard changes a rule for good (always).
    const chat = via === "chat";
    if (chat && !String(words ?? "").trim()) throw settingsError("An answer from the chat keeps the person's words: give words.");
    if (chat) always = false;
    const text = String(note ?? "").trim().slice(0, 500);
    const approval = saved.approvals.find((entry) => entry.id === id);
    if (!approval) { const error = new Error(`No approval ${id}.`); error.status = 404; throw error; }
    if (approval.status !== "pending") {
      const why = ["canceled", "replaced"].includes(approval.status) ? `no longer waits: ${approval.result.text}` : `was already answered (${approval.status})`;
      const error = new Error(`${id} ${why}.`); error.status = 409; throw error;
    }
    approval.status = decision === "allow" ? "allowed" : "denied";
    approval.answeredAt = new Date(now()).toISOString();
    approval.note = text;
    approval.always = always === true;
    approval.via = chat ? "chat" : "dashboard";
    if (chat) approval.words = String(words).trim().slice(0, 500);
    if (always === true) {
      for (const kind of approval.kinds ?? [approval.kind]) saved.settings.approvals[kind] = decision;
      publish({ type: "settings", settings: structuredClone(saved.settings) });
    }
    await persist();
    publish({ type: "approval", projectId: approval.projectId, approval: publicApproval(approval) });
    const yourNote = (chat ? ` in the chat ("${approval.words}")` : "") + (text ? ` · your note: "${text}"` : "");
    if (approval.status === "denied") {
      await tellAgent(approval.projectId, `${approval.id} denied by the person${yourNote}: ${approval.summary}. Do not send it again; ask in a note if you need it.`);
      return publicApproval(approval);
    }
    if (approval.resend) {
      await tellAgent(approval.projectId, `${approval.id} allowed${yourNote}: send the same import again (project {action:"import", file}).`);
      return publicApproval(approval);
    }
    let reply;
    try { reply = await run(approval); }
    catch (error) { reply = { isError: true, text: error.message }; }
    const madeLink = !reply.isError && (approval.kinds ?? [approval.kind]).includes("share-link");
    if (madeLink && typeof reply.data?.url === "string") {
      shareLinks.set(approval.id, { url: reply.data.url, ...(reply.data.desktopUrl ? { desktopUrl: reply.data.desktopUrl } : {}) });
      if (shareLinks.size > APPROVALS_KEPT) shareLinks.delete(shareLinks.keys().next().value);
    }
    const resultText = madeLink ? SHARE_LINK_RESULT : hideShareSecrets(String(reply.text ?? "").split("\n")[0].slice(0, 400));
    approval.result = { text: resultText, isError: Boolean(reply.isError), job: reply.data?.job ?? null };
    await persist();
    publish({ type: "approval", projectId: approval.projectId, approval: publicApproval(approval) });
    const howToGetIt = madeLink ? `; render {action:"wait", job:"${approval.id}"} gives you its URL, once` : "";
    await tellAgent(approval.projectId, `${approval.id} allowed${yourNote}: ${approval.result.text}${howToGetIt}`);
    return publicApproval(approval);
  }

  // The share link an allowed approval made, for the agent's own wait answer: given once.
  function takeShareLink(id) {
    const link = shareLinks.get(id) ?? null;
    shareLinks.delete(id);
    return link;
  }

  const approvals = (projectId) => saved.approvals.filter((entry) => !projectId || entry.projectId === projectId).map(publicApproval);
  const pendingCount = () => saved.approvals.filter((entry) => entry.status === "pending").length;

  // ---- hold ---------------------------------------------------------------------------------
  const heldProjects = new Set();
  async function setHold(on, note = "") {
    const wasOn = saved.hold.on;
    saved.hold = on ? { on: true, since: saved.hold.on ? saved.hold.since : new Date(now()).toISOString(), note: String(note ?? "").slice(0, 300) } : { on: false, since: null, note: "" };
    await persist();
    publish({ type: "hold", hold: { ...saved.hold } });
    // The agent's held writes said "try again after the hold is released": tell it when.
    if (wasOn && !on) {
      for (const projectId of heldProjects)
        await agentState.update(projectId, (state) => { state.inbox.push({ kind: "hold", text: "hold released: agent writes work again" }); }).catch(() => {});
      heldProjects.clear();
    }
    return { ...saved.hold };
  }

  // ---- pointing -----------------------------------------------------------------------------
  // What you selected in the dashboard: layers, a time range in a scene ([start, end] seconds),
  // or both. `line` is the exact text the agent's status shows after "pointing " (labels.mjs
  // pointingText, with the project's codes): the dashboard shows that same line.
  const pointing = new Map();
  function point(projectId, selection, { codes } = {}) {
    const layerIds = Array.isArray(selection?.layerIds) ? selection.layerIds.filter((id) => typeof id === "string" && id.length <= 128).slice(0, 20) : [];
    const range = pointedRange(selection?.range);
    const sceneId = typeof selection?.sceneId === "string" ? selection.sceneId : null;
    if (range && !sceneId) throw settingsError("A time range needs sceneId, the scene it is in.");
    if (!layerIds.length && !range) pointing.delete(projectId);
    else {
      const selected = { sceneId, layerIds, range, where: "dashboard" };
      pointing.set(projectId, { ...selected, line: pointingText(selected, { codes }) });
    }
    publish({ type: "pointing", projectId, pointing: pointing.get(projectId) ?? null });
  }

  return {
    boot,
    seq: () => seq,
    publish,
    replay,
    recent: (limit = 200) => events.slice(-limit),
    onEvent,
    mintReviewKey,
    validReviewKey,
    settings: () => structuredClone(saved.settings),
    async updateSettings(change) {
      saved.settings = mergeSettings(saved.settings, change);
      await persist();
      publish({ type: "settings", settings: structuredClone(saved.settings) });
      return structuredClone(saved.settings);
    },
    request,
    answer,
    cancel,
    approval: getApproval,
    takeShareLink,
    approvals,
    pendingCount,
    hold: () => ({ ...saved.hold }),
    setHold,
    heldCall(projectId) { if (projectId) heldProjects.add(projectId); },
    point,
    pointing: (projectId) => pointing.get(projectId) ?? null,
    flush: () => writing,
  };
}
