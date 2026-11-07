// compose {footage}: the small pure parts (engine/footage/): beat math, cuts at word edges, the
// opening moment, the layout choice and music-led pacing. One test per behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { barAtOrAfter, beatGrid, editBeats, speechSpan } from "./footage/cuts.js";
import { markedSubject, openingMoment } from "./footage/moments.js";
import { shotLayout } from "./footage/layout.js";
import { accentTimes, phrasePlan } from "./footage/pace.js";
import { planEdit } from "./footage/plan.js";
import { footageOps } from "./footage/ops.js";

const round3 = (value) => Math.round(value * 1000) / 1000;

const words = [
  { text: "hello", start: 1, end: 1.4 },
  { text: "there", start: 1.5, end: 1.9 },
  { text: "friend", start: 3, end: 3.5 },
];

test("beat grid: period, downbeat and edit-time beats", () => {
  const beats = Array.from({ length: 16 }, (_, index) => 0.25 + index * 0.5);
  // The loud low onsets fall on beats 1, 5, 9: the bar starts on beat 1.
  const onsets = [1, 5, 9].map((index) => ({ time: 0.25 + index * 0.5, low: 5 }));
  const grid = beatGrid({ beats, period: 0.5, onsets });
  assert.equal(grid.bpm, 120);
  assert.equal(grid.bar, 1);
  assert.equal(barAtOrAfter(grid, 1), 2.75);
  const edit = editBeats(grid, { offset: 2.75, start: 0 });
  assert.equal(edit.next(0.1), 0.5);
  assert.equal(edit.nearest(0.7), 0.5);
  assert.ok(edit.isDownbeat(edit.index(0)));
});

test("speech span pads into the silence, never into a neighbor word", () => {
  const span = speechSpan(words[0], words[1], words);
  assert.equal(span.in, 0.94);
  assert.equal(span.out, 2.06);
  const tight = speechSpan(words[1], words[1], words);
  assert.equal(tight.in, 1.45);
});

test("the opening is a face saying the hook, never a dark frame", () => {
  const moments = [
    { kind: "visual", hook: 90, score: 90, face: 0, dark: true },
    { kind: "visual", hook: 70, score: 70, face: 0.8 },
    { kind: "speech", hook: 60, score: 60, face: 0.5 },
  ];
  assert.equal(openingMoment(moments), moments[2]);
  assert.equal(openingMoment(moments.slice(0, 2)), moments[1]);
});

test("layout: same shape fills, a phone clip in 16:9 is a card, a screen goes over its camera shot", () => {
  const frame = { width: 1920, height: 1080 };
  assert.equal(shotLayout({ width: 1920, height: 1080 }, frame).kind, "fill");
  const card = shotLayout({ width: 1080, height: 1920 }, frame);
  assert.equal(card.kind, "blur-fill");
  assert.ok(card.main.height <= 1080 && card.main.x >= 0);
  const screen = shotLayout({ width: 1080, height: 2340, kind: "screen" }, frame, { partner: { clip: { width: 1920, height: 1080 }, focus: null } });
  assert.equal(screen.kind, "screen-over");
  // A portrait frame crops a 4:3 talking head around the face (it keeps 42% of the width).
  assert.equal(shotLayout({ width: 1440, height: 1080 }, { width: 1080, height: 1920 }, { focus: [0.5, 0.4] }).kind, "fill");
  // A 16:9 clip in 9:16 keeps 32% of its width: a card, unless a marked subject fits that crop,
  // which then sits in the middle of it.
  const wide = { width: 1920, height: 1080 };
  const tall = { width: 1080, height: 1920 };
  assert.equal(shotLayout(wide, tall, { focus: [0.8, 0.4] }).kind, "blur-fill");
  const subject = markedSubject({ subjects: [{ at: 2, box: [70, 20, 20, 50] }] }, 1.8, 3);
  assert.deepEqual(subject.box.map((value) => Math.round(value * 100)), [70, 20, 20, 50]);
  const cropped = shotLayout(wide, tall, { focus: subject.center, subject: subject.box });
  assert.equal(cropped.kind, "fill");
  assert.ok(Math.abs(cropped.main.x + 0.8 * cropped.main.width - 540) <= 1);
  assert.equal(markedSubject({ subjects: [{ at: 2, box: [70, 20, 20, 50] }] }, 3, 4), null);
  assert.equal(shotLayout(wide, tall, { focus: [0.5, 0.5], subject: [0.2, 0.2, 0.6, 0.6] }).kind, "blur-fill");
  // A portrait clip in 16:9 keeps 32% of its height: a tall marked subject does not fit, a card.
  assert.equal(shotLayout(tall, wide, { focus: [0.5, 0.5], subject: [0.3, 0.1, 0.4, 0.8] }).kind, "blur-fill");
});

// Music-led pacing (pace.js): six steady clips cut to a
// 105 BPM song.
const paced = (pace, duration) => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ t: index / 2, motion: 0.1, change: 0.05, bright: 0.5, faces: [] }));
  const clips = Array.from({ length: 6 }, (_, index) => ({ key: `c${index}`, name: `clip${index}`, src: `c${index}.mp4`, kind: "camera", width: 1920, height: 1080, duration: 20, in: 0, out: 20, words: [], samples, shots: [{ start: 0, end: 20 }] }));
  const period = 60 / 105;
  const analysis = { beats: Array.from({ length: 200 }, (_, index) => 0.3 + index * period), period, bpm: 105, onsets: [] };
  const plan = planEdit({ clips, music: { src: "m.mp3", duration: 120, analysis, loud: -14, curve: [] }, frame: { width: 1920, height: 1080 }, duration, treatment: "punchy", pace, seed: 3, title: "Hi" });
  return { plan, period, clips: new Map(clips.map((clip) => [clip.key, clip])) };
};

test("pace: runs of whole beats on the beat grid, a calm open and an ending twice as fast", () => {
  assert.deepEqual(phrasePlan("promo", 35), [{ from: 0, to: 16, beats: 4 }, { from: 16, to: 28, beats: 2 }, { from: 28, to: 35, beats: 1 }]);
  assert.deepEqual(phrasePlan("velocity", 10), [{ from: 0, to: 10, beats: 1 }]);
  const { plan, period } = paced("promo", 30);
  // Every cut within 1 frame (33 ms) of a beat of the song, never drifting.
  for (const shot of plan.shots.slice(1)) {
    const beats = (shot.start + plan.music.offset - 0.3) / period;
    assert.ok(Math.abs(beats - Math.round(beats)) * period < 1 / 30, `cut at ${shot.start} is off the beat`);
  }
  // The body after the title: 4 shots of 4 beats, 6 of 2, then 7 of 1.
  assert.deepEqual(plan.runs.slice(1).map((run) => `${run.count}x${run.beats}`), ["4x4", "6x2", "7x1"]);
});

test("accents: a zoom punch on every other downbeat in the open, every one in the ending, none under words", () => {
  const bars = [0, 2, 4, 6, 8, 10, 12, 14];
  assert.deepEqual(accentTimes(bars, { ending: 10, quiet: [{ start: 3.9, end: 4.2 }] }), [0, 8, 10, 12, 14]);
  const { plan, clips } = paced("promo", 30);
  const accented = plan.shots.filter((shot) => shot.accents);
  assert.ok(accented.length >= 3);
  const ops = footageOps(plan, clips);
  const layer = ops.find((op) => op.name === `shot-${accented[0].n}`);
  const punch = layer.animations.find((animation) => animation.name === "Accent");
  assert.equal(punch.start, round3(accented[0].accents[0] - 0.04));
  assert.ok(punch.to.scaleX > punch.from.scaleX);
});
