// What a video is about decides the words of kino's direction answers. A product video is asked
// about the product (its own picture, a screenshot, why only this product can show it). An edit of
// a subject in footage (a series, a match, a trip, a person on camera) with no product is asked
// the same questions about the subject and its footage: a footage-led run read "the product's own
// picture ... screenshot", "why only this product can show it" and "footage of you, the viewer" at
// its decision points (.scratch/run8/trace/direction.md L109), none of which fit its material.
// Plain functions, no file or network access. No field for the agent to fill: kino reads what is
// stored (the brief's lines, the person's ask, the footage it imported).
import { footageLedWords } from "../footage-finder/step.mjs";

// The brief lines that say what the video is and what it is made from, plus the person's own ask.
const LINES = ["message", "made_from", "about"];

/** The stored words of a brief: its message, made_from and about lines (text and quote) and the asks. */
export function briefWords(brief) {
  const lines = LINES.flatMap((name) => [brief?.fields?.[name]?.text, brief?.fields?.[name]?.quote]);
  const asks = Array.isArray(brief?.fields?.ask) ? brief.fields.ask.map((entry) => entry?.text) : [];
  return [...lines, ...asks].filter((text) => typeof text === "string").join(" ");
}

// Words that name a product's own things. A guess, not a measurement: footage in a brief that says
// one of these is B-roll for a product video, so its answers keep the product wording.
const PRODUCT_WORDS = /\b(apps?|products?|launch(?:es|ing)?|features?|startups?|saas|software|websites?|brand|stores?|shop|platform|tool|service|demo|promo|ad|commercial|screenshots?|screen recordings?)\b/i;
// The plainest of them name a product even in an ask that also says "edit" or "montage" ("a promo
// edit for our travel app"): they win over the edit words. Also a guess; "brand", "store" or
// "service" are left out here because "highlights for the team's brand page" is still a subject edit.
const NAMES_PRODUCT = /\b(apps?|products?|startups?|saas|software|websites?|demo|promo|commercial|screenshots?|screen recordings?)\b/i;

/**
 * True when the project is an edit of a subject in footage with no product: the stored words ask
 * for an edit or montage of existing material (footage-finder/step.mjs footageLedWords) and name no
 * product outright (NAMES_PRODUCT), or the project has footage (kino's found clips in
 * state.footage, or `video.footage` from videoFacts: a clip placed or imported, such as a
 * talking-head take) and the words name no product (PRODUCT_WORDS). False for a product video,
 * for a brief with no words yet, and for every project from before kino kept these.
 */
export function isSubjectEdit(state, video = null) {
  const words = briefWords(state?.brief);
  if (!words.trim() || NAMES_PRODUCT.test(words)) return false;
  if (footageLedWords(words)) return true;
  const found = (state?.footage?.candidates ?? []).some((candidate) => candidate?.imported);
  return (found || Boolean(video?.footage)) && !PRODUCT_WORDS.test(words);
}

// A who that is the viewer ("you, the viewer", "the audience"): never on camera in found footage.
const VIEWER = /\b(you|viewers?|audience|watchers?|fans?)\b/i;
/** True for a treatment's who that names the viewer rather than someone in the footage. */
export const viewerWho = (who) => VIEWER.test(String(who ?? ""));

// The words each answer uses for what the video shows: the product, or the subject and its footage.
export const ONLY = Object.freeze({
  product: { only: "only this product", picture: "the product's own picture (a screenshot or footage, with a push into the part that matters)", material: "a screenshot or clip of the product" },
  subject: { only: "only this subject and its footage", picture: "the subject's own footage (the shot where it happens, with a push into the part that matters)", material: "the shot of the subject" },
});
/** The wording set for a project: ONLY.subject for a subject edit, else ONLY.product. */
export const onlyWords = (subject) => (subject ? ONLY.subject : ONLY.product);
