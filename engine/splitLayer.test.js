import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateLayer } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { mediaFrameState } from "./playback.js";
import { splitLayer } from "./splitLayer.js";

const anim = (id, start, duration, from, to) => ({ id, kind: "custom", name: id, start, duration, easing: "linear", from, to });

function clipDocument(extra = {}) {
  const clip = createLayer("video", {
    id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width: 160, height: 90,
    mediaStart: 1, mediaOffset: 2, mediaDuration: 4, mediaSourceDuration: 10, mediaFreeze: "both",
    animations: [
      anim("in", 1, 0.5, { opacity: 0 }, { opacity: 1 }), // before the cut
      anim("push", 2, 2, { scaleX: 1, scaleY: 1 }, { scaleX: 1.2, scaleY: 1.2 }), // crosses it
      anim("out", 4.5, 0.5, { opacity: 1 }, { opacity: 0 }), // after it
    ],
    ...extra,
  });
  return parseDocument(createDocument({ id: "split", name: "split", scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 6, layers: [clip] })] }));
}

test("split_layer cuts a clip in two that play and look the same as the whole clip", () => {
  const before = clipDocument();
  const whole = before.scenes[0].layers[0];
  const { document, copyId } = splitLayer(before, "main", "clip", { at: 3, copy: { id: "clip-2", name: "clip 2" } });
  const [first, second] = document.scenes[0].layers;
  assert.equal(copyId, "clip-2");
  assert.deepEqual([first.id, second.id, second.name], ["clip", "clip-2", "clip 2"], "the new piece lands right above");
  assert.deepEqual([first.mediaStart, first.mediaOffset, first.mediaDuration, first.mediaFreeze], [1, 2, 2, "first"]);
  assert.deepEqual([second.mediaStart, second.mediaOffset, second.mediaDuration, second.mediaFreeze], [3, 4, 2, "last"]);
  assert.deepEqual(first.animations.map((item) => item.name), ["in", "push"]);
  assert.deepEqual(second.animations.map((item) => item.name), ["push", "out"], "the crossing push is on both pieces");
  // At every moment exactly the piece that shows, shows the same file moment with the same values.
  for (const time of [0.5, 1.2, 2.5, 2.99, 3, 3.6, 4.7, 5.5]) {
    const piece = [first, second].find((layer) => mediaFrameState(layer, time).visible && (time < 3 ? layer === first : layer === second));
    assert.ok(piece, `a piece shows at ${time}`);
    assert.equal(mediaFrameState(piece, time).sourceTime, mediaFrameState(whole, time).sourceTime, `file time at ${time}`);
    const { opacity, scaleX } = evaluateLayer(piece, time);
    assert.deepEqual({ opacity, scaleX }, (({ opacity, scaleX }) => ({ opacity, scaleX }))(evaluateLayer(whole, time)), `values at ${time}`);
  }
  assert.equal(mediaFrameState(first, 3.5).visible, false, "the first piece is gone after the cut");
  assert.equal(mediaFrameState(second, 2.5).visible, false, "the new piece is hidden before it");
});

test("split_layer from/to skips the file between and refuses what it can't cut", () => {
  const { document } = splitLayer(clipDocument(), "main", "clip", { at: 2, to: 2.3, copy: { name: "clip 2" } });
  const [first, second] = document.scenes[0].layers;
  assert.deepEqual([first.mediaDuration, second.mediaStart, second.mediaOffset, second.mediaDuration], [1, 2, 3.3, 2.7], "plays on from 2.3 s worth of file, 0.3 s sooner done");
  assert.deepEqual(second.animations.map((item) => [item.name, item.start]), [["push", 2], ["out", 4.2]], "the fade-out after the skip moves 0.3 s earlier with the clip's end");
  assert.throws(() => splitLayer(clipDocument(), "main", "clip", { at: 5.5 }), /at must be a scene time inside “clip”'s Play, 1 to 5 s/);
  const still = parseDocument(createDocument({ id: "s", name: "s", scenes: [createScene({ id: "main", name: "Main", width: 320, height: 180, duration: 2,
    layers: [createLayer("image", { id: "pic", name: "pic", src: "/api/media/pic.png", width: 10, height: 10 })] })] }));
  assert.throws(() => splitLayer(still, "main", "pic", { at: 1 }), /is a still image layer/);
});
