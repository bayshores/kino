import test from "node:test";
import assert from "node:assert/strict";
import { renderRange, rangeCaptions, fastPreviewOptions } from "./render-range.mjs";
import { plannedFrameCount, sceneOptions } from "./export-batches.mjs";

const scene = { width: 1920, height: 1080, duration: 10 };
const draft = { renderQuality: "draft", format: "mp4", fps: 15 };

test("draft excerpts snap outward and budget only their frames without changing the scene", () => {
  const range = renderRange(scene, { ...draft, from: 3.01, to: 3.19 });
  assert.deepEqual(range, { first: 45, count: 3, from: 3, to: 3.2, duration: 0.2 });
  assert.equal(plannedFrameCount(scene, { ...draft, from: 3.01, to: 3.19 }), 3);
  assert.equal(plannedFrameCount(scene, draft), 150);
  const fractional = renderRange(scene, { ...draft, fps: 29.97, from: 9.99, to: 10 });
  assert.equal(fractional.count, 1);
  assert.equal(scene.duration, 10);
});

test("incomplete, unsafe and non-video ranges are rejected rather than exporting the full scene", () => {
  for (const overrides of [{ from: 2 }, { to: 3 }, { from: NaN, to: 3 }, { from: 1, to: Infinity },
    { from: -1, to: 2 }, { from: 2, to: 2 }, { from: 3, to: 2 }, { from: 0, to: 11 },
    { from: 0, to: 2, duration: 3 }, { from: 0, to: 2, format: "gif" },
    { from: 0, to: 2, renderQuality: "final" }, { from: 0, to: 2, playbackDirection: "reverse" }])
    assert.throws(() => renderRange(scene, { ...draft, ...overrides }));
  assert.equal(renderRange(scene, draft), null);
});

test("fast review bounds resolution and leaves ordinary draft and final settings intact", () => {
  const options = fastPreviewOptions({ preview: "fast" }, { draftWidth: 960 });
  assert.equal(options.draftWidth, 640);
  assert.equal(fastPreviewOptions({ preview: "fast", options: { draftWidth: 320 } }).draftWidth, 320);
  assert.throws(() => fastPreviewOptions({ preview: "fast", quality: "final" }));
  const quick = sceneOptions({ ...draft, ...options }, scene);
  assert.deepEqual([quick.width, quick.height, quick.fps, quick.motionBlur, quick.dither], [640, 360, 15, 0, false]);
  const normal = sceneOptions({ renderQuality: "draft", format: "mp4" }, scene);
  assert.deepEqual([normal.width, normal.height, normal.fps], [960, 540, 30]);
  assert.equal(sceneOptions({ renderQuality: "final", format: "mp4" }, scene).width, 1920);
});

test("caption sidecars clip and rebase to the excerpt clock", () => {
  const events = [{ start: 1, end: 2, text: "before" }, { start: 2, end: 4, text: "across" }, { start: 4, end: 6, text: "after" }];
  assert.deepEqual(rangeCaptions(events, renderRange(scene, { ...draft, from: 3, to: 5 })),
    [{ start: 0, end: 1, text: "across" }, { start: 1, end: 2, text: "after" }]);
  assert.equal(rangeCaptions(events, null), events);
});
