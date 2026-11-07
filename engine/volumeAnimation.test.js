// Volume animations: video and audio layers animate their volume (0 to 4, 1 as recorded) like any other
// property; other layers, which have no sound, refuse it with a plain reason.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { animatesVolume, evaluateLayer, volumeAt } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";

const fade = (from, to, extra = {}) => ({ kind: "custom", start: 1, duration: 1, easing: "linear", from: { volume: from }, to: { volume: to }, ...extra });

function documentWith(...layers) {
  return parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 4, layers })] });
}

const addVolume = (document, layerId, animation) =>
  applyOperations(document, [{ type: "add_animation", sceneId: "s", layerId, animation }]);

test("audio and video layers take a Volume animation from 0.6 to 0.2", () => {
  for (const type of ["audio", "video"]) {
    const document = addVolume(documentWith(createLayer(type, { id: "sound", src: "/api/media/a.wav", volume: 0.8 })), "sound", fade(0.6, 0.2));
    const layer = document.scenes[0].layers[0];
    assert.deepEqual(layer.animations[0].from, { volume: 0.6 });
    assert.deepEqual(layer.animations[0].to, { volume: 0.2 });
    assert.equal(animatesVolume(layer), true);
    // Before the animation the layer's own volume; then a straight line from 0.6 to 0.2; then it holds 0.2.
    assert.equal(volumeAt(layer, 0.5), 0.8);
    assert.equal(volumeAt(layer, 1), 0.6);
    assert.ok(Math.abs(volumeAt(layer, 1.5) - 0.4) < 1e-9);
    assert.equal(volumeAt(layer, 3), 0.2);
    // volumeAt gives what the full evaluator gives.
    for (const time of [0, 1.25, 1.75, 4]) assert.equal(volumeAt(layer, time), evaluateLayer(layer, time).volume);
  }
});

test("update_layer volume carries the new level into fades that go to or from the old one", () => {
  const document = documentWith(createLayer("audio", { id: "bed", src: "/api/media/a.wav", volume: 0.5, animations: [
    { ...fade(0, 0.5), id: "in", name: "Fade in" }, { ...fade(0.5, 0.2), id: "dip", name: "Duck down", start: 2 }] }));
  const reports = new Map();
  const operation = { type: "update_layer", sceneId: "s", layerId: "bed", properties: { volume: 0.15 } };
  const layer = applyOperations(document, [operation], { reports }).scenes[0].layers[0];
  assert.deepEqual(layer.animations.map((animation) => [animation.from.volume, animation.to.volume]), [[0, 0.15], [0.15, 0.06]]);
  assert.deepEqual(reports.get(operation).presetsMoved.map((entry) => entry.what), ["volume", "volume"]);
  // Fades that never touch the old volume are the agent's own levels: left alone.
  const own = documentWith(createLayer("audio", { id: "bed", src: "/api/media/a.wav", volume: 0.5, animations: [{ ...fade(0.9, 0.3), id: "x", name: "Fade" }] }));
  assert.deepEqual(applyOperations(own, [operation]).scenes[0].layers[0].animations[0].to, { volume: 0.3 });
});

test("a fade in holds its From before it starts, and a turned-off Volume animation does nothing", () => {
  let document = addVolume(documentWith(createLayer("audio", { id: "music", src: "/api/media/a.wav" })), "music",
    { kind: "in", id: "fade-in", start: 0.5, duration: 1, easing: "linear", from: { volume: 0 }, to: { volume: 1 } });
  let layer = document.scenes[0].layers[0];
  assert.equal(volumeAt(layer, 0), 0);
  // A linear fade from or to silence is equal power (SoundCraft's FadeShape): sin(t pi/2) in, cos out,
  // so a crossfade's two halves keep their summed power, where a straight line dips 3 dB.
  assert.ok(Math.abs(volumeAt(layer, 1) - Math.SQRT1_2) < 1e-9);
  const out = { ...layer, animations: [{ ...layer.animations[0], kind: "custom", from: { volume: 1 }, to: { volume: 0 } }] };
  for (const time of [0.6, 0.8, 1, 1.3]) assert.ok(Math.abs(volumeAt(layer, time) ** 2 + volumeAt(out, time) ** 2 - 1) < 1e-9, `power at ${time} s`);
  assert.equal(volumeAt(layer, 2), 1);
  document = applyOperations(document, [{ type: "update_animation", sceneId: "s", layerId: "music", animationId: "fade-in", properties: { enabled: false } }]);
  layer = document.scenes[0].layers[0];
  assert.equal(animatesVolume(layer), false);
  assert.equal(volumeAt(layer, 0), 1);
  const plain = addVolume(documentWith(createLayer("audio", { id: "music", src: "/api/media/a.wav" })), "music",
    { kind: "in", start: 0, duration: 1, from: { volume: 0 }, to: { volume: 1 } });
  assert.equal(plain.scenes[0].layers[0].animations[0].easing, "smooth", "a fade in without an easing stays smooth, not the expo-out of visual entrances");
});

test("layers without sound refuse a Volume animation, and a volume outside 0 to 4 is refused", () => {
  const document = documentWith(
    createLayer("audio", { id: "music", src: "/api/media/a.wav" }),
    createLayer("rectangle", { id: "box" }),
    createLayer("text", { id: "title", text: "Hi" }),
  );
  for (const layerId of ["box", "title"])
    assert.throws(() => addVolume(document, layerId, fade(0, 1)), /a Volume animation needs a video or audio layer; a (rectangle|text) layer has no sound/);
  // Up to 4 (+12 dB) raises a quiet recording without a louder copy of its file.
  const raised = addVolume(document, "music", fade(1, 2.5)).scenes[0].layers[0];
  assert.equal(volumeAt(raised, 3), 2.5);
  assert.equal(documentWith(createLayer("audio", { id: "loud", src: "/api/media/a.wav", volume: 4 })).scenes[0].layers[0].volume, 4);
  assert.throws(() => addVolume(document, "music", fade(0, 4.5)), /to\.volume: must be a finite number from 0 to 4/);
  assert.throws(() => addVolume(document, "music", fade(-0.1, 1)), /from\.volume: must be a finite number from 0 to 4/);
  assert.equal(isAnimationCompatible({ type: "rectangle" }, fade(0, 1)), false);
  assert.equal(isAnimationCompatible({ type: "video" }, fade(0, 1)), true);
});
