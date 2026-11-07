// Morph cut (morphCut.js, ported from ArtCraft flow.rs): the in-between frame of a moved square
// shows one square halfway, not two faded ones; the joins a scene asks for.
import test from "node:test";
import assert from "node:assert/strict";
import { interpolateFrame, morphDissolveScene, morphFlows, morphJoins, shotDifference, MORPH_SAME_SHOT } from "./morphCut.js";
import { evaluateLayer } from "./animation.js";
import { mediaFrameState } from "./playback.js";
import { createLayer, createScene } from "./model.js";
import { speechPieces } from "./speech.js";

// A gray frame with a white square of side 24 whose left edge is at x0 (ArtCraft's flow.rs test).
function square(x0, w = 128, h = 96) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const level = x >= x0 && x < x0 + 24 && y >= 36 && y < 60 ? 255 : 90;
      data.set([level, level, level, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

test("the in-between of a square moved 10 px shows it once, halfway", () => {
  const a = square(40), b = square(50);
  const flows = morphFlows(a, b);
  assert.ok(shotDifference(flows) < MORPH_SAME_SHOT, "one shot");
  const middle = interpolateFrame(a, b, 0.5, flows);
  const at = (x) => middle.data[(48 * 128 + x) * 4];
  // The square spans 45..68 halfway: its leading and trailing bands are solid or empty, not half.
  for (const [x, want] of [[42, 90], [46, 255], [57, 255], [67, 255], [71, 90]]) assert.ok(Math.abs(at(x) - want) < 30, `x ${x}: ${at(x)}, want ${want}`);
  assert.deepEqual(interpolateFrame(a, b, 0, flows).data, a.data);
});

test("morphJoins finds the speech piece that morphs in from the one before it", () => {
  const piece = (id, name, play) => createLayer("video", { id, name, src: "/api/media/talk.mp4", mediaSourceDuration: 9, ...play });
  const scene = createScene({ id: "s", duration: 4, layers: [
    piece("a", "talk", { mediaStart: 0, mediaOffset: 0, mediaDuration: 2 }),
    piece("b", "talk-2", { mediaStart: 2, mediaOffset: 3, mediaDuration: 2, morphIn: 0.4 }),
  ] });
  const [join, ...rest] = morphJoins(scene, speechPieces);
  assert.equal(rest.length, 0);
  assert.deepEqual([join.outgoing.id, join.incoming.id, join.start, join.end], ["a", "b", 1.8, 2.2]);
  // The preview's dissolve: both pieces show over 1.8-2.2 s, a holding its last frame and b its
  // first, b (on top) fading in; outside the window each is drawn as before.
  const dissolved = morphDissolveScene(scene, speechPieces);
  const at = (id, time) => { const state = evaluateLayer(dissolved.layers.find((item) => item.id === id), time); return [state.visible, Math.round(state.opacity * 100) / 100]; };
  assert.deepEqual([at("a", 1.7), at("b", 1.7)], [[true, 1], [false, 0]]);
  assert.deepEqual([at("a", 2.1), at("b", 2.1)], [[true, 1], [true, 0.75]]);
  assert.deepEqual([at("a", 2.3), at("b", 2.3)], [[false, 1], [true, 1]]);
  assert.equal(mediaFrameState(dissolved.layers[1], 1.9).sourceTime, 3, "b holds its first frame before its join");
  const plain = createScene({ id: "plain", layers: [] });
  assert.equal(morphDissolveScene(plain, speechPieces), plain);
});
