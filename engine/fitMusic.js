// fit_music: the song as the edit's structure.
//
// The agent service measures the music file first (backend/song-shape.mjs: sections; the beat
// analysis: the bar grid) and puts both in the operation, like detect_beats. planFitMusic then
// cuts the song in song order, only on bar lines (a section start, a phrase line, first), so that:
// - a drop lands on the payoff (and an earlier drop on the turn, when one is given);
// - the song's break or build before that drop plays under the lines before the payoff;
// - the song's own ending lands at `end` (worked backwards from it), or, when the file is cut
//   off, the last piece fades out over at least a bar, ending on a bar line.
// Every offset differs from the payoff's by whole bars, so the beat never stumbles at a cut;
// each cut is a short crossfade that reaches full volume on the incoming downbeat.
// applyFitMusic turns the plan into pieces of the music layer (like cut_speech's pieces) and
// writes the sections as marker cues song-<kind>-<n> in video time.
import { uid } from "./model.js";
import { withCues } from "./cues.js";
import { round } from "./numbers.js";

const EPS = 1e-6;
// How far a cut's bar line may sit outside its window. The window's ends come from measured times:
// the tempo is a measurement (a bar of 1.9999983 s, not 2), and FFmpeg 6 decodes an AAC file's end
// padding too (up to 1024 samples, 23 ms at 44.1 kHz), so a bar line on a window's end can land a
// hair outside it. 50 ms is far under any bar and too short to hear.
const CUT_SLACK = 0.05;
export const FIT_NAMES = Object.freeze({ in: "Fit in", out: "Fit out" });
const RUN_UP_BARS = 16;

function fail(message) {
  throw new Error(`fit_music: ${message}`);
}

/**
 * The bar grid of a beat analysis {bpm, period, beats, onsets}: {bar, beat, downbeat}, the
 * downbeat on the first drop's beat. Without a drop, and with weighted onsets (beat analysis
 * version 7), the downbeat is the first beat of the four whose beats carry the most heavy low
 * sound (the kick on the one); otherwise the first beat.
 */
export function barGrid(analysis, sections = []) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const beat = analysis?.period > 0 ? analysis.period : analysis?.bpm > 0 ? 60 / analysis.bpm : null;
  if (!(beat > 0) || beats.length < 4) return null;
  const drop = sections.find((part) => part.kind === "drop");
  let downbeat = beats[0];
  if (drop) downbeat = beats.reduce((best, time) => (Math.abs(time - drop.at) < Math.abs(best - drop.at) ? time : best), beats[0]);
  else {
    const onsets = (Array.isArray(analysis?.onsets) ? analysis.onsets : []).filter((onset) => typeof onset.weight === "number");
    const totals = [0, 0, 0, 0];
    let cursor = 0;
    beats.forEach((time, index) => {
      while (cursor < onsets.length && onsets[cursor].time < time - 0.035) cursor += 1;
      for (let at = cursor; at < onsets.length && onsets[at].time <= time + 0.035; at += 1) totals[index % 4] += onsets[at].weight * (onsets[at].low ?? 0);
    });
    const phase = totals.indexOf(Math.max(...totals));
    if (totals[phase] > 0) downbeat = beats[phase];
  }
  return { bar: beat * 4, beat, downbeat };
}

/**
 * The plan: song {sections [{at, kind}], seconds, whole}, grid {bar, beat?, downbeat}, video
 * {payoff, turn?, end}. Returns {pieces: [{from, to, at, fadeIn, fadeOut}] (song seconds, video
 * start), sections: [{at, kind, label?}] in video time, ending, notes}.
 */
export function planFitMusic({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, payoff, turn = null, end }) {
  if (!(bar > 0)) fail("the song has no steady beat, so it cannot be cut on bar lines.");
  const snap = (time) => downbeat + Math.round((time - downbeat) / bar) * bar;
  // Cuts go on bar lines (at); the cues keep each edge as measured (heard), with its weight.
  const parts = sections.map((part) => ({ kind: part.kind, at: Math.max(0, snap(part.at)), heard: part.at, weight: part.weight }));
  const drops = [...new Set(parts.filter((part) => part.kind === "drop").map((part) => part.at))];
  if (!drops.length) fail("the song has no drop (no point where the kick and bass come in strong); pick a song with one, or place it with update_layer.");
  const notes = [];
  // The run-up into a drop: the latest break before it (within 16 bars), else the latest build.
  const runUp = (drop) => {
    const near = parts.filter((part) => part.at < drop - EPS && part.at >= drop - RUN_UP_BARS * bar);
    return near.filter((part) => part.kind === "break").at(-1) ?? near.filter((part) => part.kind === "build").at(-1) ?? null;
  };
  const roomAfter = (drop) => !whole || seconds - drop >= end - payoff - bar / 2;

  // The payoff's drop: room after it for the ending, an earlier drop for the turn, a run-up before it.
  const penalty = (drop) => (roomAfter(drop) ? 0 : 100) + (turn != null && !drops.some((other) => other < drop - EPS) ? 10 : 0)
    + (runUp(drop) ? 0 : 5) + (drop >= payoff - EPS ? 0 : 3);
  const drop = [...drops].sort((a, b) => penalty(a) - penalty(b) || b - a)[0];
  const lead = runUp(drop);
  if (!lead) notes.push("no break or build before the drop in this song: nothing quiets the line before the payoff");
  const oPayoff = payoff - drop;

  // The turn: an earlier drop, a whole number of bars from the payoff's offset (within half a bar of the turn).
  let turnPiece = null;
  if (turn != null) {
    const options = drops.filter((other) => other < drop - EPS).map((other) => {
      const skip = (drop - other) - (payoff - turn);
      const bars = Math.max(0, Math.round(skip / bar));
      const offset = oPayoff + bars * bar;
      return { drop: other, offset, lands: other + offset };
    }).filter((option) => option.lands < payoff - bar + EPS);
    turnPiece = options.sort((a, b) => Math.abs(a.lands - turn) - Math.abs(b.lands - turn) || b.drop - a.drop)[0] ?? null;
    if (!turnPiece) notes.push("no earlier drop for the turn");
  }

  // A cut from offset `from` to offset `to` in (lo, hi]: on an incoming phrase line (song times
  // `prefer` first, then any section start), else the video bar line nearest `target`.
  const cutAt = (lo, hi, offset, prefer, target) => {
    const inRange = (time) => time >= lo - CUT_SLACK && time <= hi + CUT_SLACK;
    for (const song of prefer) if (song != null && inRange(song + offset)) return song + offset;
    const lines = parts.map((part) => part.at + offset).filter(inRange);
    if (lines.length) return lines.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const first = downbeat + offset + Math.ceil((lo - CUT_SLACK - downbeat - offset) / bar) * bar;
    const options = [];
    for (let time = first; time <= hi + CUT_SLACK; time += bar) options.push(time);
    return options.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? null;
  };

  // Pieces in video order: [offset, cut into it].
  const chain = [];
  if (turnPiece) {
    chain.push({ offset: turnPiece.offset });
    if (Math.abs(turnPiece.offset - oPayoff) > EPS) {
      const cut = cutAt(turnPiece.lands + bar, payoff, oPayoff, [lead?.at], payoff - 4 * bar);
      if (cut == null) { notes.push("no bar line between the turn and the payoff to cut on"); chain.length = 0; turnPiece = null; }
      else chain.push({ offset: oPayoff, cut });
    }
  }
  if (!chain.length) chain.push({ offset: oPayoff });

  // The ending, worked back from `end`: skip whole bars so the song's last second lands at or just before it.
  let ending = null;
  if (whole) {
    const skip = (seconds - drop) - (end - payoff);
    const bars = skip > 0.01 ? Math.ceil(skip / bar - 0.01) : 0;
    const offset = oPayoff - bars * bar;
    const lands = seconds + offset;
    if (bars === 0) ending = { at: round(lands), offset };
    else {
      const outro = parts.filter((part) => part.kind === "outro").map((part) => part.at);
      // The payoff's drop plays at least a bar (up to 4 when there is time) before the cut.
      const cut = cutAt(payoff + Math.min(4 * bar, Math.max(bar, (lands - payoff) / 2)), lands - bar, offset, outro, lands - 4 * bar);
      if (cut != null) { chain.push({ offset, cut }); ending = { at: round(lands), offset }; }
      else notes.push("too little time between the payoff and the end for the song's own ending; it fades out instead");
    }
    if (ending && ending.at < end - bar - EPS) notes.push(`the song ends at ${round(ending.at)} s, ${round(end - ending.at)} s before the end`);
  }

  // The opening: the song's intro when the first piece would start far into the song.
  const firstOffset = chain[0].offset;
  if (-firstOffset > bar) {
    const bars = Math.floor(-firstOffset / bar);
    const offset = firstOffset + bars * bar;
    const firstDrop = turnPiece ? turnPiece.drop : drop;
    const firstLands = firstDrop + firstOffset;
    const cut = cutAt(bar, firstLands, firstOffset, [runUp(firstDrop)?.at], firstLands - 4 * bar);
    if (cut != null) { chain[0].cut = cut; chain.unshift({ offset }); }
  }

  // Pieces: video [start, stop) at each offset; crossfades end on each incoming downbeat.
  const xfade = Math.min(0.12, beat / 4);
  const pieces = [];
  for (const [index, link] of chain.entries()) {
    const next = chain[index + 1];
    let start = index === 0 ? Math.max(0, link.offset) : link.cut - xfade;
    let stop = next ? next.cut : ending ? ending.at : Math.min(end, seconds + link.offset);
    stop = Math.min(stop, seconds + link.offset);
    if (stop - start < 0.05) continue;
    pieces.push({ from: round(start - link.offset), to: round(stop - link.offset), at: round(start), fadeIn: index === 0 ? (start - link.offset > 0.05 ? round(beat) : 0) : round(xfade), fadeOut: next ? round(xfade) : 0 });
  }
  const last = pieces.at(-1);
  const lastOffset = last.at - last.from;
  if (!ending) {
    // No ending of its own: fade out over at least a bar, ending on a bar line.
    const stop = last.at + (last.to - last.from);
    const line = downbeat + lastOffset + Math.floor((stop + EPS - downbeat - lastOffset) / bar) * bar;
    const fadeEnd = line > last.at + bar ? line : stop;
    last.to = round(fadeEnd - lastOffset);
    last.fadeOut = round(Math.max(bar, Math.min(2 * bar, (fadeEnd - last.at) / 2)));
  }

  // The sections in video time.
  // Each section and seam goes in the piece that plays its heard time at full volume (not in a
  // crossfade). A section heard just before the bar line its cut is on goes in the piece cut there,
  // its cue on that piece's first full-volume moment: the change is heard at the cut, not earlier.
  const placed = [];
  const seamParts = seams.filter((seam) => Number.isFinite(seam?.at) && typeof seam.kind === "string").map((seam) => ({ kind: seam.kind, at: seam.at, heard: seam.at, weight: seam.weight }));
  const full = (piece) => piece.from + (piece === pieces[0] ? 0 : piece.fadeIn); // song time it reaches full volume
  const plays = (piece, time) => time >= full(piece) - EPS && time < piece.to - EPS;
  for (const part of [...parts, ...seamParts]) {
    const byHeard = pieces.filter((piece) => plays(piece, part.heard));
    // Heard after the piece that holds its bar line stops: the change is never heard, no cue.
    const owners = byHeard.length ? byHeard : pieces.filter((piece) => plays(piece, part.at) && part.heard < piece.to);
    for (const piece of owners) {
      const offset = piece.at - piece.from;
      const entry = { at: round(Math.max(part.heard, full(piece)) + offset), kind: part.kind, ...(Number.isFinite(part.weight) ? { weight: part.weight } : {}) };
      if (part.kind === "drop" && Math.abs(part.at + offset - payoff) < 0.01) entry.label = "payoff";
      else if (part.kind === "drop" && turnPiece && Math.abs(part.at + offset - turnPiece.lands) < 0.01) entry.label = "turn";
      placed.push(entry);
    }
  }
  if (turnPiece && Math.abs(turnPiece.lands - turn) > 0.01) notes.push(`the turn's drop lands at ${round(turnPiece.lands)} s (${round(turnPiece.lands - turn) > 0 ? "+" : ""}${round(turnPiece.lands - turn)} s): move the turn there for a hit`);
  const fadeStop = last.at + (last.to - last.from);
  placed.push(ending ? { at: ending.at, kind: "ending" } : { at: round(fadeStop - last.fadeOut), kind: "fade" });
  if (!ending && whole === false) notes.push("the measured song stops before its end: it fades out on a bar line");
  return { pieces, sections: placed.sort((a, b) => a.at - b.at), ending: ending?.at ?? null, notes };
}

/** Applies fit_music {sceneId, layerId, payoff, turn?, end?, shape: {sections, seconds, whole}, analysis}. Returns the receipt. */
export function applyFitMusic(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) fail(`scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  if (!layer || (layer.type !== "audio" && layer.type !== "video") || !layer.src) fail("layer must be an audio (or video) layer with a sound.");
  const { shape, analysis } = operation;
  if (!shape || !Array.isArray(shape.sections) || !analysis) fail("the song has not been measured; send fit_music through the agent service (edit), which measures it first.");
  for (const field of ["payoff", "turn", "end"]) {
    const value = operation[field];
    if (value !== undefined && value !== null && !(typeof value === "number" && value >= 0 && value <= scene.duration + EPS)) fail(`${field} is a time in seconds within the scene (0 to ${scene.duration}).`);
  }
  if (typeof operation.payoff !== "number") fail("give payoff (the time the drop lands), or a spine with a payoff beat (notes brief style.spine).");
  const end = operation.end ?? scene.duration;
  if (end < operation.payoff + 1) fail("end must be at least 1 s after the payoff.");
  if (operation.turn != null && operation.turn >= operation.payoff) fail("turn must come before the payoff.");
  const grid = barGrid(analysis, shape.sections);
  if (!grid) fail("no steady beat was found in the song, so it cannot be cut on bar lines.");
  const seconds = shape.seconds ?? analysis.duration;
  const plan = planFitMusic({ sections: shape.sections, seams: Array.isArray(shape.seams) ? shape.seams : [], seconds, whole: shape.whole !== false, ...grid, payoff: operation.payoff, turn: operation.turn ?? null, end });

  // The old pieces (this layer, and pieces an earlier fit_music made from it) go; the new ones take their place.
  const headId = layer.fitMusic ?? layer.id;
  const old = scene.layers.filter((item) => item.id === headId || item.fitMusic === headId);
  const head = old.find((item) => item.id === headId) ?? layer;
  const base = head.name;
  const volume = head.volume ?? 1;
  const dropped = old.some((item) => (item.animations ?? []).some((animation) => animation?.to && "volume" in animation.to && animation.name !== FIT_NAMES.in && animation.name !== FIT_NAMES.out));
  const made = plan.pieces.map((piece, number) => {
    const copy = structuredClone(head);
    copy.id = number === 0 ? head.id : old.filter((item) => item !== head)[number - 1]?.id ?? uid();
    copy.name = number === 0 ? base : `${base}-${number + 1}`;
    if (number === 0) delete copy.fitMusic; else copy.fitMusic = head.id;
    copy.mediaStart = piece.at;
    copy.mediaOffset = piece.from;
    copy.mediaDuration = round(piece.to - piece.from);
    delete copy.playbackWindows;
    const stop = round(piece.at + copy.mediaDuration);
    copy.animations = (copy.animations ?? []).filter((animation) => !(animation?.to && "volume" in animation.to) && !(animation?.from && "volume" in animation.from)).map((animation) => (number === 0 ? animation : { ...structuredClone(animation), id: uid() }));
    if (piece.fadeIn) copy.animations.push({ id: uid(), name: FIT_NAMES.in, kind: "custom", easing: "linear", start: piece.at, duration: piece.fadeIn, from: { volume: 0 }, to: { volume } });
    if (piece.fadeOut) copy.animations.push({ id: uid(), name: FIT_NAMES.out, kind: "custom", easing: number === plan.pieces.length - 1 ? "ease-in" : "linear", start: round(stop - piece.fadeOut), duration: piece.fadeOut, from: { volume }, to: { volume: 0 } });
    return copy;
  });
  const at = scene.layers.indexOf(old[0] ?? layer);
  scene.layers = scene.layers.filter((item) => !old.includes(item));
  scene.layers.splice(Math.max(0, at), 0, ...made);

  // The sections as marker cues song-<kind>-<n> (an earlier fit's are replaced), marked fitted:
  // measured in the song, not placed by hand (impact-accent answers only these).
  const counts = {};
  const cues = plan.sections.map((part) => ({ name: `song-${part.kind}-${(counts[part.kind] = (counts[part.kind] ?? 0) + 1)}`, time: part.at, kind: "marker", fitted: true }));
  document.cues = withCues(document.cues, cues, { kinds: ["marker"], prefix: "song-" });

  const lines = plan.sections.map((part) => `${part.at} s ${part.kind}${part.weight != null ? `, weight ${part.weight}` : ""}${part.label ? ` (${part.label})` : ""}`);
  return {
    layer: base,
    pieces: made.length,
    sections: lines,
    ...(plan.notes.length || dropped ? { notes: [...plan.notes, ...(dropped ? [`its volume animations (ducks, fades) were removed: run duck_audio {layer:"${base}"} again (it ducks every piece)`] : [])] } : {}),
  };
}
