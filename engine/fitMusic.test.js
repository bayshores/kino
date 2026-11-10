// fit_music: the song cut so its drop lands on the payoff and its ending on the end (fitMusic.js).
// The song's measures (song-shape.mjs, the beat analysis) are made up here; the agent service
// measures real files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";
import { planFitMusic } from "./fitMusic.js";

// 120 bpm (a bar is 2 s): intro, build at 24, drop at 32, break at 64, build at 72, drop at 80, outro at 112, ends at 120.
const SECTIONS = [{ at: 0, kind: "intro" }, { at: 24, kind: "build" }, { at: 32, kind: "drop" }, { at: 64, kind: "break" }, { at: 72, kind: "build" }, { at: 80, kind: "drop" }, { at: 112, kind: "outro" }];
const onBar = (time) => Math.abs(time / 2 - Math.round(time / 2)) < 1e-6;

test("planFitMusic: the drop on the payoff, an earlier drop on the turn, the song's own ending on the end, cuts on bar lines in song order", () => {
  const plan = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 20, turn: 8, end: 30 });
  const drops = plan.sections.filter((part) => part.kind === "drop");
  assert.deepEqual(drops.map((part) => [part.at, part.label]), [[8, "turn"], [20, "payoff"]]);
  assert.equal(plan.ending, 30);
  assert.deepEqual(plan.sections.at(-1), { at: 30, kind: "ending" });
  // In song order, each cut on a bar line of the song, each piece's start a whole number of bars from the payoff's.
  for (const [index, piece] of plan.pieces.entries()) {
    if (index) assert.ok(piece.from > plan.pieces[index - 1].from, "song order");
    assert.ok(onBar(piece.from + piece.fadeIn) && onBar(piece.at + piece.fadeIn), `piece ${index} starts on a bar line`);
  }
  assert.equal(plan.pieces.at(-1).to, 120, "the last piece plays to the song's end");
  assert.equal(plan.pieces.at(-1).fadeOut, 0, "the song ends by itself");
  // Without a turn, the break or build before the payoff's drop plays under the line before it.
  const plain = planFitMusic({ sections: SECTIONS, seconds: 120, bar: 2, downbeat: 0, payoff: 20, end: 30 });
  const before = plain.sections.filter((part) => part.at < 20 && part.at >= 10).map((part) => part.kind);
  assert.ok(before.includes("build") || before.includes("break"), JSON.stringify(plain.sections));
  // A break heard 0.4 s before its bar line (more than the crossfade): the cut is on the bar line
  // at 4 s, and the cue there too, not at 3.6 s, where the opening piece still plays.
  const early = planFitMusic({ sections: SECTIONS.map((part) => (part.at === 64 ? { ...part, at: 63.6 } : part)), seconds: 120, bar: 2, downbeat: 0, payoff: 20, end: 30 });
  assert.equal(early.pieces[1].at + early.pieces[1].fadeIn, 4, JSON.stringify(early.pieces));
  assert.deepEqual(early.sections.filter((part) => part.kind === "break").map((part) => part.at), [4], JSON.stringify(early.sections));
});

test("planFitMusic: a song cut off before its end fades out over at least a bar, ending on a bar line", () => {
  const plan = planFitMusic({ sections: SECTIONS.slice(0, 3), seconds: 60, whole: false, bar: 2, downbeat: 0, payoff: 12, end: 25 });
  const last = plan.pieces.at(-1);
  assert.equal(plan.ending, null);
  assert.ok(last.fadeOut >= 2, `fade ${last.fadeOut}`);
  assert.ok(onBar(last.at + last.to - last.from - 12 + 32), "the fade ends on a bar line");
  assert.throws(() => planFitMusic({ sections: [{ at: 0, kind: "intro" }], seconds: 60, bar: 2, payoff: 10, end: 20 }), /no drop/);
});

test("fit_music cuts the music layer into pieces with crossfades and writes the sections and seams as cues at their heard times, with weights", () => {
  // The drop is heard 20 ms after its bar line: the cut stays on the bar line, the cue on the sound.
  const HEARD = SECTIONS.map((part) => (part.at === 80 ? { ...part, at: 80.02, weight: 0.8 } : part));
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: 30, volume: 0.8 });
  const document = createDocument({ scenes: [createScene({ id: "s1", duration: 30, layers: [music] })], cues: [{ name: "song-drop-9", time: 3, kind: "marker" }, { name: "hit", time: 4, kind: "marker" }] });
  const beats = Array.from({ length: 240 }, (_, index) => index * 0.5);
  const op = { type: "fit_music", sceneId: "s1", layerId: "music", payoff: 20, end: 30, shape: { sections: HEARD, seconds: 120, whole: true, seams: [{ at: 78.012, kind: "dropout", weight: 0.9 }, { at: 78.5, kind: "return", weight: 0.7 }] }, analysis: { bpm: 120, period: 0.5, beats, duration: 120 } };
  const reports = new Map();
  const next = applyOperations(document, [op], { reports });
  const report = [...reports.values()][0];
  const layers = next.scenes[0].layers;
  assert.equal(report.pieces, layers.length);
  assert.ok(layers.length >= 2 && layers[0].name === "music" && layers[1].name === "music-2" && layers[1].fitMusic === "music");
  assert.ok(report.sections.includes("20.02 s drop, weight 0.8 (payoff)") && report.sections.includes("18.012 s dropout, weight 0.9") && report.sections.at(-1) === "30 s ending", report.sections.join("; "));
  // Crossfades: each later piece fades in, each earlier one fades out, at the piece's volume.
  assert.ok(layers.slice(1).every((layer) => layer.animations.some((animation) => animation.name === "Fit in" && animation.to.volume === 0.8)));
  assert.ok(layers.slice(0, -1).every((layer) => layer.animations.some((animation) => animation.name === "Fit out")));
  // The measured sections are marked fitted (impact-accent answers only these); a hand cue is not.
  assert.ok(next.cues.some((cue) => cue.name === "song-drop-1" && cue.time === 20.02 && cue.fitted === true) && next.cues.some((cue) => cue.name === "song-return-1" && cue.time === 18.5) && next.cues.some((cue) => cue.name === "hit" && cue.fitted === undefined));
  assert.ok(!next.cues.some((cue) => cue.name === "song-drop-9"), "an earlier fit's cues are replaced");
  // Again on the result: the same pieces, not pieces of pieces.
  const again = applyOperations(next, [{ ...op, layerId: "music" }]);
  assert.equal(again.scenes[0].layers.length, layers.length);
  // duck_audio on the song ducks every piece, and the crossfade at 4 s (under the voice) stays ducked.
  const voice = createLayer("audio", { id: "voice", name: "voice", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556667.mp3", mediaStart: 3, mediaDuration: 2 });
  next.scenes[0].layers.push(voice);
  const ducked = applyOperations(next, [{ type: "duck_audio", sceneId: "s1", layerId: "music", under: ["voice"], to: 0.25 }]).scenes[0].layers;
  const fade = (layer, name) => layer.animations.find((animation) => animation.name === name);
  assert.ok(ducked.filter((layer) => layer.id !== "voice").every((layer) => fade(layer, "Duck down")));
  assert.equal(fade(ducked[0], "Fit out").from.volume, 0.25);
  assert.equal(fade(ducked[1], "Fit in").to.volume, 0.25);
  assert.equal(fade(ducked[1], "Fit out").from.volume, 0.8, "a crossfade outside the dip fades from full volume");
});
