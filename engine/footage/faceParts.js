// Where a part of a face sits in a footage frame, for place {layers, on, of} (backend/agent/blocks.mjs
// and blocks-layout.mjs): text or a line set on a mouth, the eyes, between the eyes, the face or
// above the head. kino keeps face boxes only (Vision face rectangles, kino-measure.swift job 16, and
// the agent's own mark_subject boxes), no landmarks, so a part is either a box the agent marked
// for that part (exact) or a share of a face box (an estimate the receipt names as one).
// Boxes are [x, y, w, h] in % of the source frame, top-left origin (engine/sourceView.js).
import { boxEntry } from "./layout.js";

export const FACE_PARTS = Object.freeze(["mouth", "eyes", "between-eyes", "face", "above-head"]);

// Each part's center as shares of a face box ([x, y], 0 at the box's left and top edge).
// head: a box the agent marked around the head (framing.md: "a face: the head", hair to chin).
//   mouth 0.81: measured on the type-on-feature study's drawn face (head box y 4.2% to 95.8% of the
//   frame, the open mouth's center at 855 px of 1080: 0.82); a real head puts the mouth near 0.79
//   (classical proportions, a guess), so 0.81 sits between them.
//   eyes 0.43: a guess between that drawn face (0.39) and a real head (about 0.47, eyes at half
//   the head's height less the hair).
//   face 0.62: a guess, the middle of the face below the hair (between the eyes and the mouth).
// detected: a Vision face rectangle, brow to chin and tighter than a head: all guesses, not measured.
export const PART_SHARES = Object.freeze({
  head: Object.freeze({ mouth: [0.5, 0.81], eyes: [0.5, 0.43], "between-eyes": [0.5, 0.43], face: [0.5, 0.62] }),
  detected: Object.freeze({ mouth: [0.5, 0.78], eyes: [0.5, 0.38], "between-eyes": [0.5, 0.38], face: [0.5, 0.55] }),
});

// A mark or a measured face counts for a moment this many file seconds away (samples come twice a second).
export const FACE_REACH = 0.5;
// A face counts when it is at least 0.4% of the frame (as engine/footage/layout.js FACE_AREA).
const FACE_AREA = 0.004;
// A mark without a part is taken as the head when it is no taller than this many times its width
// (a guess: a head box is about 1.3; a standing person is 2.5 or more).
const HEAD_SHAPE = 1.6;

const partOf = (entry) => String(entry?.part ?? "").trim().toLowerCase();

/**
 * The face box to place on for `on` at file second `sourceTime`, or null when none is near:
 *   {box, how: "part" | "head" | "detected", at}
 * part: a mark the agent made for that very part (mark_subject {part:"mouth"}; an "eyes" strip also
 * serves between-eyes); head: a mark of the face or head (part "face" or "head", or a mark without
 * a part shaped like a head); detected: the largest face kino measured in the file. A nearer mark
 * of the same kind wins; a part mark beats a head mark, and any mark beats a measured face.
 * `marks` are a video layer's subjectBoxes.boxes, `samples` its saved [{t, faces, subjects?}]
 * (fractions), `size` the file's {width, height} (for the head shape; null reads % as square).
 */
export function pickFace({ marks = [], samples = [], sourceTime, on, size = null, reach = FACE_REACH }) {
  const near = (marks ?? []).filter((entry) => Array.isArray(entry?.box) && Math.abs(entry.at - sourceTime) <= reach + 1e-9)
    .sort((a, b) => Math.abs(a.at - sourceTime) - Math.abs(b.at - sourceTime));
  const exact = near.find((entry) => partOf(entry) === on || (on === "between-eyes" && partOf(entry) === "eyes"));
  if (exact && on !== "above-head") return { box: exact.box, how: "part", at: exact.at };
  const aspect = size?.width > 0 && size?.height > 0 ? size.height / size.width : 1;
  const head = near.find((entry) => {
    const part = partOf(entry);
    if (part === "face" || part === "head") return true;
    return !part && (entry.box[3] * aspect) / entry.box[2] <= HEAD_SHAPE;
  });
  if (head) return { box: head.box, how: "head", at: head.at };
  const measured = (samples ?? []).filter((sample) => Number.isFinite(sample?.t) && Math.abs(sample.t - sourceTime) <= reach + 1e-9)
    .sort((a, b) => Math.abs(a.t - sourceTime) - Math.abs(b.t - sourceTime));
  for (const sample of measured) {
    const faces = (Array.isArray(sample.subjects) ? sample.subjects : sample.faces ?? []).map(boxEntry)
      .filter((entry) => entry && entry.kind === "face" && entry.box[2] * entry.box[3] >= FACE_AREA);
    if (!faces.length) continue;
    const biggest = faces.reduce((best, entry) => (entry.box[2] * entry.box[3] > best.box[2] * best.box[3] ? entry : best));
    return { box: biggest.box.map((value) => value * 100), how: "detected", at: sample.t };
  }
  return null;
}

/**
 * The point to place on, in % of the source frame: {point: [x, y], edge}. edge "center" puts the
 * placed layers' center on the point; "bottom" (above-head) puts their bottom edge on it.
 * `found` is pickFace's answer; `offset` [x, y] moves the point by % of the face box's width and
 * height (a correction after a look); `shares` overrides PART_SHARES for that kind of box.
 */
export function facePartPoint(found, on, { offset = [0, 0], shares = null } = {}) {
  const [x, y, w, h] = found.box;
  const [dx, dy] = offset ?? [0, 0];
  if (on === "above-head") return { point: [x + w * (0.5 + dx / 100), y + h * (dy / 100)], edge: "bottom" };
  const [sx, sy] = found.how === "part" ? [0.5, 0.5] : (shares ?? PART_SHARES[found.how])[on];
  return { point: [x + w * (sx + dx / 100), y + h * (sy + dy / 100)], edge: "center" };
}
