// fit_music: the song as the edit's structure.
//
// The agent service measures the music file first (backend/song-shape.mjs: sections; the beat
// analysis: the bar grid) and puts both in the operation, like detect_beats.
//
// planFitMusic plays ONE unbroken stretch of the song (planStretch): the stretch whose drop lands
// on the payoff. Nothing in the song is skipped or reordered, so it sounds like the song; the
// picture is then timed to the song's cues (the receipt says where each section lands, where the
// turn and the end would land on a song change). It fades in to a bar line when it starts inside
// the song and fades out at the end unless the song's own ending is there.
//
// With `recut: true` the song is re-arranged instead (planRecut): cut in song order, only on bar
// lines, so a drop lands on the payoff, an earlier drop on the turn and the song's own ending on
// `end`. Every jump is heard as an edit in a song with a voice or a melody that carries over the
// cut, so it is never the default.
//
// With `plan: "stop"` (planStop) the song plays the way a listener heard best: its opening up to
// the song's own stop (kick and bass leave for a bar or two), then a drop entered on a bar line on
// the payoff for whole groups of 4 bars, then the song's last bar ringing out. Every song time is
// a measured bar line (the shape's bars), and each join is cut on a hit with a few ms of fade.
// applyFitMusic turns the plan into pieces of the music layer (like cut_speech's pieces) and
// writes the sections as marker cues song-<kind>-<n> in video time.
import { uid } from "./model.js";
import { withCues } from "./cues.js";
import { round } from "./numbers.js";
import { barIndexAt, downbeatPhase } from "./songBars.js";

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
 * The bar grid of a beat analysis {bpm, period, beats, onsets}: {bar, beat, downbeat}, a constant
 * grid for planFitMusic to snap to. Which beat of 4 starts the bar is voted by the song's drops
 * and its heavy low onsets (downbeatPhase, shared with barLines); the downbeat is the beat of
 * that phase nearest the first drop, or the first beat of that phase when there is no drop.
 */
export function barGrid(analysis, sections = []) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const beat = analysis?.period > 0 ? analysis.period : analysis?.bpm > 0 ? 60 / analysis.bpm : null;
  if (!(beat > 0) || beats.length < 4) return null;
  const phase = downbeatPhase(analysis, sections);
  const onPhase = beats.filter((_, index) => index % 4 === phase);
  const drop = sections.find((part) => part.kind === "drop");
  const downbeat = drop ? onPhase.reduce((best, time) => (Math.abs(time - drop.at) < Math.abs(best - drop.at) ? time : best), onPhase[0]) : onPhase[0];
  return { bar: beat * 4, beat, downbeat };
}

// The fade that closes a stretch which does not reach the song's own ending, in seconds.
const FADE_OUT_MAX = 4;

/**
 * Each section and seam in video time, in the piece that plays its heard time at full volume (not
 * in a fade between pieces). A section heard just before the bar line its cut is on goes in the
 * piece cut there, its cue on that piece's first full-volume moment: the change is heard at the
 * cut, not earlier. `lands` {payoff, turn}: the video times whose drop gets that label.
 */
function placeSections({ parts, seams, pieces, lands }) {
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
      if (part.kind === "drop" && Math.abs(part.at + offset - lands.payoff) < 0.01) entry.label = "payoff";
      else if (part.kind === "drop" && lands.turn != null && Math.abs(part.at + offset - lands.turn) < 0.01) entry.label = "turn";
      placed.push(entry);
    }
  }
  return placed;
}

/**
 * The plan: song {sections [{at, kind}], seconds, whole}, grid {bar, beat?, downbeat}, video
 * {payoff, turn?, end}. Returns {pieces: [{from, to, at, fadeIn, fadeOut}] (song seconds, video
 * start), sections: [{at, kind, label?}] in video time, ending, notes}. `plan` picks how the song
 * plays: "stretch" (the default: one unbroken stretch), "stop" (planStop: the song's opening, its
 * own stop, then a drop for whole bar groups and its last bar; needs `bars`, the song shape's
 * bars) or "recut" (the song re-arranged; `recut: true` means the same).
 */
export function planFitMusic(input) {
  if (!(input.bar > 0)) fail("the song has no steady beat, so it cannot be fit on bar lines.");
  const plan = input.plan ?? (input.recut ? "recut" : "stretch");
  if (plan === "stop") return planStop(input);
  if (plan === "recut") return planRecut(input);
  if (plan !== "stretch") fail(`plan is "stretch", "stop" or "recut", not ${JSON.stringify(plan)}.`);
  return planStretch(input);
}

// The joins of the stop plan, in seconds. A hit on the entered bar line is cut in 2 ms before its
// attack with a 3 ms fade (no click, none of the hit lost); with no hit the cut is exactly on the
// line with a 5 ms fade. The piece that is left fades out over 5 ms.
const JOIN_LEAD = 0.002;
const JOIN_FADE_HIT = 0.003;
const JOIN_FADE_LINE = 0.005;
const JOIN_FADE_OUT = 0.005;
const LATE_HEARD = 0.06; // a drop heard this much after its bar line: the bass enters late
const GROUP = 4; // a drop plays whole groups of this many bars
const LATE_START = 0.05; // an opening that would start this late in the video is skipped

/**
 * The stop-down plan: the song's opening, played unbroken up to its own stop (kick and bass leave
 * for a bar or two); then a drop of the song, entered on its bar line on the payoff, playing whole
 * groups of 4 bars; then the song's last bar and its own ending. Every song time is a measured bar
 * line (bars.lines, never a constant grid). The bar count goes on across each join: the entered
 * bar line lands where the bar line of the piece being left would have been.
 * Extra input: bars {lines, out, hits, last, voice?} (the song shape's), drop (a song time that
 * picks the drop). Extra result: facts {stop, dropFrom, bars, ending} for the receipt.
 */
function planStop({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, bars, payoff, turn = null, end, drop: dropTime = null }) {
  const lines = bars?.lines;
  if (!Array.isArray(lines) || lines.length < 2) fail("the song has no measured bars, so plan \"stop\" cannot be used; use plan \"stretch\".");
  const out = new Set(bars.out ?? []);
  const hits = bars.hits ?? [];
  const lastBar = Number.isInteger(bars.last?.bar) ? bars.last.bar : lines.length - 1;
  const notes = [];
  const hitAt = (index) => (typeof hits[index] === "number" ? hits[index] : null);
  // Where the piece entering bar `index` starts, against that bar's line (a few ms before its hit).
  const enterDelta = (index) => (hitAt(index) == null ? 0 : hitAt(index) - JOIN_LEAD - lines[index]);
  const enterFade = (index) => (hitAt(index) == null ? JOIN_FADE_LINE : JOIN_FADE_HIT);
  const barsOut = (from, to) => { for (let i = from; i < to; i += 1) if (out.has(i)) return true; return false; };
  const cleanRun = (from) => { let count = 0; while (from + count <= lastBar && !out.has(from + count)) count += 1; return count; };

  // 1. The drops that could land on the payoff, best first: heavy, entered on its line, with 4 bars to play.
  const barOfPart = (part) => (Number.isInteger(part.bar) ? part.bar : barIndexAt(lines, part.at));
  let drops = sections.filter((part) => part.kind === "drop" && Number.isFinite(part.at)).map((part) => ({ bar: barOfPart(part), heard: part.at, weight: part.weight }))
    .filter((part, index, list) => list.findIndex((other) => other.bar === part.bar) === index);
  if (Number.isFinite(dropTime)) {
    // The agent's pick: the drop section nearest that song time within 2 bars, else the bar line nearest it.
    const near = drops.filter((part) => Math.abs(part.heard - dropTime) <= 2 * bar).sort((a, b) => Math.abs(a.heard - dropTime) - Math.abs(b.heard - dropTime))[0];
    const index = barIndexAt(lines, dropTime);
    drops = [near ?? { bar: index, heard: lines[index], weight: null }];
  }
  if (!drops.length) fail("the song has no drop (no point where the kick and bass come in strong); pick a song with one, or place it with update_layer.");
  const dropCost = (part) => (1 - (Number.isFinite(part.weight) ? part.weight : 0.5)) * 4 + (Math.abs(part.heard - lines[part.bar]) > LATE_HEARD ? 2 : 0)
    + (cleanRun(part.bar) < GROUP ? 3 : 0) + (bars.voice?.[part.bar] > 0.5 ? 1 : 0);
  drops.sort((a, b) => dropCost(a) - dropCost(b) || a.heard - b.heard);

  // 2. The stop the opening ends on, for a drop at bar `drop`: bar s-1 is out, its run of out bars
  // began at most 2 bars before s, and the song was going before it (4 of the 6 bars before the run play).
  const stopsBefore = (drop) => {
    const found = [];
    for (let s = 1; s < drop && s <= lastBar; s += 1) {
      if (!out.has(s - 1)) continue;
      let run = s - 1;
      while (run > 0 && out.has(run - 1)) run -= 1;
      if (s - run > 2) continue;
      let going = 0;
      for (let i = Math.max(0, run - 6); i < run; i += 1) if (!out.has(i)) going += 1;
      if (going >= 4) found.push({ s, run, start: lines[s] - payoff });
    }
    return found;
  };
  // Starts on the song's first second (0), else on a bar line (1), else mid-bar (2).
  const startKind = (start) => (Math.abs(start) <= beat ? 0 : lines.some((line) => Math.abs(line - start) <= 0.02) ? 1 : 2);
  let chosen = null;
  for (const candidate of drops) {
    const stops = stopsBefore(candidate.bar);
    const fits = stops.filter((stop) => stop.start >= -LATE_START).sort((a, b) => startKind(a.start) - startKind(b.start) || (b.s - b.run) - (a.s - a.run) || a.start - b.start);
    const stop = fits[0] ?? stops.sort((a, b) => b.start - a.start)[0]; // none fits: the song starts late, the least late
    if (stop) { chosen = { drop: candidate, stop }; break; }
  }
  if (!chosen) fail("the song has no stop to open on (a bar or two where the kick and bass leave, after the song was going) before a drop; use plan \"stretch\" for one unbroken stretch.");
  const { drop, stop } = chosen;
  const D = drop.bar;
  const first = Math.max(0, stop.start); // the opening's first song second
  const at0 = Math.max(0, -stop.start); // and its place in the video (late only when no stop fits)
  if (stop.start < -LATE_START) notes.push(`the song starts at ${round(at0)} s (its stop is ${round(lines[stop.s])} s in): a later payoff fills the opening`);
  const firstBar = lines[0];
  if (Math.abs((lines[stop.s] - firstBar) - payoff) > beat && lines[stop.s] - firstBar > 0) notes.push(`payoff at ${round(lines[stop.s] - firstBar)} s starts the song on its first bar`);

  // 3 and 4. The drop plays whole groups of 4 bars; the song's own last bar closes it.
  // The song's own ending: its last bar, cut in on its hit, or on its line when it has none (as for every join).
  const own = whole && bars.last?.ends === "own" && lastBar > D;
  const songEnd = own ? Math.min(seconds, lines[lastBar] + 2 * bar) : 0;
  const tail = own ? songEnd - lines[lastBar] : 0;
  const groupEnd = (g) => payoff + lines[D + GROUP * g] - lines[D]; // video time of group g's end
  const reach = (g) => groupEnd(g) + tail; // where the song's ending would end
  const maxGroups = Math.max(0, Math.floor((lastBar - D) / GROUP));
  let groups = 0;
  for (let g = 1; g <= maxGroups; g += 1) if (reach(g) <= end + 0.05) groups = g;
  let ending = own;
  if (own && !groups && maxGroups >= 1 && reach(1) <= end + bar) groups = 1; // passes the end by less than a bar
  if (!groups) {
    ending = false;
    if (own) notes.push(`4 bars of the drop and the song's own ending do not fit before ${round(end)} s: the drop plays to the end and fades`);
    else if (maxGroups >= 1) notes.push(`4 bars of the drop do not fit before ${round(end)} s: the drop plays to the end and fades`);
  }
  while (groups > 1 && barsOut(D, D + GROUP * groups)) groups -= 1; // never leave inside a group

  const pieces = [];
  // The video instant of the drop's join, and the song time each piece is entered at.
  const dropAt = round(payoff + enterDelta(D));
  const dropFrom = round(lines[D] + enterDelta(D));
  // The opening's fade-in: none when it plays from the start of the song; 5 ms when it starts a
  // little into the song or on a bar line (no click); else a fade to the next bar line.
  let fadeIn = 0;
  if (stop.start > 0) {
    const line = lines.find((time) => time >= stop.start + beat - EPS) ?? lines.at(-1);
    fadeIn = startKind(stop.start) === 2 ? Math.min(round(line - stop.start), round(payoff / 2)) : JOIN_FADE_LINE;
  }
  const opening = { from: round(first), to: 0, at: round(at0), fadeIn, fadeOut: JOIN_FADE_OUT };
  opening.to = round(opening.from + (dropAt - opening.at));
  pieces.push(opening);
  const dropPiece = { from: dropFrom, to: 0, at: dropAt, fadeIn: enterFade(D), fadeOut: 0 };
  pieces.push(dropPiece);
  let endAt = null;
  if (groups) {
    const lineEnd = D + GROUP * groups;
    const join = round(payoff + lines[lineEnd] - lines[D] + (ending ? enterDelta(lastBar) : 0)); // video time of the next join or the fade's end
    if (ending && lineEnd === lastBar) {
      // The groups run into the last bar: one piece plays on to the song's end.
      dropPiece.to = round(songEnd);
      endAt = round(dropAt + dropPiece.to - dropPiece.from);
    } else if (ending) {
      dropPiece.to = round(dropFrom + (join - dropAt));
      dropPiece.fadeOut = JOIN_FADE_OUT;
      const lastFrom = round(lines[lastBar] + enterDelta(lastBar));
      pieces.push({ from: lastFrom, to: round(songEnd), at: join, fadeIn: enterFade(lastBar), fadeOut: 0 });
      endAt = round(join + songEnd - lastFrom);
    } else {
      // No ending of its own: a fade over the last bar, ending on the group's line.
      dropPiece.to = round(lines[lineEnd]);
      dropPiece.fadeOut = round(lines[lineEnd] - lines[lineEnd - 1]);
    }
  } else {
    // The drop plays to the end of the video (or of the song) and fades, as planStretch does.
    const cutAt = Math.min(end, payoff + (seconds - lines[D]));
    dropPiece.to = round(dropFrom + (cutAt - dropAt));
    dropPiece.fadeOut = round(Math.min(FADE_OUT_MAX, 2 * bar, Math.max(bar, (cutAt - payoff) / 2), cutAt - dropAt));
  }
  if (own && endAt != null && Math.abs(endAt - end) > beat) notes.push(`the song ends at ${round(endAt)} s: end the video there`);

  // 6. Sections in video time (the drop labeled payoff), the stop and the ending or fade.
  const parts = sections.map((part) => ({ kind: part.kind, at: lines[barOfPart(part)] ?? part.at, heard: part.at, weight: part.weight }));
  // The chosen drop is heard no earlier than its piece reaches full volume, so its cue lands in that piece.
  for (const part of parts) if (part.kind === "drop" && part.at === lines[D]) part.heard = Math.max(part.heard, dropPiece.from + dropPiece.fadeIn);
  const seamParts = seams.filter((seam) => Number.isFinite(seam?.at) && typeof seam.kind === "string");
  const placed = placeSections({ parts, seams: seamParts, pieces, lands: { payoff, turn: null } });
  const stopAt = round(lines[stop.run] + opening.at - opening.from);
  placed.push({ at: Math.max(stopAt, opening.at), kind: "stop" });
  const last = pieces.at(-1);
  const stopTime = round(last.at + (last.to - last.from));
  placed.push(endAt != null ? { at: endAt, kind: "ending" } : { at: round(stopTime - last.fadeOut), kind: "fade" });
  if (turn != null) notes.push(`the song stops at ${stopAt} s${Math.abs(stopAt - turn) > 0.01 ? ` (${round(stopAt - turn) > 0 ? "+" : ""}${round(stopAt - turn)} s from the turn): move the turn there for a hit` : ", on the turn"}`);
  return {
    pieces, sections: placed.sort((a, b) => a.at - b.at), ending: endAt, notes,
    facts: { stop: lines[stop.run], dropFrom: lines[D], bars: groups ? GROUP * groups : null, ending: endAt },
  };
}

/** One unbroken stretch of the song, its drop on the payoff. */
function planStretch({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, payoff, turn = null, end }) {
  const snap = (time) => downbeat + Math.round((time - downbeat) / bar) * bar;
  const parts = sections.map((part) => ({ kind: part.kind, at: Math.max(0, snap(part.at)), heard: part.at, weight: part.weight }));
  const drops = parts.filter((part) => part.kind === "drop").filter((part, index, list) => list.findIndex((other) => other.at === part.at) === index);
  if (!drops.length) fail("the song has no drop (no point where the kick and bass come in strong); pick a song with one, or place it with update_layer.");
  const notes = [];
  const runUp = (drop, from) => parts.some((part) => (part.kind === "break" || part.kind === "build") && part.at < drop.at - EPS && part.at >= Math.max(from, drop.at - RUN_UP_BARS * bar) - EPS);
  // A change the turn can sit on: another section start of the stretch, in video time.
  const changeNear = (drop, time) => parts.filter((part) => part.at !== drop.at && part.kind !== "intro" && part.kind !== "outro").map((part) => part.at + payoff - drop.at)
    .filter((lands) => lands > bar && lands < payoff - bar + EPS).sort((a, b) => Math.abs(a - time) - Math.abs(b - time))[0] ?? null;
  // The stretch for each drop is fixed by the payoff: song [drop - payoff, drop + end - payoff].
  const cost = (drop) => {
    const from = drop.at - payoff;
    const to = drop.at + (end - payoff);
    let total = (1 - (Number.isFinite(drop.weight) ? drop.weight : 0.5)) * 4;
    if (from < -CUT_SLACK) total += 50 - from; // the video would open without music
    // The song runs out before the end: silence. Its own ending inside the last bar is the best close.
    if (to > seconds + 2 * bar) total += 100;
    else if (whole && to > seconds - CUT_SLACK && to <= seconds + bar) total -= 2;
    if (!runUp(drop, from)) total += 3;
    if (turn != null) { const lands = changeNear(drop, turn); total += lands == null ? 4 : Math.min(4, Math.abs(lands - turn) / bar); }
    // Opens on a phrase line: a section starts within a beat of the stretch's first second.
    if (from > CUT_SLACK && !parts.some((part) => Math.abs(part.at - from) <= beat)) total += 1;
    return total;
  };
  const drop = [...drops].sort((a, b) => cost(a) - cost(b) || a.at - b.at)[0];
  if (!runUp(drop, drop.at - payoff)) notes.push("no break or build before the drop in this stretch: nothing quiets the line before the payoff");
  const offset = payoff - drop.at; // video time = song time + offset
  const start = Math.max(0, offset);
  const from = start - offset;
  const songEnd = seconds + offset;
  const own = whole && songEnd <= end + CUT_SLACK; // the song's own ending is inside the video
  const stop = Math.min(end, songEnd);
  if (start > CUT_SLACK) notes.push(`the song starts at ${round(start)} s (its drop is ${round(drop.at)} s in): a later payoff, or a song with a later drop, fills the opening`);
  // Starts inside the song: on a section line it starts clean, else it fades in to the next bar line.
  let fadeIn = 0;
  if (from > CUT_SLACK && !parts.some((part) => Math.abs(part.at - from) <= CUT_SLACK)) {
    const line = downbeat + Math.ceil((from + beat - EPS - downbeat) / bar) * bar;
    fadeIn = round(line - from);
  }
  const fadeOut = own ? 0 : round(Math.min(FADE_OUT_MAX, 2 * bar, Math.max(bar, (stop - payoff) / 2), stop - start));
  const pieces = [{ from: round(from), to: round(stop - offset), at: round(start), fadeIn, fadeOut }];
  if (own && songEnd < end - bar - EPS) notes.push(`the song ends at ${round(songEnd)} s, ${round(end - songEnd)} s before the end`);
  if (!own) {
    // A fade closes a phrase when it ends on a phrase line (every 4 bars from the drop).
    const phrase = 4 * bar;
    const line = payoff + Math.round((end - payoff) / phrase) * phrase;
    if (Math.abs(line - end) > beat && line > payoff + bar) notes.push(`the song's phrase ends at ${round(line)} s: end the video there and the fade closes the phrase (at ${round(end)} s it fades mid-phrase)`);
  }
  const turnLands = turn != null ? changeNear(drop, turn) : null;
  if (turn != null && turnLands == null) notes.push("no song change before the payoff for the turn");
  else if (turn != null && Math.abs(turnLands - turn) > 0.01) notes.push(`the song changes at ${round(turnLands)} s (${round(turnLands - turn) > 0 ? "+" : ""}${round(turnLands - turn)} s from the turn): move the turn there for a hit`);
  const placed = placeSections({ parts, seams, pieces, lands: { payoff, turn: null } });
  placed.push(own ? { at: round(songEnd), kind: "ending" } : { at: round(stop - fadeOut), kind: "fade" });
  if (!own && whole === false) notes.push("the measured song stops before its end: it fades out");
  return { pieces, sections: placed.sort((a, b) => a.at - b.at), ending: own ? round(songEnd) : null, notes };
}

/** The song re-arranged (recut:true): a drop on the payoff, an earlier one on the turn, its own ending on the end. */
function planRecut({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, payoff, turn = null, end }) {
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

  const placed = placeSections({ parts, seams, pieces, lands: { payoff, turn: turnPiece?.lands ?? null } });
  if (turnPiece && Math.abs(turnPiece.lands - turn) > 0.01) notes.push(`the turn's drop lands at ${round(turnPiece.lands)} s (${round(turnPiece.lands - turn) > 0 ? "+" : ""}${round(turnPiece.lands - turn)} s): move the turn there for a hit`);
  const fadeStop = last.at + (last.to - last.from);
  placed.push(ending ? { at: ending.at, kind: "ending" } : { at: round(fadeStop - last.fadeOut), kind: "fade" });
  if (!ending && whole === false) notes.push("the measured song stops before its end: it fades out on a bar line");
  return { pieces, sections: placed.sort((a, b) => a.at - b.at), ending: ending?.at ?? null, notes };
}

const PLANS = ["stretch", "stop", "recut"];
const clock = (time) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;

/**
 * One short line per plan the agent did not pick that this song allows (a plan that fails is not
 * listed), so it can choose by the video's story.
 */
function otherPlans(input, used) {
  const lines = [];
  for (const name of PLANS) {
    if (name === used) continue;
    try {
      if (name === "recut") { planFitMusic({ ...input, plan: "recut" }); lines.push("recut: the song re-arranged, its drops on turn and payoff"); continue; }
      const plan = planFitMusic({ ...input, plan: name });
      const first = plan.pieces[0];
      const text = name === "stop"
        ? `stop: opening ${clock(first.from)}-${clock(first.to)}, the song stops at ${plan.facts.stop} s, drop ${clock(plan.facts.dropFrom)} on the payoff${plan.facts.bars ? ` for ${plan.facts.bars} bars` : ""}, ${plan.ending != null ? `the song's last bar ends ${plan.ending} s` : "then it fades out"}`
        : `stretch: ${clock(first.from)}-${clock(first.to)}, ${plan.ending != null ? "plays to the song's own ending" : "fades out"}`;
      lines.push(text.slice(0, 140));
    } catch { /* this song does not allow that plan */ }
  }
  return lines;
}

/** Applies fit_music {sceneId, layerId, payoff, turn?, end?, plan?, drop?, recut?, shape: {sections, seconds, whole, bars?}, analysis}. Returns the receipt. */
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
  const which = operation.plan ?? (operation.recut === true ? "recut" : "stretch");
  if (!PLANS.includes(which)) fail(`plan is "stretch" (one unbroken stretch), "stop" (the song's stop, then a drop on the payoff) or "recut" (the song re-arranged), not ${JSON.stringify(which)}.`);
  if (operation.drop != null && !(typeof operation.drop === "number" && operation.drop >= 0)) fail("drop is a time in the song in seconds (0 or more): the drop that lands on the payoff.");
  if (which === "stop" && !Array.isArray(shape.bars?.lines)) fail("the song has no measured bars, so plan \"stop\" cannot be used; use plan \"stretch\".");
  const input = { sections: shape.sections, seams: Array.isArray(shape.seams) ? shape.seams : [], seconds, whole: shape.whole !== false, ...grid, payoff: operation.payoff, turn: operation.turn ?? null, end, bars: shape.bars, drop: operation.drop ?? null };
  const plan = planFitMusic({ ...input, plan: which });

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
  const plans = otherPlans(input, which);
  return {
    layer: base,
    pieces: made.length,
    // Which part of the song plays, in song order.
    plays: plan.pieces.map((piece) => `${clock(piece.from)}-${clock(piece.to)}`).join(", "),
    sections: lines,
    // The plans not used that this song allows, one line each, for choosing by the video's story.
    ...(plans.length ? { plans } : {}),
    ...(plan.notes.length || dropped ? { notes: [...plan.notes, ...(dropped ? [`its volume animations (ducks, fades) were removed: run duck_audio {layer:"${base}"} again (it ducks every piece)`] : [])] } : {}),
  };
}
