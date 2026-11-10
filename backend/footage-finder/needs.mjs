// Song to footage: how many shots the video's song asks for, and what each part of it should
// show. The song's sections come from song-shape.mjs ({at, kind}: intro, build, drop, break,
// outro, in seconds of the song file) and its tempo from the beat analysis. The drop cuts every
// 2 beats on high-motion shots; builds and the parts in between (verses, where the lyrics sit)
// cut every 4 beats on calm shots of the characters; an intro, a break or an outro every 8.
// The scan answer says the count and asks for 1.5 times as many shots, so the edit can choose.

/** Beats between cuts in each kind of song part ("verse": a stretch no section names). */
export const BEATS_PER_CUT = Object.freeze({ drop: 2, build: 4, verse: 4, intro: 8, break: 8, outro: 8 });
/** How many more shots to import than the song needs, so the edit has a choice. */
export const IMPORT_SHARE = 1.5;

/** Visual words added to `want` for each kind of part: motion for the drop, calm faces elsewhere. */
const FAST_WORDS = "fast action, motion, impact";
const CALM_WORDS = "close-up face, calm, still";

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The song's parts between `from` and `to` (seconds of the song file): [{kind, from, to}]. A part
 * runs from its section to the next one; the stretch before the first named section is a verse.
 */
export function songParts(sections = [], { from = 0, to } = {}) {
  const marks = [...sections].filter((part) => Number.isFinite(part?.at)).sort((a, b) => a.at - b.at);
  const parts = [];
  let kind = "verse";
  let at = 0;
  for (const mark of [...marks, { at: Infinity, kind: null }]) {
    const start = Math.max(at, from);
    const end = Math.min(mark.at, to);
    if (end - start > 0.05) parts.push({ kind, from: round1(start), to: round1(end) });
    kind = BEATS_PER_CUT[mark.kind] ? mark.kind : "verse";
    at = mark.at;
    if (at >= to) break;
  }
  return parts;
}

/**
 * The shots the song needs: bpm, sections (song-shape.mjs), seconds (the song's length), from/to
 * (the stretch the video plays, in seconds of the song file; the whole song by default).
 * Answers {bpm, shots, import, parts: [{kind, from, to, beats, every, shots}]}, or null without a
 * tempo kino is sure of.
 */
export function shotsNeeded({ bpm, sections = [], seconds, from = 0, to = seconds } = {}) {
  if (!(bpm >= 40 && bpm <= 240) || !(to > from)) return null;
  const parts = songParts(sections, { from, to }).map((part) => {
    const every = BEATS_PER_CUT[part.kind];
    const beats = ((part.to - part.from) * bpm) / 60;
    return { ...part, beats: Math.round(beats), every, shots: Math.max(1, Math.round(beats / every)) };
  });
  const shots = parts.reduce((sum, part) => sum + part.shots, 0);
  return { bpm: Math.round(bpm), shots, import: Math.ceil(shots * IMPORT_SHARE), parts };
}

/**
 * What each kind of part should show, as visual words for the scan's `want`: the agent's words
 * plus high-motion words for the drop and calm character words for builds and lyric parts.
 * Answers {[kind]: words} for the kinds in `parts`.
 */
export function wantBySection(want, parts = []) {
  const base = String(want ?? "").replace(/\s+/g, " ").trim();
  const words = (extra) => (base ? `${base}, ${extra}` : extra);
  const result = {};
  for (const part of parts) result[part.kind] ??= words(part.kind === "drop" ? FAST_WORDS : CALM_WORDS);
  return result;
}

/** The scan answer's line: "The song needs about N shots: ... Import 1.5x: about M." */
export function needLine(need) {
  if (!need?.shots) return "";
  const drop = need.parts.filter((part) => part.kind === "drop").reduce((sum, part) => sum + part.shots, 0);
  const calm = need.shots - drop;
  const split = drop && calm
    ? `: ${drop} on the drop (a cut every 2 beats, high motion), ${calm} on builds and lyrics (every 4 to 8 beats, calm faces)`
    : drop ? " (a cut every 2 beats, high motion)" : " (a cut every 4 to 8 beats, calm faces)";
  return `The song (${need.bpm} bpm) needs about ${need.shots} shot${need.shots === 1 ? "" : "s"}${split}. Import ${IMPORT_SHARE}x: about ${need.import}.`;
}
