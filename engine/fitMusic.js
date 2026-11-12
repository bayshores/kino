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
// With `recut: true` the song is re-arranged instead (planRecut): cut in song order, only on
// measured bar lines, so a drop lands on the payoff, an earlier drop on the turn and the song's own
// ending on `end`. Each piece that is left plays whole groups of 4 bars, joined like the stop
// plan's. Every jump is heard as an edit in a song with a voice or a melody that carries over the
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
import { CONFIDENT } from "./beatDetection.js";
import { constantSpeed } from "./mediaTime.js";
import { animatesSpeed } from "./animation.js";

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
const LEAD_SHARE = 0.45; // the share of the video before the drop a default payoff keeps (a guess: one measured human edit, 46%)

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

// The joins of the stop plan, in seconds. The entered bar is cut in 2 ms before the attack of the
// hit on its line with a 3 ms fade (no click, none of the hit lost). A line with no measured hit is
// entered where its hit would be: the song's own lead (the median of hit minus line; the lines sit
// a few ms after the attacks), so a kick the measure missed is not cut into. The piece that is left
// ends at the same instant with a 5 ms fade, before the next bar's attack.
const JOIN_LEAD = 0.002;
const HIT_LEAD = -0.012; // the lead of a song with fewer than HIT_LEAD_MIN measured hits
const HIT_LEAD_MIN = 8;
const END_FADE_MIN = 0.05; // the song's own ending fades at least this long (its ring past the last bar)
const JOIN_FADE_HIT = 0.003;
const JOIN_FADE_LINE = 0.005;
const JOIN_FADE_OUT = 0.005;
const LATE_HEARD = 0.06; // a drop heard this much after its bar line: the bass enters late
const GROUP = 4; // a drop plays whole groups of this many bars
const SILENCE_BARS = 2; // the song's own ending beats a fade only when it ends at most this many bars before the end
const LATE_START = 0.05; // an opening that would start this late in the video is skipped

/**
 * What the stop and recut plans share to join pieces on measured bar lines: the bars where the
 * song's kick and bass are out, the last bar, and enterDelta(index): where the piece entering bar
 * `index` starts, against that bar's line (JOIN_LEAD before its hit; a line with no measured hit
 * is entered where its hit would be, the song's own lead, the median of hit minus line, since the
 * lines sit a few ms after the attacks; HIT_LEAD for a song with too few measured hits). The piece
 * that is left ends at the same video instant, with a JOIN_FADE_OUT fade.
 */
function joinsOf(lines, bars) {
  const hits = bars.hits ?? [];
  const hitAt = (index) => (typeof hits[index] === "number" ? hits[index] : null);
  const leads = lines.map((line, index) => (hitAt(index) == null ? null : hitAt(index) - line)).filter((value) => value != null).sort((a, b) => a - b);
  const lead = leads.length >= HIT_LEAD_MIN ? leads[Math.floor(leads.length / 2)] : HIT_LEAD;
  return {
    out: new Set(bars.out ?? []),
    lastBar: Number.isInteger(bars.last?.bar) ? bars.last.bar : lines.length - 1,
    enterDelta: (index) => round((hitAt(index) ?? lines[index] + lead) - JOIN_LEAD - lines[index]),
  };
}

/** The song's own ending, closing a plan: where its sound ends (bars.last.end), the fade over its ring past the last bar, and the ring. */
function endingOf(lines, bars, lastBar, seconds, bar) {
  const songEnd = Math.min(seconds, Number.isFinite(bars.last?.end) && bars.last.end > lines[lastBar] ? bars.last.end : lines[lastBar] + 2 * bar);
  return { songEnd, endFade: round(Math.min(bar, Math.max(END_FADE_MIN, songEnd - (lines[lastBar + 1] ?? songEnd)))), tail: songEnd - lines[lastBar] };
}

// Starts on the song's first second (0), else on a bar line (1), else mid-bar (2).
// `early`: how much further before a bar line than 20 ms still counts as on it (an opening entered
// with the join lead starts up to LATE_START before its line).
const startKindOf = (lines, beat, start, early = 0) => (Math.abs(start) <= beat ? 0 : lines.some((line) => line - start >= -0.02 && line - start <= 0.02 + early) ? 1 : 2);

// The fade-in of a piece that opens the video at song time `start`: none when it plays from the
// start of the song; 5 ms when it starts a little into the song or on a bar line (no click); else a
// fade to the next bar line.
function openingFade(lines, beat, payoff, start, early = 0) {
  if (!(start > 0)) return 0;
  const line = lines.find((time) => time >= start + beat - EPS) ?? lines.at(-1);
  return startKindOf(lines, beat, start, early) === 2 ? Math.min(round(line - start), round(payoff / 2)) : JOIN_FADE_LINE;
}

/**
 * The stop-down plan: the song's opening, played unbroken up to its own stop (kick and bass leave
 * for a bar or two); then a drop of the song, entered on its bar line on the payoff, playing whole
 * groups of 4 bars; then the song's last bar and its own ending. Every song time is a measured bar
 * line (bars.lines, never a constant grid). The bar count goes on across each join: the entered
 * bar line lands where the bar line of the piece being left would have been.
 * Extra input: bars {lines, out, hits, last} (the song shape's), drop (a song time that
 * picks the drop). Extra result: facts {stop, dropFrom, bars, ending} for the receipt.
 */
function planStop({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, bars, payoff, turn = null, end, drop: dropTime = null }) {
  const lines = bars?.lines;
  if (!Array.isArray(lines) || lines.length < 2) fail("the song has no measured bars, so plan \"stop\" cannot be used; use plan \"stretch\".");
  const { out, lastBar, enterDelta } = joinsOf(lines, bars);
  const notes = [];
  const enterFade = () => JOIN_FADE_HIT;
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
    + (cleanRun(part.bar) < GROUP ? 3 : 0);
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
  const startKind = (start) => startKindOf(lines, beat, start);
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
  // Where its sound ends (bars.last.end), and the fade over its ring past the last bar.
  const { songEnd, endFade, tail } = own ? endingOf(lines, bars, lastBar, seconds, bar) : { songEnd: 0, endFade: 0, tail: 0 };
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
  const fadeIn = openingFade(lines, beat, payoff, stop.start);
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
      dropPiece.fadeOut = endFade;
      endAt = round(dropAt + dropPiece.to - dropPiece.from);
    } else if (ending) {
      dropPiece.to = round(dropFrom + (join - dropAt));
      dropPiece.fadeOut = JOIN_FADE_OUT;
      const lastFrom = round(lines[lastBar] + enterDelta(lastBar));
      pieces.push({ from: lastFrom, to: round(songEnd), at: join, fadeIn: enterFade(lastBar), fadeOut: endFade });
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
  // A drop the agent picked that the song's sections do not list (the bass coming back inside the
  // song) still lands on the payoff: its cue is the entered line, so the picture can be timed to it.
  if (!parts.some((part) => part.kind === "drop" && part.at === lines[D])) parts.push({ kind: "drop", at: lines[D], heard: dropPiece.from + dropPiece.fadeIn, weight: null });
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

/**
 * The payoff (where the drop lands) when none is given, for a video of `length` seconds on a song
 * with bars of `bar` seconds: the drop gets one whole group of 4 bars at full volume and a bar to
 * fade (GROUP, the listener test above: a cut after 2 bars sounded premature), so the payoff sits
 * `length - 5 bars` in. Kept between 45% and 75% of the video. 75% was the old fixed default;
 * on a 15 s edit it put the drop 1.5 s before the closing fade (run 8: drop 11.32 s, fade from
 * 12.86 s). 45% is a guess from one measured human edit of the same length class (drop at 9.7 of
 * 21 s, 46%, played 8.6 s: about 4 bars at its tempo). Without a bar length: 75%.
 */
export function defaultPayoff(length, bar, dropSeconds) {
  return payoffPlan(length, bar, dropSeconds).payoff;
}

/**
 * The payoff for a video of `length` seconds on a song with bars of `bar` seconds, and what it
 * gives the drop: {payoff, groups, fade}. The drop plays the most whole groups of 4 bars that fit
 * with 45% or more of the video before it (LEAD_SHARE: the old floor, a guess from one measured
 * human edit, 46% in), at most as many as its measured section holds (`dropSeconds`: the
 * references played whole groups or a whole section, never 1.5 s), then its fade (a bar after one
 * group, 2 bars up to FADE_OUT_MAX after more: what planStretch makes). Never earlier than 45%
 * (lead decision: the owner scored a switch that came too early lower than one that let the song
 * play), never later than 75%. A video too short for 45% and a group keeps the 45% payoff, and
 * `oneGroup` names the earlier payoff that gives the drop one group and a bar (run 8, 15 s: 6.75 s
 * plays 6.09 s of drop, 4.32 s plays 8.52 s); the receipt says both, the agent picks.
 * Without a bar length: 75%, no groups.
 */
export function payoffPlan(length, bar, dropSeconds) {
  if (!(length > 0)) return { payoff: 0, groups: 0, fade: 0, oneGroup: null };
  if (!(bar > 0)) return { payoff: round(length * 0.75), groups: 0, fade: 0, oneGroup: null };
  const group = GROUP * bar;
  const fadeOf = (count) => (count <= 1 ? bar : Math.min(FADE_OUT_MAX, 2 * bar));
  const lead = (count) => length - fadeOf(count) - count * group;
  const floor = length * LEAD_SHARE;
  const most = dropSeconds > 0 ? Math.max(1, Math.floor(dropSeconds / group + EPS)) : Math.max(1, Math.floor(length / group));
  let groups = 1;
  for (let count = 2; count <= most; count += 1) if (lead(count) >= floor - EPS) groups = count;
  if (lead(groups) >= floor - EPS) {
    const payoff = round(Math.min(length * 0.75, lead(groups)));
    return { payoff, groups, fade: fadeOf(groups), oneGroup: payoff };
  }
  // Too short for 45% and a whole group: the floor holds (the old rule), the drop plays under a group.
  return { payoff: round(Math.min(length * 0.75, floor)), groups: 0, fade: bar, oneGroup: lead(1) >= 1 ? round(lead(1)) : null };
}

/**
 * The payoff that sits on the song's measured drop: defaultPayoff, then the drop it picks, then
 * defaultPayoff again with that drop's section length (the drop to the next section start, or the
 * song's end) as the groups it may play. Two passes; the second is kept only when it picks the
 * same drop. Returns {payoff, groups, fade, sectionSeconds} (sectionSeconds null without a drop).
 */
export function songPayoff({ sections = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, length, turn = null }) {
  const first = payoffPlan(length, bar);
  if (!(bar > 0) || !Array.isArray(sections) || !(seconds > 0)) return { ...first, sectionSeconds: null };
  const pick = (payoff) => stretchDrop({ sections, seconds, whole, bar, beat, downbeat, payoff, turn, end: length }).drop;
  const drop = pick(first.payoff);
  if (!drop) return { ...first, sectionSeconds: null };
  const next = sections.map((part) => part.at).filter((at) => Number.isFinite(at) && at > drop.heard + EPS).sort((a, b) => a - b)[0];
  const sectionSeconds = round((next ?? seconds) - drop.heard);
  const second = payoffPlan(length, bar, sectionSeconds);
  const same = pick(second.payoff)?.at === drop.at;
  return { ...(same ? second : first), sectionSeconds };
}

/**
 * The drop one unbroken stretch is built around, shared by fit_music (planStretch) and the
 * soundtrack answer (backend/soundtrack.mjs compareToStory), so both name the same window: the
 * heaviest drop that fits (cost: (1 - weight) x 4, plus the video opening without music, the song
 * running out, no break or build before it, the turn, a start off a phrase line). Returns
 * {drop, parts, runUp} with each part's bar-snapped `at` and its `heard` time; drop is null when
 * the song has no drop.
 */
export function stretchDrop({ sections = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, payoff, turn = null, end }) {
  const snap = (time) => downbeat + Math.round((time - downbeat) / bar) * bar;
  const parts = sections.map((part) => ({ kind: part.kind, at: Math.max(0, snap(part.at)), heard: part.at, weight: part.weight }));
  const drops = parts.filter((part) => part.kind === "drop").filter((part, index, list) => list.findIndex((other) => other.at === part.at) === index);
  const runUp = (drop, from) => parts.some((part) => (part.kind === "break" || part.kind === "build") && part.at < drop.at - EPS && part.at >= Math.max(from, drop.at - RUN_UP_BARS * bar) - EPS);
  if (!drops.length) return { drop: null, parts, runUp };
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
  return { drop: [...drops].sort((a, b) => cost(a) - cost(b) || a.at - b.at)[0], parts, runUp, changeNear };
}

/** One unbroken stretch of the song, its drop on the payoff. */
function planStretch({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, payoff, turn = null, end, roomy: given }) {
  const { drop, parts, runUp, changeNear } = stretchDrop({ sections, seconds, whole, bar, beat, downbeat, payoff, turn, end });
  if (!drop) fail("the song has no drop (no point where the kick and bass come in strong); pick a song with one, or place it with update_layer.");
  const notes = [];
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
  // The closing fade: 1 to 2 bars, but it never starts inside the drop's first group of 4 bars
  // while a one-bar fade fits after that group (run 8: a 2-bar fade would have cut the drop's
  // full-volume time to 2 bars).
  const fadeOut = own ? 0 : round(Math.min(FADE_OUT_MAX, 2 * bar, Math.max(bar, (stop - payoff) / 2), Math.max(bar, stop - payoff - GROUP * bar), stop - start));
  const pieces = [{ from: round(from), to: round(stop - offset), at: round(start), fadeIn, fadeOut }];
  if (own && songEnd < end - bar - EPS) notes.push(`the song ends at ${round(songEnd)} s, ${round(end - songEnd)} s before the end`);
  // A payoff the agent gave (or a spine's) that leaves the drop under one 4-bar group before the
  // fade: said with the payoff that gives it the group (run 8's spine payoff 11.3 of 15 s left it
  // 1.54 s). A note only: the payoff stays as given.
  const heard = stop - fadeOut - payoff;
  // The payoff that gives the drop whole groups (applyFitMusic's songPayoff, else payoffPlan): its
  // default when that gives a group, else the earlier one that does (`oneGroup`, under 45%).
  const plan = given ?? payoffPlan(end, bar);
  const roomy = plan.groups >= 1 ? plan.payoff : plan.oneGroup;
  const gives = plan.groups > 1 ? `${plan.groups} groups of 4 bars and ${round(plan.fade)} s` : "4 bars and a bar";
  if (!own && roomy != null && heard < GROUP * bar - beat && roomy < payoff - beat) notes.push(`the drop plays ${round(heard)} s before the fade, under 4 bars: payoff ${roomy} s gives it ${gives} to fade`);
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

// The bars of a song that has no measured ones: a constant grid (downbeat + n * bar), no hits, no
// out bars, the last bar ending with the song (its own ending when the song is whole).
function gridBars({ seconds, whole, bar, downbeat }) {
  const first = downbeat - Math.floor((downbeat + EPS) / bar) * bar;
  const lines = [];
  for (let n = 0; first + n * bar <= seconds + EPS; n += 1) lines.push(round(first + n * bar));
  const lastBar = Math.max(0, lines.findLastIndex((line) => line + bar <= seconds + CUT_SLACK));
  return { lines, out: [], hits: [], last: { bar: lastBar, end: seconds, ends: whole ? "own" : "fade" } };
}

/**
 * The song re-arranged (plan "recut", or recut:true): a drop of the song on the payoff, an earlier
 * one on the turn, the song's own ending on the end. Like planStop it cuts only on measured bar
 * lines (bars.lines; a constant grid when the song has none) and joins as it does (joinsOf: the
 * entered bar 2 ms before its hit with a 3 ms fade, the piece left ends there with a 5 ms fade; no
 * crossfades). A piece that is left before the song ends plays whole groups of 4 bars counted from
 * the bar line it was entered on, and a drop plays at least 4 bars before the cut: a listener
 * heard a cut after 2 bars as premature and pieces of 3 or 5 bars as jarring. The video opens on a
 * piece that plays from a second of the song (the song's start when it fits), or on an opening of the
 * song's start. Any piece that starts the video is left a whole number of groups after the latest
 * drop, break or build inside it (else after its first bar line), and plays at least 4 bars; this
 * wins over the turn and payoff alignment (another entry bar, up to 16 bars before its drop, is
 * tried). The song's own ending ends by `end` (+ 50 ms) or the last piece fades over 1 to 2 bars; a plan
 * that ends on the own ending is chosen before any plan that fades when the ending comes at most 2 bars before
 * `end` (the video then ends in at most 2 bars of silence); a later-ending fade wins over a longer silence.
 * `drop` (a song second) picks the drop that lands on the payoff, as in planStop.
 * Pieces are entered on the run-up of a drop (its latest break, else build) when it has one,
 * else on the drop; never on a bar where the kick and bass are out unless a break or build starts there.
 */
function planRecut({ sections = [], seams = [], seconds, whole = true, bar, beat = bar / 4, downbeat = 0, bars, payoff, turn = null, end, drop: dropTime = null }) {
  const measured = Array.isArray(bars?.lines) && bars.lines.length >= 2;
  const shape = measured ? bars : gridBars({ seconds, whole, bar, downbeat });
  const lines = shape.lines;
  if (lines.length < 2) fail("the song is shorter than a bar.");
  const { out, lastBar, enterDelta } = joinsOf(lines, shape);
  const notes = [];
  const barOfPart = (part) => (measured && Number.isInteger(part.bar) ? part.bar : barIndexAt(lines, part.at));

  // The bars that start a section, and what starts there.
  const kinds = new Map();
  for (const part of sections) if (Number.isFinite(part.at)) kinds.set(barOfPart(part), [...(kinds.get(barOfPart(part)) ?? []), part.kind]);
  const sectionBars = [...kinds.keys()].sort((a, b) => a - b);
  const startsAs = (index, ...list) => (kinds.get(index) ?? []).some((kind) => list.includes(kind));
  const enterable = (index) => index >= 0 && index <= lastBar && (!out.has(index) || startsAs(index, "break", "build"));
  const drops = [];
  for (const part of sections) {
    if (part.kind === "drop" && Number.isFinite(part.at) && !drops.some((drop) => drop.bar === barOfPart(part))) drops.push({ bar: barOfPart(part), heard: part.at, weight: part.weight });
  }
  if (!drops.length) fail("the song has no drop (no point where the kick and bass come in strong); pick a song with one, or place it with update_layer.");
  let usable = drops.filter((drop) => drop.bar < lastBar && enterable(drop.bar)).sort((a, b) => b.bar - a.bar); // the later drop wins a tie
  if (!usable.length) fail("no drop of the song can be entered: the kick and bass are out on the bar line of each.");
  let picked = null;
  if (Number.isFinite(dropTime)) {
    // The agent's pick, as in planStop: the drop section nearest that song time within 2 bars, else the bar line nearest it.
    const near = drops.filter((part) => Math.abs(part.heard - dropTime) <= 2 * bar).sort((a, b) => Math.abs(a.heard - dropTime) - Math.abs(b.heard - dropTime))[0];
    const index = barIndexAt(lines, dropTime);
    picked = near ?? { bar: index, heard: lines[index], weight: null };
    if (!(picked.bar < lastBar && enterable(picked.bar))) fail(`the song cannot be entered on the bar line at ${round(lines[picked.bar])} s (the kick and bass are out there, or it is the song's last bar): pick another drop.`);
    usable = [picked];
  }
  const weightCost = (drop) => (1 - (Number.isFinite(drop.weight) ? drop.weight : 0.5)) * 4 + (Math.abs(drop.heard - lines[drop.bar]) > LATE_HEARD ? 2 : 0);
  // The run-up into a drop: the latest break before it (within 16 bars), else the latest build.
  const runUp = (drop) => {
    const near = sectionBars.filter((index) => index < drop && index >= drop - RUN_UP_BARS && enterable(index));
    return near.filter((index) => startsAs(index, "break")).at(-1) ?? near.filter((index) => startsAs(index, "build")).at(-1) ?? null;
  };
  const entriesOf = (drop) => { const run = runUp(drop); return run == null ? [drop] : [run, drop]; };

  // The video before a piece entered on bar `e` at video time `ve`: the song plays on from its start
  // (roll: song second f0 is at video 0), or an opening from the song's start is left on a bar line x.
  // A piece that starts the video at song second f0 is left on bar line x: at least 4 bars after its
  // first bar line, a whole number of groups after the latest drop, break or build inside it (else after its first bar line).
  const phraseBars = sectionBars.filter((index) => startsAs(index, "drop", "break", "build"));
  const leftOnGroup = (f0, x) => {
    let first = 0;
    while (first < x && lines[first] < f0 - 0.02) first += 1;
    if (x - first < GROUP) return false;
    const base = phraseBars.filter((index) => index >= first && index < x).at(-1) ?? first;
    return (x - base) % GROUP === 0;
  };
  const before = (e, ve) => {
    const roll = lines[e] - ve;
    if (ve <= LATE_START || roll <= bar + CUT_SLACK) return { f0: roll, x: null, cost: roll < -CUT_SLACK ? 50 - roll : 0 };
    const found = [];
    for (let x = 1; x < e; x += 1) {
      const f0 = lines[x] - ve;
      if (f0 >= -CUT_SLACK && leftOnGroup(f0, x)) found.push({ f0, x });
    }
    // Left on the same place in the phrase as the next piece enters, then the song's own start.
    found.sort((a, b) => ((e - a.x) % GROUP ? 1 : 0) - ((e - b.x) % GROUP ? 1 : 0) || a.f0 - b.f0);
    if (found.length) return { ...found[0], cost: 0 };
    const why = ve < GROUP * bar ? "are less than 4 bars, so no opening piece fits" : "do not fit an opening of whole 4-bar groups";
    return { f0: roll, x: null, cost: 2, note: `the first ${round(ve)} s ${why}: the song starts ${round(roll)} s in` };
  };

  // The ending of a piece for the drop on bar d, entered on bar e: left after whole groups into the
  // song's own ending, or (no ending that fits) played on to the video's end and faded over 1 to 2 bars on a bar line.
  const ownEnd = whole && shape.last?.ends === "own";
  const closing = ownEnd ? endingOf(lines, shape, lastBar, seconds, bar) : null;
  // `accept(x)`: a bar line the piece may be left on (the first piece of the video must obey leftOnGroup).
  const tailOf = (e, d, accept = () => true) => {
    const at = (line) => payoff + lines[line] - lines[d]; // video time of a bar line of this piece
    const own = closing != null && lastBar > d;
    if (own) {
      const lo = Math.ceil((d + GROUP - e) / GROUP); // the drop plays at least 4 bars
      const hi = Math.floor((lastBar - e) / GROUP);
      // The song's own ending must end by the video's end (no slack): else the drop plays on and fades.
      const fits = (g) => g <= hi && at(e + GROUP * g) + closing.tail <= end + CUT_SLACK && (e + GROUP * g === lastBar || enterable(lastBar)) && accept(e + GROUP * g);
      let g = 0;
      for (let k = lo; k <= hi; k += 1) if (fits(k)) g = k;
      if (g) {
        const gap = end - (at(e + GROUP * g) + closing.tail); // seconds of silence between the song's ending and the end
        return { x: e + GROUP * g, gap, cost: Math.min(4, Math.abs(gap) / bar) };
      }
    }
    let fadeAt = null;
    for (let line = d + 1; line < lines.length && line <= lastBar + 1 && lines[line] <= seconds + CUT_SLACK; line += 1) if (at(line) <= end + EPS) fadeAt = line;
    return { x: null, fadeAt, fadeBars: fadeAt != null && fadeAt - d >= GROUP ? 2 : 1, cost: own ? 3 : 0, note: own ? `4 bars of the drop and the song's own ending do not fit before ${round(end)} s: the drop plays to the end and fades` : null };
  };

  // The earlier drops that can land on the turn: a piece left on a bar line a whole number of groups after its entry (and at least 4 bars after its drop), at or before `e`.
  const turnRoom = turn != null && payoff - turn >= GROUP * bar - bar / 2;
  // `extra`: also any bar up to 16 bars before the drop that is not out (used when the group rule leaves no option).
  const extraEntries = (index) => {
    const list = [];
    for (let i = Math.max(0, index - RUN_UP_BARS); i <= index; i += 1) if (!out.has(i) && !entriesOf(index).includes(i)) list.push(i);
    return list;
  };
  let ruledOut = false; // turnOptions skipped a way because the first piece would break the group rule
  const turnOptions = (d, e, ve, extra = false) => {
    const found = [];
    ruledOut = false;
    for (const early of drops) {
      const t = early.bar;
      if (t >= d || !enterable(t)) continue;
      for (const et of extra ? extraEntries(t) : entriesOf(t)) {
        for (let x = et + GROUP * Math.ceil((t + GROUP - et) / GROUP); x <= e; x += GROUP) {
          const vt = ve - (lines[x] - lines[et]); // video time of the bar line it is entered on
          const lands = vt + lines[t] - lines[et];
          if (lands < -CUT_SLACK) break;
          const head = before(et, vt);
          if (head.x == null && x !== e && !leftOnGroup(head.f0, x)) { ruledOut = true; continue; } // it starts the video: it obeys the group rule (on x = e it plays on into the next piece)
          found.push({ t, e: et, x, ve: vt, lands, head, cost: Math.min(4, Math.abs(lands - turn) / bar) + weightCost(early) / 4 + (et === t && runUp(t) != null ? 1.5 : 0) + (extra ? 1 : 0) });
        }
      }
    }
    return found.sort((a, b) => a.cost - b.cost).slice(0, 4);
  };

  // The best way to play the song: the payoff's drop (heavy, a run-up, an earlier drop for the turn, room for the ending).
  // Every candidate already obeys the cut, join and group rules. Ordered: a plan whose song ends on its own ending
  // (tail.x) at most 2 bars before the end comes before any plan that fades; within each, and for an ending
  // further from the end (a fade costs less than that much silence), the lower cost.
  const preferred = (a, b) => {
    const closes = (choice) => choice.tail.x != null && choice.tail.gap <= SILENCE_BARS * bar + EPS;
    return closes(a) !== closes(b) ? closes(a) : a.cost < b.cost - EPS;
  };
  let best = null;
  for (const drop of usable) {
    const d = drop.bar;
    const run = runUp(d);
    let blocked = false; // the group rule of the first piece took a way to leave it
    const consider = (e, extra) => {
      const free = tailOf(e, d);
      const ve = payoff - (lines[d] - lines[e]);
      const ownCost = (tail) => weightCost(drop) + tail.cost + (run == null ? 5 : e === run ? 0 : extra ? 1 : 3);
      const plain = before(e, ve);
      // A piece that starts the video is left on a bar line the group rule allows.
      const tailPlain = plain.x == null ? tailOf(e, d, (x) => leftOnGroup(plain.f0, x)) : free;
      if (tailPlain.x !== free.x) blocked = true;
      let choice = { head: plain, tail: tailPlain, turn: null, cost: ownCost(tailPlain) + plain.cost + (turn != null ? 4 : 0) };
      if (turnRoom) {
        let options = turnOptions(d, e, ve, extra);
        if (!options.length && !extra && ruledOut) options = turnOptions(d, e, ve, true);
        for (const option of options) {
          // The turn's piece plays on into this one (x = e): the merged piece is the first, left where this one is.
          const tail = option.x === e && option.head.x == null ? tailOf(e, d, (x) => leftOnGroup(option.head.f0, x)) : free;
          const cost = ownCost(tail) + option.cost + option.head.cost;
          const next = { head: option.head, tail, turn: option, cost };
          if (preferred(next, choice)) choice = next;
        }
      }
      if (!best || preferred(choice, best.choice)) best = { drop, e, run, choice };
    };
    for (const e of entriesOf(d)) consider(e, false);
    if (blocked) for (const e of extraEntries(d)) consider(e, true);
  }
  const { drop, e, choice } = best;
  const tail = choice.tail;
  if (best.run == null) notes.push("no break or build before the drop in this song: nothing quiets the line before the payoff");
  if (turn != null && !choice.turn) {
    if (!turnRoom) notes.push("the turn is less than 4 bars before the payoff: an earlier drop cannot play 4 bars up to it, so the turn has no drop of its own");
    else notes.push(usable.some((other) => other.bar < drop.bar) ? "no earlier drop can land on the turn and play whole 4-bar groups" : "no earlier drop for the turn");
  }

  // The pieces in video order: [opening] [turn's drop] the payoff's drop [the song's last bar].
  const chain = [];
  const lay = (head, seg) => {
    if (head.note) notes.push(head.note);
    if (head.x == null) chain.push({ ...seg, first: true, f0: head.f0 });
    else chain.push({ first: true, f0: head.f0, x: head.x }, seg);
  };
  const payoffSeg = { e, x: tail.x ?? undefined, fadeAt: tail.fadeAt, fadeBars: tail.fadeBars };
  if (choice.turn) { lay(choice.turn.head, { e: choice.turn.e, x: choice.turn.x }); chain.push(payoffSeg); }
  else lay(choice.head, payoffSeg);
  if (tail.x != null) chain.push({ e: lastBar, ending: true });
  if (tail.note) notes.push(tail.note);
  // A piece left on the bar line the next one is entered on plays on: no cut.
  const joined = [];
  for (const seg of chain) {
    const prev = joined.at(-1);
    if (prev && prev.x === seg.e) Object.assign(prev, { x: seg.x, ending: seg.ending, fadeAt: seg.fadeAt, fadeBars: seg.fadeBars });
    else joined.push({ ...seg });
  }

  // Video time = song time + shift in each piece. The bar count goes on across a join: the entered bar
  // line lands where the next bar line of the piece being left would have been.
  const pieces = [];
  const { songEnd, endFade } = closing ?? { songEnd: 0, endFade: 0 };
  let enterAt = 0;
  let endAt = null;
  for (const [index, seg] of joined.entries()) {
    const next = joined[index + 1];
    let from;
    let at;
    let fadeIn = JOIN_FADE_HIT;
    if (seg.first) {
      from = Math.max(0, seg.f0);
      at = Math.max(0, -seg.f0);
      fadeIn = openingFade(lines, beat, payoff, seg.f0, LATE_START - 0.02); // entered on a bar line with the join lead: the join fade
    } else {
      from = lines[seg.e] + enterDelta(seg.e);
      at = enterAt + enterDelta(seg.e);
    }
    const shift = at - from;
    let to;
    let fadeOut = JOIN_FADE_OUT;
    if (next) {
      enterAt = lines[seg.x] + shift; // the video time of the line left on, where the next bar line is entered
      to = lines[seg.x] + enterDelta(next.e); // the piece left ends where the next one starts
    } else if (seg.ending) {
      to = songEnd;
      fadeOut = endFade;
      endAt = round(at + to - from);
    } else if (seg.fadeAt != null) {
      to = lines[seg.fadeAt];
      fadeOut = round(lines[seg.fadeAt] - lines[seg.fadeAt - seg.fadeBars]);
    } else {
      const cut = Math.min(end, shift + seconds);
      to = cut - shift;
      fadeOut = round(Math.min(FADE_OUT_MAX, 2 * bar, Math.max(bar, (cut - payoff) / 2), cut - at));
    }
    pieces.push({ from: round(from), to: round(to), at: round(at), fadeIn, fadeOut });
  }

  // Sections in video time (the payoff's drop labeled payoff, the turn's turn), then the ending or the fade.
  const parts = sections.map((part) => ({ kind: part.kind, at: lines[barOfPart(part)] ?? part.at, heard: part.at, weight: part.weight }));
  // A bar line the agent picked that the song's sections do not list as a drop still lands on the payoff.
  if (picked && !parts.some((part) => part.kind === "drop" && part.at === lines[drop.bar])) parts.push({ kind: "drop", at: lines[drop.bar], heard: lines[drop.bar], weight: null });
  const placed = placeSections({ parts, seams, pieces, lands: { payoff, turn: choice.turn?.lands ?? null } });
  if (choice.turn && Math.abs(choice.turn.lands - turn) > 0.01) notes.push(`the turn's drop lands at ${round(choice.turn.lands)} s (${round(choice.turn.lands - turn) > 0 ? "+" : ""}${round(choice.turn.lands - turn)} s): move the turn there for a hit`);
  const last = pieces.at(-1);
  placed.push(endAt != null ? { at: endAt, kind: "ending" } : { at: round(last.at + (last.to - last.from) - last.fadeOut), kind: "fade" });
  if (endAt != null && endAt < end - bar - EPS) notes.push(`the song ends at ${endAt} s, ${round(end - endAt)} s before the end`);
  if (endAt == null && whole === false) notes.push("the measured song stops before its end: it fades out on a bar line");
  return { pieces, sections: placed.sort((a, b) => a.at - b.at), ending: endAt, notes };
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

/**
 * The project's rhythm from the beats the fitted song plays with: its tempo and the first tracked
 * beat the video hears (the first piece's), so cuts snapped to the grid land on the song's own
 * beats. Before, the agent typed it by hand (run 8: offset 0.086 s against a tracked first beat at
 * 0.023 s, every snapped cut 63 ms late). Set as detect_beats sets it: a steady analysis
 * (confidence 0.5 or more) at the file's own speed. Returns the rhythm, or null.
 */
function fittedRhythm(document, layer, pieces, analysis) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats.filter(Number.isFinite) : [];
  if (animatesSpeed(layer) || constantSpeed(layer) !== 1) return null;
  if (!(analysis.bpm >= 30 && analysis.bpm <= 300) || !(analysis.confidence >= CONFIDENT) || beats.length < 2) return null;
  const piece = pieces[0];
  const first = beats.find((time) => time >= piece.from - EPS && time < piece.to);
  if (first === undefined) return null;
  document.rhythm = { bpm: analysis.bpm, offset: round(piece.at + first - piece.from) };
  return document.rhythm;
}

// The receipt line for a payoff kino chose, read from the plan made (what the last piece plays at
// full volume after the payoff, then its fade), not from the formula: the groups, the seconds, and
// on a video too short for 45% and a group, the earlier payoff that gives the drop one group.
function payoffLine(payoff, picked, bar, beat, plan) {
  const section = picked?.sectionSeconds ? `; its section runs ${picked.sectionSeconds} s in the song` : "";
  // plan stop and recut join pieces: the payoff left room for these groups and the fade.
  if (plan.pieces.length !== 1) return `${payoff} s (none given: room for ${Math.max(1, picked?.groups ?? 1)} group${picked?.groups > 1 ? "s" : ""} of 4 bars and the fade${section})`;
  const last = plan.pieces[0];
  const fade = last.fadeOut ?? 0;
  const heard = round(last.at + (last.to - last.from) - fade - payoff);
  const group = GROUP * bar;
  const groups = Math.floor((heard + beat / 2) / group); // half a beat of slack: tracked beats sit a few ms off the grid
  const then = fade > 0 ? `then ${round(fade)} s to fade` : "then the song's own ending";
  if (groups >= 1) return `${payoff} s (none given: the drop plays ${groups} group${groups === 1 ? "" : "s"} of 4 bars, ${heard} s, ${then}${section})`;
  const offer = picked?.oneGroup != null && picked.oneGroup < payoff ? `; payoff ${picked.oneGroup} s gives it the group` : "";
  return `${payoff} s (none given: 45% of the video before the drop; it plays ${heard} s, under one group of 4 bars (${round(group)} s), ${then}${offer}${section})`;
}

/** Applies fit_music {sceneId, layerId, payoff?, turn?, end?, plan?, drop?, recut?, shape: {sections, seconds, whole, bars?}, analysis}. Returns the receipt. */
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
  const end = operation.end ?? scene.duration;
  const grid = barGrid(analysis, shape.sections);
  if (!grid) fail("no steady beat was found in the song, so it cannot be cut on bar lines.");
  // No payoff given (and no spine payoff): the payoff goes where the measured drop plays the most
  // whole groups its section holds (songPayoff), then its fade.
  const chosen = typeof operation.payoff !== "number";
  // A payoff the agent gave is kept; songPayoff then only names the payoff the short-drop note offers.
  const picked = songPayoff({ sections: shape.sections, seconds: shape.seconds ?? analysis.duration, whole: shape.whole !== false, ...grid, length: end, turn: operation.turn ?? null });
  if (chosen) operation = { ...operation, payoff: picked.payoff };
  if (end < operation.payoff + 1) fail("end must be at least 1 s after the payoff.");
  if (operation.turn != null && operation.turn >= operation.payoff) fail("turn must come before the payoff.");
  const seconds = shape.seconds ?? analysis.duration;
  const which = operation.plan ?? (operation.recut === true ? "recut" : "stretch");
  if (!PLANS.includes(which)) fail(`plan is "stretch" (one unbroken stretch), "stop" (the song's stop, then a drop on the payoff) or "recut" (the song re-arranged), not ${JSON.stringify(which)}.`);
  if (operation.drop != null && !(typeof operation.drop === "number" && operation.drop >= 0)) fail("drop is a time in the song in seconds (0 or more): the drop that lands on the payoff.");
  if (which === "stop" && !Array.isArray(shape.bars?.lines)) fail("the song has no measured bars, so plan \"stop\" cannot be used; use plan \"stretch\".");
  const input = { sections: shape.sections, seams: Array.isArray(shape.seams) ? shape.seams : [], seconds, whole: shape.whole !== false, ...grid, payoff: operation.payoff, turn: operation.turn ?? null, end, bars: shape.bars, drop: operation.drop ?? null, roomy: picked };
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
  const cues = plan.sections.map((part) => ({ name: `song-${part.kind}-${(counts[part.kind] = (counts[part.kind] ?? 0) + 1)}`, time: part.at, kind: "marker", fitted: true, ...(Number.isFinite(part.weight) ? { weight: part.weight } : {}) }));
  document.cues = withCues(document.cues, cues, { kinds: ["marker"], prefix: "song-" });

  const lines = plan.sections.map((part) => `${part.at} s ${part.kind}${part.weight != null ? `, weight ${part.weight}` : ""}${part.label ? ` (${part.label})` : ""}`);
  const plans = otherPlans(input, which);
  const planNotes = plan.notes.filter((note) => !(chosen && note.startsWith("the drop plays ")));
  const rhythm = fittedRhythm(document, head, plan.pieces, analysis);
  return {
    layer: base,
    pieces: made.length,
    // Which part of the song plays, in song order.
    plays: plan.pieces.map((piece) => `${clock(piece.from)}-${clock(piece.to)}`).join(", "),
    ...(chosen ? { payoff: payoffLine(operation.payoff, picked, grid.bar, grid.beat ?? grid.bar / 4, plan) } : {}),
    sections: lines,
    ...(rhythm ? { rhythm: `${rhythm.bpm} bpm, first beat ${rhythm.offset} s (set from the song's measured beats)` } : {}),
    // The plans not used that this song allows, one line each, for choosing by the video's story.
    ...(plans.length ? { plans } : {}),
    // A chosen payoff's short drop is said in the payoff line itself, not again as a note.
    ...(planNotes.length || dropped ? { notes: [...planNotes, ...(dropped ? [`its volume animations (ducks, fades) were removed: run duck_audio {layer:"${base}"} again (it ducks every piece)`] : [])] } : {}),
  };
}
