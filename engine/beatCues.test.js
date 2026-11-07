// detect_beats turns an analysis into beat and onset cues on the scene clock (beatCues.js).
// The analysis itself is tested on real click tracks in server/audio-analysis.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";
import { moveBeatCues, sceneTimes } from "./beatCues.js";

const analysis = { bpm: 120, confidence: 0.95, beats: [0.5, 1, 1.5, 2, 2.5, 3], onsets: [{ time: 0.5, strength: 1 }, { time: 1.25, strength: 0.2 }, { time: 2, strength: 0.9 }] };

function project(layer = {}) {
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.mp3", mediaDuration: 10, ...layer });
  return createDocument({ scenes: [createScene({ id: "s1", duration: 4, layers: [music] })] });
}

function detect(document, op = {}) {
  const reports = new Map();
  const next = applyOperations(document, [{ type: "detect_beats", sceneId: "s1", layerId: "music", analysis, ...op }], { reports });
  return { document: next, report: [...reports.values()][0] };
}

test("beats and onsets become cues, and a steady beat sets the rhythm", () => {
  const { document, report } = detect(project());
  assert.deepEqual(report, { layer: "music", bpm: 120, confidence: 0.95, beats: 6, onsets: 3, firstBeat: 0.5, lastBeat: 3, rhythm: { bpm: 120, offset: 0.5 } });
  assert.deepEqual(document.rhythm, { bpm: 120, offset: 0.5 });
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.name), ["beat-1", "beat-2", "beat-3", "beat-4", "beat-5", "beat-6"]);
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "onset").map((cue) => cue.time), [0.5, 1.25, 2]);
});

test("cue times follow where the layer starts and which part of the file it plays", () => {
  const layer = { mediaStart: 1, mediaOffset: 0.5 };
  assert.deepEqual(sceneTimes(createLayer("audio", { src: "x", mediaDuration: 10, ...layer }), 4, [0.4, 0.5, 1, 3.5, 4]), [1, 1.5, 4]);
  const { document, report } = detect(project(layer));
  assert.equal(report.firstBeat, 1);
  assert.equal(report.lastBeat, 3.5);
  assert.deepEqual(document.rhythm, { bpm: 120, offset: 1 });
});

test("running it again replaces beat and onset cues but keeps other cues; onsets and rhythm can be left out", () => {
  let document = applyOperations(project(), [{ type: "set_cues", cues: [{ name: "drop", time: 2.2 }] }]);
  ({ document } = detect(document));
  ({ document } = detect(document, { onsets: false, rhythm: false }));
  assert.equal(document.cues.filter((cue) => cue.kind === "onset").length, 0);
  assert.equal(document.cues.filter((cue) => cue.kind === "beat").length, 6);
  assert.ok(document.cues.some((cue) => cue.name === "drop"));
});

test("an uncertain beat makes cues but does not set the rhythm", () => {
  const { document, report } = detect(project(), { analysis: { ...analysis, confidence: 0.3, note: "Beat grid uncertain" } });
  assert.equal(document.rhythm, undefined);
  assert.equal(report.rhythm, undefined);
  assert.equal(report.note, "Beat grid uncertain");
});

test("it refuses layers without sound and runs without an analysis", () => {
  const document = project();
  document.scenes[0].layers.push(createLayer("rectangle", { id: "box", name: "box" }));
  assert.throws(() => detect(document, { layerId: "box" }), /"box" is a rectangle layer/);
  assert.throws(() => detect(project(), { analysis: undefined }), /has not been analysed; send detect_beats through the agent service/);
  assert.throws(() => detect(project(), { onsets: "yes" }), /onsets must be true or false/);
});

test("running it again lists the animations whose beat or onset cue moved, and they keep their times", () => {
  const document = project();
  document.scenes[0].layers.push(createLayer("rectangle", { id: "box", name: "box" }));
  let next = detect(document).document;
  // On beat-3 (1.5 s), on beat-6 (3 s), on onset-2 (1.25 s), and on no cue (0.9 s).
  const starts = [1.5, 3, 1.25, 0.9];
  next = applyOperations(next, starts.map((start) => ({ type: "add_animation", sceneId: "s1", layerId: "box", preset: "color", start })));
  const box = (doc) => doc.scenes[0].layers.find((layer) => layer.id === "box");
  const [onBeat3, onBeat6] = box(next).animations.map((animation) => animation.id);
  // The new sound has no beat at 0.5 s, so every beat number moves down by one; its onsets are the same.
  const later = { ...analysis, beats: [1, 1.5, 2, 2.5, 3] };
  const { document: after, report } = detect(next, { analysis: later });
  assert.deepEqual(report.cuesMoved, [
    { animation: onBeat3, cue: "beat-3", at: 1.5, moved: 0.5, now: "beat-2" },
    { animation: onBeat6, cue: "beat-6", at: 3, gone: true, now: "beat-5" },
  ]);
  assert.deepEqual(box(after).animations.map((animation) => animation.start), starts);
  assert.equal(detect(after, { analysis: later }).report.cuesMoved, undefined, "the same beats again: nothing moved");
});

test("an animation on a beat that shares its moment with an onset is listed when the beat moves and the onset stays", () => {
  const document = project();
  document.scenes[0].layers.push(createLayer("rectangle", { id: "box", name: "box" }));
  let next = detect(document).document;
  // beat-4 and onset-3 are both at 2 s.
  next = applyOperations(next, [{ type: "add_animation", sceneId: "s1", layerId: "box", preset: "color", start: 2 }]);
  const [onBeat4] = next.scenes[0].layers.find((layer) => layer.id === "box").animations.map((animation) => animation.id);
  // The beats renumber (no beat at 0.5 s): beat-4 is at 2.5 s, and beat-3 is at 2 s now.
  const renumbered = detect(next, { analysis: { ...analysis, beats: [1, 1.5, 2, 2.5, 3] } }).report;
  assert.deepEqual(renumbered.cuesMoved, [{ animation: onBeat4, cue: "beat-4", at: 2, moved: 0.5, now: "beat-3" }]);
  // The grid moves 20 ms later: the animation is off the beat, and only onset-3 is still at 2 s.
  const shifted = detect(next, { analysis: { ...analysis, beats: analysis.beats.map((time) => time + 0.02) } }).report;
  assert.deepEqual(shifted.cuesMoved, [{ animation: onBeat4, cue: "beat-4", at: 2, moved: 0.02, now: "onset-3" }]);
});

// retime moves a sound's Play start and the scene's end, then calls moveBeatCues; here the
// tests do the same by hand. `starts` holds each layer's mediaStart before the change.
function retimed(document, change) {
  const scene = document.scenes[0];
  const starts = new Map(scene.layers.map((layer) => [layer, layer.mediaStart]));
  const length = scene.duration;
  change(scene);
  return moveBeatCues(document, scene, starts, length);
}

test("when retime moves the sound, its beat and onset cues and the rhythm move by the same seconds", () => {
  let document = applyOperations(project({ mediaStart: 1, mediaDuration: 2.5 }), [{ type: "set_cues", cues: [{ name: "drop", time: 2.2 }] }]);
  ({ document } = detect(document));
  assert.deepEqual(document.rhythm, { bpm: 120, offset: 1.5 });
  const note = retimed(document, (scene) => { scene.layers[0].mediaStart = 1.6; scene.duration = 8; });
  assert.equal(note, 'retime: "music" moved +0.6 s, and its beat and onset cues and the rhythm with it');
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "beat").map((cue) => [cue.name, cue.time]), [["beat-1", 2.1], ["beat-2", 2.6], ["beat-3", 3.1], ["beat-4", 3.6], ["beat-5", 4.1]]);
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "onset").map((cue) => cue.time), [2.1, 2.85, 3.6]);
  assert.equal(document.cues.find((cue) => cue.name === "drop").time, 2.2, "a marker stays where it was put");
  assert.deepEqual(document.rhythm, { bpm: 120, offset: 2.1 });
  // The same as finding the beats again on the moved sound.
  const again = detect(structuredClone(document)).document;
  assert.deepEqual(again.cues, document.cues);
  assert.deepEqual(again.rhythm, document.rhythm);
});

test("when the cues could be from another sound too, retime leaves them and asks for detect_beats", () => {
  let { document } = detect(project({ mediaStart: 1, mediaDuration: 2.5 }));
  document.scenes[0].layers.push(createLayer("video", { id: "clip", name: "clip", src: "/api/media/0b8e3f8e-1111-4222-8333-444455557777.mp4", mediaDuration: 10 }));
  const before = structuredClone(document.cues);
  const note = retimed(document, (scene) => { scene.layers[0].mediaStart = 1.6; scene.duration = 8; });
  assert.equal(note, 'retime: "music" moved +0.6 s, but the beat and onset cues could be from any of "music", "clip", so they stayed: run detect_beats again on the sound they are from');
  assert.deepEqual(document.cues, before);
  assert.deepEqual(document.rhythm, { bpm: 120, offset: 1.5 });
});

test("a shorter scene drops the cues its sound no longer plays; a longer one asks for the beats in the new part", () => {
  let { document } = detect(project());
  assert.equal(document.cues.filter((cue) => cue.kind === "beat").length, 6);
  const shorter = retimed(document, (scene) => { scene.duration = 2.5; });
  assert.equal(shorter, 'retime: removed 1 beat/onset cue that "music" no longer plays');
  assert.deepEqual(document.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.time), [0.5, 1, 1.5, 2, 2.5]);

  ({ document } = detect(project()));
  const longer = retimed(document, (scene) => { scene.duration = 8; });
  assert.equal(longer, 'retime: "music" now plays more of its file: run detect_beats again for the beats there');
  assert.equal(document.cues.filter((cue) => cue.kind === "beat").length, 6);
  // A sound with no beat cues, or a retime that leaves every sound alone, changes nothing.
  assert.equal(retimed(project(), (scene) => { scene.duration = 8; }), null);
  ({ document } = detect(project()));
  assert.equal(retimed(document, () => {}), null);
});

// A sound with a speed (mediaTime.js) plays its file on a time map, so its beats land where
// that moment of the file plays on the scene.
const speedRamp = { id: "music.speed", kind: "custom", name: "Speed", start: 0, duration: 2, easing: "smooth", from: { speed: 1 }, to: { speed: 0.5 } };

test("beats of a sound with a speed land where the scene plays them, and the rhythm is the tempo heard", () => {
  const fast = detect(project({ mediaSpeed: 2 }));
  assert.deepEqual(fast.document.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.time), [0.25, 0.5, 0.75, 1, 1.25, 1.5]);
  assert.deepEqual(fast.document.cues.filter((cue) => cue.kind === "onset").map((cue) => cue.time), [0.25, 0.625, 1]);
  assert.deepEqual(fast.document.rhythm, { bpm: 240, offset: 0.25 });
  assert.equal(fast.report.bpm, 240);
  // Backwards, the file's last beat is heard first.
  const back = detect(project({ mediaReverse: true, mediaDuration: 4 }));
  assert.deepEqual(back.document.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.time), [1, 1.5, 2, 2.5, 3, 3.5]);
  // A Speed animation changes the tempo as it plays: cues, but no rhythm.
  const ramp = detect(project({ animations: [speedRamp] }));
  assert.equal(ramp.document.rhythm, undefined);
  assert.match(ramp.report.note, /has a Speed animation, so its tempo changes and no rhythm was set/);
  const beats = ramp.document.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.time);
  assert.ok(beats[0] > 0.5 && beats[0] < 0.55, "just slowing at the start: the first beat comes a little late");
  assert.ok(beats.at(-1) > 3, "slowed down: the later beats come later than in the file");
});

test("when retime stretches a Speed animation, the beat cues move to where the same moments of the file play", () => {
  const { document } = detect(project({ animations: [speedRamp] }));
  const found = document.cues.filter((cue) => cue.kind === "beat").length;
  const scene = document.scenes[0];
  const starts = new Map(scene.layers.map((layer) => [layer, layer.mediaStart]));
  const animations = new Map(scene.layers.map((layer) => [layer, layer.animations]));
  scene.layers[0].animations = [{ ...speedRamp, duration: 4 }];
  scene.duration = 8;
  const note = moveBeatCues(document, scene, starts, 4, animations);
  assert.equal(note, 'retime: "music" plays at a speed (mediaSpeed or a Speed animation), so its beat and onset cues moved to where the same moments of its file play now; "music" now plays more of its file: run detect_beats again for the beats there');
  // The same times as finding the beats again on the retimed sound, for the beats found before.
  const again = detect(structuredClone(document)).document;
  const times = (doc) => doc.cues.filter((cue) => cue.kind === "beat").map((cue) => cue.time);
  assert.deepEqual(times(document), times(again).slice(0, found));
  assert.ok(times(again).length > found);
});
