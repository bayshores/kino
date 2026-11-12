// Cut facts: how fast shots pass on each side of the music's turn, and how much each cut changes
// the picture (brightness and hue), for an edit and for the project's own references in the same
// units. Facts only: no rule, no target, no verdict. Plain data in, plain data out (no Node, no DOM).
import { round } from "./numbers.js";
import { medianOf } from "./footage/refPace.js";

// A frame whose channels differ by less than this (of 255) is gray: it has no hue. A guess at the
// level where 8-bit noise stops deciding the hue; changeable through frameLevel's `least`.
export const CHROMA_LEAST = 6;
// A brightness jump this large (of 255) or more counts in big10. The unit of the bar study (BAR
// SKEPTIC row 14): five human edits had 1.9 to 14.9 such jumps per 10 s, the rejected edit 0.67.
export const BIG_JUMP = 50;

/**
 * One frame's level from its mean color (0 to 255 each): { y, hue }. y uses the BT.709 weights of
 * render-output-audit.mjs `luma`, so the render's facts and these share units; hue is in degrees
 * (0 red, 120 green, 240 blue), null when the frame is gray (chroma under `least`).
 */
export function frameLevel(r, g, b, { least = CHROMA_LEAST } = {}) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
  if (chroma < least) return { y: round(y, 1), hue: null };
  let hue = high === r ? ((g - b) / chroma) % 6 : high === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { y: round(y, 1), hue: round(hue, 0) };
}

// One side's pace: the count of shots that start on it, their median length (whole length, even
// when a shot runs past the turn) and the shots per 10 s of that side.
function side(shots, seconds) {
  const median = medianOf(shots);
  return { shots: shots.length, median: median == null ? null : round(median, 2), per10: seconds > 0 ? round((shots.length / seconds) * 10, 1) : null };
}

/**
 * The pace of an edit from its cut times: { all } with no turn, else { turn, before, after }, each
 * side { shots, median, per10 }. A shot belongs to the side it starts on. `start` is where the edit
 * starts (0), `seconds` where it ends; cuts outside are ignored.
 */
export function paceFacts({ cuts = [], seconds, turn = null, start = 0 }) {
  const edges = [start, ...cuts.filter((time) => time > start && time < seconds).sort((a, b) => a - b), seconds];
  const shots = edges.slice(1).map((end, index) => ({ from: edges[index], length: end - edges[index] }));
  const all = side(shots.map((shot) => shot.length), seconds - start);
  if (!(turn > start && turn < seconds)) return { all };
  const lengths = (keep) => shots.filter(keep).map((shot) => shot.length);
  return { turn, all, before: side(lengths((shot) => shot.from < turn), turn - start), after: side(lengths((shot) => shot.from >= turn), seconds - turn) };
}

const hueStep = (a, b) => {
  if (a == null || b == null) return null;
  const step = Math.abs(a - b) % 360;
  return Math.min(step, 360 - step);
};
const percentile = (values, share) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];
};

/**
 * What each cut does to the picture, from every frame's level (levels: [{t, y, hue}] in time order):
 *   jumps       [{at, dy, dhue}]: dy = the first frame after the cut minus the last frame before
 *               (of 255), dhue the hue step in degrees (null when either frame is gray)
 *   jumpMedian  the median |dy|; hueMedian the median dhue of the cuts that have one
 *   big10       cuts with |dy| >= BIG_JUMP per 10 s of the edit
 *   sections    [{from, to, low, high}]: the 5th and 95th percentile of y on each side of the turn
 *               (one section without a turn)
 */
export function cutFacts({ cuts = [], levels = [], turn = null, seconds, big = BIG_JUMP }) {
  const frames = levels.filter((level) => Number.isFinite(level?.t) && Number.isFinite(level?.y)).sort((a, b) => a.t - b.t);
  const end = seconds ?? frames.at(-1)?.t ?? 0;
  const jumps = [];
  for (const at of [...cuts].sort((a, b) => a - b)) {
    let before = null, after = null;
    for (const frame of frames) {
      if (frame.t < at - 1e-6) before = frame;
      else { after = frame; break; }
    }
    if (!before || !after) continue;
    jumps.push({ at: round(at, 2), dy: round(after.y - before.y, 0), dhue: hueStep(before.hue, after.hue) });
  }
  const bigCount = jumps.filter((jump) => Math.abs(jump.dy) >= big).length;
  const edges = turn > 0 && turn < end ? [0, turn, end] : [0, end];
  const sections = edges.slice(1).map((to, index) => {
    const from = edges[index];
    const values = frames.filter((frame) => frame.t >= from && frame.t < to).map((frame) => frame.y);
    return { from: round(from, 2), to: round(to, 2), low: values.length ? round(percentile(values, 0.05), 0) : null, high: values.length ? round(percentile(values, 0.95), 0) : null };
  });
  const jumpMedian = medianOf(jumps.map((jump) => Math.abs(jump.dy)));
  const hueMedian = medianOf(jumps.map((jump) => jump.dhue).filter((value) => value != null));
  return { jumps, jumpMedian: jumpMedian == null ? null : round(jumpMedian, 0), hueMedian: hueMedian == null ? null : round(hueMedian, 0), big10: end > 0 ? round((bigCount / end) * 10, 1) : null, sections };
}

/**
 * The cuts after `turn` moved onto `times` (edit seconds, ascending: the song's measured beats).
 * Each cut at or after the turn (less one frame) goes to the nearest time later than the cut
 * before it and earlier than the shot's end; a cut with no such time stays. Shots keep their
 * order, media and in-points; dur follows the moved cuts. `fits(shot, dur)` (optional) says whether
 * a shot can last `dur`: a move that would give a shot a length it does not fit (it would run past
 * its clip file) is not made, and the cut stays. Returns { shots, moved: [{id, from, to}],
 * kept: [{id, at, to}] } (kept: the cuts that stayed for that reason, `to` the beat they would
 * have moved to).
 */
export function cutsOnBeats(shots, { turn, times, frame = 1 / 30, fits = null }) {
  const out = shots.map((shot) => ({ ...shot }));
  const moved = [], kept = [];
  const end = (shot) => shot.cue + shot.dur;
  for (let index = 1; index < out.length; index += 1) {
    const cut = out[index].cue;
    if (cut < turn - frame) continue;
    const after = out[index - 1].cue, until = end(out[index]);
    const open = times.filter((time) => time > after + frame && time < until - frame);
    if (!open.length) continue;
    const to = open.reduce((best, time) => (Math.abs(time - cut) < Math.abs(best - cut) ? time : best));
    if (Math.abs(to - cut) < 1e-4) continue;
    const before = round(to - out[index - 1].cue, 3), later = round(until - to, 3);
    if (fits && (!fits(out[index - 1], before) || !fits(out[index], later))) { kept.push({ id: out[index].id, at: cut, to: round(to, 3) }); continue; }
    out[index - 1].dur = before;
    out[index].dur = later;
    out[index].cue = round(to, 3);
    moved.push({ id: out[index].id, from: cut, to: out[index].cue });
  }
  return { shots: out, moved, kept };
}

const s2 = (value) => (value == null ? "-" : value.toFixed(2));
const range = (values, digits, unit = "") => {
  const known = values.filter(Number.isFinite);
  if (!known.length) return null;
  const low = Math.min(...known), high = Math.max(...known);
  return `${low.toFixed(digits)}${low === high ? "" : ` to ${high.toFixed(digits)}`}${unit}`;
};
const sideWords = (facts) => `${facts.shots} shot${facts.shots === 1 ? "" : "s"}, median ${s2(facts.median)} s, ${facts.per10 ?? "-"} per 10 s`;

/**
 * The pace line: ours (paceFacts of the board) and refs (paceFacts of each reference, those with a
 * turn counted on their after side when ours has one). The references are a low-to-high range and
 * a count, never a target. `kind` names the turn ("drop").
 */
export function paceLine(ours, refs = [], { kind = "turn" } = {}) {
  const head = ours.before
    ? `pace: before the ${kind} at ${s2(ours.turn)} s ${sideWords(ours.before)}; after, ${sideWords(ours.after)}`
    : `pace: ${sideWords(ours.all)}`;
  const turned = ours.before ? refs.filter((ref) => ref.after) : [];
  const used = ours.before ? turned : refs;
  const pick = (ref) => (ours.before ? ref.after : ref.all);
  if (!used.length) return head;
  const medians = range(used.map((ref) => pick(ref).median), 2, " s");
  const per10 = range(used.map((ref) => pick(ref).per10), 1, " per 10 s");
  const whose = ours.before ? `your ${used.length} reference${used.length === 1 ? "" : "s"} after their turn` : `your ${used.length} reference${used.length === 1 ? "" : "s"}`;
  return `${head} · ${whose}: median ${medians}, ${per10}`;
}

/**
 * The render answer's two cut lines, from a rendered file's cutFacts (`ours`) and the saved
 * references' (`refs`: each { jumpMedian, big10 }, those measured). Facts only: the references are
 * a low-to-high range and a count. Returns [] for a file with no cuts. `label` names the file
 * ("draft R2"); at most `listed` cuts are listed and the rest counted. `older` counts the saved
 * references measured before these facts were kept (not in the range).
 */
export function cutLines(ours, refs = [], { label = "", listed = 12, older = 0 } = {}) {
  if (!ours?.jumps?.length) return [];
  const sign = (value) => `${value > 0 ? "+" : ""}${value}`;
  const where = ours.sections.map((section) => `${+section.from.toFixed(1)}-${+section.to.toFixed(1)} s ${section.low ?? "-"}-${section.high ?? "-"}`).join(", ");
  const head = `cuts (${label ? `${label}, ` : ""}every frame): brightness jump median ${ours.jumpMedian ?? "-"} of 255${ours.hueMedian == null ? "" : `, hue ${ours.hueMedian}°`}; 50+ jumps ${ours.big10 ?? "-"} per 10 s; range ${where}`;
  const known = refs.filter((ref) => Number.isFinite(ref?.jumpMedian));
  const beside = known.length
    ? ` · your ${known.length} measured reference${known.length === 1 ? "" : "s"}: median ${range(known.map((ref) => ref.jumpMedian), 0)}, 50+ jumps ${range(known.map((ref) => ref.big10), 1, " per 10 s")}`
    : "";
  const unread = older > 0 ? ` · ${older} saved reference${older === 1 ? "" : "s"} measured before cut facts were kept (library {topic:"inspire", name:"measure <id>"} reads one again)` : "";
  const shown = ours.jumps.slice(0, listed).map((jump) => `${s2(jump.at)} ${sign(jump.dy)} ${jump.dhue == null ? "-" : `${jump.dhue}°`}`);
  const all = ours.cutCount ?? ours.jumps.length;
  const more = all > listed ? `, ... (${all - listed} more)` : "";
  return [`${head}${beside}${unread}`, `per cut: ${shown.join(", ")}${more}`];
}

/**
 * The beat line: the song's measured beat times after the turn, every `beats` beats, with where
 * that step came from (`why`). `call` names the one call that moves the cuts there.
 */
export function beatLine({ turn, beats, period, times, why, kind = "turn", call = null }) {
  if (!times?.length) return null;
  const every = beats === 1 ? "every beat" : `every ${beats} beats`;
  return `the song's beats after the ${kind} at ${s2(turn)} s, ${every} (${(beats * period).toFixed(3)} s${why ? `; ${why}` : ""}): ${times.map(s2).join(", ")}${call ? ` · ${call} puts the cuts after it there` : ""}`;
}
