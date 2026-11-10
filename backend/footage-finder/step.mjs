// The footage step: a footage-led brief (an edit or montage of an existing subject: anime, sports,
// travel, a game) with none of the person's media names the footage search in status, before the
// treatments and the plan. The service's directionFacts sets video.findFootage (footageStepOn says
// when); brief.mjs nextMove asks this module for the step. Plain functions, no file or network access.
import { call } from "../agent/next-call.mjs";

/** library {topic:"footage", search}: the first call of the footage finder. */
export const searchCall = () => call("library", { topic: "footage", search: "<series or subject> <scene words>", want: "<what the shots show>" });
/** library {topic:"footage", scan}: scans one candidate (or "top"); a saved scan answers at once. */
export const scanCall = (ref, extra = {}) => call("library", { topic: "footage", scan: ref, ...extra });

// The waiver that ends the footage step (waive_check {code:"footage", target:"*", reason}): the
// search found nothing usable, or the person said not to use found footage.
export const FOOTAGE_WAIVER = "footage";

// A cut of existing material: the kind of video a footage search serves.
const FORM = "edits?|montages?|compilations?|highlights?|tributes?|recaps?|supercuts?|mashups?|fan ?cams?";
const FORM_WORD = new RegExp(`\\b(${FORM})\\b`, "i");
// What that material is of: something filmed, aired or played that the person did not make. Words
// that also name a product's own things (series, season, episode, journey, holiday, trip) are left out.
const SUBJECT = /\b(anime|manga|cartoons?|movies?|films?|sports?|football|soccer|basketball|baseball|hockey|tennis|boxing|mma|wrestling|racing|skat(?:e|ing)|surf(?:ing)?|travel|vacation|gameplay)\b/i;
// A game counts only right before the form word ("game edit", "gaming montage"): "a launch edit
// for our game" is a product video.
const GAME = new RegExp(`\\b(games?|gaming)\\s+(${FORM})\\b`, "i");
// Words that are footage-led on their own (an anime music video, a pack of scenes for edits).
const ALONE = /\b(amvs?|scene ?packs?)\b/i;
// The lines a footage-led ask shows in: what the video says and what it is made from. Never (what
// the person said not to do) and the look and sound lines are left out.
const READ = ["message", "made_from"];

/** The brief's words: the message and made_from lines, their text and the person's quote. */
function briefWords(brief) {
  return READ.flatMap((name) => [brief?.fields?.[name]?.text, brief?.fields?.[name]?.quote]).filter((text) => typeof text === "string").join(" ");
}

/** True for a brief that asks for an edit or montage of an existing subject ("anime edit of <series>"). */
export function footageLed(brief) {
  const words = briefWords(brief);
  return ALONE.test(words) || GAME.test(words) || (FORM_WORD.test(words) && SUBJECT.test(words));
}

/**
 * Whether the footage step shows: a footage-led brief, nothing built, no plan, no waiver and
 * none of the person's media (clips placed or uploaded, or pictures uploaded to this project).
 * facts: { footage (videoFacts), built, planned, waived, personMedia }.
 */
export function footageStepOn(brief, facts) {
  return !facts.footage && !facts.built && !facts.planned && !facts.waived && !facts.personMedia && footageLed(brief);
}

/**
 * The footage step from the project's saved footage (agent state `footage`): { step, call }.
 * A scanned one not imported yet: its scan again, which answers at once with the import call for
 * its best shots. Else the first one not scanned, imported or noted "no": scan it. Else (nothing
 * found, or every one used up): search, or waive the step.
 */
export function footageMove(footage) {
  const candidates = (footage?.candidates ?? []).filter((candidate) => !candidate.imported && candidate.note?.verdict !== "no");
  const scanned = candidates.find((candidate) => candidate.scan);
  if (scanned) return { step: `import found shots (scan ${scanned.code} names them)`, call: scanCall(scanned.code) };
  const ordered = (footage?.order ?? []).map((code) => candidates.find((candidate) => candidate.code === code)).filter(Boolean);
  const unscanned = ordered[0] ?? candidates[0];
  if (unscanned) return { step: "scan the found footage (library footage)", call: scanCall(unscanned.code) };
  const searched = (footage?.candidates ?? []).length > 0;
  return { step: `${searched ? "found footage used up" : "no clips of theirs"}: find footage (library footage), or waive_check {code:"${FOOTAGE_WAIVER}"}`, call: searchCall() };
}
