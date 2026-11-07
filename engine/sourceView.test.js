import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { boxesAt, cropOnSource, insideShare, subjectBox } from "./sourceView.js";

// A 16:9 file (384×216) in a 9:16 scene, filling its height: 3413 × 1920.
const source = { width: 384, height: 216 };
const footage = (overrides = {}) => createLayer("video", { id: "footage", name: "footage", src: "/api/media/a.mp4", x: -1167, y: 0, width: 3413, height: 1920, ...overrides });
const portrait = (layers) => createScene({ id: "s1", width: 1080, height: 1920, duration: 4.4, layers });
const round = (values) => values.map((value) => Math.round(value) || 0);

test("cropOnSource: a centered layer shows the middle third of a 16:9 frame", () => {
  const crop = cropOnSource(portrait([footage()]), footage(), 0.6, source);
  assert.deepEqual(round(crop.bounds), [34, 0, 66, 100]);
  assert.equal(crop.covers, 1);
  assert.deepEqual(round(crop.quad.flat()), [34, 0, 66, 0, 66, 100, 34, 100]);
});

test("cropOnSource: a moved layer moves the crop the other way", () => {
  const layer = footage({ x: -689 });
  assert.deepEqual(round(cropOnSource(portrait([layer]), layer, 0.6, source).bounds), [20, 0, 52, 100]);
});

test("cropOnSource: a scaled-down layer shows the whole frame and covers part of the scene", () => {
  // 1080 × 608 across the middle: the whole file, a 32% band of the scene.
  const layer = footage({ x: 0, y: 656, width: 1080, height: 607.5 });
  const crop = cropOnSource(portrait([layer]), layer, 0, source);
  assert.deepEqual(crop.bounds, [0, 0, 100, 100]);
  assert.ok(Math.abs(crop.covers - 607.5 / 1920) < 0.002, `covers ${crop.covers}`);
  assert.ok(crop.quad[0][1] < -100, "the scene's top corner is far above the file");
  // scaleX/scaleY count too, as the renderer draws them.
  const scaled = footage({ scaleX: 0.5, scaleY: 0.5 });
  assert.ok(cropOnSource(portrait([scaled]), scaled, 0, source).covers < 0.6);
});

test("cropOnSource: a box of another shape holds the picture centred, as contain draws it", () => {
  // A square box 1920 × 1920 holds the 16:9 picture 1920 × 1080, 420 px down.
  const layer = footage({ x: -420, y: 0, width: 1920, height: 1920 });
  const crop = cropOnSource(portrait([layer]), layer, 0, source);
  assert.deepEqual(round(crop.bounds), [22, 0, 78, 100]);
  assert.ok(crop.covers < 0.6 && crop.covers > 0.5, `covers ${crop.covers}`);
});

test("boxesAt keeps boxes within 0.02 s on the layer's own file; insideShare measures a box in the crop", () => {
  const layer = footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: [{ at: 0.6, box: [17, 25, 38, 63], by: "agent" }, { at: 1, box: [40, 10, 20, 80], by: "agent" }] } });
  assert.deepEqual(boxesAt(layer, 0.615).map((entry) => entry.at), [0.6]);
  assert.deepEqual(boxesAt(layer, 0.7), []);
  assert.deepEqual(boxesAt({ ...layer, src: "/api/media/b.mp4" }, 0.6), [], "boxes marked on another file are not used");
  assert.equal(Math.round(insideShare([17, 25, 38, 63], [34.19, 0, 65.84, 100]) * 100), 55);
  assert.equal(Math.round(insideShare([17, 25, 38, 63], [20.19, 0, 51.84, 100]) * 100), 83);
  assert.equal(insideShare([0, 0, 10, 10], [50, 0, 100, 100]), 0);
});

test("subjectBox rounds to 0.1% and pulls a box up to 0.05 over back to the edge", () => {
  assert.deepEqual(subjectBox([17.04, 25, 38, 63]), [17, 25, 38, 63]);
  assert.deepEqual(subjectBox([50, 50, 50.04, 10]), [50, 50, 50, 10]);
  for (const bad of [[50, 50, 51, 10], [-1, 0, 10, 10], [0, 0, 0, 10], [0, 0, 10], [0, 0, "10", 10], null, [0, 0, NaN, 10]])
    assert.equal(subjectBox(bad), null, JSON.stringify(bad));
});

test("model.js keeps good subject boxes sorted and refuses bad ones", () => {
  const documentWith = (layer) => createDocument({ id: "d", scenes: [portrait([layer])] });
  const kept = parseDocument(documentWith(footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: [{ at: 1.2346, box: [10, 10, 20, 20], by: "agent" }, { at: 0.5, box: [1, 2, 3, 4], by: "agent" }] } })));
  assert.deepEqual(kept.scenes[0].layers[0].subjectBoxes.boxes.map((entry) => entry.at), [0.5, 1.235]);
  assert.equal(parseDocument(documentWith(footage({ subjectBoxes: null }))).scenes[0].layers[0].subjectBoxes, undefined, "null removes the field");
  const refusals = [
    [createLayer("image", { id: "logo", name: "logo", subjectBoxes: { src: "x", boxes: [] } }), /only a video layer has subject boxes/],
    [footage({ subjectBoxes: { boxes: [] } }), /subjectBoxes\.src: must be the file/],
    [footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: [{ at: 0, box: [60, 0, 50, 10], by: "agent" }] } }), /boxes\[0\]\.box: must be \[x, y, w, h\]/],
    [footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: [{ at: -1, box: [0, 0, 5, 5], by: "agent" }] } }), /boxes\[0\]\.at: must be seconds/],
    [footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: [{ at: 0, box: [0, 0, 5, 5], by: "face" }] } }), /boxes\[0\]\.by: must be "agent"/],
    [footage({ subjectBoxes: { src: "/api/media/a.mp4", boxes: Array.from({ length: 601 }, (_, at) => ({ at, box: [0, 0, 5, 5], by: "agent" })) } }), /at most 600 boxes/],
  ];
  for (const [layer, message] of refusals) assert.throws(() => parseDocument(documentWith(layer)), message);
});
