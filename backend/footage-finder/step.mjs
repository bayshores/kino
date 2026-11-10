// The footage step: a footage-led brief (an edit or montage of an existing subject: anime, sports,
// travel, a game) with none of the person's clips names the footage search in status, before the
// treatments and the plan. The service's directionFacts sets video.findFootage; brief.mjs nextMove
// asks this module for the step. Plain functions, no file or network access.
import { call } from "../agent/next-call.mjs";

/** library {topic:"footage", search}: the first call of the footage finder. */
export const searchCall = () => call("library", { topic: "footage", search: "<series or subject> <scene words>", want: "<what the shots show>" });
/** library {topic:"footage", scan}: scans one candidate (or "top"); a saved scan answers at once. */
export const scanCall = (ref, extra = {}) => call("library", { topic: "footage", scan: ref, ...extra });

// A cut of existing material: the kind of video a footage search serves.
const FORM = /\b(edits?|montages?|compilations?|highlights?|tributes?|recaps?|supercuts?|mashups?|fan ?cams?)\b/i;
// What that material is of: something filmed, aired or played that the person did not make.
const SUBJECT = /\b(anime|manga|cartoons?|series|episodes?|seasons?|movies?|films?|sports?|football|soccer|basketball|baseball|hockey|tennis|boxing|mma|wrestling|racing|skat(?:e|ing)|surf(?:ing)?|travel|trips?|journey|vacation|holiday|games?(?!-)|gameplay|gaming)\b/i;
// Words that are footage-led on their own (an anime music video, a pack of scenes for edits).
const ALONE = /\b(amvs?|scene ?packs?)\b/i;

/** The brief's words: every line's text and the person's quote. */
function briefWords(brief) {
  return Object.values(brief?.fields ?? {}).flatMap((line) => [line?.text, line?.quote]).filter((text) => typeof text === "string").join(" ");
}

/** True for a brief that asks for an edit or montage of an existing subject ("anime edit of <series>"). */
export function footageLed(brief) {
  const words = briefWords(brief);
  return ALONE.test(words) || (FORM.test(words) && SUBJECT.test(words));
}

/**
 * The footage step from the project's saved footage (agent state `footage`): { step, call }.
 * Nothing found yet: search. Found, none scanned: scan the top one. Scanned: its scan again,
 * which answers at once with the import call for its best shots.
 */
export function footageMove(footage) {
  const candidates = footage?.candidates ?? [];
  const scanned = candidates.find((candidate) => candidate.scan && !candidate.imported);
  if (scanned) return { step: `import found shots (scan ${scanned.code} names them)`, call: scanCall(scanned.code) };
  if (candidates.length) return { step: "scan the found footage (library footage)", call: scanCall("top") };
  return { step: "no clips of theirs: find footage (library footage)", call: searchCall() };
}
