// Footage cues (footageCues.js): a cue pinned to a clip's file follows the clip on every parse.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { footageCueTime } from "./footageCues.js";

// A 10 s scene with a clip that starts at 2 s and reads its file from 3 s; one cue at 7 s of the file.
function project(clip = {}, cues = [{ name: "goal", time: 0, kind: "marker", layer: "clip", media: 7 }]) {
  const layer = createLayer("video", { id: "clip", src: "/api/media/clip.mp4", mediaStart: 2, mediaOffset: 3, mediaSourceDuration: 20, ...clip });
  return createDocument({ scenes: [createScene({ id: "s1", duration: 10, layers: [layer] })], cues });
}
const read = (document) => parseDocument(JSON.parse(JSON.stringify(document)));
const cue = (document, name = "goal") => document.cues.find((entry) => entry.name === name);

test("a footage cue sits where the clip plays that moment of its file", () => {
  const saved = read(project());
  assert.deepEqual(cue(saved), { name: "goal", time: 6, kind: "marker", layer: "clip", media: 7 });
});

test("trimming 1 s off the clip head moves the cue 1 s earlier; moving the clip moves it too", () => {
  const document = read(project());
  const trimmed = read(applyOperations(document, [{ type: "update_layer", sceneId: "s1", layerId: "clip", properties: { mediaOffset: 4 } }]));
  assert.equal(cue(trimmed).time, 5);
  const moved = read(applyOperations(document, [{ type: "update_layer", sceneId: "s1", layerId: "clip", properties: { mediaStart: 3.5 } }]));
  assert.equal(cue(moved).time, 7.5);
});

test("speed 2 halves the offset from the clip start, and a reversed clip counts from its end", () => {
  assert.equal(cue(read(project({ mediaSpeed: 2 }))).time, 4);
  // Reversed, 4 s of Play over file 3..7 s: file 7 s shows first.
  assert.equal(cue(read(project({ mediaReverse: true, mediaDuration: 4 }))).time, 2);
});

test("plain cues parse exactly as before", () => {
  const plain = [{ name: "drop", time: 4.2, kind: "marker" }, { name: "beat-1", time: 1, kind: "beat" }];
  const saved = read(project({}, plain));
  assert.deepEqual(saved.cues, [{ name: "beat-1", time: 1, kind: "beat" }, { name: "drop", time: 4.2, kind: "marker" }]);
});

test("a speed-ramped clip is refused; one ramped later keeps its last time; a deleted clip leaves a plain cue", () => {
  const ramp = { animations: [{ id: "ramp", name: "Speed", kind: "custom", start: 2, duration: 1, easing: "linear", from: { speed: 1 }, to: { speed: 0.25 } }] };
  const ramped = read(project(ramp, []));
  assert.throws(() => footageCueTime(ramped, "clip", 7), /Speed animation/);
  assert.throws(() => applyOperations(ramped, [{ type: "set_cues", cues: [{ name: "goal", layer: "clip", media: 7 }] }]), /Speed animation/);
  assert.equal(cue(read(project(ramp, [{ name: "goal", time: 6, kind: "marker", layer: "clip", media: 7 }]))).time, 6);
  const gone = read(applyOperations(read(project()), [{ type: "delete_layer", sceneId: "s1", layerId: "clip" }]));
  assert.deepEqual(cue(gone), { name: "goal", time: 6, kind: "marker" });
});

test("set_cues pins a cue to footage, and a non-clip layer is refused", () => {
  const document = applyOperations(read(project({}, [])), [{ type: "set_cues", cues: [{ name: "hit", layer: "clip", media: 5 }] }]);
  assert.deepEqual(cue(read(document), "hit"), { name: "hit", time: 4, kind: "marker", layer: "clip", media: 5 });
  const withBox = createDocument({ scenes: [createScene({ id: "s1", duration: 5, layers: [createLayer("rectangle", { id: "box" })] })] });
  assert.throws(() => footageCueTime(withBox, "box", 1), /needs a video or audio layer/);
});
