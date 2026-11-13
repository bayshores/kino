// The move a sketch shows, read from a treatment's own words: one of kino's moves by name
// (engine/blocks/moves), one of the sketch's own, or plain words for either. Pure; sketches.mjs
// places the move, treatments.mjs shows treatments whose moves differ.
import { MOVE_NAMES } from "../../engine/blocks/moves/index.js";

/** The key of the row whose pattern (its last item) comes first in the text, or null. */
export function firstNamed(text, rows) {
  let found = null;
  for (const row of rows) {
    const at = row.at(-1).exec(text)?.index;
    if (at !== undefined && (!found || at < found.at)) found = { key: row[0], at };
  }
  return found?.key ?? null;
}

/** The sketch's own moves, beside kino's move library. */
export const SKETCH_MOVES = Object.freeze({
  push: "the camera pushes in on each clip (scale, point)",
  pull: "the camera pulls out of each clip (scale, point)",
  "fast-cuts": "a cut on every beat through the clips",
  card: "the line alone on a dark card, then a hard cut to the picture",
});
// Plain words for a move, tried after the moves' own names (the first in the words wins).
const MOVE_WORDS = [
  ["push", /\b(?:push(?:es|ing)?(?: in)?|zooms? (?:in(?:to)?|from)|falls? away|dolly in)\b/i],
  ["pull", /\b(?:pulls?[- ]out|pull back|zooms? out|reverse reveal|pulls? away)\b/i],
  ["split-screen", /\b(?:split|side by side|two panes|beside|next to)\b/i],
  ["picture-in-picture", /\b(?:inset|picture in picture|in (?:a|the) corner)\b/i],
  ["count-up", /\b(?:counter|counts?(?: up)?|counting|clock|ticking|tally|timer)\b/i],
  ["fast-cuts", /\b(?:montage|(?:every|each|per) (?:cut|beat)|faster and faster|beat[- ]cuts?|rapid cuts?|quick cuts?)\b/i],
  ["card", /\b(?:(?:type|title|text) cards?|on a card|hard[- ]cuts? to)\b/i],
  ["whip-pan", /\bwhips?\b/i],
  ["freeze-shutter", /\b(?:freeze\w*|freezes?[- ]frame|stops? dead)\b/i],
  ["speed-ramp", /\b(?:speed[- ]ramps?|slow[- ]mo\w*|slows? (?:down|into)|ramps?)\b/i],
  ["beat-repeat", /\b(?:stutters?|repeats? on|replay\w*)\b/i],
  ["masked-type", /\b(?:made of (?:the )?footage|through the letters|footage inside)\b/i],
  ["zoom-through", /\bzooms? through\b/i],
  ["punch-in", /\bpunch(?:es)?[- ]ins?\b/i],
];
const MOVE_PATTERNS = [...MOVE_NAMES, ...Object.keys(SKETCH_MOVES)].map((name) => [name, new RegExp(`\\b${name.replace(/-/g, "[- ]")}\\b`, "i")]);

/** The move a treatment's words name: one of kino's moves by its own name, else by plain words, or null. */
export function readMove(text) {
  const words = String(text ?? "");
  return firstNamed(words, MOVE_PATTERNS) ?? firstNamed(words, MOVE_WORDS);
}
