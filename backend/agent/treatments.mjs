// Treatments (verbalized sampling): before the storyboard the agent writes 5 directions for the
// video, each a small story with a rough likelihood that its story is the typical one. Asking a
// model for options with their likelihoods, then taking them from the tail, gives far more varied
// work than asking for one answer (Zhang et al. 2025). kino drops the most typical one and keeps
// the 3 least typical of the rest, one per `who` when it can, for the person to pick at the next stop.
//
// Saved on the brief as field `treatments` (notes {action:"brief", fields:{treatments}}):
//   a list of 5   [{idea, who, tension, turn, move, ending, type, p, source}]: the idea, who (whose want
//                 or fear drives the story: a person, a crew, a viewer, a thing; the 5 name at
//                 least 3 different, so they are not 5 demos of one tool), the tension (what they
//                 want, fear or wonder before the turn), the turn (the on-screen moment it flips),
//                 the signature move, the ending (the last image, from this material: the pick's
//                 ending becomes the spine's end beat and template_end quotes it), type (the type and
//                 how it appears, such as "small serif captions, each word cut on": kino has no
//                 default type, so each treatment carries its own and the pick saves it as the
//                 style spec's type), p, 0 to 1, how
//                 typical the story is, and source, the material the signature move uses (a file
//                 or screen, and the moment). Lists saved before who, tension and turn existed, or
//                 with a rhythm before ending, or before type, keep showing as they were.
//   a pick        {pick:"A"|"B"|"C", quote?, why?}: the one the person picked (their words in
//                 quote), or yours when they said "just start" (no quote, then why is required:
//                 why a viewer would retell it). It becomes the idea line, and its move and source
//                 the style spec's first signature (pickedSignature).
// Stored as brief.treatments = { list, dropped, shown:[indexes], picked:{label, by, quote?, why?}|null }.
import { isRecord } from "../../engine/numbers.js";

export const TREATMENT_COUNT = 5;
export const SHOWN_COUNT = 3;
export const LABELS = Object.freeze(["A", "B", "C"]);
// The fewest different `who` the 5 must name.
export const WHO_MIN = 3;
// The fewest different `type` directions the 5 must carry.
export const TYPE_MIN = 3;
export const TREATMENT_LIMITS = Object.freeze({ idea: 120, who: 40, tension: 60, turn: 60, move: 60, ending: 60, type: 60, quote: 120, why: 80, source: 80 });
const KEYS = ["idea", "who", "tension", "turn", "move", "ending", "type", "p", "source"];
// The text fields every treatment needs, in the order a refusal names them.
const TEXT_KEYS = ["idea", "who", "tension", "turn", "move", "ending", "type", "source"];
// What a missing or empty text field is, after its length.
const FIELD_HINTS = Object.freeze({
  who: ": whose want or fear drives it: a person, a crew, a viewer, a thing",
  tension: ": what they want, fear or wonder before the turn",
  turn: ": the on-screen moment it flips",
  ending: ": the last image, from this material",
  type: ': "<family class>, <size>, <case>, <how it appears>", from the references you studied; the 5 differ',
  source: ': the material the move uses, such as "review.mp4, the card flip at 0:12"',
});
const problem = (message) => ({ code: "bad_input", message });
const EXAMPLE = '[{idea:"the crew skates the city at dawn", who:"the crew", tension:"will they land it before the cops come?", turn:"the bridge gap, landed as the sun hits", move:"whip-pan between spots", ending:"the crew walking off the bridge at sunrise", type:"<family class, size, case, how it appears; each of the 5 differs>", p:0.3, source:"dawn.mp4, the empty bridge"}, …]';

/** The same `who` twice: trimmed, lowercased, a leading "the", "a" or "an" dropped. */
export const whoKey = (who) => String(who ?? "").trim().toLowerCase().replace(/^(the|an?)\s+/, "");

/** The problem with a treatments save, or null. `current` is the saved brief.treatments. */
export function treatmentsProblem(value, current) {
  if (isRecord(value) && value.pick !== undefined) {
    const extra = Object.keys(value).filter((key) => !["pick", "quote", "why"].includes(key));
    if (extra.length) return problem(`A pick takes pick, quote and why, not ${extra.join(", ")}.`);
    if (!current?.list) return problem("Save the 5 treatments first, then the pick.");
    if (!LABELS.includes(value.pick)) return problem(`pick is ${LABELS.join(", ")}: the letter the person chose from the 3 shown.`);
    if (value.quote !== undefined && (typeof value.quote !== "string" || !value.quote.trim() || value.quote.trim().length > TREATMENT_LIMITS.quote))
      return problem(`quote is the person's words that picked it, 1 to ${TREATMENT_LIMITS.quote} characters; leave it out when it is your pick.`);
    // Your own pick says why: a pick in 1 s with no reason is the typical one.
    if ((value.why !== undefined || value.quote === undefined) && (typeof value.why !== "string" || !value.why.trim() || value.why.trim().length > TREATMENT_LIMITS.why))
      return problem(`why is 1 to ${TREATMENT_LIMITS.why} characters, required on your own pick: why a viewer would retell it tomorrow and this material can carry it.`);
    return null;
  }
  if (!Array.isArray(value) || value.length !== TREATMENT_COUNT)
    return problem(`treatments is a list of ${TREATMENT_COUNT}: ${EXAMPLE} (or {pick:"A", quote} once the person picked).`);
  // Every problem of the list at once, each with its field, length and limit: one retry fixes all.
  const problems = [];
  for (const [index, entry] of value.entries()) {
    const where = `treatments[${index}]`;
    if (!isRecord(entry)) { problems.push(`${where} is {${KEYS.join(", ")}}.`); continue; }
    const extra = Object.keys(entry).filter((key) => !KEYS.includes(key));
    if (extra.length) problems.push(`${where} takes ${KEYS.join(", ")}, not ${extra.join(", ")}.`);
    for (const key of TEXT_KEYS) {
      const text = entry[key];
      if (typeof text !== "string" || !text.trim()) problems.push(`${where}.${key} is 1 to ${TREATMENT_LIMITS[key]} characters${FIELD_HINTS[key] ?? ""}.`);
      else if (text.trim().length > TREATMENT_LIMITS[key]) problems.push(`${where}.${key} is ${text.trim().length} characters, limit ${TREATMENT_LIMITS[key]}.`);
    }
    if (typeof entry.p !== "number" || !Number.isFinite(entry.p) || entry.p < 0 || entry.p > 1) problems.push(`${where}.p is 0 to 1: how typical this story is.`);
  }
  if (problems.length) return problem(problems.length > 1 ? `${problems.join(" ")} (${problems.length} problems)` : problems[0]);
  if (new Set(value.map((entry) => entry.idea.trim().toLowerCase())).size < TREATMENT_COUNT) return problem("Each treatment needs its own idea.");
  // At least 3 different whos: 5 stories about one tool are one story told 5 ways.
  const counts = new Map();
  for (const entry of value) counts.set(whoKey(entry.who), (counts.get(whoKey(entry.who)) ?? 0) + 1);
  if (counts.size < WHO_MIN) {
    const [key, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const who = value.find((entry) => whoKey(entry.who) === key).who.trim();
    return problem(`treatments: ${count} of ${TREATMENT_COUNT} share who "${who}"; give at least ${WHO_MIN} different whos.`);
  }
  // At least 3 different types: picking a treatment picks its look, so 5 of one look is no choice.
  const types = new Set(value.map((entry) => entry.type.trim().toLowerCase()));
  if (types.size < TYPE_MIN) return problem(`treatments: only ${types.size} different type directions; give at least ${TYPE_MIN}, from different families, so a pick picks a look.`);
  return null;
}

/**
 * The 3 shown of the list, least typical first: the most typical dropped, then one at a time the
 * least typical that adds the most of a new `who` and a new `type` (so the person is not shown 3 of
 * one look, or a 4th story left out for being one more of the same who), ties by p. A list saved
 * without who or type counts each entry as new there, so it shows as before.
 */
function shownOf(list, dropped) {
  const rest = list.map((entry, index) => ({ entry, index })).filter(({ index }) => index !== dropped)
    .sort((a, b) => a.entry.p - b.entry.p || a.index - b.index);
  const keyOf = ({ entry, index }) => ({
    who: entry.who ? whoKey(entry.who) : `#${index}`,
    type: typeof entry.type === "string" && entry.type.trim() ? entry.type.trim().toLowerCase() : `#${index}`,
  });
  const whos = new Set();
  const types = new Set();
  const chosen = [];
  while (chosen.length < Math.min(SHOWN_COUNT, rest.length)) {
    const score = (item) => { const key = keyOf(item); return (whos.has(key.who) ? 0 : 1) + (types.has(key.type) ? 0 : 1); };
    const next = rest.filter((item) => !chosen.includes(item)).reduce((best, item) => (score(item) > score(best) ? item : best));
    const key = keyOf(next);
    whos.add(key.who);
    types.add(key.type);
    chosen.push(next);
  }
  return rest.filter((item) => chosen.includes(item)).map(({ index }) => index);
}

/**
 * The treatments as saved: the most typical (highest p, the first on a tie) is dropped, and the
 * 3 least typical of the rest are shown, one per who when the list allows. A pick keeps the list.
 */
export function cleanTreatments(value, current) {
  if (isRecord(value) && value.pick !== undefined) {
    const index = current.shown[LABELS.indexOf(value.pick)];
    const why = typeof value.why === "string" && value.why.trim() ? { why: value.why.trim() } : {};
    return { ...current, picked: { label: value.pick, index, by: value.quote ? "you" : "guessed", ...(value.quote ? { quote: value.quote.trim() } : {}), ...why } };
  }
  // Who, tension, turn, ending, type and source are optional here only for callers that skip
  // treatmentsProblem; rhythm only for a list written before ending.
  const optional = (entry, key) => (typeof entry[key] === "string" ? { [key]: entry[key].trim() } : {});
  const list = value.map((entry) => ({ idea: entry.idea.trim(), ...optional(entry, "who"), ...optional(entry, "tension"), ...optional(entry, "turn"),
    move: entry.move.trim(), ...optional(entry, "ending"), ...optional(entry, "type"), ...optional(entry, "rhythm"), p: Math.round(entry.p * 100) / 100, ...optional(entry, "source") }));
  const dropped = list.reduce((best, entry, index) => (entry.p > list[best].p ? index : best), 0);
  return { list, dropped, shown: shownOf(list, dropped), picked: null };
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

/** The picked treatment's ending (the last image it named), or null: no pick, or a list from before ending. */
export function pickedEnding(treatments) {
  const entry = treatments?.picked ? treatments.list?.[treatments.picked.index] : null;
  return typeof entry?.ending === "string" && entry.ending ? entry.ending : null;
}

// A source that names material, not words: a media file, a screen, footage, a shot or a sound.
const PICTURE_WORDS = /\.(png|jpe?g|webp|gif|heic|mp4|mov|webm|m4v|mp3|wav|m4a|aiff?)\b|screen|footage|clip|shot|record|video|photo|image|picture|frame|camera|demo|\bui\b|interface|dashboard|sound|audio|voice|song|music/i;

/** True when a treatment's source names only words (copy, a tagline, site text) or nothing: no picture or sound. */
export const wordsOnly = (source) => !PICTURE_WORDS.test(String(source ?? ""));

// The line a pick with a words-only source adds: the signature is built from the product's picture.
export const PICTURE_LINE = "Its source is words only: build the signature from the product's own picture (a screenshot or footage, with a push into the part that matters), with the line over it.";

// "move (source)", or the move alone without a source.
const moveText = (entry) => `${entry.move}${entry.source ? ` (${entry.source})` : ""}`;

/** The picked treatment's type direction ("small serif captions, each word cut on"), or null: no pick, or a list from before type. */
export function pickedType(treatments) {
  const entry = treatments?.picked ? treatments.list?.[treatments.picked.index] : null;
  return typeof entry?.type === "string" && entry.type ? entry.type : null;
}

/**
 * "A. idea · who: tension → turn · ends on ending · type: type" for each shown treatment: the story,
 * where it lands and how its type looks. A list saved before type leaves " · type: ..." off, one
 * before ending shows the move last ("A. idea · who: tension → turn · move"),
 * one before who drops "who: ", and one before tension and turn as it did:
 * "A. idea · move (source) · rhythm".
 */
export const shownLines = (treatments) => treatments.shown.map((index, position) => {
  const entry = treatments.list[index];
  if (entry.tension && entry.turn) return `${LABELS[position]}. ${entry.idea} · ${entry.who ? `${entry.who}: ` : ""}${entry.tension} → ${entry.turn} · ${entry.ending ? `ends on ${entry.ending}` : entry.move}${entry.type ? ` · type: ${entry.type}` : ""}`;
  return `${LABELS[position]}. ${entry.idea} · ${moveText(entry)} · ${entry.rhythm ?? `ends on ${entry.ending}`}`;
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

// What the agent's own pick is for, and the call that saves it ("just start").
export const OWN_PICK = "pick the one a viewer would retell tomorrow that this material can carry; say why";
export const OWN_PICK_CALL = Object.freeze({ pick: "<A, B or C>", why: "<why a viewer would retell it>" });

/** The saved treatments in a few lines for the brief's answers. */
export function treatmentsText(brief) {
  const treatments = brief?.treatments;
  if (!treatments?.list) return "";
  const dropped = treatments.list[treatments.dropped];
  if (treatments.picked) {
    const entry = treatments.list[treatments.picked.index];
    // The pick's move and source become style.signatures[0] (the lock needs idea + a signature).
    const line = `treatments: ${treatments.picked.label} picked (${treatments.picked.by === "you" ? "by them" : "your call"}): ${entry.idea} · signature: ${moveText(entry)}${entry.type ? ` · type: ${entry.type}` : ""}`;
    const saved = brief.style?.signatures?.[0]?.source;
    return wordsOnly(entry.source) && wordsOnly(saved) ? `${line}\n${PICTURE_LINE}` : line;
  }
  const own = /just start/i.test(brief.noPlayback?.reason ?? "");
  return [
    `treatments: dropped the most typical (p ${dropped.p}: ${dropped.idea}); ${own ? "they said just start, so pick one yourself" : "the next stop's ask shows these 3 to pick"}:`,
    ...shownLines(treatments),
    own ? `${OWN_PICK}: fields:{treatments:{pick:"A", why:"<why>"}}.` : 'Their pick: fields:{treatments:{pick:"B", quote:"<their words>"}}. With no stop ahead, ask in one message.',
  ].join("\n");
}
