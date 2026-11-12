// Comparing a render's fingerprint with the fingerprints of the project's saved references
// (backend/measure/fingerprint.mjs makes both). Used by the reference_drift check
// (rules/reference.js) and by the server when it reports on a rendered draft.
//
// What may drive a warning and what only advises (measured on saved references, see
// COMPATIBILITY.md "Reference fingerprint"):
//   - text on screen (share of the time, and big type) is read reliably by Apple Vision: it drives
//     the warning;
//   - motion from optical flow cannot tell handheld footage from designed motion, and feature
//     print distances have no fixed scale: they are shown as advice, never on their own a warning.

/** A packed feature print ({q: base64 of signed bytes, k: scale}) as numbers. */
export function unpackPrint(packed) {
  const text = atob(packed.q);
  const values = new Float32Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const byte = text.charCodeAt(index);
    values[index] = (byte > 127 ? byte - 256 : byte) * packed.k;
  }
  return values;
}

/** The distance Vision uses between two feature prints: straight-line (Euclidean). */
export function printDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += (a[index] - b[index]) ** 2;
  return Math.sqrt(sum);
}

const percent = (value) => `${Math.round(value * 100)}%`;
const quantile = (values, q) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  return list.length ? list[Math.min(list.length - 1, Math.max(0, Math.round(q * (list.length - 1))))] : null;
};

// How far outside the references' range a share may be before it counts as off.
export const SHARE_MARGIN = 0.15;

/**
 * How close the references' shots are to each other: for each reference shot, the distance to the
 * nearest other shot (in any saved reference). Returns {low, high} (10th and 90th percentile) and
 * the pool of prints, or null with fewer than 4 shots.
 */
export function referenceSpread(references) {
  const pool = references.flatMap((reference) => (reference.prints ?? []).map((print) => unpackPrint(print)));
  if (pool.length < 4) return null;
  const nearest = pool.map((print, index) => Math.min(...pool.filter((_, other) => other !== index).map((other) => printDistance(print, other))));
  return { low: quantile(nearest, 0.1), high: quantile(nearest, 0.9), pool };
}

/**
 * What the saved references' own facts span, for the reference_range check: per fact {low, high, n}
 * over the references that measured it. brightness (median luma 0 to 1) and dark (share of frames
 * under 0.15) and contrast (2 x the spread of 16 x 9 cell brightness) come from `fingerprint.look`; text10 is text entrances per 10 s; voice counts the
 * references with a voice span that starts before their own loudest change (`heard`, inspire
 * measure): {n: references that heard both, before, example: {id, at}, pending: references whose
 * voice is still being measured (`heardPending`)}.
 */
export function referenceRanges(references) {
  const span = (pick) => {
    const values = references.map((reference) => pick(reference.fingerprint ?? {})).filter(Number.isFinite);
    return values.length ? { low: Math.min(...values), high: Math.max(...values), n: values.length } : null;
  };
  const entrances = (fp) => {
    const counts = fp.text?.counts;
    return counts && fp.seconds > 0 ? (Object.values(counts).reduce((sum, value) => sum + value, 0) / fp.seconds) * 10 : null;
  };
  const heard = references.filter((reference) => Array.isArray(reference.heard?.voice) && Number.isFinite(reference.heard?.change?.at));
  const first = heard.map((reference) => ({ id: reference.id, at: reference.heard.voice.map((voice) => voice[0]).filter((from) => from < reference.heard.change.at).sort((a, b) => a - b)[0] }));
  return {
    brightness: span((fp) => fp.look?.brightness), dark: span((fp) => fp.look?.darkShare), contrast: span((fp) => fp.look?.contrast), text10: span(entrances),
    voice: { n: heard.length, before: first.filter((entry) => entry.at != null).length, example: first.find((entry) => entry.at != null) ?? null, pending: references.filter((reference) => reference.heardPending).length },
  };
}

// The pace of the saved references, for the pacing rules (transitions_dense, technique_repeat's
// flash budget, even_shot_lengths). Needs this many measured references; fewer and the rules keep
// their own house bounds.
export const PACE_REFS = 2;
// A reference needs this many shots before its shot length spread means anything.
const PACE_MIN_SHOTS = 4;

/**
 * What the saved references' own cutting spans, from their lent rhythms (inspire savedRhythms:
 * [{id, seconds, allCuts, flashes}], allCuts every measured cut time): per fact {low, high, ids}
 * over the references that measured it, or null with fewer than PACE_REFS of them. cut and flash are
 * per 10 s; spread is the shot lengths' stdev / mean (the number even_shot_lengths judges). Returns
 * null unless 2 or more references have cuts, so no bound moves on one reference's say-so.
 */
export function referencePace(rhythms) {
  const facts = { cut: [], flash: [], spread: [] };
  for (const ref of rhythms ?? []) {
    const seconds = Number(ref.seconds);
    if (!(seconds > 0) || !Array.isArray(ref.allCuts) || !ref.allCuts.length) continue;
    facts.cut.push({ id: ref.id, value: (ref.allCuts.length / seconds) * 10 });
    if (Number.isFinite(ref.flashes)) facts.flash.push({ id: ref.id, value: (ref.flashes / seconds) * 10 });
    const edges = [0, ...ref.allCuts.filter((time) => time > 0 && time < seconds), seconds];
    const lengths = edges.slice(1).map((time, index) => time - edges[index]);
    const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    if (lengths.length >= PACE_MIN_SHOTS && average > 0) {
      facts.spread.push({ id: ref.id, value: Math.sqrt(lengths.reduce((sum, value) => sum + (value - average) ** 2, 0) / lengths.length) / average });
    }
  }
  const span = (list) => (list.length >= PACE_REFS
    ? { low: Math.min(...list.map((entry) => entry.value)), high: Math.max(...list.map((entry) => entry.value)), ids: list.map((entry) => entry.id) }
    : null);
  const cut = span(facts.cut);
  return cut ? { cut, flash: span(facts.flash), spread: span(facts.spread) } : null;
}

/** A per-10-s span turned into counts over `seconds`: {low, high} whole numbers (low rounded, high rounded up). */
export function paceCounts(span, seconds) {
  return { low: Math.round((span.low * seconds) / 10), high: Math.ceil((span.high * seconds) / 10 - 1e-6) };
}

/**
 * The render against the references, as rows: [{key, label, value, low, high, off, drives, line}].
 * `render` and each reference's `fingerprint` come from fingerprint.mjs; `renderPrints` and each
 * reference's `prints` are packed feature prints. Rows a side did not measure are left out.
 */
export function compareFingerprints(render, references, { renderPrints = [] } = {}) {
  const rows = [];
  const measured = references.filter((reference) => reference.fingerprint);
  const range = (pick) => {
    const values = measured.map((reference) => pick(reference.fingerprint)).filter(Number.isFinite);
    return values.length ? { low: Math.min(...values), high: Math.max(...values) } : null;
  };
  const shareRow = (key, label, pick, drives) => {
    const value = pick(render);
    const span = range(pick);
    if (!Number.isFinite(value) || !span) return;
    const off = value > span.high + SHARE_MARGIN || value < span.low - SHARE_MARGIN;
    const refs = span.low === span.high ? `reference ${percent(span.low)}` : `references ${percent(span.low)} to ${percent(span.high)}`;
    rows.push({ key, label, value, ...span, off, drives, line: `${label} ${percent(value)} (${refs})` });
  };
  shareRow("text", "text on screen", (fp) => fp.text?.share, true);
  shareRow("bigText", "big type on screen", (fp) => fp.text?.bigShare, true);
  // Text alone on a plain frame (no picture): off at over twice the references' highest share.
  // Fingerprints made before onlyShare was measured give it as onPlain x share.
  const onlyShare = (fp) => fp.text?.onlyShare ?? (Number.isFinite(fp.text?.onPlain) && Number.isFinite(fp.text?.share) ? Math.round(fp.text.onPlain * fp.text.share * 100) / 100 : null);
  const only = onlyShare(render);
  const onlySpan = range(onlyShare);
  if (Number.isFinite(only) && onlySpan) {
    const refs = onlySpan.low === onlySpan.high ? `reference ${percent(onlySpan.low)}` : `references ${percent(onlySpan.low)} to ${percent(onlySpan.high)}`;
    // Over references with almost none, twice is not enough: an end card is text alone too.
    const off = only > 2 * onlySpan.high && only - onlySpan.high > SHARE_MARGIN;
    rows.push({ key: "textOnly", label: "text alone on a plain frame", value: only, ...onlySpan, off, drives: true, line: `text alone on a plain frame ${percent(only)} (${refs}; twice is off)` });
  }
  shareRow("still", "camera still", (fp) => fp.motion?.stillShare, false);
  shareRow("camera", "camera moving", (fp) => fp.camera?.moving, false);
  // How text appears: the share of text entrances that come in a word (or a few words) at a time.
  // Only when both sides were read densely enough to tell (a full measure, not a render check).
  const wordShare = (fp) => {
    const counts = fp.text?.counts;
    const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0;
    return total >= 3 ? counts.words / total : null;
  };
  shareRow("words", "text entrances word by word", wordShare, false);
  // How shots hand off: cuts that land while the picture moves.
  shareRow("cutsInMotion", "cuts in motion", (fp) => (fp.handoff?.cuts >= 3 ? fp.handoff.inMotion / fp.handoff.cuts : null), false);
  // The longest stretch the picture holds still (a static card reads cheap): off only when it is
  // much longer than the references' longest (half again, plus half a second).
  const hold = render.motion?.longestStill?.seconds;
  const holds = range((fp) => fp.motion?.longestStill?.seconds);
  if (Number.isFinite(hold) && holds) {
    const refs = holds.low === holds.high ? `reference ${holds.low} s` : `references ${holds.low} to ${holds.high} s`;
    rows.push({ key: "hold", label: "longest still hold", value: hold, ...holds, off: hold > holds.high * 1.5 + 0.5, drives: false, line: `longest still hold ${hold} s (${refs})` });
  }
  // Closeness: each render print to its nearest reference shot, against how close reference
  // shots are to each other.
  const spread = referenceSpread(measured);
  if (spread && renderPrints.length) {
    const nearest = renderPrints.map((packed) => {
      const print = unpackPrint(packed);
      return Math.min(...spread.pool.map((other) => printDistance(print, other)));
    });
    const value = quantile(nearest, 0.5);
    const off = value > spread.high * 1.25;
    rows.push({ key: "closeness", label: "nearest reference shot", value, low: spread.low, high: spread.high, off, drives: false,
      line: `nearest reference shot ${value.toFixed(2)} (reference shots ${spread.low.toFixed(2)} to ${spread.high.toFixed(2)} apart)` });
  }
  return rows;
}
