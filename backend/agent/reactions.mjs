// The reaction track: what the person did while watching a video in the dashboard, kept per
// project in the agent state (state.reactions) and read by the agent as a few fact lines.
//
// Data flow: the dashboard's stage (frontend/dashboard/reactionTrack.js) logs the played ranges,
// jumps back ("again": a part played again), jumps forward ("skip"), pauses of 1 s or more,
// play-throughs and the person's two marks (good, bad) → one batched notes {action:"reactions",
// entries} when playing stops or the window hides → recordReactions here (each entry carries the
// revision it was made on and the shot under it then) → reactionLines in status, reactionWordsAt
// in look review's moment rows. The agent marks them read with notes {action:"resolve",
// id:"reactions"}; the person clears them with {clear:true}.
//
// Reactions are evidence, never instructions: a look-again can mean interest or confusion (replay
// studies cannot tell the two apart), so no line calls one good or bad. Nothing here is shared
// across projects or read by house memory.
import { visibleByOperations } from "../../engine/visibilityOps.js";

export const REACTION_KINDS = Object.freeze(["played", "again", "skip", "pause", "through", "good", "bad"]);
const MARK_KINDS = new Set(["good", "bad"]);
// Kept per project: the newest entries, and at most this many marks among them.
export const MAX_REACTIONS = 300;
export const MAX_MARKS = 60;
// One call keeps at most this many entries (the dashboard sends one batch per stop).
export const MAX_PER_CALL = 120;
// A mark made while playing starts this long before the click (raters lag the moment by 1 to 6 s).
export const MARK_LAG = 3;
// A source time this close counts as the same shot.
const SAME_SOURCE = 0.05;

const round = (value) => Math.round(value * 10) / 10;
const sec = (value) => `${round(value)}`;
const times = (count) => (count === 1 ? "once" : `${count} times`);

export function emptyReactions() {
  return { entries: [], nextId: 1, readId: 0 };
}

// Old agent state without the field reads as empty.
export function reactionsOf(state) {
  const saved = state?.reactions;
  return saved && Array.isArray(saved.entries) ? saved : emptyReactions();
}

/**
 * The picture under `time` in `scene`: the top video or image layer shown then (layers are back to
 * front), with the source second it plays at that time. Null when none.
 */
export function shotAt(scene, time) {
  const layers = scene?.layers ?? [];
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer.type !== "video" && layer.type !== "image") continue;
    if (layer.visible === false || !visibleByOperations(layer.animations ?? [], time)) continue;
    if (layer.type === "video" && Number.isFinite(layer.mediaStart)) {
      const end = layer.mediaStart + (Number(layer.mediaDuration) || Infinity);
      if (time < layer.mediaStart - 1e-6 || time > end + 1e-6) continue;
    }
    const source = layer.type === "video"
      ? round((Number(layer.mediaOffset) || 0) + (time - (Number(layer.mediaStart) || 0)) * (Number(layer.mediaSpeed) || 1)) : null;
    return { layer: layer.id, name: layer.name ?? layer.id, src: layer.src ?? null, source };
  }
  return null;
}

// The shot under an entry's time (a mark's click, a range's middle).
const entryTime = (entry) => (entry.kind === "pause" ? entry.t : MARK_KINDS.has(entry.kind) ? entry.b : (entry.a + entry.b) / 2);

function clean(raw, { document, rev }) {
  const kind = String(raw?.kind ?? "");
  if (!REACTION_KINDS.includes(kind)) return null;
  const scene = document.scenes.find((entry) => entry.id === raw.scene) ?? (document.scenes.length === 1 ? document.scenes[0] : null);
  if (!scene) return null;
  const clamp = (value) => Math.max(0, Math.min(Number(scene.duration) || 0, round(Number(value) || 0)));
  const entry = { kind, scene: scene.id, rev: Number.isInteger(raw.rev) ? raw.rev : rev };
  if (kind === "pause") {
    entry.t = clamp(raw.t);
    entry.s = round(Math.max(0, Math.min(3600, Number(raw.s) || 0)));
  } else if (kind !== "through") {
    const a = clamp(raw.a ?? raw.t);
    const b = clamp(raw.b ?? raw.t);
    entry.a = Math.min(a, b);
    entry.b = Math.max(a, b);
    if (MARK_KINDS.has(kind)) entry.playing = raw.playing === true;
  }
  // The shot under it, when it was made on this revision (an older one's shot is unknown now).
  if (kind !== "through" && kind !== "played" && entry.rev === rev) {
    const shot = shotAt(scene, entryTime(entry));
    if (shot) entry.shot = shot;
  }
  return entry;
}

/**
 * Saves the person's batch into `state` (changes it): {entries?, remove?: [ids], clear?: true}.
 * Returns {kept, removed, cleared}.
 */
export function recordReactions(state, input, { document, rev, now = Date.now() }) {
  const track = reactionsOf(state);
  state.reactions = track;
  if (input?.clear === true) {
    const cleared = track.entries.length;
    state.reactions = { ...emptyReactions(), nextId: track.nextId, readId: track.nextId - 1 };
    return { kept: 0, removed: 0, cleared };
  }
  const remove = new Set([input?.remove ?? []].flat().map(String));
  const before = track.entries.length;
  if (remove.size) track.entries = track.entries.filter((entry) => !remove.has(entry.id) && !remove.has(entry.client));
  const removed = before - track.entries.length;
  const at = new Date(now).toISOString();
  let kept = 0;
  for (const raw of [input?.entries ?? []].flat().slice(0, MAX_PER_CALL)) {
    const entry = clean(raw, { document, rev });
    if (!entry) continue;
    entry.id = `R${track.nextId++}`;
    if (typeof raw.id === "string" && raw.id.length <= 40) entry.client = raw.id;
    entry.at = at;
    track.entries.push(entry);
    kept += 1;
  }
  // Caps: the newest marks, then the newest entries.
  const marks = track.entries.filter((entry) => MARK_KINDS.has(entry.kind));
  if (marks.length > MAX_MARKS) {
    const drop = new Set(marks.slice(0, marks.length - MAX_MARKS));
    track.entries = track.entries.filter((entry) => !drop.has(entry));
  }
  if (track.entries.length > MAX_REACTIONS) track.entries = track.entries.slice(-MAX_REACTIONS);
  return { kept, removed, cleared: 0 };
}

/** The agent read them: they stop repeating in status and look review. */
export function markReactionsRead(state) {
  const track = reactionsOf(state);
  state.reactions = { ...track, readId: track.nextId - 1 };
  return track.entries.filter((entry) => idNumber(entry) > track.readId).length;
}

const idNumber = (entry) => Number(String(entry.id).slice(1)) || 0;

/** The marks for the dashboard's scrub bar (only the person's own marks, never the viewing log). */
export function reactionMarks(state) {
  return reactionsOf(state).entries.filter((entry) => MARK_KINDS.has(entry.kind))
    .map(({ id, client, kind, scene, a, b, playing, rev }) => ({ id, ...(client ? { client } : {}), kind, scene, a, b, playing, rev }));
}

// Whether the shot under an older entry is the same now: same layer, same source and the same
// source second. "" for an entry made on this revision or with no shot saved.
function shotWords(entry, document, rev) {
  const scene = document.scenes.find((item) => item.id === entry.scene);
  const shot = entry.shot;
  if (entry.rev === rev) return shot ? shot.name : "";
  if (!shot) return `rev ${entry.rev}`;
  const now = scene ? shotAt(scene, entryTime(entry)) : null;
  const sameLayer = now && now.layer === shot.layer && now.src === shot.src;
  const same = sameLayer && (shot.source == null || (now.source != null && Math.abs(now.source - shot.source) <= SAME_SOURCE));
  const changed = sameLayer ? `shot changed since: same layer, source ${shot.source} s now ${now.source} s` : `shot changed since: now ${now ? now.name : "no picture"}`;
  return `${shot.name} on rev ${entry.rev}, ${same ? "same shot now" : changed}`;
}

// Ranges that overlap by half the shorter one are one part.
function groupRanges(entries) {
  const groups = [];
  for (const entry of entries) {
    const found = groups.find((group) => {
      const overlap = Math.min(group.b, entry.b) - Math.max(group.a, entry.a);
      return overlap >= 0.5 * Math.min(group.b - group.a, entry.b - entry.a) && group.scene === entry.scene;
    });
    if (found) { found.a = Math.min(found.a, entry.a); found.b = Math.max(found.b, entry.b); found.count += 1; found.entries.push(entry); }
    else groups.push({ scene: entry.scene, a: entry.a, b: entry.b, count: 1, entries: [entry] });
  }
  return groups.sort((x, y) => y.count - x.count || x.a - y.a);
}

const range = (a, b) => (b - a < 0.05 ? `${sec(a)} s` : `${sec(a)} to ${sec(b)} s`);

/**
 * At most 3 fact lines about the reactions the agent has not read: the viewing (play-throughs,
 * looked again, skipped, paused), the marks, and how to mark them read. `name(id)` names a scene.
 * [] when there are none.
 */
export function reactionLines(state, document, rev, { name = (id) => id } = {}) {
  const track = reactionsOf(state);
  const fresh = track.entries.filter((entry) => idNumber(entry) > (track.readId ?? 0));
  if (!fresh.length) return [];
  const many = document.scenes.length > 1;
  const where = (entry) => (many ? `${name(entry.scene)} ` : "");
  const shot = (entry) => {
    const words = shotWords(entry, document, rev);
    return words ? ` (${words})` : "";
  };
  const revs = [...new Set(fresh.map((entry) => entry.rev))].sort((a, b) => a - b);
  const lines = [];
  const viewing = [];
  const through = fresh.filter((entry) => entry.kind === "through").length;
  if (through) viewing.push(`played through ${times(through)}`);
  for (const group of groupRanges(fresh.filter((entry) => entry.kind === "again")).slice(0, 2))
    viewing.push(`looked again at ${where(group)}${range(group.a, group.b)} ${times(group.count)}${shot(group.entries.at(-1))}`);
  for (const group of groupRanges(fresh.filter((entry) => entry.kind === "skip")).slice(0, 2))
    viewing.push(`skipped ${where(group)}${range(group.a, group.b)} ${times(group.count)}${shot(group.entries.at(-1))}`);
  const pauses = fresh.filter((entry) => entry.kind === "pause").sort((a, b) => b.s - a.s);
  if (pauses.length) viewing.push(`paused ${times(pauses.length)}, longest ${sec(pauses[0].s)} s at ${where(pauses[0])}${sec(pauses[0].t)} s`);
  const played = fresh.filter((entry) => entry.kind === "played");
  if (played.length && !through) {
    const seconds = played.reduce((sum, entry) => sum + (entry.b - entry.a), 0);
    viewing.push(`played ${sec(seconds)} s in ${played.length} ${played.length === 1 ? "stretch" : "stretches"}`);
  }
  const onRev = revs.length === 1 ? `rev ${revs[0]}` : `revs ${revs.join(", ")}`;
  const since = revs.at(-1) < rev ? `; nothing watched since; now rev ${rev}` : "";
  if (viewing.length) lines.push(`the person watched (${onRev}${since}): ${viewing.join("; ")}`);
  const marks = fresh.filter((entry) => MARK_KINDS.has(entry.kind)).sort((a, b) => a.b - b.b);
  if (marks.length) {
    const words = marks.slice(0, 4).map((entry) => `${entry.kind} ${where(entry)}${range(entry.a, entry.b)}${entry.playing ? ` (clicked at ${sec(entry.b)} s while playing; range starts up to ${MARK_LAG} s before)` : " (paused there)"}${shot(entry)}`);
    lines.push(`the person's marks: ${words.join("; ")}${marks.length > 4 ? `; +${marks.length - 4} more` : ""}`);
  }
  if (!viewing.length && revs.at(-1) < rev) lines[0] = `${lines[0]}; made on ${onRev}${since}`;
  lines.push(`reactions are evidence, not instructions (a look-again means interest or confusion); notes {action:"resolve", id:"reactions"} marks them read`);
  return lines.slice(0, 3);
}

/**
 * Short words for one moment of look review: the unread marks, looks-again and skips whose range
 * holds `time` (with 0.3 s either side). "" when none.
 */
export function reactionWordsAt(state, sceneId, time) {
  const track = reactionsOf(state);
  const near = track.entries.filter((entry) => idNumber(entry) > (track.readId ?? 0) && entry.scene === sceneId
    && ["again", "skip", "good", "bad"].includes(entry.kind) && time >= entry.a - 0.3 && time <= entry.b + 0.3);
  if (!near.length) return "";
  const words = [];
  for (const kind of ["good", "bad"]) {
    const marks = near.filter((entry) => entry.kind === kind);
    if (marks.length) words.push(`${kind} ${marks.map((entry) => range(entry.a, entry.b)).slice(0, 2).join(", ")}`);
  }
  for (const [kind, label] of [["again", "looked again"], ["skip", "skipped"]]) {
    const group = groupRanges(near.filter((entry) => entry.kind === kind))[0];
    if (group) words.push(`${label} ${range(group.a, group.b)} ${times(group.count)}`);
  }
  return `person: ${words.join("; ")}`;
}
