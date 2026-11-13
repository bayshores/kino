// The person's early pick on the path the agent follows: while someone is at the kino app, the
// step after the treatments is a sketch round (tries.mjs, sketches.mjs) whose `next:` call is
// filled from what kino knows (the shown treatments, their source files, their words), so the
// agent only chooses a song and a font per treatment. Pure functions; brief.mjs uses them.
import { LABELS, PICK_QUESTION, OWN_PICK_CALL } from "./treatments.mjs";

// Seconds each sketch lasts.
export const SKETCH_SECONDS = 6;
// A sketch's line when its treatment has no quote: the agent writes it (a cut-off idea is not a line).
const LINE_PLACEHOLDER = "<the words on screen>";

export const SKETCH_STEP = "show sketches: their pick in the app";
// Before the round, when the song finder is on and the project has no song candidate yet: the
// song search is the step itself (a run took the bundled tracks while the finder was only named
// beside the sketch call).
export const SONG_FIRST_STEP = `find each sketch's song (real songs first), then ${SKETCH_STEP}`;
// They answered "None of these": other treatments come next, then a round of those.
export const OTHER_STEP = "they liked none of the sketches: write 5 other treatments (other ideas and moves), then show sketches of those";
// Where the song and font candidates come from (the real-song finder and the font ranking).
export const SKETCH_HINT = 'songs: library {topic:"soundtrack", song:"<title> by <artist>"} or explore:true; fonts: library {topic:"fonts"}';

/** The sketch round asked for these treatments (an option's idea is the saved one), or null. */
export function sketchRoundFor(state, treatments) {
  const ideas = new Set((treatments?.list ?? []).map((entry) => entry?.idea));
  return (state?.tries ?? []).findLast((round) => round?.sketch
    && round.options?.some((option) => option.treatment) && round.options.every((option) => !option.idea || ideas.has(option.idea))) ?? null;
}

const shownEntries = (treatments) => (treatments?.shown ?? []).map((index, position) => ({ letter: LABELS[position], entry: treatments.list[index] })).filter((one) => one.entry);

/**
 * The filled sketch-round call: one option per shown treatment, its clip the project file its
 * source names (at the seconds the source names, else 0), else the project's clips in turn; its
 * line the treatment's quote, else a placeholder. Song and font stay placeholders.
 * `files` are the project's clip and picture names.
 */
export function sketchCall(treatments, files = []) {
  const options = shownEntries(treatments).map(({ letter, entry }, index) => {
    const source = String(entry.source ?? "");
    const named = files.find((name) => source.toLowerCase().includes(String(name).toLowerCase()));
    const at = named ? Number(/(\d+(?:\.\d+)?)\s*s\b/.exec(source.slice(source.toLowerCase().indexOf(named.toLowerCase()) + named.length))?.[1] ?? 0) : 0;
    const file = named ?? (files.length ? files[index % files.length] : "<project file>");
    return { treatment: letter, song: "<title> by <artist>", font: "<family>", line: entry.quote || LINE_PLACEHOLDER, clips: [{ file, in: at }] };
  });
  return { tool: "notes", input: { action: "try", options, seconds: SKETCH_SECONDS } };
}

// While a round waits for their pick: recording a reply in words ("your call") moves on.
export const WAIT_CALL = { tool: "notes", input: { action: "brief", log: [{ q: PICK_QUESTION, a: "<their reply>" }] } };

/**
 * The step while no treatment is picked: { step, call }. A round asked for these treatments is
 * never asked again: once it ended without a pick (skipped, failed) or the app went away, the
 * pick is the agent's own. "None of these" is an answer, not a missing pick: other treatments
 * come next (`otherCall` saves them), and a new set of treatments gets its own round.
 * `own` is true under "just start" or a pick left to the agent.
 */
export function pickStep(state, treatments, { appSeen = false, own = false, files = [], leftToAgent = false, songCall = null, otherCall = null } = {}) {
  const ownPick = { step: "pick a treatment, with why", call: { tool: "notes", input: { action: "brief", fields: { treatments: { ...OWN_PICK_CALL } } } } };
  if (leftToAgent) return ownPick;
  const round = sketchRoundFor(state, treatments);
  if (round) {
    if (appSeen && (round.status === "rendering" || round.status === "waiting")) return { step: `their sketch pick in the app (${round.id}): end your turn`, call: WAIT_CALL };
    // Their note (typed with the answer) rides on the step: an agent reads `next:` before the inbox.
    if (round.status === "none" && otherCall) return { step: round.words ? `${OTHER_STEP}; their note: "${round.words}"` : OTHER_STEP, call: otherCall };
    return ownPick;
  }
  if (appSeen && songCall && !state?.soundtrack?.candidates?.length) return { step: SONG_FIRST_STEP, call: songCall };
  if (appSeen) return { step: `${SKETCH_STEP}; ${SKETCH_HINT}`, call: sketchCall(treatments, files) };
  return own ? ownPick : null;
}

/**
 * Where the sketch round stands for the saved treatments: "songs" (the next step finds the
 * sketches' songs), "show" (the next step shows sketches),
 * "wait" (their pick is waiting in the app), "other" (they liked none: other treatments first) or null (no round: the pick is asked or the agent's own).
 * The treatments text (treatments.mjs treatmentsText) says the same thing as the step.
 */
export function sketchPhase(state, treatments, { appSeen = false, leftToAgent = false, songCall = null } = {}) {
  if (!treatments?.list || treatments.picked) return null;
  const step = pickStep(state, treatments, { appSeen, own: true, leftToAgent, songCall, otherCall: {} })?.step ?? "";
  return step === SONG_FIRST_STEP ? "songs" : step.startsWith(OTHER_STEP) ? "other" : step.startsWith(SKETCH_STEP) ? "show" : step.startsWith("their sketch pick") ? "wait" : null;
}

/**
 * The last line of a sketch round's answer. Someone at the app: the pick is theirs, so the turn
 * ends there (a run read "Nothing waits on it" and picked for them). No one there: the agent goes on.
 */
export function sketchTail({ appSeen = false, treatments = false } = {}) {
  const theirs = treatments ? "saves that treatment as theirs and " : "";
  return appSeen
    ? `Someone is at the kino app: tell them the sketches are ready to play there, then end your turn. Their pick ${theirs}reaches your inbox; a reply in chat goes in next.`
    : `The person plays them on the dashboard; a pick ${theirs}reaches your inbox. Nothing waits on it.`;
}
