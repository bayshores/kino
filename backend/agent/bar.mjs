// The bar: the person's verdicts on past cuts, and the best one as the cut to beat. kino's critic
// and viewer once rated a cut the person called sloppy and jarring about the same as the cut they
// called the best so far, because each judged a cut alone. With a bar saved, the
// critic and the viewer see this cut and the bar side by side at the same story points and must
// say which is better and why; the critic also reads the person's verdicts as anchors.
// notes {action:"verdict", of?, rev, words, wrong?, best?} saves one (only the person's words).
import { sec } from "./describe.mjs";

export const VERDICTS_KEPT = 8;
// Story points shown side by side when the spines do not share beats.
export const BAR_POINTS = 9;
// The critic's comparison line, and the viewer's.
export const BAR_FORM = "BAR better|worse · <what this cut does better or worse than the bar, at which times, specifically>";
export const PREFER_FORM = "PREFER A|B · <why, at which times>";
export const BAR_PROBLEM = "worse than the bar";

const bad = (message) => Object.assign(new Error(message), { code: "bad_input" });

/**
 * notes verdict input → {of, rev, words, wrong, best}. of is the project the cut belongs to (an
 * id or name; default this one), rev its revision, words the person's own words, wrong what was
 * wrong (optional), best marks the bar.
 */
export function parseVerdict(input, projectId) {
  const rev = Number(input.rev);
  const words = String(input.words ?? "").trim();
  if (!Number.isSafeInteger(rev) || rev < 1) throw bad('verdict needs rev: the revision the person judged, such as {action:"verdict", of:"app-trailer", rev:391, words:"<their words>", best:true}.');
  if (words.length < 3 || words.length > 600) throw bad("words is the person's verdict in their own words (3 to 600 characters), never a summary of yours.");
  const wrong = String(input.wrong ?? input.text ?? "").trim().slice(0, 400);
  return { of: String(input.of ?? projectId).trim() || projectId, rev, words, ...(wrong ? { wrong } : {}), best: input.best === true };
}

/** Adds a verdict to the list: the same cut replaces its old verdict; one best (the newest). */
export function addVerdict(list = [], verdict) {
  const others = list.filter((item) => !(item.of === verdict.of && item.rev === verdict.rev)).map((item) => (verdict.best ? { ...item, best: false } : item));
  return [...others, verdict].slice(-VERDICTS_KEPT);
}

/** The bar (the verdict marked best), or null. */
export const barOf = (verdicts = []) => verdicts.findLast((item) => item.best) ?? null;

/** The verdicts as packet lines: the anchors the critic reads before judging. */
export function anchorLines(verdicts = [], names = {}) {
  if (!verdicts.length) return [];
  return ["The person's verdicts on past cuts (anchors: judge this cut by the same taste):",
    ...verdicts.map((item) => `  ${names[item.of] ?? item.of} rev ${item.rev}${item.best ? " (THE BAR, the best so far)" : ""}: "${item.words}"${item.wrong ? `; what was wrong: ${item.wrong}` : ""}`)];
}

/**
 * Matching story points of this cut and the bar: [{at, barAt, why}]. Beats both spines share by
 * role are paired at their middles; without shared beats, BAR_POINTS even fractions of each.
 */
export function barPairs({ duration, barDuration, spine = [], barSpine = [] }) {
  const mid = (beat) => (beat.from + beat.to) / 2;
  const pairs = [];
  for (const beat of spine) {
    const theirs = barSpine.find((other) => other.role === beat.role && Number.isFinite(other.from) && Number.isFinite(other.to));
    if (theirs && Number.isFinite(beat.from) && Number.isFinite(beat.to)) pairs.push({ at: sec(mid(beat)), barAt: sec(mid(theirs)), why: beat.role });
  }
  if (pairs.length >= 3) return pairs.slice(0, 12);
  return Array.from({ length: BAR_POINTS }, (_, index) => {
    const fraction = (index + 0.5) / BAR_POINTS;
    return { at: sec(fraction * duration), barAt: sec(fraction * barDuration), why: `${Math.round(fraction * 100)}%` };
  });
}

/**
 * The bar's time at the same story point as `at` in this cut: linear between the boundaries of
 * the beats both spines share (by role), else the same fraction of each cut. The viewer sees both
 * cuts at the same density this way (one bar frame for each frame of this cut).
 */
export function barTimeAt(at, { duration, barDuration, spine = [], barSpine = [] }) {
  const sorted = [[0, 0]];
  const add = (ours, theirs) => { const [lastOurs, lastTheirs] = sorted.at(-1); if (ours > lastOurs && theirs > lastTheirs) sorted.push([ours, theirs]); };
  for (const beat of [...spine].sort((a, b) => a.from - b.from)) {
    const theirs = barSpine.find((other) => other.role === beat.role);
    if (theirs && Number.isFinite(beat.from) && Number.isFinite(theirs.from) && beat.from < duration && theirs.from < barDuration) add(beat.from, theirs.from);
  }
  add(duration, barDuration);
  const right = sorted.findIndex(([ours]) => ours >= at);
  if (right <= 0) return right === 0 ? 0 : sec(barDuration - 1 / 30);
  const [a0, b0] = sorted[right - 1];
  const [a1, b1] = sorted[right];
  return sec(Math.min(barDuration - 1 / 30, b0 + ((at - a0) / (a1 - a0)) * (b1 - b0)));
}

const BAR_LINE =/^BAR\s+(better|worse|same|equal)\s*[·|:]\s*(.+?)\s*$/i;
/** A critic's BAR line → {level:"BAR", verdict, why} (same counts as worse), or null. */
export function barLine(line) {
  const match = BAR_LINE.exec(line);
  if (!match) return null;
  return { level: "BAR", verdict: /better/i.test(match[1]) ? "better" : "worse", why: match[2].slice(0, 400) };
}

const PREFER = /^\W*PREFER\W+(A|B)\b\W*(.*)$/im;
/** A viewer's PREFER line → {cut:"A"|"B", why} (A is this cut, B the bar), or null. */
export function preferLine(report) {
  const match = PREFER.exec(String(report));
  return match ? { cut: match[1].toUpperCase(), why: match[2].trim().slice(0, 300) } : null;
}

// The anti-AI-edit questions (for a cut that "looks like an AI edited it"): principles,
// not a house style. Asked of every critic.
export const AI_EDIT_QUESTIONS = [
  "Does each device (tilt, whip, roll, type-on, stream, glow) come from the story at that moment, or is it decoration?",
  "Do the captions break as spoken phrases and appear and leave with the words, or as fixed chunks?",
  "Does each cut land on an action or the voice (a word, a breath, a hit), or between them?",
  "Do the title and the end card feel designed for this product, or like a template?",
  "Count the devices: does it look like an AI stacked effects? A taste-led edit uses few and repeats them on purpose.",
];
