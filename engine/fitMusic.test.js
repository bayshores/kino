// fit_music: one unbroken stretch of the song with its drop on the payoff; with recut:true the
// song cut on measured bar lines in whole groups of 4 bars so its drop lands on the payoff and its
// ending on the end (fitMusic.js).
// The song's measures (song-shape.mjs, the beat analysis) are made up here; the agent service
// measures real files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { planFitMusic } from "./fitMusic.js";
import { round } from "./numbers.js";
import { volumeAt } from "./animation.js";

// 120 bpm (a bar is 2 s): intro, build at 24, drop at 32, break at 64, build at 72, drop at 80, outro at 112, ends at 120.
const SECTIONS = [{ at: 0, kind: "intro" }, { at: 24, kind: "build" }, { at: 32, kind: "drop" }, { at: 64, kind: "break" }, { at: 72, kind: "build" }, { at: 80, kind: "drop" }, { at: 112, kind: "outro" }];
const onBar = (time) => Math.abs(time / 2 - Math.round(time / 2)) < 1e-6;

test("planFitMusic: one unbroken stretch of the song, its drop on the payoff, faded in to a bar line and out at the end", () => {
  const plan = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 21, turn: 8, end: 31 });
  // Song 59 to 90 s: the second drop, whose break lands nearest the turn. Nothing is skipped.
  // The drop plays its first 4 bars (8 s) at full volume, then fades over one bar (not from 27 s, inside the group).
  assert.deepEqual(plan.pieces, [{ from: 59, to: 90, at: 0, fadeIn: 1, fadeOut: 2 }]);
  assert.deepEqual(plan.sections.map((part) => [part.at, part.kind, part.label]), [[5, "break", undefined], [13, "build", undefined], [21, "drop", "payoff"], [29, "fade", undefined]]);
  // The picture moves to the song: where the turn and the end would land on it.
  assert.ok(plan.notes.some((note) => /song changes at 5 s \(-3 s from the turn\)/.test(note)) && plan.notes.some((note) => /phrase ends at 29 s/.test(note)), plan.notes.join("; "));
  // Its own ending when the stretch reaches it, and a clean start on a section line.
  const close = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 8, end: 48 });
  assert.deepEqual(close.pieces, [{ from: 72, to: 120, at: 0, fadeIn: 0, fadeOut: 0 }]);
  assert.equal(close.ending, 48);
});

test("planFitMusic stretch with drop and payoff: exactly that song second on exactly the payoff, the drops not taken named", () => {
  // Without drop kino takes the drop at 80 s (the test above); the agent's drop 32.37 s (37 ms off
  // the grid's bar line at 32) is placed as given, not snapped and not swapped for the other drop.
  const plan = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 21, turn: 8, end: 31, drop: 32.37 });
  assert.equal(plan.pieces[0].from, 11.37);
  assert.equal(plan.pieces[0].at, 0);
  assert.deepEqual(plan.sections.filter((part) => part.kind === "drop").map((part) => [part.at, part.label]), [[21, "payoff"]]);
  assert.ok(plan.notes.some((note) => note === "drop 32.37 s of the song lands exactly on the payoff, as given; drops not taken: 80 s (kino's pick without drop)"), plan.notes.join("; "));
  // A drop second with no measured drop near it is placed too.
  const bare = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 10, end: 20, drop: 50 });
  assert.deepEqual([bare.pieces[0].from, bare.sections.find((part) => part.label === "payoff")?.at], [40, 10]);
});

test("planFitMusic recut: the drop on the payoff, an earlier drop on the turn, the song's own ending on the end, cuts on bar lines in song order, whole groups of 4 bars between joins", () => {
  const plan = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 36, turn: 12, end: 46, recut: true });
  const drops = plan.sections.filter((part) => part.kind === "drop");
  assert.deepEqual(drops.map((part) => [part.at, part.label]), [[12, "turn"], [36, "payoff"]]);
  assert.equal(plan.ending, 46);
  assert.deepEqual(plan.sections.at(-1), { at: 46, kind: "ending" });
  // In song order. Each piece after the first is entered 2 ms (and the 12 ms the song's hits sit before a made-up grid's lines) before a bar line,
  // the piece before it ends at the same video instant (the bar count goes on), and a piece that is left plays whole groups of 4 bars (8 s).
  for (const [index, piece] of plan.pieces.entries()) {
    if (index) assert.ok(piece.from > plan.pieces[index - 1].from, "song order");
    if (index) assert.ok(onBar(piece.from + 0.014) && piece.fadeIn === 0.003 && Math.abs(piece.at - (plan.pieces[index - 1].at + plan.pieces[index - 1].to - plan.pieces[index - 1].from)) < 0.002, `piece ${index} is joined on a bar line`);
    if (index && index < plan.pieces.length - 1) assert.ok(Math.abs((piece.to - piece.from) / 8 - Math.round((piece.to - piece.from) / 8)) < 0.001, `piece ${index} plays whole groups`);
  }
  assert.equal(plan.pieces.at(-1).to, 120, "the last piece plays to the song's end");
  assert.ok(plan.pieces.at(-1).fadeOut < 0.1, "the song ends by itself: only its ring fades");
  assert.ok(plan.pieces.every((piece, index) => index === plan.pieces.length - 1 || piece.fadeOut === 0.005), "no crossfades");
  // Without a turn, the break or build before the payoff's drop plays under the line before it.
  const plain = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 36, end: 46, recut: true });
  const before = plain.sections.filter((part) => part.at < 36 && part.at >= 20).map((part) => part.kind);
  assert.ok(before.includes("build") && before.includes("break"), JSON.stringify(plain.sections));
  // A break heard 0.4 s before its bar line: the piece is entered on the bar line (at 20 s), and the cue there too, not at 19.6 s.
  const early = planFitMusic({ sections: SECTIONS.map((part) => (part.at === 64 ? { ...part, at: 63.6 } : part)), seconds: 120, bar: 2, downbeat: 0, payoff: 36, turn: 12, end: 46, recut: true });
  assert.ok(early.sections.filter((part) => part.kind === "break").every((part) => Math.abs(part.at - 20) < 0.02), JSON.stringify(early.sections));
});

test("planFitMusic recut: a song cut off before its end fades out over at least a bar, ending on a bar line", () => {
  const plan = planFitMusic({ sections: SECTIONS.slice(0, 3), seconds: 60, whole: false, bar: 2, downbeat: 0, payoff: 12, end: 25, recut: true });
  const last = plan.pieces.at(-1);
  assert.equal(plan.ending, null);
  assert.ok(last.fadeOut >= 2, `fade ${last.fadeOut}`);
  assert.ok(onBar(last.at + last.to - last.from - 12 + 32), "the fade ends on a bar line");
  assert.throws(() => planFitMusic({ sections: [{ at: 0, kind: "intro" }], seconds: 60, bar: 2, payoff: 10, end: 20 }), /no drop/);
});

test("fit_music keeps the music layer in one piece by default; recut:true cuts it into pieces joined on bar lines; both write the sections and seams as cues at their heard times, with weights", () => {
  // The drop is heard 20 ms after its bar line: the cut stays on the bar line, the cue on the sound.
  const HEARD = SECTIONS.map((part) => (part.at === 80 ? { ...part, at: 80.02, weight: 0.8 } : part));
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: 30, volume: 0.8 });
  const document = createDocument({ scenes: [createScene({ id: "s1", duration: 30, layers: [music] })], cues: [{ name: "song-drop-9", time: 3, kind: "marker" }, { name: "hit", time: 4, kind: "marker" }] });
  const beats = Array.from({ length: 240 }, (_, index) => index * 0.5);
  const op = { type: "fit_music", sceneId: "s1", layerId: "music", payoff: 20, end: 30, recut: true, shape: { sections: HEARD, seconds: 120, whole: true, seams: [{ at: 78.012, kind: "dropout", weight: 0.9 }, { at: 78.5, kind: "return", weight: 0.7 }] }, analysis: { bpm: 120, period: 0.5, beats, duration: 120 } };
  // By default: one layer playing song 60 to 90 s, the drop's cue on the payoff, a fade at the end.
  const whole = new Map();
  const single = applyOperations(document, [{ ...op, recut: false }], { reports: whole });
  const only = single.scenes[0].layers;
  assert.equal(only.length, 1);
  assert.deepEqual([only[0].mediaStart, only[0].mediaOffset, only[0].mediaDuration], [0, 60, 30]);
  assert.equal([...whole.values()][0].plays, "1:00-1:30");
  assert.ok(single.cues.some((cue) => cue.name === "song-drop-1" && cue.time === 20.02 && cue.fitted === true) && only[0].animations.some((animation) => animation.name === "Fit out"));
  // A payoff pinned by a board shot (drop:true, the service sets `pinned`): the heard drop lands on the shot's cut, not 20 ms after it.
  const pinned = new Map();
  const onCut = applyOperations(document, [{ ...op, recut: false, pinned: "shot 3 (drop:true)" }], { reports: pinned });
  assert.equal(onCut.scenes[0].layers[0].mediaOffset, 60.02);
  assert.ok(onCut.cues.some((cue) => cue.name === "song-drop-1" && cue.time === 20), JSON.stringify(onCut.cues));
  assert.equal([...pinned.values()][0].payoff, "20 s (the cut of board shot 3 (drop:true))");
  const reports = new Map();
  const next = applyOperations(document, [op], { reports });
  const report = [...reports.values()][0];
  const layers = next.scenes[0].layers;
  assert.equal(report.pieces, layers.length);
  assert.ok(layers.length >= 2 && layers[0].name === "music" && layers[1].name === "music-2" && layers[1].fitMusic === "music");
  assert.ok(report.sections.includes("20.02 s drop, weight 0.8 (payoff)") && report.sections.includes("18.012 s dropout, weight 0.9") && report.sections.at(-1) === "30 s ending", report.sections.join("; "));
  // Joins: each later piece fades in (3 ms), each earlier one fades out (5 ms), at the piece's volume.
  assert.ok(layers.slice(1).every((layer) => layer.animations.some((animation) => animation.name === "Fit in" && animation.to.volume === 0.8)));
  assert.ok(layers.slice(0, -1).every((layer) => layer.animations.some((animation) => animation.name === "Fit out")));
  // The measured sections are marked fitted (impact-accent answers only these); a hand cue is not.
  assert.ok(next.cues.some((cue) => cue.name === "song-drop-1" && cue.time === 20.02 && cue.fitted === true) && next.cues.some((cue) => cue.name === "song-return-1" && cue.time === 18.5) && next.cues.some((cue) => cue.name === "hit" && cue.fitted === undefined));
  assert.ok(!next.cues.some((cue) => cue.name === "song-drop-9"), "an earlier fit's cues are replaced");
  // Again on the result: the same pieces, not pieces of pieces.
  const again = applyOperations(next, [{ ...op, layerId: "music" }]);
  assert.equal(again.scenes[0].layers.length, layers.length);
  // duck_audio on the song ducks every piece, and the join at 28 s (under the voice) stays ducked.
  const voice = createLayer("audio", { id: "voice", name: "voice", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556667.mp3", mediaStart: 27, mediaDuration: 2 });
  next.scenes[0].layers.push(voice);
  const ducked = applyOperations(next, [{ type: "duck_audio", sceneId: "s1", layerId: "music", under: ["voice"], to: 0.25 }]).scenes[0].layers;
  const fade = (layer, name) => layer.animations.find((animation) => animation.name === name);
  assert.ok(ducked.filter((layer) => layer.id !== "voice").every((layer) => fade(layer, "Duck down")));
  assert.equal(fade(ducked[0], "Fit out").from.volume, 0.25);
  assert.equal(fade(ducked[1], "Fit in").to.volume, 0.25);
  assert.equal(fade(ducked[1], "Fit out").from.volume, 0.8, "a fade outside the dip fades from full volume");
});

test("fit_music on a short edit: the heavier of two drops, room for 4 bars of it when no payoff is given, the rhythm from the measured beats", () => {
  // A light drop (0.24) at 50 s, the main drop (weight 1) at 68 s; 120 bpm, beats tracked from 0.023 s; no bars (plan stop cannot run).
  const sections = [{ at: 0, kind: "intro" }, { at: 34, kind: "build", weight: 0.07 }, { at: 50, kind: "drop", weight: 0.24 }, { at: 68, kind: "drop", weight: 1 }, { at: 150, kind: "outro" }];
  const beats = Array.from({ length: 370 }, (_, index) => round(0.023 + index * 0.5));
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: 15 });
  const document = createDocument({ scenes: [createScene({ id: "s1", duration: 15, layers: [music] })] });
  const reports = new Map();
  const next = applyOperations(document, [{ type: "fit_music", sceneId: "s1", layerId: "music", shape: { sections, seconds: 188, whole: true }, analysis: { bpm: 120, period: 0.5, beats, confidence: 0.9, duration: 188 } }], { reports });
  const report = [...reports.values()][0];
  const layer = next.scenes[0].layers[0];
  // 15 s is too short for 45% before the drop and a group: the 45% floor holds (6.75 s), and the receipt says what the drop plays and the payoff that gives it the group (5 s).
  // No end given: the phrase end 4 bars after the drop (14.767 s, 7 frames before 15 s) is taken, and the fade closes on it.
  assert.match(report.payoff, /^6\.75 s \(none given: 45% of the video before the drop; it plays 6\.017 s, under one group of 4 bars \(8 s\), then 2 s to fade; payoff 5 s gives it the group; its section runs 82 s in the song\)/);
  assert.equal(report.ending, "phrase end at 14.767 s (song 76.04 s): the scene end moved -7 frames (was 15 s); end:15 keeps it");
  assert.equal(next.scenes[0].duration, 14.767);
  assert.ok(next.cues.some((cue) => cue.name === "song-drop-1" && cue.weight === 1 && Math.abs(cue.time - 6.75) < 0.05) && !next.cues.some((cue) => cue.weight === 0.24), JSON.stringify(next.cues));
  assert.ok(Math.abs(next.cues.find((cue) => cue.name === "song-fade-1").time - 12.767) < 0.05, "a bar to fade");
  // A 60 s edit: the drop's section ends 16 s after it (a break), so it plays 2 groups, not the 3 the lead would allow; the break and the fade both land at 56.
  const long = new Map();
  const capped = [...sections.slice(0, 4), { at: 84, kind: "break" }, { at: 100, kind: "outro" }];
  const wide = createDocument({ scenes: [createScene({ id: "s1", duration: 60, layers: [{ ...music, mediaDuration: 60 }] })] });
  const sixty = applyOperations(wide, [{ type: "fit_music", sceneId: "s1", layerId: "music", end: 60, shape: { sections: capped, seconds: 188, whole: true }, analysis: { bpm: 120, period: 0.5, beats, confidence: 0.9, duration: 188 } }], { reports: long });
  assert.match([...long.values()][0].payoff, /^40 s \(none given: the drop plays 2 groups of 4 bars, 16 s/);
  // (the measured beats start 0.023 s in, so the break is heard 23 ms before the 56 s line)
  assert.ok([sixty.cues.find((cue) => cue.name === "song-break-1").time, sixty.cues.find((cue) => cue.name === "song-fade-1").time].every((time) => Math.abs(time - 56) < 0.05), JSON.stringify(sixty.cues));
  // The rhythm: the first tracked beat the video hears, not a typed offset.
  const first = beats.find((time) => time >= layer.mediaOffset) - layer.mediaOffset;
  assert.ok(next.rhythm.bpm === 120 && Math.abs(next.rhythm.offset - first) < 0.01, JSON.stringify(next.rhythm));
  assert.match(report.rhythm, /120 bpm, first beat .* measured beats/);
  assert.ok(!(report.plans ?? []).some((line) => line.startsWith("stop")), "no bars: plan stop is not offered");
  // A late payoff the agent gives is kept, and the receipt says what it costs the drop and which payoff gives it 4 bars.
  const late = new Map();
  applyOperations(document, [{ type: "fit_music", sceneId: "s1", layerId: "music", payoff: 11.3, shape: { sections, seconds: 188, whole: true }, analysis: { bpm: 120, period: 0.5, beats, confidence: 0.9, duration: 188 } }], { reports: late });
  const lateReport = [...late.values()][0];
  assert.ok(lateReport.sections.some((line) => /^11\.\d+ s drop, weight 1 \(payoff\)/.test(line)) && lateReport.notes.some((note) => /^the drop plays 3\.04 s before the ring, under 4 bars: payoff 5 s gives it/.test(note)), JSON.stringify(lateReport));
  // No phrase end near 15 s: the song's last beat before it rings out instead of a 2 s fade.
  assert.match(lateReport.ending, /^the song's hit at 14\.3 s \(song 71\.023 s, beat\) rings 0\.7 s to the end; phrase end at 19\.3 s/);
  assert.ok(!(report.notes ?? []).some((note) => note.startsWith("the drop plays")), "no note when the payoff was chosen for the drop");
});

test("fit_music with no end: a phrase end near the scene end is taken; else the song's last hit rings out to the end; a given end stays", () => {
  // 120 bpm (2 s bars), the drop at song 32 s on the payoff at 8 s: bar lines at 10, 12, 14 s, phrase ends at 16 s.
  const beats = Array.from({ length: 240 }, (_, index) => index * 0.5);
  const fit = (duration, extra = {}, clipStart = 11, given = null) => {
    const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: duration, volume: 0.8 });
    const clip = createLayer("video", { id: "clip", name: "clip", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556670.mp4", mediaStart: clipStart, mediaDuration: duration - clipStart });
    const reports = new Map();
    const document = applyOperations(given ?? createDocument({ scenes: [createScene({ id: "s1", duration, layers: [music, clip] })] }), [{ type: "fit_music", sceneId: "s1", layerId: "music", payoff: 8, shape: { sections: SECTIONS, seconds: 120, whole: true }, analysis: { bpm: 120, period: 0.5, beats, confidence: 0.9, duration: 120 }, ...extra }], { reports });
    return { document, report: [...reports.values()][0], song: document.scenes[0].layers[0] };
  };
  // 13 s: no phrase end near (16 s is 90 frames on). The hit on the bar line at 12 s (song 36 s) plays, then rings 1 s to the end.
  const rung = fit(13);
  assert.equal(rung.report.ending, "the song's hit at 12 s (song 36 s, bar line) rings 1 s to the end; phrase end at 16 s (song 40 s) would need the scene end moved +90 frames");
  assert.equal(rung.document.scenes[0].duration, 13);
  assert.ok(rung.document.cues.some((cue) => cue.name === "song-ring-1" && cue.time === 12) && !rung.document.cues.some((cue) => cue.name === "song-fade-1"));
  // The level of the last second: full on the hit, then a fast decay (quart-out), silent at the end; a linear fade would still be at 0.4 at 12.5 s.
  const curve = [12, 12.04, 12.1, 12.25, 12.5, 12.75, 13].map((time) => round(volumeAt(rung.song, time), 2));
  assert.deepEqual(curve, [0.8, 0.8, 0.62, 0.29, 0.06, 0.01, 0]);
  // 16.2 s: the phrase end at 16 s is 6 frames before the end: taken, and the clip that ran to 16.2 s ends there too.
  const taken = fit(16.2);
  assert.equal(taken.report.ending, "phrase end at 16 s (song 40 s): the scene end moved -6 frames (was 16.2 s); end:16.2 keeps it");
  assert.equal(taken.document.scenes[0].duration, 16);
  assert.equal(taken.document.scenes[0].layers[1].mediaDuration, 5);
  // Run again on that video: it already ends on the phrase end, so nothing moves.
  assert.equal(fit(16, {}, 11, taken.document).report.ending, "phrase end at 16 s (song 40 s): the video ends on it");
  // A clip that starts after the phrase end keeps the end where it is, and the receipt says why.
  assert.match(fit(16.2, {}, 16.1).report.ending, /would need the scene end moved -6 frames \(not taken: "clip" starts at 16\.1 s\)$/);
  // A given end stays as given: the old fade, no ending line.
  const given = fit(16.2, { end: 16.2 });
  assert.ok(given.document.scenes[0].duration === 16.2 && given.report.ending === undefined);
});

// plan "stop" (and "recut" on the same song): the song's opening, its own stop, a drop on the payoff for whole groups of 4 bars, its last bar.
// A made-up song whose bars drift (2.02 s each, a constant 2 s grid would be 1 s wrong by bar 50):
// kick and bass out in bars 8 and 9 (the stop) and 45 and 46; drops at bars 20 and 40; a hit 10 ms before each line.
const lines = Array.from({ length: 60 }, (_, index) => Math.round(2.02 * index * 1000) / 1000);
const barsOf = (extra = {}) => ({ lines, out: [8, 9, 45, 46], hits: lines.map((time) => Math.round((time - 0.01) * 1000) / 1000), last: { bar: 58, end: 119.5, ends: "own" }, ...extra });
const STOP_SECTIONS = [{ at: 0, kind: "intro", bar: 0 }, { at: lines[15], kind: "build", bar: 15 }, { at: lines[20] + 0.01, kind: "drop", weight: 0.9, bar: 20 }, { at: lines[40], kind: "drop", weight: 0.5, bar: 40 }, { at: lines[56], kind: "outro", bar: 56 }];
const stopInput = (extra = {}) => ({ sections: STOP_SECTIONS, seconds: 119.5, bar: 2.02, payoff: lines[10], end: 46.78, plan: "stop", bars: barsOf(), ...extra });

test("planFitMusic stop: the opening to the song's stop, the drop for whole groups on the payoff, the last bar; each join on a hit, bar lines of the measured song", () => {
  const plan = planFitMusic(stopInput());
  // Song bar 10 (the stop's end) lands on the payoff; bar 20 enters 12 ms early (2 ms before its hit) and plays 3 groups (bars 20 to 31); the last bar (58) follows.
  assert.deepEqual(plan.pieces, [
    { from: 0, to: 20.188, at: 0, fadeIn: 0, fadeOut: 0.005 },
    { from: 40.388, to: 64.628, at: 20.188, fadeIn: 0.003, fadeOut: 0.005 },
    { from: 117.148, to: 119.5, at: 44.428, fadeIn: 0.003, fadeOut: 0.32 }, // the ring past the last bar (line 59 to the song's end) fades
  ]);
  assert.equal(plan.ending, 46.78);
  // The bar count goes on across each join: the entered bar line lands where the bar line left behind would have.
  assert.ok(Math.abs(plan.pieces[1].at + 0.012 - lines[10] - 0) < 1e-9 && Math.abs(plan.pieces[2].at + 0.012 - (lines[10] + lines[32] - lines[20])) < 1e-9);
  assert.deepEqual(plan.sections.map((part) => [part.at, part.kind, part.label]).filter(([, kind]) => kind !== "build" && kind !== "intro" && kind !== "outro"), [[16.16, "stop", undefined], [20.21, "drop", "payoff"], [46.78, "ending", undefined]]);
  // No measured hit on an entered line (bar 20, the last bar): it is entered where its hit would be, the song's own lead
  // (hits sit 10 ms before the lines), so a kick the measure missed is not cut into; the piece left ends at the same instant.
  const plain = planFitMusic(stopInput({ bars: barsOf({ hits: barsOf().hits.map((time, index) => (index === 20 || index === 58 ? null : time)) }) }));
  assert.deepEqual(plain.pieces, plan.pieces);
  // A song with too few measured hits to tell its lead: 12 ms before the line, and 2 ms more.
  const few = planFitMusic(stopInput({ bars: barsOf({ hits: [] }) }));
  assert.deepEqual(few.pieces.slice(0, 2).map((piece) => [piece.from, piece.at, piece.fadeIn]), [[0, 0, 0], [round(lines[20] - 0.014), round(lines[10] - 0.014), 0.003]]);
  // The song's sound ends before its file does: the last piece and the ending stop there.
  const early = planFitMusic(stopInput({ bars: barsOf({ last: { bar: 58, end: 119.0, ends: "own" } }) }));
  assert.deepEqual([early.pieces[2].to, early.pieces[2].fadeOut, early.ending], [119, 0.05, 46.28]);
  // A bar out inside the third group: it is left out (never leave inside a group).
  const shorter = planFitMusic(stopInput({ bars: barsOf({ out: [8, 9, 25] }) }));
  assert.equal(shorter.pieces[1].to, 48.468, "plays bars 20 to 23 only");
  assert.equal(shorter.pieces[2].at, 28.268, "the last bar follows at once");
  // drop: the section nearest that song time (within 2 bars), else the bar line nearest it.
  assert.equal(planFitMusic(stopInput({ drop: 80 })).pieces[1].from, round(lines[40] - 0.012));
  assert.equal(planFitMusic(stopInput({ drop: 60 })).pieces[1].from, round(lines[30] - 0.012));
  // A bar line that no section lists as a drop still gets the payoff cue (the picture is timed to it).
  const payoffCue = planFitMusic(stopInput({ drop: 60 })).sections.find((part) => part.label === "payoff");
  assert.ok(payoffCue?.kind === "drop" && Math.abs(payoffCue.at - lines[10]) < 0.02, JSON.stringify(payoffCue));
});

test("planFitMusic stop: no usable stop is a plain failure that names plan stretch; a song with no bars cannot use it", () => {
  assert.throws(() => planFitMusic(stopInput({ bars: barsOf({ out: [] }) })), /no stop.*plan "stretch"/);
  assert.throws(() => planFitMusic(stopInput({ bars: null })), /no measured bars/);
});

test("planFitMusic recut: on drifting bar lines every piece left early plays whole groups of 4 bars, each join 2 ms before its hit", () => {
  const plan = planFitMusic(stopInput({ plan: "recut", payoff: lines[22], end: 70 }));
  const [opening, drop, last] = plan.pieces;
  // The opening is left 4 bars after the drop that starts inside it (bar 20); the drop is entered on bar 40 and plays 8 bars; the last bar closes the song.
  assert.equal(round(opening.to + 0.012), lines[24]);
  assert.deepEqual([drop.from, drop.to, last.from], [round(lines[40] - 0.012), round(lines[48] - 0.012), round(lines[58] - 0.012)]);
  assert.equal(round((drop.to - drop.from) / 2.02), 8);
  // The bar count goes on across each join: bar 40 lands on the payoff, bar 58's place is where bar 48 would be.
  assert.ok(Math.abs(drop.at + 0.012 - lines[22]) < 1e-9 && Math.abs(last.at + 0.012 - (lines[22] + lines[48] - lines[40])) < 1e-9);
  assert.deepEqual([opening.fadeOut, drop.fadeIn, drop.fadeOut, last.fadeIn], [0.005, 0.003, 0.005, 0.003]);
  assert.equal(plan.pieces.length, 3);
  // The piece that starts the video is left a whole number of groups after the drop inside it (the drop on bar 20: bar 28, not bar 27).
  const first = planFitMusic(stopInput({ plan: "recut", payoff: 10, end: 30 })).pieces[0];
  assert.equal(round(first.to + 0.012), lines[28], "left on bar 28");
  // Entered on a bar line with the join lead (starts 30 ms before line 15): the join fade; a start mid-bar fades to the next bar line.
  assert.equal(planFitMusic(stopInput({ plan: "recut", payoff: 10.13, end: 30 })).pieces[0].fadeIn, 0.005);
  assert.ok(planFitMusic(stopInput({ plan: "recut", payoff: 10.6, end: 30 })).pieces[0].fadeIn > 1);
  // drop: the drop section nearest that song time lands on the payoff, as for plan stop.
  const picked = planFitMusic(stopInput({ plan: "recut", payoff: 22, end: 46, drop: lines[40] }));
  assert.ok(picked.pieces.some((piece) => piece.from <= lines[40] && lines[40] < piece.to && Math.abs(piece.at + lines[40] - piece.from - 22) < 0.02), JSON.stringify(picked.pieces));
  assert.ok(picked.sections.some((part) => part.label === "payoff" && Math.abs(part.at - 22) < 0.02));
});

test("planFitMusic recut: the song's own ending never runs past the end: when no whole group fits, the drop plays on and fades over 1 to 2 bars", () => {
  // The ending would end at 22.12 s, 0.42 s past the end (it used to pass by less than a bar).
  const plan = planFitMusic(stopInput({ plan: "recut", payoff: 11.7, end: 21.7 }));
  const last = plan.pieces.at(-1);
  assert.equal(plan.ending, null);
  assert.ok(last.at + last.to - last.from <= 21.75 && last.fadeOut >= 2.02 && last.fadeOut <= 4.05, JSON.stringify(plan.pieces));
  assert.ok(plan.notes.some((note) => /own ending do not fit before 21.7 s/.test(note)), plan.notes.join("; "));
  // A plan that ends on the song's own ending comes before any fade when the ending is at most 2 bars (4.04 s) before the end: 2.58 s early here.
  const early = planFitMusic(stopInput({ plan: "recut", payoff: 10, end: 23 }));
  assert.deepEqual([early.ending, early.pieces.at(-1).to], [20.42, 119.5], JSON.stringify(early.pieces));
  assert.ok(early.notes.some((note) => /the song ends at 20.42 s, 2.58 s before the end/.test(note)), early.notes.join("; "));
  // More silence than that (4.58 s) is not accepted: the drop plays on and fades to the end, as before.
  for (const end of [25]) {
    const fade = planFitMusic(stopInput({ plan: "recut", payoff: 10, end }));
    assert.equal(fade.ending, null, `end ${end}`);
    assert.ok(Math.abs(fade.pieces.at(-1).at + fade.pieces.at(-1).to - fade.pieces.at(-1).from - end) < 4.1, JSON.stringify(fade.pieces));
  }
});

test("planFitMusic recut: a turn less than 4 bars before the payoff drops the turn piece and says so", () => {
  const plan = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 36, turn: 30, end: 46, recut: true });
  assert.deepEqual(plan.pieces, planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 36, end: 46, recut: true }).pieces);
  assert.ok(plan.notes.some((note) => /turn is less than 4 bars before the payoff/.test(note)) && !plan.sections.some((part) => part.label === "turn"), plan.notes.join("; "));
});

test("fit_music plan stop: three pieces with 3 ms and 5 ms fades kept, the receipt lists the plans not used; no plan is the unbroken stretch", () => {
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: 119.5 });
  const document = createDocument({ scenes: [createScene({ id: "s1", duration: 60, layers: [music] })] });
  const analysis = { bpm: 118.8, period: 0.505, beats: Array.from({ length: 240 }, (_, index) => index * 0.505), duration: 119.5 };
  const op = { type: "fit_music", sceneId: "s1", layerId: "music", payoff: lines[10], end: 46.78, shape: { sections: STOP_SECTIONS, seconds: 119.5, whole: true, bars: barsOf() }, analysis };
  const reports = new Map();
  const next = parseDocument(applyOperations(document, [{ ...op, plan: "stop" }], { reports }));
  const layers = next.scenes[0].layers;
  const animation = (layer, name) => layer.animations.find((item) => item.name === name);
  assert.equal(layers.length, 3);
  assert.deepEqual([animation(layers[1], "Fit in").duration, animation(layers[0], "Fit out").duration, animation(layers[1], "Fit out").duration], [0.003, 0.005, 0.005]);
  const report = [...reports.values()][0];
  assert.equal(report.plays, "0:00-0:20, 0:40-1:04, 1:57-1:59");
  // duck_audio ducks every piece and keeps the short fades: a join inside a dip fades to the ducked level.
  next.scenes[0].layers.push(createLayer("audio", { id: "voice", name: "voice", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556667.mp3", mediaStart: 19, mediaDuration: 3 }));
  const ducked = applyOperations(next, [{ type: "duck_audio", sceneId: "s1", layerId: "music", under: ["voice"], to: 0.25 }]).scenes[0].layers;
  assert.deepEqual([animation(ducked[1], "Fit in").duration, animation(ducked[0], "Fit out").duration], [0.003, 0.005]);
  assert.deepEqual([animation(ducked[1], "Fit in").to.volume, animation(ducked[0], "Fit out").from.volume], [0.25, 0.25]);
  assert.deepEqual(report.plans.map((line) => line.split(":")[0]), ["stretch", "recut"]);
  assert.ok(report.plans.every((line) => line.length <= 140));
  // No plan: one unbroken stretch, and the stop plan is the one listed.
  const unused = new Map();
  const whole = applyOperations(document, [op], { reports: unused });
  assert.equal(whole.scenes[0].layers.length, 1);
  assert.equal([...unused.values()][0].plans[0], "stop: opening 0:00-0:20, the song stops at 16.16 s, drop 0:40 on the payoff for 12 bars, the song's last bar ends 46.78 s");
  // No bars in the shape: plan stop fails plainly.
  assert.throws(() => applyOperations(document, [{ ...op, plan: "stop", shape: { ...op.shape, bars: undefined } }]), /no measured bars/);
  // A wrong plan or drop is refused in plain words.
  assert.throws(() => applyOperations(document, [{ ...op, plan: "loop" }]), /plan is "stretch".*not "loop"/);
  assert.throws(() => applyOperations(document, [{ ...op, plan: "stop", drop: -3 }]), /drop is a time in the song/);
});
