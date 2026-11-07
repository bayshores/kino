// What kino measures on one storyboard shot (document.board, engine/board.js): how much of each
// subject box the crop keeps, how close the subject comes to the crop's sides, where the eyes sit
// in the cropped picture, and the flags the person should look at. look {mode:"board"} draws and
// prints these numbers and the board's chat text lists them (backend/agent/board-look.mjs and
// board-text.mjs), so the agent's words are never the only evidence.
//
// Crops, boxes and the eye line are in % of the source frame (x, y from its top-left), as the
// board keeps them; the numbers here are whole % of the crop.
import { insideShare } from "./sourceView.js";
import { SAFE_ZONES } from "./quality/rules/layout.js";

// Below this share of a box inside the crop, the subject is cut (flag).
export const INSIDE_LEAST = 95;
// A subject closer than this to the crop's left or right side (% of the crop width) is flagged.
export const EDGE_LEAST = 5;
// Eyes look natural from 20% to 45% down the picture (the upper third, with room above).
export const EYES_RANGE = [20, 45];
// Where the phone app's captions start on a 9:16 video, % from the top (SAFE_ZONES: the bottom
// 707 of 1920 px are covered; third-party measurements, unverified).
export const CAPTIONS_TOP = Number(((1 - SAFE_ZONES.portrait.bottom) * 100).toFixed(1));
// The two flags for what sits under the app's captions (board-text.mjs adds them to its sentences).
export const TEXT_UNDER_CAPTIONS = "text under the app's captions";
export const EYES_UNDER_CAPTIONS = "eyes under the app's captions";

/** True when a video of this size is 9:16 (its width per height within 2% of 9/16). */
export function isPortrait(frame) {
  return frame?.width > 0 && frame?.height > 0 && Math.abs(frame.width / frame.height / (9 / 16) - 1) <= 0.02;
}

const hasMedia = (shot) => typeof shot?.media === "string" && shot.media !== "none";
const boxesOf = (subject) => (subject && subject !== "none" ? subject.boxes ?? (subject.box ? [subject.box] : []) : []);

/**
 * The numbers for one shot on a video `frame` ({width, height}):
 * { inside: [% of each box in the crop], edge: % | null, eyes: % | null, flags: [words] }.
 * A shot with no media has no numbers, only the text flag. A shot whose crop is "none" (a
 * picture shown whole) is measured against the whole source frame.
 */
export function shotMeasures(shot, frame) {
  const flags = [];
  const portrait = isPortrait(frame);
  const textFlag = () => {
    const text = shot?.text;
    if (portrait && text && text !== "none" && (text.y ?? 20) >= CAPTIONS_TOP) flags.push(TEXT_UNDER_CAPTIONS);
  };
  if (!hasMedia(shot)) {
    textFlag();
    return { inside: [], edge: null, eyes: null, flags };
  }
  const [cx, cy, cw, ch] = Array.isArray(shot.crop) ? shot.crop : [0, 0, 100, 100];
  const bounds = [cx, cy, cx + cw, cy + ch];
  const boxes = boxesOf(shot.subject);
  const inside = boxes.map((box) => Math.round(insideShare(box, bounds) * 100));
  // The closest left or right gap between a box and the crop's side; a box the crop cuts is 0.
  let edge = null;
  for (const [index, [x, , w]] of boxes.entries()) {
    const gap = inside[index] < 100 ? 0 : Math.max(0, Math.min(x - cx, cx + cw - (x + w)));
    const share = Math.round((gap / cw) * 100);
    edge = edge == null ? share : Math.min(edge, share);
  }
  const eyeLine = shot.subject && shot.subject !== "none" ? shot.subject.eyes : null;
  const eyesAt = typeof eyeLine === "number" ? ((eyeLine - cy) / ch) * 100 : null;
  const eyes = eyesAt == null ? null : Math.round(eyesAt);

  if (!boxes.length) flags.push("no subject marked");
  const least = inside.length ? Math.min(...inside) : null;
  if (least != null && least < INSIDE_LEAST) flags.push(`subject ${least}% in the crop`);
  else if (edge != null && edge < EDGE_LEAST) flags.push(edge === 0 ? "subject touches the crop edge" : `subject ${edge}% from the crop edge`);
  if (eyes != null) {
    if (eyes < 0 || eyes > 100) flags.push("eyes outside the crop");
    else if (eyes < EYES_RANGE[0] || eyes > EYES_RANGE[1]) flags.push(`eyes ${eyes}% from the top`);
    if (portrait && eyesAt >= CAPTIONS_TOP && eyes <= 100) flags.push(EYES_UNDER_CAPTIONS);
  }
  textFlag();
  return { inside, edge, eyes, flags };
}
