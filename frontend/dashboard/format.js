// Small text helpers for the dashboard. Everything here returns plain strings, so the panes
// stay text on a character grid (plan §5.10).

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** 2.4 → "00:02.40" */
export function clock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** 640 → "640", 3120 → "3.1k" */
export function tokens(count) {
  const value = Math.max(0, Math.round(Number(count) || 0));
  return value < 1000 ? String(value) : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

/** 1536 → "1.5 KB" */
export function bytes(count) {
  const value = Math.max(0, Number(count) || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A braille progress bar: 0.72 over 5 cells → "⣿⣿⣿⣶⣀". */
export function progressBar(fraction, cells = 5) {
  const steps = ["⣀", "⣤", "⣶", "⣿"];
  const value = Math.min(1, Math.max(0, Number(fraction) || 0)) * cells;
  let text = "";
  for (let cell = 0; cell < cells; cell += 1) {
    const fill = Math.min(1, Math.max(0, value - cell));
    text += fill >= 1 ? "⣿" : steps[Math.min(steps.length - 1, Math.floor(fill * steps.length))];
  }
  return text;
}

/** An ISO time on this computer's 24-hour clock: "14:02". Empty for a missing or bad time. */
export function timeOfDay(iso) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How long ago, short: "4s", "3m", "2h", "5d". */
export function ago(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** About how many tokens an image costs an agent (width × height / 750). */
export function imageTokens(width, height) {
  return Math.ceil(((Number(width) || 0) * (Number(height) || 0)) / 750);
}

// A note's delivery state as the dashboard shows it (plan §5.6).
const NOTE_STATES = {
  new: { word: "queued", symbol: "○" },
  seen: { word: "delivered", symbol: "◐" },
  addressed: { word: "delivered", symbol: "◐" },
  resolved: { word: "addressed", symbol: "●" },
};
export function noteState(note) {
  return NOTE_STATES[note?.status] ?? NOTE_STATES.new;
}

/** Cuts text to `length` characters with an ellipsis. */
export function cut(text, length) {
  const value = String(text ?? "");
  return value.length > length ? `${value.slice(0, Math.max(0, length - 1))}…` : value;
}

// The fields that name what a fix changes, the most specific first.
const FIX_TARGETS = ["animationId", "layerId", "sceneId", "animation", "layer", "scene"];
// At most this many values are named; more end with "…".
const FIX_VALUES = 4;

/**
 * A check's fix in plain words. An instruction stays as it is; an edit operation becomes its op,
 * what it changes and its new values ({op: "update_animation", animationId: "A1", properties:
 * {duration: 0.8}} → "update_animation A1 · duration 0.8"). Its other fields are named the same way
 * ({op: "move_layer", layerId: "L1", index: 0} → "move_layer L1 · index 0"), a value that is itself
 * a list or an object is written as words too ("from x 10, y 20"), and a list of edits is joined
 * with "; ". So no braces or quotes show.
 */
export function fixWords(fix) {
  if (fix == null || fix === "") return "";
  if (typeof fix === "string") return fix;
  if (Array.isArray(fix)) return fix.map(fixWords).filter(Boolean).join("; ");
  if (typeof fix !== "object") return String(fix);
  const { op, properties } = fix;
  const targetKey = FIX_TARGETS.find((key) => typeof fix[key] === "string" || typeof fix[key] === "number");
  const fields = Object.entries(fix).filter(([key, value]) => key !== "op" && key !== targetKey && key !== "properties" && value != null && value !== "");
  const changes = properties && typeof properties === "object" && !Array.isArray(properties) ? Object.entries(properties) : [];
  const named = [...fields, ...changes].map(([key, value]) => `${key} ${fixValue(value)}`);
  const values = named.length > FIX_VALUES ? [...named.slice(0, FIX_VALUES), "…"] : named;
  return [[op, targetKey ? fix[targetKey] : null].filter((part) => part != null && part !== "").join(" "), values.join(", ")].filter(Boolean).join(" · ");
}
function fixValue(value, depth = 0) {
  if (typeof value === "string") return cut(value, 32);
  if (value === null || typeof value !== "object") return String(value);
  if (depth > 0) return "…";
  const words = Array.isArray(value)
    ? value.map((item) => fixValue(item, depth + 1)).join(", ")
    : Object.entries(value).map(([key, item]) => `${key} ${fixValue(item, depth + 1)}`).join(", ");
  return cut(words, 32);
}

/** "frame-0a1b2c3d4e5f.png" → "frame" */
export function imageKind(file) {
  return String(file ?? "").split("/").pop().split("-")[0] || "image";
}

/** The file name at the end of a path, for both / and \ separators. */
export function baseName(file) {
  return String(file ?? "").split(/[\\/]/).pop();
}

/**
 * A log row's words for a call: its label ("move Title"), with what happened when it did not
 * run as asked ("move Title · held: …", a stop's refusal, "waits for your approval Q1" or a
 * failure), else the summary.
 */
export function callLine(call) {
  if (!call?.label) return `${call?.verb ?? ""} ${callSummary(call)}`;
  if (call.approval && !call.isError) return `${call.label}, waits for your approval ${call.approval}`;
  return call.held || call.waiting || call.isError ? [call.label, callSummary(call)].filter(Boolean).join(", ") : call.label;
}

/** One line about a call. Edit receipts are JSON, so they become "card, headline → rev 2". */
export function callSummary(call) {
  const text = String(call?.summary ?? "");
  if (call?.verb !== "edit" || !text.startsWith("{")) return text;
  // The input arrives as compact JSON text, cut at 600 characters.
  const asked = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
  const rev = call.rev ?? text.match(/"rev":(\d+)/)?.[1];
  const after = rev ? ` → rev ${rev}` : "";
  const retry = asked.match(/"retry":"([^"]+)"/)?.[1];
  if (retry) return `retry ${retry}${after}`;
  const names = [...new Set([...asked.matchAll(/"(?:name|layer|layerId|scene|sceneId)":"([^"]{1,40})"/g)].map((match) => match[1]))];
  const kinds = [...new Set([...asked.matchAll(/"op":"([a-z_]+)"/g)].map((match) => match[1]))];
  const what = names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}` : kinds.slice(0, 2).join(", ") || "edit";
  return `${what}${after}`;
}
