// Notes on the frame, as plain functions (tested in frontend/dashboardNotes.test.js). The React side
// is in panes.jsx (the stage's dots and the notes view) and Dashboard.jsx (the note bubble).
//   snapNote     a click on the stage: the layer under it (its whole group), outlined, or the spot
//   noteNumber   "N4" → "4", the number on a note's dot
//   noteDot      where a note's dot sits on the frame
//   bubbleSide   which side of the dot the note bubble opens on
//   noteStatus   a note's chip: queued, working, fixed or done
//   noteGroups   the notes view's parts: stopped, open, always, done
//   noteReader   the agent that reads the notes, for the line under the message box
import { layerBounds } from "../layerBounds.js";
import { pickLayer, topmostFirst } from "../../engine/selection.js";

// A layer that covers more of the frame than this (a background, a full-frame clip) is not what
// a click points at: the note keeps the spot instead.
const MOST_OF_FRAME = 0.6;

function sceneBox(document, scene, ids, time) {
  try {
    const found = layerBounds(document, scene, ids, time);
    return found ? { x: found.x + scene.width / 2, y: found.y + scene.height / 2, width: found.width, height: found.height } : null;
  } catch { return null; }
}

const inside = (box, point) => box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;

/**
 * What a click at `point` (scene pixels) on the frame at `time` points at: the layer under it, as
 * a plain click on the canvas picks it (the outermost group around it), with that layer's box as
 * the note's area. A layer that covers most of the frame does not count. Nothing under the
 * click: the spot itself, a 1×1 area. Returns { area, layerId, point }.
 */
export function snapNote(document, scene, point, time = null) {
  const spot = { area: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 }, layerId: null, point: { x: Math.round(point.x), y: Math.round(point.y) } };
  if (!document || !scene?.layers?.length) return spot;
  const frame = scene.width * scene.height;
  const under = scene.layers.filter((layer) => layer.type !== "audio" && layer.visible !== false && inside(sceneBox(document, scene, [layer.id], time), point)).map((layer) => layer.id);
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  // From the top down: each layer a click can pick (locked and hidden ones let it through), and
  // in it the outermost group, or the layer itself, that is smaller than most of the frame.
  for (const id of topmostFirst(scene.layers, under)) {
    if (!pickLayer(scene.layers, [id], [], { deep: true })) continue;
    const chain = [];
    for (let layer = byId.get(id); layer; layer = byId.get(layer.parentId)) chain.unshift(layer.id);
    for (const candidate of chain) {
      const box = sceneBox(document, scene, [candidate], time);
      if (box && box.width * box.height <= frame * MOST_OF_FRAME) {
        return { area: { x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) }, layerId: candidate, point: spot.point };
      }
    }
  }
  return spot;
}

/**
 * Where a click on the share-link viewer's frame puts a new comment: `hit` ({sceneId, x, y}) and,
 * by the same rule as notes, the layer under it (layerId). Null stays null (a click off the frame).
 */
export function snapComment(document, scene, hit, time = null) {
  if (!hit) return null;
  const { layerId } = snapNote(document, scene, hit, time);
  return layerId ? { ...hit, layerId } : hit;
}

/** The number on a note's dot: the digits of its id ("N4" → "4"), else the id. */
export function noteNumber(id) {
  const digits = String(id ?? "").match(/\d+/);
  return digits ? digits[0] : String(id ?? "");
}

/** Where a note's dot sits, in scene pixels: the spot it was made at, else its area's middle. */
export function noteDot(note) {
  if (note?.point) return note.point;
  const area = note?.area;
  if (!area) return null;
  return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
}

/**
 * The side of the dot the note bubble opens on, so it stays on the frame: "left" when the dot is
 * in the right half, else "right". No dot (a note on the whole frame): "center".
 */
export function bubbleSide(dot, scene) {
  if (!dot || !scene?.width) return "center";
  return dot.x > scene.width / 2 ? "left" : "right";
}

/**
 * A note's state as one chip for the notes view: queued until the agent's next call takes it,
 * working once it read it, fixed when it replied, done when you said it looks good.
 */
export function noteStatus(note) {
  if (note?.status === "resolved") return { kind: "done", words: "done", mark: "✓" };
  if (note?.status === "addressed") return { kind: "fixed", words: "fixed", mark: "✓" };
  if (note?.status === "seen") return { kind: "working", words: "working", mark: "◉" };
  // Handed to the agent (a Claude Code channel or `kino watch`), not read yet.
  if (note?.channelAt) return { kind: "queued", words: "sent", mark: "→" };
  return { kind: "queued", words: "queued", mark: "◷" };
}

/**
 * The notes view's parts, top to bottom: the stopped edits, the open notes (as given, newest
 * first), the always notes and the done ones (an always note stays under "always", not "done").
 */
export function noteGroups(notes = [], stopped = []) {
  return {
    stopped,
    open: notes.filter((note) => note.status !== "resolved"),
    always: notes.filter((note) => note.always),
    done: notes.filter((note) => note.status === "resolved" && !note.always),
  };
}

/** The rows the note cursor steps through: the stopped edits, then the open notes. */
export const noteCursorRows = (groups) => [
  ...groups.stopped.map((item) => ({ type: "stopped", id: item.id, item })),
  ...groups.open.map((note) => ({ type: "note", id: note.id, note })),
];

/** What waits for the person in the notes view: fixed notes to look at and stopped edits. */
export const notesForYou = (notes = [], stopped = []) => notes.filter((note) => note.status === "addressed").length + stopped.length;

// An agent counts as on the project this long after its last call there.
const READING_MS = 10 * 60_000;

/**
 * The name of the agent that reads this project's notes: a crew member on the project that has
 * not ended, else an agent that called kino in the project in the last 10 minutes. Null if none.
 */
export function noteReader(data, now = Date.now()) {
  const project = data?.projectId;
  if (!project) return null;
  const member = (data.crew?.members ?? []).find((row) => row.projectId === project && !["asleep", "stopped", "done"].includes(row.state));
  if (member) return member.name;
  const agent = (data.agents ?? []).filter((row) => row.projectId === project && now - Date.parse(row.lastAt) < READING_MS)
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0];
  return agent?.name ?? null;
}

/** The line under the message box. */
export const readerLine = (name) => (name ? `${name} reads notes between steps` : "notes wait until an agent starts");
