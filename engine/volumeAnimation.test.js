// Volume animations: video and audio layers animate their volume (0 to 4, 1 as recorded) like any other
// property; other layers, which have no sound, refuse it with a plain reason.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { animatesVolume, evaluateLayer, volumeAt } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { peakTrims } from "./peakTrim.js";

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

test("a limiter place turns the layers playing there down by its factor: a long clip over the span only, a short hit whole", () => {
  // The voice fades in across the place: a fixed level would flatten it, so it is left alone.
  const document = addVolume(documentWith(
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 0.8, mediaSourceDuration: 4 }),
    createLayer("audio", { id: "hit", name: "hit", src: "/api/media/b.wav", volume: 1, mediaStart: 2, mediaSourceDuration: 0.2 }),
    createLayer("audio", { id: "voice", name: "voice", src: "/api/media/c.wav", volume: 1, mediaSourceDuration: 4 })),
  "voice", { kind: "custom", start: 1.9, duration: 0.5, easing: "linear", from: { volume: 0 }, to: { volume: 1 } });
  const scene = document.scenes[0];
  const playing = ["song", "hit", "voice"].map((layerId) => ({ layerId, name: layerId }));
  const trim = peakTrims(scene, [{ at: 2, from: 2, to: 2.2, overDb: 4.6, factor: 0.58, playing }]);
  const after = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest })));
  const [song, hit, voice] = after.scenes[0].layers;
  assert.equal(hit.volume, 0.58);
  assert.equal(volumeAt(song, 1.9), 0.8, "before the ramp");
  assert.equal(volumeAt(song, 2.1), 0.464, "inside the span: 0.8 x 0.58");
  assert.equal(volumeAt(song, 3), 0.8, "after the ramp up");
  assert.deepEqual(song.animations.map((animation) => [animation.name, animation.start, animation.duration]), [["Peak down", 1.95, 0.05], ["Peak up", 2.2, 0.05]]);
  assert.equal(voice.animations.length, 1);
  assert.match(trim.dropped[0], /^mix 2 s voice: its volume moves there/);
  assert.deepEqual(trim.fixed, ["mix 2 s (2-2.2 s, 4.6 dB over) x0.58: song 0.8->0.464, hit 0.58"]);
});

test("a song whose limiter dips would churn its level keeps it; the hit at a place still comes down", () => {
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 10, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 10 }),
    createLayer("audio", { id: "step", name: "step", src: "/api/media/b.wav", volume: 1, mediaStart: 4, mediaSourceDuration: 0.2 })] })] });
  const place = (at, factor, ids) => ({ at, from: at, to: at + 0.2, overDb: 3, factor, playing: ids.map((layerId) => ({ layerId, name: layerId })) });
  const trim = peakTrims(document.scenes[0], [place(2, 0.7, ["song"]), place(4, 0.58, ["song", "step"]), place(6, 0.7, ["song"])]);
  assert.deepEqual(trim.ops.map((op) => [op.op, op.layerId]), [["update_layer", "step"]]);
  assert.deepEqual(trim.fixed, ["mix 4 s (4-4.2 s, 3 dB over) x0.58: step 0.58"]);
  assert.match(trim.dropped[0], /^mix 2 s x0\.7, 4 s x0\.58, 6 s x0\.7 song: 3 dips would turn its level 5 times in 4 s \(volume_churn\), so it keeps its level$/);
  // One dip turns it twice: no churn, so it is applied.
  assert.equal(peakTrims(document.scenes[0], [place(2, 0.7, ["song"])]).ops.length, 2);
});
