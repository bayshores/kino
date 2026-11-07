// Treatments (verbalized sampling): before the storyboard the agent writes 5 directions for the
// video, each with a rough likelihood that a typical editor would make it. Asking a model for
// options with their likelihoods, then taking them from the tail, gives far more varied work
// than asking for one answer (Zhang et al. 2025). kino drops the most typical one and keeps the
// 3 least typical of the rest for the person to pick at the next stop.
//
// Saved on the brief as field `treatments` (notes {action:"brief", fields:{treatments}}):
//   a list of 5   [{idea, move, rhythm, p, source?}]: the idea, the signature move, the rhythm,
//                 p, 0 to 1, how likely a typical editor would make it, and source, the material
//                 the signature move uses (a file or screen, and the moment)
//   a pick        {pick:"A"|"B"|"C", quote?}: the one the person picked (their words in quote),
//                 or yours when they said "just start" (no quote). It becomes the idea line, and
//                 its move and source the style spec's first signature (pickedSignature).
// Stored as brief.treatments = { list, dropped, shown:[indexes], picked:{label, by, quote?}|null }.
import { isRecord } from "../../engine/numbers.js";

export const TREATMENT_COUNT = 5;
export const SHOWN_COUNT = 3;
export const LABELS = Object.freeze(["A", "B", "C"]);
export const TREATMENT_LIMITS = Object.freeze({ idea: 80, move: 60, rhythm: 60, quote: 120, source: 80 });
const KEYS = ["idea", "move", "rhythm", "p", "source"];
const problem = (message) => ({ code: "bad_input", message });
const EXAMPLE = '[{idea:"the crew skates the city at dawn", move:"whip-pan between spots", rhythm:"slow build, fast last 6 s", p:0.3, source:"dawn.mp4, the empty bridge"}, …]';

/** The problem with a treatments save, or null. `current` is the saved brief.treatments. */
export function treatmentsProblem(value, current) {
  if (isRecord(value) && value.pick !== undefined) {
    const extra = Object.keys(value).filter((key) => !["pick", "quote"].includes(key));
    if (extra.length) return problem(`A pick takes pick and quote, not ${extra.join(", ")}.`);
    if (!current?.list) return problem("Save the 5 treatments first, then the pick.");
    if (!LABELS.includes(value.pick)) return problem(`pick is ${LABELS.join(", ")}: the letter the person chose from the 3 shown.`);
    if (value.quote !== undefined && (typeof value.quote !== "string" || !value.quote.trim() || value.quote.trim().length > TREATMENT_LIMITS.quote))
      return problem(`quote is the person's words that picked it, 1 to ${TREATMENT_LIMITS.quote} characters; leave it out when it is your pick.`);
    return null;
  }
  if (!Array.isArray(value) || value.length !== TREATMENT_COUNT)
    return problem(`treatments is a list of ${TREATMENT_COUNT}: ${EXAMPLE} (or {pick:"A", quote} once the person picked).`);
  // Every problem of the list at once, each with its field, length and limit: one retry fixes all.
  const problems = [];
  for (const [index, entry] of value.entries()) {
    const where = `treatments[${index}]`;
    if (!isRecord(entry)) { problems.push(`${where} is {idea, move, rhythm, p, source?}.`); continue; }
    const extra = Object.keys(entry).filter((key) => !KEYS.includes(key));
    if (extra.length) problems.push(`${where} takes ${KEYS.join(", ")}, not ${extra.join(", ")}.`);
    for (const key of ["idea", "move", "rhythm", "source"]) {
      const text = entry[key];
      if (key === "source" && text === undefined) continue;
      if (typeof text !== "string" || !text.trim()) problems.push(`${where}.${key} is 1 to ${TREATMENT_LIMITS[key]} characters${key === "source" ? ': the material the move uses, such as "review.mp4, the card flip at 0:12"' : ""}.`);
      else if (text.trim().length > TREATMENT_LIMITS[key]) problems.push(`${where}.${key} is ${text.trim().length} characters, limit ${TREATMENT_LIMITS[key]}.`);
    }
    if (typeof entry.p !== "number" || !Number.isFinite(entry.p) || entry.p < 0 || entry.p > 1) problems.push(`${where}.p is 0 to 1: how likely a typical editor would make this.`);
  }
  if (problems.length) return problem(problems.length > 1 ? `${problems.join(" ")} (${problems.length} problems)` : problems[0]);
  if (new Set(value.map((entry) => entry.idea.trim().toLowerCase())).size < TREATMENT_COUNT) return problem("Each treatment needs its own idea.");
  return null;
}

/**
 * The treatments as saved: the most typical (highest p, the first on a tie) is dropped, and the
 * 3 least typical of the rest are shown, least typical first. A pick keeps the list.
 */
export function cleanTreatments(value, current) {
  if (isRecord(value) && value.pick !== undefined) {
    const index = current.shown[LABELS.indexOf(value.pick)];
    return { ...current, picked: { label: value.pick, index, by: value.quote ? "you" : "guessed", ...(value.quote ? { quote: value.quote.trim() } : {}) } };
  }
  const list = value.map((entry) => ({ idea: entry.idea.trim(), move: entry.move.trim(), rhythm: entry.rhythm.trim(), p: Math.round(entry.p * 100) / 100,
    ...(entry.source !== undefined ? { source: entry.source.trim() } : {}) }));
  const dropped = list.reduce((best, entry, index) => (entry.p > list[best].p ? index : best), 0);
  const shown = list.map((entry, index) => ({ entry, index })).filter(({ index }) => index !== dropped)
    .sort((a, b) => a.entry.p - b.entry.p || a.index - b.index).slice(0, SHOWN_COUNT).map(({ index }) => index);
  return { list, dropped, shown, picked: null };
}

/** The idea line a pick makes: the treatment's idea, by:"you" with their words, or guessed. */
export function pickedIdea(treatments) {
  const { picked, list } = treatments;
  const text = list[picked.index].idea;
  return picked.by === "you" ? { text, by: "you", quote: picked.quote } : { text, by: "guessed" };
}

/**
 * The style spec's first signature a pick drafts: {what: the move, source}, or null with no pick.
 * The agent adds beat and why (lockCall in brief.mjs drafts them).
 */
export function pickedSignature(treatments) {
  const entry = treatments?.picked ? treatments.list?.[treatments.picked.index] : null;
  return entry ? { what: entry.move, source: entry.source ?? null } : null;
}

// A source that names material, not words: a media file, a screen, footage, a shot or a sound.
const PICTURE_WORDS = /\.(png|jpe?g|webp|gif|heic|mp4|mov|webm|m4v|mp3|wav|m4a|aiff?)\b|screen|footage|clip|shot|record|video|photo|image|picture|frame|camera|demo|\bui\b|interface|dashboard|sound|audio|voice|song|music/i;

/** True when a treatment's source names only words (copy, a tagline, site text) or nothing: no picture or sound. */
export const wordsOnly = (source) => !PICTURE_WORDS.test(String(source ?? ""));

// The line a pick with a words-only source adds: the signature is built from the product's picture.
export const PICTURE_LINE = "Its source is words only: build the signature from the product's own picture (a screenshot or footage, with a push into the part that matters), with the line over it.";

// "move (source)", or the move alone without a source.
const moveText = (entry) => `${entry.move}${entry.source ? ` (${entry.source})` : ""}`;

/** "A. idea · move (source) · rhythm" for each shown treatment. */
export const shownLines = (treatments) => treatments.shown.map((index, position) => {
  const entry = treatments.list[index];
  return `${LABELS[position]}. ${entry.idea} · ${moveText(entry)} · ${entry.rhythm}`;
});

/**
 * The lines a stop's ask adds while the person has not picked: the 3 shown treatments. None when
 * they said "just start" (the agent picks) or one is picked.
 */
export function pickLines(brief) {
  const treatments = brief?.treatments;
  if (!treatments?.list || treatments.picked) return [];
  if (/just start/i.test(brief.noPlayback?.reason ?? "")) return [];
  return ["Pick a direction (or say your own):", ...shownLines(treatments)];
}

/** The saved treatments in a few lines for the brief's answers. */
export function treatmentsText(brief) {
  const treatments = brief?.treatments;
  if (!treatments?.list) return "";
  const dropped = treatments.list[treatments.dropped];
  if (treatments.picked) {
    const entry = treatments.list[treatments.picked.index];
    // The pick's move and source become style.signatures[0] (the lock needs idea + a signature).
    const line = `treatments: ${treatments.picked.label} picked (${treatments.picked.by === "you" ? "by them" : "your call"}): ${entry.idea} · signature: ${moveText(entry)}`;
    const saved = brief.style?.signatures?.[0]?.source;
    return wordsOnly(entry.source) && wordsOnly(saved) ? `${line}\n${PICTURE_LINE}` : line;
  }
  const own = /just start/i.test(brief.noPlayback?.reason ?? "");
  return [
    `treatments: dropped the most typical (p ${dropped.p}: ${dropped.idea}); ${own ? "they said just start, so pick one yourself" : "the next stop's ask shows these 3 to pick"}:`,
    ...shownLines(treatments),
    own ? 'Save your pick: fields:{treatments:{pick:"A"}}.' : 'Their pick: fields:{treatments:{pick:"B", quote:"<their words>"}}. With no stop ahead, ask in one message.',
  ].join("\n");
}
