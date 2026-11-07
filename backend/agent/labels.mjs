// Plain words for every agent call, written by the server (milestone LIVE): the dashboard's log
// row and live marker show them, and they cost the agent nothing (tool definitions and answers
// are unchanged). They use layer and scene names, not IDs, where the document has them. They
// hold no secrets: a share call reads "create a share link", an import names only the file,
// and paths and URLs never appear. Also the pointing line the agent's status shows (and the
// dashboard shows word for word), and the words for what a call is about.
import path from "node:path";
import { refName } from "./describe.mjs";
import { createResolver, emptyCodes } from "./refs.mjs";

const LABEL_LENGTH = 60;
const NAME_LENGTH = 24;

/** Seconds as the dashboard writes them: one decimal ("2.0"), or two when needed ("1.25"). */
export function timeText(seconds) {
  const value = Math.round(Number(seconds) * 100) / 100;
  if (!Number.isFinite(value)) return "?";
  return Math.abs(Math.round(value * 10) / 10 - value) < 1e-9 ? value.toFixed(1) : value.toFixed(2);
}

const rangeText = ([start, end]) => `${timeText(start)}–${timeText(end)} s`;

// One line of plain text: control, bidi and zero-width characters go, URLs and paths are hidden.
function plain(text) {
  return String(text ?? "")
    .replace(/\p{C}/gu, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "a link")
    .split(/\s+/)
    .map((word) => (/^(?:~|\.{0,2})\/|^[A-Za-z]:\\|\/.*\//.test(word) ? path.basename(word.replace(/\\/g, "/")) : word))
    .join(" ")
    .trim();
}

const cut = (text, length) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);
const words = (name) => String(name ?? "").replace(/_/g, " ").trim();

// Names for the refs an agent wrote (names, codes or IDs), from the document when it has them.
function namer(document, codes) {
  let resolver = null;
  try { resolver = document?.scenes ? createResolver(document, codes ?? emptyCodes()) : null; } catch { resolver = null; }
  const find = (ref, kind) => {
    if (!resolver || typeof ref !== "string" || !ref) return null;
    try { return resolver.resolve(ref, kind); } catch { return null; }
  };
  const layerById = (id) => document?.scenes?.flatMap((scene) => scene.layers ?? []).find((layer) => layer.id === id) ?? null;
  const sceneById = (id) => document?.scenes?.find((scene) => scene.id === id) ?? null;
  const short = (text) => cut(plain(text), NAME_LENGTH);
  return {
    layerId: (ref) => find(ref, "layer"),
    sceneId: (ref) => find(ref, "scene"),
    layer(ref) {
      const id = find(ref, "layer");
      const layer = id ? layerById(id) : null;
      return short(layer?.name || (id ? refName(id, codes) : ref));
    },
    layerOfId: (id) => short(layerById(id)?.name || refName(id, codes)),
    scene(ref) {
      const id = find(ref, "scene");
      const scene = id ? sceneById(id) : null;
      return short(scene?.name || (id ? refName(id, codes) : ref));
    },
    sceneOfId: (id) => short(sceneById(id)?.name || refName(id, codes)),
    count: () => document?.scenes?.length ?? 0,
  };
}

const MOVE = ["x", "y"];
const RESIZE = ["width", "height"];
const only = (keys, allowed) => keys.length > 0 && keys.every((key) => allowed.includes(key));

function opLabel(op, names) {
  if (!op || typeof op !== "object") return "change";
  const name = String(op.op ?? op.type ?? "change");
  const layerRef = op.layer ?? op.layerId;
  const layers = Array.isArray(op.layers ?? op.layerIds) ? (op.layers ?? op.layerIds) : null;
  const target = typeof layerRef === "string" ? names.layer(layerRef)
    : layers?.length ? `${layers.slice(0, 2).map((ref) => names.layer(String(ref))).join(", ")}${layers.length > 2 ? ` +${layers.length - 2}` : ""}`
      : typeof (op.scene ?? op.sceneId) === "string" && name.endsWith("_scene") ? names.scene(op.scene ?? op.sceneId)
        : typeof op.name === "string" ? plain(op.name) : "";
  if (name === "add_layer") {
    const layerType = op.layerType ?? (op.op ? op.type : undefined) ?? "layer";
    const title = op.name ?? op.properties?.name ?? op.properties?.text ?? "";
    return `add ${plain(layerType)} ${plain(title)}`.trim();
  }
  if (name === "update_layer" && typeof layerRef === "string") {
    const keys = Object.keys(op.properties ?? {});
    const verb = only(keys, MOVE) ? "move" : only(keys, RESIZE) ? "resize" : only(keys, ["rotation"]) ? "rotate" : "change";
    return `${verb} ${target}`;
  }
  if (name === "delete_layer" || name === "remove_layer") return `delete ${target}`.trim();
  if (name === "add_animation" && target) return `animate ${target}`;
  return `${words(name)} ${target}`.trim();
}

function lookLabel(input, names) {
  const mode = input.mode ?? "sheet";
  const where = typeof input.scene === "string" ? ` in ${names.scene(input.scene)}` : "";
  const has = (value) => Number.isFinite(value);
  if (mode === "frame") return has(input.t) ? `look at ${timeText(input.t)} s${where}` : `look at the middle frame${where}`;
  if (mode === "sheet") {
    if (has(input.from) || has(input.to)) {
      if (!has(input.to)) return `look at ${timeText(input.from)} s to the end${where}`;
      return `look at ${rangeText([has(input.from) ? input.from : 0, input.to])}${where}`;
    }
    if (typeof input.scene === "string") return `look at the whole ${names.scene(input.scene)}`;
    return names.count() > 1 ? "look at every scene" : "look at the whole scene";
  }
  const layer = typeof input.layer === "string" ? names.layer(input.layer) : "a layer";
  if (mode === "zoom") return `zoom on ${layer}`;
  if (mode === "source") return `look at the source of ${layer}`;
  if (mode === "strip") return `look at the motion ${typeof input.anim === "string" ? plain(input.anim) : ""}`.trim();
  if (mode === "compare") return Number.isSafeInteger(input.rev) ? `compare with rev ${input.rev}` : "compare with a rev";
  if (mode === "changed") return "look at what changed";
  if (mode === "variants") return "look at the variants";
  if (mode === "board") return "look at the storyboard";
  return `look ${words(mode)}`;
}

function projectLabel(input) {
  const action = input.action ?? "list";
  const id = typeof input.id === "string" ? ` ${plain(input.id)}` : "";
  if (action === "share") return "create a share link";
  if (action === "list") return "list projects";
  if (action === "create") return `create project ${plain(input.name ?? input.id ?? "")}`.trim();
  if (action === "import") return `import ${path.basename(String(input.file ?? input.name ?? "a file").replace(/\\/g, "/"))}`;
  if (action === "manage") {
    const { resource, action: inner } = input.options ?? {};
    if (resource === "shares" && inner === "create") return "create a share link";
    return `manage ${words(resource ?? "")} ${words(inner ?? "")}`.replace(/\s+/g, " ").trim();
  }
  return `${words(action)} project${id}`;
}

/**
 * The label of one call: plain text of at most 60 characters. `document` and `codes` (the
 * project before the call) give the names of the layers and scenes it names.
 */
export function callLabel(verb, input = {}, { document = null, codes = null } = {}) {
  const asked = input && typeof input === "object" ? input : {};
  const names = namer(document, codes);
  let label;
  if (verb === "edit") {
    const ops = Array.isArray(asked.ops) ? asked.ops : [];
    label = typeof asked.retry === "string" ? `retry ${plain(asked.retry)}` : ops.length ? opLabel(ops[0], names) : "edit";
    if (ops.length > 1) label += ` +${ops.length - 1} more`;
    if (asked.dry_run === true) label = `try: ${label}`;
  } else if (verb === "look") label = lookLabel(asked, names);
  else if (verb === "inspect") {
    const targets = (Array.isArray(asked.targets) ? asked.targets : asked.targets != null ? [asked.targets] : []).map(String);
    label = `inspect ${targets.slice(0, 4).map((ref) => names.layer(ref)).join(", ")}${targets.length > 4 ? ` +${targets.length - 4}` : ""}`;
  } else if (verb === "check") {
    const what = typeof asked.scene === "string" ? names.scene(asked.scene) : "the video";
    label = asked.fix === "auto" || asked.fix === true ? `check and fix ${what}` : `check ${what}`;
  } else if (verb === "status") label = typeof asked.scene === "string" ? `read the outline of ${names.scene(asked.scene)}` : "read the outline";
  else if (verb === "render") {
    const action = asked.action ?? "start";
    const job = typeof asked.job === "string" ? plain(asked.job) : "the render";
    if (action === "wait") label = `wait for ${job}`;
    else if (action === "cancel") label = `cancel ${job}`;
    else if (action === "status" || action === "queue") label = "check the renders";
    else label = `render a ${asked.quality === "final" ? "final" : "draft"}${typeof asked.format === "string" ? ` ${plain(asked.format)}` : ""}${typeof asked.scene === "string" && asked.scene !== "all" ? ` of ${names.scene(asked.scene)}` : ""}`;
  } else if (verb === "library") {
    const topic = typeof asked.topic === "string" ? asked.topic : "topics";
    const name = Array.isArray(asked.name) ? asked.name.map(String).join(", ") : typeof asked.name === "string" ? asked.name : "";
    if (topic === "op" || topic === "rules") label = `read ${topic === "op" ? "op" : "rules"} ${plain(name)}`.trim();
    else if (typeof asked.search === "string") label = `search ${words(topic)} for ${plain(asked.search)}`;
    else label = `read the library ${words(topic)}`;
  } else if (verb === "history") {
    const action = asked.action ?? "list";
    if (action === "revert") label = `revert ${typeof asked.turn === "string" ? plain(asked.turn) : "the last turn"}`;
    else if (action === "restore") label = `restore rev ${Number.isSafeInteger(asked.rev) ? asked.rev : "?"}`;
    else label = "read the history";
  } else if (verb === "notes") {
    const action = asked.action ?? "list";
    const id = typeof asked.id === "string" ? plain(asked.id) : "";
    label = { list: "read the notes", set_plan: "update the plan", add: "add a note", reply: `reply to ${id}`, resolve: `resolve ${id}`,
      brief: "save the brief", checkpoint: `ask the ${id} stop`, answer: `record the answer to ${id}` }[action] ?? `notes ${words(action)}`;
  } else if (verb === "project") label = projectLabel(asked);
  else label = words(verb);
  return cut(plain(label).replace(/\s+/g, " ").trim() || words(verb), LABEL_LENGTH);
}

/**
 * The words for what a call is about, for screen readers: "Title, 1.0–2.0 s", "0.5 s", "intro".
 * `where` is {sceneId, layerIds, time, range}; returns the presence target (live.mjs).
 */
export function callTarget(document, codes, { sceneId = null, layerIds = [], time = null, range = null } = {}) {
  const names = namer(document, codes);
  const ids = (layerIds ?? []).filter((id) => typeof id === "string").slice(0, 20);
  const scene = sceneId ? document?.scenes?.find((entry) => entry.id === sceneId) : null;
  const sceneName = sceneId ? names.sceneOfId(sceneId) : null;
  const parts = [];
  if (ids.length) parts.push(`${ids.slice(0, 3).map((id) => names.layerOfId(id)).join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}`);
  if (Array.isArray(range)) parts.push(rangeText(range));
  else if (Number.isFinite(time)) parts.push(`${timeText(time)} s`);
  const text = parts.join(", ") || sceneName || "the video";
  return { sceneId: scene?.id ?? sceneId ?? null, sceneName, layerIds: ids, time: Number.isFinite(time) ? time : null, range: Array.isArray(range) ? range : null, text };
}

/**
 * The text after "pointing " in the agent's status, for what the person selected: layers, a
 * time range in a scene, or both. `selected` is {sceneId, layerIds, range?, where?}; null when
 * nothing is selected.
 */
export function pointingText(selected, { codes } = {}) {
  const layerIds = Array.isArray(selected?.layerIds) ? selected.layerIds : [];
  const range = Array.isArray(selected?.range) ? selected.range : null;
  if (!layerIds.length && !range) return null;
  const names = layerIds.slice(0, 5).map((id) => refName(id, codes)).join(", ");
  const who = `(you selected ${layerIds.length > 1 ? "them" : "it"} in the ${selected.where ?? "editor"})`;
  if (!range) return `${names} ${who}`;
  const span = `${rangeText(range)} in ${refName(selected.sceneId, codes)}`;
  return `${names ? `${names} at ` : ""}${span} ${who}`;
}
