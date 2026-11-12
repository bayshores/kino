// What plays on the song's strong cues (its drop and section starts): for each cue, the shot on it
// and whether that stretch of its file was already shown earlier in the edit (same file, by file
// time, so speed and reverse count), and, when it was, the unused scanned shots whose tags (light,
// subject size, face) differ most from what was shown. Also each file that fills over half the
// edit. Facts only: no finding, nothing moved.
import { round } from "../numbers.js";

/** A file stretch within this many file seconds of an earlier one continues it. */
export const NEAR_SECONDS = 1;
/** A file that fills more than this share of the edit's runtime is named. */
export const TAKE_SHARE = 0.5;
/** Unused scanned shots listed on a cue whose shot was seen before. */
export const FRESH_MOST = 3;
/** Cues listed (the drop first, then the earliest section starts). */
export const CUES_MOST = 4;
/** A shot that started more than this before the cue was already on screen: no cut on the cue. */
export const ON_CUE_SECONDS = 0.1;

const EPS = 1e-3;
const s2 = (value) => value.toFixed(2);
const s1 = (value) => String(round(value, 2));

// The file stretch a span plays between edit times `from` and `to`, low to high.
function fileRange(span, from, to) {
  const a = span.fileAt(from), b = span.fileAt(to);
  return [Math.min(a, b), Math.max(a, b)];
}

// Merged length of [lo, hi] ranges.
function unionLength(ranges) {
  const sorted = ranges.filter(([lo, hi]) => hi - lo > EPS).sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity;
  for (const [lo, hi] of sorted) {
    if (hi <= end) continue;
    total += hi - Math.max(lo, end);
    end = hi;
  }
  return total;
}

// The mean tags of the shown spans before `at`: {light, size, face} (face: share of tagged spans
// with a face), each null when no shown span measured it.
function shownProfile(spans, at) {
  const tagged = spans.filter((span) => span.tags && span.at < at - EPS);
  const mean = (key, read = (value) => value) => {
    const values = tagged.map((span) => span.tags[key]).filter((value) => value !== null && value !== undefined).map(read);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return { light: mean("light"), size: mean("size"), face: mean("face", (value) => (value ? 1 : 0)) };
}

// How far a scanned shot's tags sit from the profile, 0 to 1 (the mean over the tags both have),
// or null when they share none.
function distance(tags, profile) {
  const parts = [];
  if (Number.isFinite(tags.light) && profile.light !== null) parts.push(Math.abs(tags.light - profile.light) / 255);
  if (Number.isFinite(tags.size) && profile.size !== null) parts.push(Math.abs(tags.size - profile.size) / 100);
  if (typeof tags.face === "boolean" && profile.face !== null) parts.push(Math.abs((tags.face ? 1 : 0) - profile.face));
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) / parts.length : null;
}

/**
 * The facts: { cues: [{at, kind, shot, name, file: [lo, hi] | null, shared, near, seenAt, fresh}],
 * takes: [{name, seconds, share}] }.
 * spans: the edit's shots in edit time [{at, end, n or label ("layer x"), name, file (a key, null for no footage),
 *   fileAt(t): the file second played at edit time t, tags?: {light, size, face}}];
 * cues: [{at, kind}] strong song cues in edit time; seconds: the edit's runtime;
 * pool: unused scanned shots [{label, tags: {light, size, face}}].
 * shared: file seconds of the cue's stretch already shown before the cue; near: the file gap to
 * the closest earlier stretch of the same file within NEAR_SECONDS when none overlaps (else null);
 * seenAt: the edit times [from, to] of those earlier stretches; since: the shot's start when it
 * began over ON_CUE_SECONDS before the cue (no cut on the cue), else null.
 */
export function cueShows({ spans = [], cues = [], seconds = 0, pool = [] }) {
  const ordered = [...spans].sort((a, b) => a.at - b.at);
  const drop = cues.filter((cue) => /drop/.test(cue.kind));
  const rest = cues.filter((cue) => !/drop/.test(cue.kind));
  const chosen = [...drop, ...rest].slice(0, CUES_MOST).sort((a, b) => a.at - b.at);
  const rows = chosen.map((cue) => {
    // The latest-starting span on the cue: the last cut before it (a layer under it plays on).
    const on = ordered.findLast((span) => span.at <= cue.at + EPS && span.end > cue.at + EPS) ?? null;
    // since: the shot was already on screen before the cue (no cut on it), so nothing new appears there.
    const since = on && on.at < cue.at - ON_CUE_SECONDS ? on.at : null;
    const row = { at: cue.at, kind: cue.kind, shot: on ? on.label ?? `shot ${on.n}` : null, name: on?.name ?? null, file: null, shared: 0, near: null, seenAt: [], since, fresh: [] };
    if (!on?.file) return row;
    const [lo, hi] = fileRange(on, cue.at, on.end);
    row.file = [lo, hi];
    const overlaps = [];
    for (const other of ordered) {
      if (other === on || other.file !== on.file || other.at >= cue.at - EPS) continue;
      const [a, b] = fileRange(other, other.at, Math.min(other.end, cue.at));
      const overlap = [Math.max(lo, a), Math.min(hi, b)];
      const gap = Math.max(a - hi, lo - b);
      if (overlap[1] - overlap[0] > EPS) overlaps.push(overlap);
      else if (gap <= NEAR_SECONDS) row.near = row.near === null ? Math.max(0, gap) : Math.min(row.near, Math.max(0, gap));
      else continue;
      row.seenAt.push([other.at, Math.min(other.end, cue.at)]);
    }
    row.shared = round(unionLength(overlaps), 2);
    if (row.shared > 0) row.near = null;
    if (row.seenAt.length || since !== null) {
      const profile = shownProfile(ordered, cue.at);
      row.fresh = pool.map((entry) => ({ ...entry, far: distance(entry.tags ?? {}, profile) }))
        .filter((entry) => entry.far !== null).sort((a, b) => b.far - a.far).slice(0, FRESH_MOST);
    }
    return row;
  });
  // Each file's runtime: the union of its spans' edit times (two layers of one file at once count once).
  const byFile = new Map();
  for (const span of ordered) if (span.file) {
    const entry = byFile.get(span.file) ?? { name: span.name, times: [] };
    entry.times.push([Math.max(0, span.at), Math.min(span.end, seconds || span.end)]);
    byFile.set(span.file, entry);
  }
  const takes = seconds > 0 ? [...byFile.values()].map(({ name, times }) => ({ name, seconds: unionLength(times) }))
    .map((entry) => ({ ...entry, share: entry.seconds / seconds })).filter((entry) => entry.share > TAKE_SHARE) : [];
  return { cues: rows, takes };
}

// "light 120, face, 30%": a scanned shot's tags, short.
function tagWords(tags = {}) {
  return [Number.isFinite(tags.light) ? `light ${tags.light}` : "", tags.face === true ? "face" : tags.face === false ? "no face" : "", Number.isFinite(tags.size) ? `${Math.round(tags.size)}%` : ""].filter(Boolean).join(", ");
}

/** One line per cue ("on the drop at 7.93 s: shot 9 (x.mp4) repeats ..." or "... new"), then the takes. */
export function cueShowLines(facts) {
  if (!facts) return [];
  const lines = facts.cues.map((row) => {
    const head = `on the ${row.kind} at ${s2(row.at)} s:`;
    if (row.shot === null) return `${head} no shot`;
    const shot = `${row.shot}${row.name ? ` (${row.name})` : ""}`;
    const onSince = row.since === null ? "" : `on screen since ${s1(row.since)} s (no cut on it)`;
    if (!row.file) return `${head} ${shot} ${onSince || "new"}${onSince ? "" : " (no footage)"}`;
    const fresh = row.fresh.length ? `; unused scanned shots that differ most: ${row.fresh.map((entry) => `${entry.label}${tagWords(entry.tags) ? ` (${tagWords(entry.tags)})` : ""}`).join(", ")}` : "";
    if (!row.seenAt.length) return onSince ? `${head} ${shot} ${onSince}${fresh}` : `${head} ${shot} new`;
    const where = row.seenAt.map(([from, to]) => `${s1(from)}-${s1(to)} s`).join(", ");
    const what = row.shared > 0 ? `repeats ${s1(row.shared)} s of file ${s1(row.file[0])}-${s1(row.file[1])} s shown at ${where}` : `continues the file ${s1(row.near)} s from what played at ${where}`;
    return `${head} ${shot} ${what}${onSince ? `, ${onSince}` : ""}${fresh}`;
  });
  for (const take of facts.takes) lines.push(`one take fills ${Math.round(take.share * 100)}% of the edit: ${take.name} (${s1(take.seconds)} s)`);
  return lines;
}

/** The spans of board shots: in, dur and speed (a board shot plays forward). */
export function boardSpans(shots = [], nameOf = (media) => media) {
  return shots.map((shot, index) => {
    const footage = typeof shot.media === "string" && shot.media !== "none" && typeof shot.in === "number";
    const speed = Number.isFinite(shot.speed) ? shot.speed : 1;
    return { at: shot.cue, end: shot.cue + shot.dur, n: index + 1, file: footage ? shot.media : null, name: footage ? nameOf(shot.media) : null,
      fileAt: (time) => shot.in + (time - shot.cue) * speed, tags: shot.tags ?? null };
  });
}
