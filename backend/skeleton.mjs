// A reference's skeleton: its measured stretch shot by shot, read only from what the saved
// reference record already holds (no new download, no new measure), then lent onto a project's
// time as sections and length distributions (borrow_rhythm). Timing and section shape only: never
// fonts, colors or shot content.
//
// Where each field comes from (a field the record cannot support is left out):
//   start, len     numbers.cuts (cuts under 6 frames apart dropped, as lentCuts) and numbers.seconds
//   beats          len over the reference's own beat (record.bpm), only when bpm is known
//   text           a text reveal time of the fingerprint (text.examples, at most 3 per style) inside
//                  the shot: a lower bound, not every shot with lettering
//   motion         a camera move time (fingerprint camera.examples, strip kinds) inside the shot,
//                  else the fingerprint's motion curve (mean per second) over the shot: still, moving, fast
//   hit            "beat" when the shot's first cut is on the reference's beat (numbers.onBeat),
//                  "change" when the song's loudest change (heard.change) lands on its first frames
// Sections: holds (a shot at least max(1 s, 2.5 x the median)), fast runs (4+ shots in a row
// under the median) and steady stretches between them, plus the song's change point.
import { round } from "../engine/numbers.js";
import { mediaPlaybackRange } from "../engine/playback.js";
import { hiddenRanges } from "../engine/visibilityOps.js";
import { COPY_RUN, copiedRun } from "../engine/quality/rules/reference.js";
import { lentCuts } from "./inspire.mjs";

// The fingerprint's still speed (backend/measure/fingerprint.mjs STILL_SPEED, not imported: that
// module loads only when a reference is measured); a shot's mean curve under 3x it reads as still.
const STILL_SPEED = 0.015;
const HIT_WINDOW = 0.15;
const FAST_RUN = 4;
const HOLD_TIMES_MEDIAN = 2.5;
const HOLD_MIN = 1;
const LEND_DRAWS = 8;

const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** The skeleton of a measured reference record, or null when it holds no cuts. */
export function referenceSkeleton(record) {
  const numbers = record?.numbers;
  if (!(numbers?.seconds > 0) || !Array.isArray(numbers.cuts)) return null;
  const seconds = numbers.seconds;
  const kept = lentCuts(numbers);
  const starts = [0, ...kept.map((index) => numbers.cuts[index])];
  const bpm = record.bpm > 0 ? record.bpm : null;
  const fp = record.fingerprint ?? null;
  const reveals = Object.entries(fp?.text?.examples ?? {}).flatMap(([style, times]) => (Array.isArray(times) ? times : []).map((at) => ({ at, style })));
  const cameraTimes = [
    ...Object.entries(fp?.camera?.examples ?? {}).flatMap(([kind, times]) => (Array.isArray(times) ? times : []).map((at) => ({ at, kind }))),
    // A saved record keeps strips; the store's summary {full:true} names them stripList.
    ...(Array.isArray(record.stripList) ? record.stripList : Array.isArray(record.strips) ? record.strips : []).flatMap((strip) => (strip.kinds ?? []).filter((kind) => /^(zoom-in|zoom-out|pan|rotate|whip)$/.test(kind)).map((kind) => ({ at: strip.at, kind }))),
  ];
  const curve = Array.isArray(fp?.motion?.curve) ? fp.motion.curve : null;
  const fast = fp?.motion?.p90 > 0 ? fp.motion.p90 : null;
  const change = Number.isFinite(record.heard?.change?.at) ? { at: record.heard.change.at, kind: record.heard.change.kind ?? "change" } : null;
  const shots = starts.map((start, index) => {
    const end = starts[index + 1] ?? seconds;
    const len = end - start;
    const shot = { start: round(start), len: round(len) };
    if (bpm) shot.beats = round(len / (60 / bpm), 2);
    const reveal = reveals.find((entry) => entry.at >= start - 1e-6 && entry.at < end);
    if (reveal) shot.text = reveal.style;
    const camera = cameraTimes.find((entry) => entry.at >= start - 1e-6 && entry.at < end);
    if (camera) shot.motion = camera.kind;
    else if (curve) {
      const values = curve.slice(Math.floor(start), Math.max(Math.floor(start) + 1, Math.ceil(end))).filter((value) => Number.isFinite(value));
      if (values.length) {
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        shot.motion = mean < 3 * STILL_SPEED ? "still" : fast && mean >= fast ? "fast" : "moving";
      }
    }
    const cutIndex = index ? kept[index - 1] : null;
    if (change && Math.abs(change.at - start) <= HIT_WINDOW && (index || change.at <= HIT_WINDOW)) shot.hit = "change";
    else if (cutIndex !== null && numbers.onBeat?.[cutIndex] === true) shot.hit = "beat";
    return shot;
  });
  const median = medianOf(shots.map((shot) => shot.len));
  const holdMin = Math.max(HOLD_MIN, HOLD_TIMES_MEDIAN * median);
  const kinds = shots.map((shot) => (shot.len >= holdMin ? "hold" : "steady"));
  for (let index = 0; index < shots.length;) {
    let end = index;
    while (end < shots.length && kinds[end] !== "hold" && shots[end].len < median) end += 1;
    if (end - index >= FAST_RUN) for (let k = index; k < end; k += 1) kinds[k] = "fast";
    index = Math.max(end, index + 1);
  }
  const sections = [];
  shots.forEach((shot, index) => {
    const last = sections.at(-1);
    if (last && last.kind === kinds[index]) { last.shots.push(index); last.to = round(shot.start + shot.len); }
    else sections.push({ kind: kinds[index], from: shot.start, to: round(shot.start + shot.len), shots: [index] });
  });
  let changeAt = null;
  if (change) {
    // The shot that starts on the change (within HIT_WINDOW), else the shot it plays inside.
    const starting = shots.findIndex((shot) => Math.abs(shot.start - change.at) <= HIT_WINDOW);
    const index = starting >= 0 ? starting : shots.findIndex((shot) => change.at >= shot.start && change.at < shot.start + shot.len);
    if (index >= 0) changeAt = { at: round(change.at, 2), kind: change.kind, shot: index, hold: kinds[index] === "hold", cut: Math.abs(shots[index].start - change.at) <= HIT_WINDOW && index > 0 };
  }
  const textBox = (fp?.persistent ?? []).find((entry) => entry.kind === "text" && Array.isArray(entry.box));
  const text = reveals.length || fp?.text ? {
    shots: shots.filter((shot) => shot.text).length,
    ...(Number.isFinite(fp?.text?.share) ? { share: fp.text.share } : {}),
    ...(textBox ? { where: placeWords(textBox.box) } : {}),
    ...(fp?.text?.limits?.height > 0 ? { height: fp.text.limits.height } : {}),
  } : null;
  return { id: record.id ?? null, title: record.title ?? null, seconds: round(seconds), bpm, median: round(median), holdMin: round(holdMin), shots, sections, change: changeAt, ...(text ? { text } : {}) };
}

// "top left", "low center" for a box [x, y, w, h] in frame shares.
function placeWords([x, y, w, h]) {
  const cy = y + h / 2, cx = x + w / 2;
  return `${cy < 1 / 3 ? "top" : cy > 2 / 3 ? "low" : "middle"} ${cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center"}`;
}

const s = (value) => `${round(value, 1)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "skeleton: 70 shots; open 3 holds of 1.3 to 2.1 s; fast run 5.0 to 9.7 s (11 shots, median 0.35 s); ..." */
export function skeletonLine(skeleton) {
  if (!skeleton?.shots?.length) return null;
  const { shots, sections } = skeleton;
  const lens = (section) => section.shots.map((index) => shots[index].len);
  const describe = (section) => {
    const values = lens(section);
    if (section.kind === "hold") return values.length === 1 ? `hold ${s(values[0])} s at ${s(section.from)} s` : `${values.length} holds of ${s(Math.min(...values))} to ${s(Math.max(...values))} s at ${s(section.from)} s`;
    return `${section.kind === "fast" ? "fast run" : "steady"} ${s(section.from)} to ${s(section.to)} s (${plural(values.length, "shot")}, median ${round(medianOf(values), 2)} s)`;
  };
  const parts = [`${plural(shots.length, "shot")} in ${s(skeleton.seconds)} s, median ${round(skeleton.median, 2)} s`];
  const first = sections[0];
  parts.push(first.kind === "steady" && first.shots.length === 1 ? `open 1 shot ${s(shots[0].len)} s` : `open ${describe(first).replace(/ at 0 s$/, "")}`);
  const fastRuns = sections.slice(1).filter((section) => section.kind === "fast");
  const holds = sections.slice(1).filter((section) => section.kind === "hold");
  for (const section of fastRuns.slice(0, 2)) parts.push(describe(section));
  if (fastRuns.length > 2) parts.push(`${fastRuns.length - 2} more fast runs`);
  for (const section of holds.slice(0, 2)) parts.push(describe(section));
  if (holds.length > 2) parts.push(`${holds.length - 2} more holds`);
  const change = skeleton.change;
  if (change) parts.push(change.hold ? `hold at the ${change.kind} ${s(change.at)} s` : change.cut ? `cut on the ${change.kind} ${s(change.at)} s` : `${change.kind} ${s(change.at)} s inside a ${s(shots[change.shot].len)} s shot`);
  const text = skeleton.text;
  if (text) parts.push(`lettering on ${plural(text.shots, "shot")} by reveal times${Number.isFinite(text.share) ? ` (text on ${Math.round(text.share * 100)}% of frames)` : ""}${text.where ? `, ${text.where}` : ""}${text.height ? `, lines up to ${Math.round(text.height * 100)}% tall` : ""}`);
  const motion = {};
  for (const shot of shots) if (shot.motion) motion[shot.motion] = (motion[shot.motion] ?? 0) + 1;
  const motionWords = Object.entries(motion).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${count} ${kind}`);
  if (motionWords.length) parts.push(`motion ${motionWords.join(", ")}`);
  const beats = shots.filter((shot) => shot.hit === "beat").length;
  if (beats) parts.push(`${plural(beats, "cut")} on its beat`);
  return `skeleton: ${parts.join("; ")} (borrow_rhythm lends it)`;
}

/** A seed from a project id (the same project, the same order; another project, another one). */
export function seedOf(text) {
  let hash = 2166136261;
  for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash % 9000) + 1000;
}

function seeded(seed) {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

/**
 * Lends a skeleton onto a project's time. Each section's shot lengths, scaled by `scale`, in a
 * new order drawn by `seed` (order "exact" keeps the reference's order); cut times from `at`;
 * with `beats` (scene seconds) each cut moves to the nearest beat within half the shorter shot
 * beside it; `seams` (song section edges) are cuts. A draw that copies COPY_RUN of the reference's
 * shot lengths in a row (reference_closeness) is drawn again, then broken by swapping two shots.
 * Returns {cues, sections, lengths, seed, scale, snapped, dropped, order}.
 */
export function lendSkeleton(skeleton, { length, at = 0, fit = null, seed = 1, order = "shuffle", beats = [], seams = [], fps = 24 } = {}) {
  const scale = fit > 0 ? fit / skeleton.seconds : 1;
  // Sections scale with the project; shot lengths scale with it only between 0.5x and 2x, so a long
  // reference lent to a short video keeps its pace and lends fewer shots per section.
  const lenScale = Math.min(2, Math.max(0.5, scale));
  const span = skeleton.seconds * scale;
  const random = seeded(seed);
  const shortest = 6 / fps;
  const refCuts = skeleton.shots.slice(1).map((shot) => shot.start);
  const shuffle = (bag) => {
    for (let last = bag.length - 1; last > 0; last -= 1) {
      const pick = Math.floor(random() * (last + 1));
      [bag[last], bag[pick]] = [bag[pick], bag[last]];
    }
    return bag;
  };
  const draw = () => skeleton.sections.flatMap((section) => {
    const target = (section.to - section.from) * scale;
    const pool = section.shots.map((index) => skeleton.shots[index].len * lenScale);
    if (order === "exact" && lenScale === scale) return pool;
    if (section.kind === "hold" && section.shots.length === 1) return [target];
    // The section's lengths in a new order (drawn again when they run out) until it is full; the
    // last shot takes what is left, so every section edge is a cut.
    const out = [];
    let used = 0, bag = [];
    while (target - used > shortest) {
      if (!bag.length) bag = order === "exact" ? [...pool].reverse() : shuffle([...pool]);
      // A shot fits when it fills the section or leaves at least the shortest shot after it.
      const pick = bag.findLastIndex((len) => Math.abs(target - used - len) < 1e-6 || used + len <= target - shortest + 1e-6);
      if (pick < 0) break;
      const len = bag.splice(pick, 1)[0];
      out.push(len);
      used += len;
    }
    if (!out.length) return [target];
    out[out.length - 1] += target - used;
    return out;
  });
  const place = (lengths) => {
    const times = [];
    let time = at;
    for (const len of lengths.slice(0, -1)) { time += len; times.push(time); }
    let snapped = 0;
    if (beats.length) {
      for (let index = 0; index < times.length; index += 1) {
        const before = index ? times[index - 1] : at;
        const after = times[index + 1] ?? at + span;
        const reach = Math.min(times[index] - before, after - times[index]) / 2;
        const beat = beats.reduce((best, value) => (Math.abs(value - times[index]) < Math.abs(best - times[index]) ? value : best), Infinity);
        if (Math.abs(beat - times[index]) <= reach && beat - before >= shortest && after - beat >= shortest && Math.abs(beat - times[index]) > 1e-4) { times[index] = beat; snapped += 1; }
      }
    }
    for (const seam of seams) {
      if (!(seam > at + shortest && seam < at + span - shortest)) continue;
      const nearest = times.reduce((best, value, index) => (best < 0 || Math.abs(value - seam) < Math.abs(times[best] - seam) ? index : best), -1);
      const before = nearest > 0 ? times[nearest - 1] : at;
      const after = times[nearest + 1] ?? at + span;
      if (nearest >= 0 && seam - before >= shortest && after - seam >= shortest) times[nearest] = seam;
      else times.push(seam);
    }
    return { times: [...new Set(times.map((value) => round(value)))].sort((a, b) => a - b), snapped };
  };
  const copies = (times) => order !== "exact" && refCuts.length > COPY_RUN && [24, 30, 60].map((rate) => copiedRun([at, ...times, at + span], [0, ...refCuts, skeleton.seconds], { tolerance: 1 / rate + 0.01 })).find(Boolean);
  let lengths = draw();
  let placed = place(lengths);
  for (let tries = 1; tries < LEND_DRAWS && copies(placed.times); tries += 1) { lengths = draw(); placed = place(lengths); }
  // Still a copied run (sections of one or two shots cannot be reordered): swap two unequal shots inside it.
  for (let tries = 0, run = copies(placed.times); run && tries < 20; tries += 1, run = copies(placed.times)) {
    const start = Math.max(0, placed.times.findIndex((time) => Math.abs(time - run.at) < 1e-3));
    const k = Math.min(lengths.length - 2, start + 2 + (tries % 3));
    const swap = lengths.findIndex((value, index) => index > k && Math.abs(value - lengths[k]) > 0.05);
    if (swap < 0) break;
    [lengths[k], lengths[swap]] = [lengths[swap], lengths[k]];
    placed = place(lengths);
  }
  const kept = placed.times.filter((time) => time > at && (!(length > 0) || time < length));
  return {
    cues: kept.map((time, index) => ({ name: `rhythm-${index + 1}`, time, kind: "marker" })),
    sections: skeleton.sections.length, lengths: skeleton.shots.length, shots: lengths.length, seed, scale: round(scale), lenScale: round(lenScale), snapped: placed.snapped, dropped: placed.times.length - kept.length, order,
  };
}

/** The receipt's line: "from 'Trust (4k AMV)': 12 sections, 70 shot lengths, seed 5831, ...". */
export function lendNote(skeleton, lent, { ref, beatsFrom = null }) {
  const title = skeleton.title ? `'${String(skeleton.title).slice(0, 48)}'` : ref;
  const seedWords = lent.order === "exact" ? "its own order (order:\"exact\")" : `seed ${lent.seed}${lent.seedFrom ? ` (${lent.seedFrom})` : ""}`;
  const snap = beatsFrom ? `, ${lent.snapped} cuts snapped to ${beatsFrom}` : ", not snapped (no beat cues or rhythm in the project)";
  const scaled = lent.lenScale === lent.scale ? `scaled ${lent.scale}x` : `sections scaled ${lent.scale}x, shot lengths ${lent.lenScale}x (0.5x to 2x)`;
  return `borrow_rhythm from ${ref} ${title}: ${plural(lent.sections, "section")}, ${lent.lengths} shot lengths, ${seedWords}, ${scaled}${snap}: ${lent.cues.length} marks rhythm-1 to rhythm-${lent.cues.length}${lent.dropped ? ` (${lent.dropped} past the scene left out)` : ""}`;
}

/**
 * board {snap:"rhythm"}: each of the board's cuts, in order, moves to the nearest lent mark
 * (rhythm-N times) between the cut before it (as moved) and its own shot's end; one mark per cut,
 * marks in order. A cut whose move would lengthen a shot past its clip (`fits(shot, dur)`) stays.
 * Returns {shots, moved: [{from, to}], kept: [{at, to}]}.
 */
export function cutsOnMarks(shots, marks, { fits = () => true, gap = 0.1 } = {}) {
  const times = [...marks].sort((a, b) => a - b);
  const out = shots.map((shot) => ({ ...shot }));
  const moved = [], kept = [];
  let lastMark = -1;
  for (let index = 1; index < out.length; index += 1) {
    const cut = out[index].cue;
    const low = out[index - 1].cue + gap, high = cut + out[index].dur - gap;
    let best = -1;
    for (let k = lastMark + 1; k < times.length; k += 1) {
      if (times[k] <= low || times[k] >= high) continue;
      if (best < 0 || Math.abs(times[k] - cut) < Math.abs(times[best] - cut)) best = k;
    }
    if (best < 0 || Math.abs(times[best] - cut) < 1e-4) { if (best >= 0) lastMark = best; continue; }
    const to = round(times[best]);
    const end = out[index].cue + out[index].dur;
    if (!fits(out[index - 1], to - out[index - 1].cue) || !fits(out[index], end - to)) { kept.push({ at: cut, to }); continue; }
    out[index - 1].dur = round(to - out[index - 1].cue);
    out[index].cue = to;
    out[index].dur = round(end - to);
    moved.push({ from: cut, to });
    lastMark = best;
  }
  return { shots: out, moved, kept };
}

/**
 * An edit's shots for skeletonGap: [{len, text}] of its first scene, from the saved board (cue,
 * dur) when it has one, else from where its video and picture layers start and end. text: a text
 * layer (and every group above it) is shown at the shot's middle (Hide and Show only).
 */
export function editShots(document) {
  const scene = (document?.scenes ?? []).find((item) => !item.isComponent);
  if (!scene) return [];
  const duration = Number(scene.duration) || 0;
  let spans;
  if (document.board?.shots?.length) spans = document.board.shots.filter((shot) => shot.dur > 0).map((shot) => ({ from: shot.cue, to: shot.cue + shot.dur }));
  else {
    const edges = new Set([0, duration]);
    for (const layer of scene.layers ?? []) {
      if (!(layer.type === "video" || layer.type === "image") || layer.visible === false) continue;
      const range = mediaPlaybackRange(layer, duration);
      if (range) { edges.add(round(range.start)); edges.add(round(range.end)); }
    }
    const times = [...edges].filter((time) => time >= 0 && time <= duration).sort((a, b) => a - b);
    spans = times.slice(1).map((to, index) => ({ from: times[index], to })).filter((span) => span.to - span.from > 0.02);
  }
  const byId = new Map((scene.layers ?? []).map((layer) => [layer.id, layer]));
  const shownAt = (layer, time) => {
    for (let item = layer; item; item = item.parentId ? byId.get(item.parentId) : null) {
      if (item.visible === false || hiddenRanges(item.animations ?? [], duration).some((range) => time >= range.start && time < range.end)) return false;
    }
    return true;
  };
  const texts = (scene.layers ?? []).filter((layer) => layer.type === "text" && String(layer.text ?? "").trim());
  return spans.map((span) => ({ len: round(span.to - span.from), text: texts.some((layer) => shownAt(layer, (span.from + span.to) / 2)) }));
}

/**
 * The gap between an edit's shots ([{len, text: bool}]) and a skeleton, in three facts: the
 * distance between the shot length distributions (mean gap of 9 quantiles over the larger median,
 * 0 = same), the share of shots with lettering, and holds (count and lengths, the skeleton's rule).
 */
export function skeletonGap(skeleton, shots) {
  if (!skeleton?.shots?.length || !shots?.length) return null;
  const ours = shots.map((shot) => shot.len).sort((a, b) => a - b);
  const theirs = skeleton.shots.map((shot) => shot.len).sort((a, b) => a - b);
  const at = (list, q) => list[Math.min(list.length - 1, Math.floor(q * list.length))];
  const qs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const base = Math.max(medianOf(ours), medianOf(theirs), 1e-3);
  const distance = round(qs.reduce((sum, q) => sum + Math.abs(at(ours, q) - at(theirs, q)), 0) / qs.length / base, 2);
  const holdsOf = (lens) => lens.filter((len) => len >= skeleton.holdMin);
  const holdWords = (lens) => (lens.length ? `${lens.length} (${lens.map((len) => s(len)).join(", ")} s)` : "0");
  const ourText = Math.round((shots.filter((shot) => shot.text).length / shots.length) * 100);
  const theirText = skeleton.text ? `${Math.round((skeleton.text.shots / skeleton.shots.length) * 100)}% by reveal times` : "not measured";
  return `skeleton gap ${skeleton.id ?? ""}: shot lengths distance ${distance} (median ${round(medianOf(ours), 2)} vs ${round(skeleton.median, 2)} s, ${shots.length} vs ${skeleton.shots.length} shots); lettering on ${ourText}% of shots vs ${theirText}; holds of ${s(skeleton.holdMin)} s or more ${holdWords(holdsOf(ours).slice(0, 4))} vs ${holdWords(holdsOf(theirs).slice(0, 4))}`;
}
