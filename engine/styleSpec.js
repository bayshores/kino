// The style spec: which techniques (engine/techniques.js) a video wants and avoids, saved on the
// brief as field `style` (backend/agent/style.mjs checks a save). The style rules of check read it.
//
// A saved spec looks like:
//   { wants: ["dissolve", "type-words"], avoids: ["beat-kick"],
//     lines: [{ text: "dissolves between screen recordings", ref: "yt:3VHoNjrUD4Q", at: 12.4, tags: ["dissolve"] }],
//     by: "you" | "guessed", quote?: "the person's words" }
//
// Who may turn a rule off: a wanted tag silences the style rules that would warn about it only
// when it is backed, that is when the person asked for it (by:"you" with their quote) or a line
// with a reference and a time (ref and at) names it (in tags, or by its tag in the text). An
// agent's own guess is shown but changes no rule, so an agent cannot write a spec to pass check.
// Avoided tags always count, but only the person's are a ban: an avoided technique that is used
// is an error (style_avoided) when the spec is by:"you" with their quote, and a warning while the
// avoid is the agent's guess, copied from another brief or otherwise not theirs (spec.sources;
// the board stop asks the person about it). The other gates (errors)
// never change with the spec.

import { TECHNIQUE_TAGS } from "./techniques.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const tagsIn = (text) => TECHNIQUE_TAGS.filter((tag) => new RegExp(`(^|[^a-z-])${tag}([^a-z-]|$)`, "i").test(String(text ?? "")));

/** True for a line that points at a moment of a reference: ref and a time. */
export const lineHasReference = (line) => typeof line?.ref === "string" && line.ref.trim() !== "" && Number.isFinite(line?.at);

/**
 * What the checks need from a saved spec (or null for none): { wants, avoids, backed, guessed, by,
 * avoidsBacked (the avoids are the person's words, so a used one is an error), spine, rejected, fonts, accent, logo, moves } (the last four null without a style bible),
 * plus idea and ending (or null), signatures, moments and signatureRanges ([] when absent).
 * `backed` holds the wanted tags that may turn rules off; `guessed` the wanted tags that may not.
 */
export function styleContext(spec) {
  if (!spec || typeof spec !== "object") return null;
  // The style bible's moves are wanted techniques too.
  const moves = Array.isArray(spec.moves) ? spec.moves.map((move) => move?.tag).filter(Boolean) : [];
  const wants = [...new Set([...(Array.isArray(spec.wants) ? spec.wants : []), ...moves])];
  const avoids = [...new Set(Array.isArray(spec.avoids) ? spec.avoids : [])];
  const fromReferences = new Set((spec.lines ?? []).filter(lineHasReference).flatMap((line) => [...(line.tags ?? []), ...tagsIn(line.text)]));
  const yours = spec.by === "you" && typeof spec.quote === "string" && spec.quote.trim() !== "";
  // Where a list came from (spec.sources, else by): only the person's words back it. Copied
  // avoids and dealt moves stay suggestions even after an approval (style.mjs mergeStyle).
  const sourceOf = (field) => (spec.sources && typeof spec.sources === "object" && spec.sources[field]) || spec.by || "guessed";
  const theirs = (field) => yours && sourceOf(field) === "you";
  const backed = wants.filter((tag) => (theirs("wants") && spec.wants?.includes(tag)) || (theirs("moves") && moves.includes(tag)) || fromReferences.has(tag));
  return { wants, avoids, backed, guessed: wants.filter((tag) => !backed.includes(tag)), by: spec.by ?? "guessed",
    avoidsBacked: theirs("avoids"), avoidsFrom: theirs("avoids") ? "you" : sourceOf("avoids") === "you" ? "guessed" : sourceOf("avoids"),
    spine: Array.isArray(spec.spine) ? spec.spine : null, rejected: Array.isArray(spec.rejected) ? spec.rejected : [],
    // The lines that point at a moment of a reference (default_font reads a font they name).
    referenceLines: (spec.lines ?? []).filter(lineHasReference),
    // The style bible the consistency rules hold the timeline to (null when the spec has none).
    fonts: isObject(spec.fonts) ? spec.fonts : null, accent: isObject(spec.accent) ? spec.accent : null,
    logo: isObject(spec.logo) ? spec.logo : null, moves: moves.length ? moves : null,
    // The idea, its signature moments and the one-off set pieces.
    idea: typeof spec.idea === "string" && spec.idea.trim() ? spec.idea.trim() : null,
    // The picked treatment's ending (the service adds it from brief.treatments), or null.
    ending: typeof spec.ending === "string" && spec.ending.trim() ? spec.ending.trim() : null,
    signatures: Array.isArray(spec.signatures) ? spec.signatures.filter(isObject) : [],
    moments: Array.isArray(spec.moments) ? spec.moments.filter((moment) => isObject(moment) && moment.tag) : [],
    signatureRanges: signatureRanges(spec),
    // Type over the footage on purpose: giant type wanted, or the spec's words ask for it.
    typeOverFootage: wants.includes("type-giant") || [spec.quote, ...(spec.lines ?? []).map((line) => line?.text), ...(Array.isArray(spec.moves) ? spec.moves.map((move) => move?.where) : [])]
      .some(asksTypeOverFootage) };
}

// "type over the footage", "titles on top of the shot", "text across his face".
const TYPE_OVER_FOOTAGE = /\b(type|text|titles?|words?|lettering)\b[^.]{0,40}\b(over|on top of|across)\b[^.]{0,30}\b(footage|video|clips?|shots?|picture|faces?|people|subjects?|b-roll)\b/i;
// "never put text over faces" asks the opposite: a no, never, avoid or without in its sentence.
const NEGATED = /\b(no|not|never|avoid|avoids|don'?t|doesn'?t|without|nothing)\b/i;
function asksTypeOverFootage(words) {
  const match = typeof words === "string" ? TYPE_OVER_FOOTAGE.exec(words) : null;
  return Boolean(match) && !NEGATED.test(words.slice(0, match.index + match[0].length).split(/[.!?;]/).pop());
}

/**
 * The signature ranges of a style spec: [{from, to, signature, beat}], one per spine beat with role
 * "signature" and per signatures[].at (no duplicates). signature is the signatures[] entry it
 * shows (or null), beat its spine index (or null). Taste warnings do not fire inside them
 * (engine/quality/index.js); signature_missing checks them (engine/quality/rules/signature.js).
 */
export function signatureRanges(spec) {
  const isRange = (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite) && pair[1] > pair[0];
  const spine = Array.isArray(spec?.spine) ? spec.spine : [];
  const signatures = Array.isArray(spec?.signatures) ? spec.signatures.filter(isObject) : [];
  const ranges = [];
  const add = (from, to, signature, beat) => {
    if (!ranges.some((range) => range.from === from && range.to === to)) ranges.push({ from, to, signature, beat });
  };
  spine.forEach((beat, index) => {
    if (beat?.role === "signature" && isRange([beat.from, beat.to])) add(beat.from, beat.to, signatures.find((entry) => entry.beat === index) ?? null, index);
  });
  for (const signature of signatures) if (isRange(signature.at)) add(signature.at[0], signature.at[1], signature, Number.isInteger(signature.beat) ? signature.beat : null);
  return ranges;
}

/**
 * The direction lock (backend/agent/style.mjs): "locked" when the spec has a story spine and a
 * font per text role, and the person approved it (by:"you" with their words) or the agent waived
 * the approval with a reason; "unapproved" with both but neither; "missing" otherwise.
 * The idea rule: once a treatment is picked (`brief.treatments.picked`), or when the spec names
 * an idea or signatures itself, the lock also needs the idea and at least 1 signature. A spec
 * locked before this rule (no picked treatment, no idea) keeps its lock.
 */
export function directionLock(spec, brief = null) {
  if (!spec?.spine?.length || !spec?.fonts || !Object.keys(spec.fonts).length) return "missing";
  const ideaRule = Boolean(brief?.treatments?.picked) || spec.idea !== undefined || spec.signatures !== undefined;
  if (ideaRule && !(typeof spec.idea === "string" && spec.idea.trim() && spec.signatures?.length)) return "missing";
  const yours = spec.by === "you" && typeof spec.quote === "string" && spec.quote.trim() !== "";
  return yours || (typeof spec.waived === "string" && spec.waived.trim()) ? "locked" : "unapproved";
}

/** The spec in one short line, e.g. "wants dissolve, type-words · avoids beat-kick (2 lines, by you)". */
export function styleLine(spec) {
  const context = styleContext(spec);
  if (!context) return "style: kino default (no style spec)";
  const parts = [
    context.wants.length ? `wants ${context.wants.join(", ")}` : "",
    context.avoids.length ? `avoids ${context.avoids.join(", ")}` : "",
  ].filter(Boolean);
  const lines = spec.lines?.length ?? 0;
  return `style: ${parts.join(" · ") || "no tags"} (${lines} ${lines === 1 ? "line" : "lines"}, ${context.by === "you" ? "by you" : "guessed"}${context.guessed.length ? `; ${context.guessed.join(", ")} not backed by a ref or your words` : ""})`;
}
