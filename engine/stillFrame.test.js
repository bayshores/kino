import test from "node:test";
import assert from "node:assert/strict";

import {
  assertBatchStillTime,
  assertStillFrameTime,
  isStillFormat,
  longestSceneDuration,
  stillFrameTime,
  stillOptionsForScene,
  thumbnailFrame,
} from "./stillFrame.js";

test("a still time is clamped into the scene", () => {
  assert.equal(stillFrameTime(1.5, 2), 1.5);
  assert.equal(stillFrameTime(3, 2), 2);
  assert.equal(stillFrameTime(-1, 2), 0);
  assert.equal(stillFrameTime(Number.NaN, 2), 0);
  assert.equal(stillFrameTime("1", 2), 0);
  assert.equal(longestSceneDuration([{ duration: 2 }, { duration: 5 }, { duration: 1 }]), 5);
  assert.equal(longestSceneDuration([]), 0);
});

test("a batch thumbnail shows the frame its still PNG saves", () => {
  assert.deepEqual(thumbnailFrame({ format: "png", time: 1.5 }), { time: 1.5 });
  assert.deepEqual(thumbnailFrame({ format: "png" }), { time: 0 });
  assert.deepEqual(thumbnailFrame({ format: "png", time: 0, design: true }), { time: 0, design: true });
  assert.deepEqual(thumbnailFrame({ format: "png", time: 1, design: false }), { time: 1 });
  assert.deepEqual(thumbnailFrame({ format: "mp4", time: 1.5 }), { time: 0 }, "animated formats show their first frame");
  assert.deepEqual(thumbnailFrame({ format: "jpeg", time: 1.5, design: true }), { time: 1.5, design: true }, "a JPEG still does too");
  assert.ok(isStillFormat("png") && isStillFormat("jpeg") && !isStillFormat("gif"));
});

test("a batch still clamps its shared time to each scene", () => {
  const options = { format: "png", time: 1.5 };
  assert.equal(stillOptionsForScene(options, { duration: 2 }).time, 1.5);
  assert.equal(stillOptionsForScene(options, { duration: 1 }).time, 1, "a shorter scene uses its last frame");
  assert.equal(stillOptionsForScene({ format: "png", time: 1.5, duration: 1.2 }, { duration: 2 }).time, 1.2,
    "an explicit export duration limits the time");
  assert.deepEqual(stillOptionsForScene({ format: "gif", time: 1.5 }, { duration: 1 }), { format: "gif", time: 1.5 },
    "animated formats ignore the still time");
  assert.equal(stillOptionsForScene({ format: "png" }, { duration: 1 }).time, undefined);
  assert.equal(stillOptionsForScene({ format: "jpeg", time: 1.5 }, { duration: 1 }).time, 1, "a JPEG still clamps too");
});

test("still times outside the scenes are rejected", () => {
  assert.doesNotThrow(() => assertStillFrameTime(0, 2));
  assert.doesNotThrow(() => assertStillFrameTime(2, 2));
  for (const time of [-0.01, 2.01, Number.NaN, Number.POSITIVE_INFINITY, "1", null])
    assert.throws(() => assertStillFrameTime(time, 2), /still image time/);
  const scenes = [{ duration: 2 }, { duration: 1 }];
  assert.doesNotThrow(() => assertBatchStillTime({ format: "png", time: 1.5 }, scenes));
  assert.throws(() => assertBatchStillTime({ format: "png", time: 3 }, scenes), /between 0 and 2 seconds/);
  assert.doesNotThrow(() => assertBatchStillTime({ format: "gif", time: 3 }, scenes));
});
