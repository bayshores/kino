// The timeline pane's facts, as plain functions (tested in frontend/dashboardTimeline.test.js):
// - when each layer is on screen,
// - which layers changed since you last looked, and the ▾ marks for them on the ruler,
// - who changed a layer last, for the hover card,
// - the video's parts for the story row (the storyboard's shots, else named cues).
// The React side is timeline.jsx.
import { animationTreeEntries } from "../../engine/animationTree.js";
import { mainScene, NONE } from "../../engine/board.js";
import { mediaPlaybackRange } from "../../engine/playback.js";
import { hiddenRanges } from "../../engine/visibilityOps.js";
import { callAgent } from "./state.js";

// ---- when a layer is on screen ----------------------------------------------------------

/**
 * When a layer is on screen, as [[start, end], …] in scene seconds: a video or audio layer while
 * it plays, any other layer the whole scene; minus the times its Hide and Show operations hide it.
 * A layer hidden with the eye button is never on screen ([]).
 */
export function onScreenRanges(layer, duration) {
  if (!layer || !(duration > 0) || layer.visible === false) return [];
  let start = 0;
  let end = duration;
  if (layer.type === "video" || layer.type === "audio") {
    const play = mediaPlaybackRange(layer, duration);
    if (!play) return [];
    start = play.start;
    end = play.end;
  }
  let ranges = [[start, end]];
  for (const hidden of hiddenRanges(layer.animations ?? [], duration)) {
    ranges = ranges.flatMap(([from, to]) => {
      if (hidden.end <= from || hidden.start >= to) return [[from, to]];
      return [[from, Math.min(to, hidden.start)], [Math.max(from, hidden.end), to]].filter(([a, b]) => b - a > 1e-6);
    });
  }
  return ranges;
}

/** "0:48–0:51" (or "1.2–3.5 s" in a scene under a minute). */
export function spanText([start, end], duration) {
  if (duration < 60) {
    const short = (seconds) => String(Math.round(seconds * 10) / 10);
    return `${short(start)}–${short(end)} s`;
  }
  const clock = (seconds) => {
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };
  return `${clock(start)}–${clock(end)}`;
}

// ---- what changed, and who changed it ---------------------------------------------------

/** The browser's memory of the revision you last looked at in each project (null: never). */
const seenKey = (projectId) => `kino.dashboard.timeline-seen.${projectId}`;
export function readSeenRev(projectId) {
  try {
    const value = Number(localStorage.getItem(seenKey(projectId)));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}
export function saveSeenRev(projectId, rev) {
  try { localStorage.setItem(seenKey(projectId), String(rev)); } catch { /* not kept: marks come back after a reload */ }
}

const lastAfter = (turn) => turn?.edits?.at(-1)?.after ?? null;

/**
 * The turns whose changes the timeline names: the last `recent` turns with edits (for "who changed
 * it last") and every turn with an edit after `seenRev` (for "new since you looked", at most 40).
 * Reverted turns are left out: their changes are gone. Oldest first.
 */
export function turnsToReview(turns, seenRev, recent = 12) {
  const kept = (turns ?? []).filter((turn) => turn.edits?.length && !turn.reverted);
  const fresh = seenRev == null ? [] : kept.filter((turn) => lastAfter(turn) > seenRev).slice(-40);
  const ids = new Set([...kept.slice(-recent), ...fresh].map((turn) => turn.id));
  return kept.filter((turn) => ids.has(turn.id));
}

/**
 * The layers of `scene` that a turn review (GET /dashboard/turn) lists as created or changed.
 * The review names each thing as the agent reads it: its id when the id is readable, else its
 * code (`codes`: id → code). A changed animation counts for the layer it belongs to.
 */
export function reviewLayerIds(changes, scene, codes = {}) {
  if (!changes || !scene) return [];
  const byId = codes?.byId ?? codes ?? {};
  const owner = new Map();
  for (const layer of scene.layers ?? []) {
    owner.set(layer.id, layer.id);
    if (byId[layer.id]) owner.set(byId[layer.id], layer.id);
    let entries = [];
    try { entries = animationTreeEntries(layer.animations ?? []); } catch { entries = []; }
    for (const { stored } of entries) {
      if (!stored?.id) continue;
      owner.set(stored.id, layer.id);
      if (byId[stored.id]) owner.set(byId[stored.id], layer.id);
    }
  }
  const found = new Set();
  for (const name of [...(changes.created ?? []), ...(changes.changed ?? [])]) if (owner.has(name)) found.add(owner.get(name));
  return [...found];
}

/**
 * Who made a turn's edits: "you", an agent's name (as the rest of the dashboard names it, also
 * for a call that carries no name: callAgent), or null when no edit call of it is known.
 */
export function turnAuthor(turnId, calls) {
  const edit = (calls ?? []).filter((call) => call.turn === turnId && call.verb === "edit" && !call.isError).at(-1);
  if (!edit) return null;
  if (edit.by === "you") return "you";
  return edit.agent?.name || callAgent(edit).name;
}

/**
 * Who changed each layer last: {layerId: {who, at, turn}}. `changes` is one entry per reviewed
 * turn, oldest first: {turn, at, who, layerIds}. `building` (the live view's entries, which name
 * the agent and the time) wins when it is newer.
 */
export function lastChanges(changes, building = [], agents = []) {
  const last = {};
  for (const entry of changes) for (const id of entry.layerIds) last[id] = { who: entry.who, at: entry.at, turn: entry.turn };
  for (const entry of building) {
    const was = last[entry.layerId];
    if (was && Date.parse(was.at) >= Date.parse(entry.at)) continue;
    const who = agents.find((agent) => agent.id === entry.agentId)?.name ?? null;
    last[entry.layerId] = { who, at: entry.at, turn: was?.turn ?? null };
  }
  return last;
}

/** The layers changed in the turns after `seenRev`: a Set of layer ids. */
export function newLayerIds(changes, seenRev) {
  const ids = new Set();
  if (seenRev == null) return ids;
  for (const entry of changes) if (entry.after > seenRev) for (const id of entry.layerIds) ids.add(id);
  return ids;
}

/**
 * The ▾ marks on the ruler: one at each new layer's first on-screen time; marks closer than
 * `gap` seconds become one (at the first). → [{at, count}]
 */
export function newMarks(times, gap) {
  const marks = [];
  for (const at of [...times].filter(Number.isFinite).sort((a, b) => a - b)) {
    const last = marks.at(-1);
    if (last && at - last.at < gap) last.count += 1;
    else marks.push({ at, count: 1 });
  }
  return marks;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function agoWords(iso, now) {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The hover card's lines (at most 3): the layer's name and when it is on screen, who changed it
 * last and when, and "new since you looked".
 */
export function hoverLines({ name, span, duration, change = null, isNew = false, now }) {
  const lines = [`${name}  ${span ? spanText(span, duration) : "not on screen"}`];
  if (change) {
    const when = agoWords(change.at, now);
    const turn = change.turn ? ` · ${change.turn}` : "";
    lines.push(change.who ? `${change.who} changed it ${when}${turn}` : `changed ${when}${turn}`);
  }
  if (isNew) lines.push("▾ new since you looked");
  return lines;
}

// ---- the story row ----------------------------------------------------------------------

// A storyboard shot's name: what it shows, else its words, else its id.
function shotName(shot) {
  if (shot.subject && shot.subject !== NONE && shot.subject.what) return shot.subject.what;
  if (shot.text && shot.text !== NONE && shot.text.text) return shot.text.text;
  return shot.id;
}

/**
 * The video's parts for the story row, as [{start, end, name}], or [] when the project names
 * none. From the storyboard's shots (on the main scene only), else from cues the agent named
 * (not the beat and onset marks, nor the line and word cues captions make): each named cue
 * starts a part that runs to the next one.
 */
const STORY_SKIPS = new Set(["beat", "onset", "line", "word"]);
export function storyParts(document, sceneId, duration) {
  const scene = (document?.scenes ?? []).find((entry) => entry.id === sceneId);
  if (!scene || !(duration > 0)) return [];
  const shots = document.board?.shots ?? [];
  if (shots.length && mainScene(document)?.id === sceneId) {
    return shots.map((shot) => ({ start: shot.cue, end: Math.min(duration, shot.cue + shot.dur), name: shotName(shot), id: shot.id }))
      .filter((part) => part.end > part.start);
  }
  const named = (document.cues ?? []).filter((cue) => cue?.name && !STORY_SKIPS.has(cue.kind) && Number.isFinite(cue.time) && cue.time < duration)
    .sort((a, b) => a.time - b.time);
  return named.map((cue, index) => ({ start: cue.time, end: named[index + 1]?.time ?? duration, name: cue.name }))
    .filter((part) => part.end > part.start);
}

/** The index of the part under `time`, or -1. */
export function partAt(parts, time) {
  return parts.findIndex((part, index) => time >= part.start && (time < part.end || (index === parts.length - 1 && time <= part.end)));
}
