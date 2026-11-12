// Volume animations: video and audio layers animate their volume (0 to 4, 1 as recorded) like any other
// property; other layers, which have no sound, refuse it with a plain reason.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { animatesVolume, evaluateLayer, volumeAt } from "./animation.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { peakCauses, peakTrims } from "./peakTrim.js";
import { churnRun } from "./quality/rules/sound.js";

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
  // The voice fades in across the place: its dip follows the fade (its own volume times x0.58).
  const document = addVolume(documentWith(
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 0.8, mediaSourceDuration: 4 }),
    createLayer("audio", { id: "hit", name: "hit", src: "/api/media/b.wav", volume: 1, mediaStart: 2, mediaSourceDuration: 0.2 }),
    createLayer("audio", { id: "voice", name: "voice", src: "/api/media/c.wav", volume: 1, mediaSourceDuration: 4 })),
  "voice", { kind: "custom", start: 1.9, duration: 0.5, easing: "linear", from: { volume: 0 }, to: { volume: 1 } });
  const scene = document.scenes[0];
  const playing = ["song", "hit", "voice"].map((layerId) => ({ layerId, name: layerId }));
  const trim = peakTrims(scene, [{ at: 2, from: 2, to: 2.2, overDb: 4.6, factor: 0.58, playing }], { bed: (layer) => layer.id === "song" });
  const after = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest })));
  const [song, hit, voice] = after.scenes[0].layers;
  assert.equal(hit.volume, 0.58);
  assert.equal(volumeAt(song, 1.9), 0.8, "before the ramp");
  assert.equal(volumeAt(song, 2.1), 0.464, "inside the span: 0.8 x 0.58");
  assert.equal(volumeAt(song, 3), 0.8, "after the ramp up");
  assert.deepEqual(song.animations.map((animation) => [animation.name, animation.start, animation.duration]), [["Peak down", 1.95, 0.05], ["Peak up", 2.2, 0.05]]);
  const fadeAt = (time) => volumeAt(document.scenes[0].layers[2], time);
  for (const time of [2.05, 2.15]) assert.ok(Math.abs(volumeAt(voice, time) - 0.58 * fadeAt(time)) <= 0.003 + 0.03 * fadeAt(time), `voice follows its fade at ${time} s`);
  for (const time of [1.9, 2.5, 3]) assert.equal(volumeAt(voice, time), fadeAt(time), `voice as before at ${time} s`);
  assert.deepEqual(trim.dropped, []);
  assert.match(trim.fixed[0], /^mix 2 s \(2-2\.2 s, 4\.6 dB over\) x0\.58: song 0\.8->0\.464, hit 0\.58, voice x0\.58 0\.309->0\.179 following its moving volume \(\d+ pieces 1\.95-2\.4 s\)$/);
});

// .scratch dm3 run a: one place 1.5 dB over where keep_line's duck ramps the song took the whole song to x0.3.
test("a limiter place where the song's volume moves dips the song there only, following its duck ramp", () => {
  const ramp = (name, start, duration, from, to) => ({ id: `${name.replace(" ", "-")}-${String(start).replace(".", "_")}`, name, kind: "custom", easing: "smooth", start, duration, from: { volume: from }, to: { volume: to } });
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 14, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 0.8, mediaSourceDuration: 14,
      animations: [ramp("Duck down", 3.45, 0.15, 0.8, 0.401), ramp("Duck up", 13.2, 0.612, 0.401, 0.8)] }),
    createLayer("audio", { id: "line", name: "line", src: "/api/media/b.wav", volume: 1, voiceLevel: -20.8, mediaSourceDuration: 14,
      animations: [ramp("Line mute", 0, 0.001, 1, 0), ramp("Line up", 3.52, 0.08, 0, 1), ramp("Line down", 5, 0.12, 1, 0)] })] })] });
  const place = { at: 3.6, from: 3.5, to: 3.7, peakDbtp: 0, overDb: 1.5, factor: 0.84,
    playing: [{ layerId: "line", name: "line", peakDbfs: -2.5 }, { layerId: "song", name: "song", peakDbfs: -6 }] };
  const trim = peakTrims(document.scenes[0], [place], { bed: (layer) => layer.id === "song" });
  assert.ok(trim.ops.every((op) => op.op === "add_animation" && op.layerId === "song"), "no update_layer: nothing whole");
  const after = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest })));
  const [song, line] = after.scenes[0].layers;
  const before = document.scenes[0].layers[0];
  // Every second outside 3.45-3.75 s as it was, the drop's stretch included; inside, x0.36 of its own curve.
  for (const time of [1, 3.44, 3.76, 5, 8, 13.5]) assert.equal(volumeAt(song, time), volumeAt(before, time), `song at ${time} s`);
  for (const time of [3.52, 3.6, 3.68]) assert.ok(Math.abs(volumeAt(song, time) - 0.36 * volumeAt(before, time)) <= 0.003 + 0.03 * volumeAt(before, time), `song x0.36 at ${time} s`);
  assert.deepEqual(line.animations, document.scenes[0].layers[1].animations, "the kept line keeps its level");
  assert.match(trim.fixed[0], /^mix 3\.6 s \(3\.5-3\.7 s, 1\.5 dB over\): song x0\.36 0\.401->0\.14\d following its moving volume \(\d+ pieces 3\.45-3\.75 s\) \(alone -6 dBFS\); kept line at the level keep_line set/);
});

// .scratch dm3 run b: placed sounds at volume 2 made the peaks, and the whole song came down to x0.3.
test("placed sounds that make the peaks come down first; the song dips only where they cannot clear it alone", () => {
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 14, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 14 }),
    createLayer("audio", { id: "line", name: "line", src: "/api/media/b.wav", volume: 1, voiceLevel: -13.4, mediaSourceDuration: 14,
      animations: [{ id: "mute", name: "Line mute", kind: "custom", easing: "smooth", start: 0, duration: 0.001, from: { volume: 1 }, to: { volume: 0 } },
        { id: "up", name: "Line up", kind: "custom", easing: "smooth", start: 6.29, duration: 0.08, from: { volume: 0 }, to: { volume: 1 } }] }),
    createLayer("audio", { id: "step", name: "step", src: "/api/media/c.wav", volume: 2, mediaStart: 7, mediaSourceDuration: 0.3 }),
    createLayer("audio", { id: "impact", name: "impact", src: "/api/media/d.wav", volume: 2, mediaStart: 8.6, mediaSourceDuration: 0.4 })] })] });
  const place = (at, to, cause, causePeak, songPeak, peakDbtp, factor) => ({ at, from: at, to, peakDbtp, overDb: round1(peakDbtp + 1.5), factor,
    playing: [{ layerId: "song", name: "song", peakDbfs: songPeak }, { layerId: "line", name: "line", peakDbfs: -14 }, { layerId: cause, name: cause, peakDbfs: causePeak }] });
  const trim = peakTrims(document.scenes[0], [place(7, 7.3, "step", 1, -12, 2, 0.66), place(8.6, 9, "impact", 6, -6.5, 6.5, 0.4)], { bed: (layer) => layer.id === "song" });
  // The step clears its place alone; at the impact the song shares the cut, as a dip.
  assert.deepEqual(trim.ops.filter((op) => op.op === "update_layer").map((op) => [op.layerId, op.properties.volume]), [["step", 0.94], ["impact", 0.66]]);
  const after = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest })));
  const song = after.scenes[0].layers[0];
  for (const time of [1, 7.1, 8.5, 9.1, 12]) assert.equal(volumeAt(song, time), 1, `song at ${time} s`);
  assert.equal(round1(100 * volumeAt(song, 8.8)), 33);
  assert.deepEqual(trim.fixed, [
    "mix 7 s (7-7.3 s, 3.5 dB over): step x0.47 2->0.94 (alone 1 dBFS); kept song (alone -12 dBFS), line at the level keep_line set (line 6.37-14 s)",
    "mix 8.6 s (8.6-9 s, 8 dB over): impact x0.33 2->0.66 (alone 6 dBFS), song x0.33 1->0.33 (alone -6.5 dBFS); kept line at the level keep_line set (line 6.37-14 s)"]);
  // The song ducked to 0.376 and coming up at 8.5-9 s: two dips would turn it 3 times, so one dip follows
  // its duck up over both places; the song is as it was before 6.95 s and after 9.05 s, and does not churn.
  const ramp = (name, start, duration, from, to) => ({ id: name.replace(" ", "-"), name, kind: "custom", easing: "smooth", start, duration, from: { volume: from }, to: { volume: to } });
  const ducked = parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [{ ...document.scenes[0].layers[0],
    animations: [ramp("Duck down", 0.15, 0.15, 1, 0.376), ramp("Duck up", 8.5, 0.5, 0.376, 1)] }, ...document.scenes[0].layers.slice(1)] }] });
  const both = peakTrims(ducked.scenes[0], [place(7, 7.3, "step", 2, -9, 3, 0.5), place(8.6, 9, "impact", 7.5, -6, 8, 0.33)], { bed: (layer) => layer.id === "song" });
  assert.equal(both.ops.filter((op) => op.layerId === "song" && op.op === "update_layer").length, 0, "the song is not lowered whole");
  const scene = applyOperations(ducked, both.ops.map(({ op, ...rest }) => ({ type: op, ...rest }))).scenes[0];
  const before = ducked.scenes[0].layers[0];
  for (const time of [1, 6.9, 9.1, 12]) assert.equal(volumeAt(scene.layers[0], time), volumeAt(before, time), `ducked song at ${time} s`);
  assert.ok(Math.abs(volumeAt(scene.layers[0], 8.8) - 0.3 * volumeAt(before, 8.8)) <= 0.003 + 0.03 * volumeAt(before, 8.8));
  assert.equal(churnRun(scene.layers[0], scene), null);
  assert.match(both.fixed[0], /^mix song: 2 places in 1 dip, not whole: 2 dips would turn its level 3 times/);
  // A place on a fade out to silence at the scene's end: the dip follows the fade (its pieces to 0 play equal power).
  const ending = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 10, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 10, animations: [fade(1, 0, { id: "out", name: "Fade out", start: 8, duration: 2 })] })] })] });
  const end = peakTrims(ending.scenes[0], [{ at: 9.8, from: 9.8, to: 10, peakDbtp: 1.5, overDb: 3, factor: 0.7, playing: [{ layerId: "song", name: "song" }] }], { bed: () => true });
  assert.deepEqual(end.dropped, []);
  assert.match(end.fixed[0], /^mix 9\.8 s \(9\.8-10 s, 3 dB over\) x0\.7: song x0\.7 0\.156->0\.11 following its moving volume/);
});
const round1 = (value) => Math.round(10 * value) / 10;

test("a song comes down whole only when its limiter places cover most of its time; else dips that would churn become one dip", () => {
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 10, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 10,
      animations: [{ id: "in", name: "Fade in", kind: "custom", easing: "linear", start: 0, duration: 1, from: { volume: 0 }, to: { volume: 1 } }] }),
    createLayer("audio", { id: "step", name: "step", src: "/api/media/b.wav", volume: 1, mediaStart: 4, mediaSourceDuration: 0.2 })] })] });
  const place = (at, factor, ids, long = 0.2) => ({ at, from: at, to: at + long, peakDbtp: 1.5, overDb: 3, factor, playing: ids.map((layerId) => ({ layerId, name: layerId })) });
  // Three 0.2 s places in 10 s: three dips would churn its level, so they become one dip (1.95-6.25 s)
  // that holds the lower neighbor's level between places; before and after it the song is as it was.
  const short = peakTrims(document.scenes[0], [place(2, 0.7, ["song"]), place(4, 0.58, ["song", "step"]), place(6, 0.7, ["song"])]);
  assert.equal(short.ops.filter((op) => op.op === "update_layer" && op.layerId === "song").length, 0);
  assert.equal(short.fixed[0], "mix song: 3 places in 1 dip, not whole: 3 dips would turn its level 5 times in 4 s (volume_churn), so the nearest are one dip and its level does not churn; its places cover 9% of its heard time (whole past 50%)");
  const dipped = applyOperations(document, short.ops.map(({ op, ...rest }) => ({ type: op, ...rest }))).scenes[0];
  assert.equal(churnRun(dipped.layers[0], dipped), null);
  assert.deepEqual([1.5, 2.1, 3, 4.1, 5, 6.1, 8].map((time) => volumeAt(dipped.layers[0], time)), [1, 0.7, 0.7, 0.58, 0.7, 0.7, 1]);
  // Three 1.8 s places cover 57%: one constant gain.
  const trim = peakTrims(document.scenes[0], [place(2, 0.7, ["song"], 1.8), place(4, 0.58, ["song", "step"], 1.8), place(6, 0.7, ["song"], 1.8)]);
  assert.deepEqual(trim.ops, [{ op: "update_layer", sceneId: "s", layerId: "step", properties: { volume: 0.58 } }, { op: "update_layer", sceneId: "s", layerId: "song", properties: { volume: 0.58 } }]);
  assert.deepEqual(trim.dropped, []);
  assert.match(trim.fixed[0], /^mix song x0\.58 whole 1->0\.58: one constant gain, sized from the 4 s place \(the lowest factor of 3, \+1\.5 dBTP\); its places cover 57% of its heard time; place by place, 3 dips would turn its level \d+ times in [\d.]+ s \(volume_churn\)$/);
  assert.deepEqual(trim.trimmed.map((entry) => entry.layers.map((layer) => [layer.name, layer.factor, layer.whole ?? false])), [[["song", 0.58, true]], [["step", 0.58, false], ["song", 0.58, true]], [["song", 0.58, true]]]);
  // Applied, the fade in keeps its shape at the new level: a constant gain.
  const after = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest })));
  assert.deepEqual(after.scenes[0].layers[0].animations.map((animation) => [animation.from.volume, animation.to.volume]), [[0, 0.58]]);
  // One dip turns it twice: no churn, so it dips there.
  assert.equal(peakTrims(document.scenes[0], [place(2, 0.7, ["song"])]).ops.length, 2);
  // A song whose Volume animations never meet its volume cannot take one constant gain this way: named with its factor.
  const own = parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [{ ...document.scenes[0].layers[0], animations: [{ ...document.scenes[0].layers[0].animations[0], to: { volume: 0.8 } }] }, document.scenes[0].layers[1]] }] });
  assert.match(peakTrims(own.scenes[0], [place(2, 0.7, ["song"], 1.8), place(4, 0.58, ["song", "step"], 1.8), place(6, 0.7, ["song"], 1.8)]).dropped[0],/^mix 2 s x0\.7, 4 s x0\.58, 6 s x0\.7 song: 3 dips would turn .*do not start or end at its volume 1: lower it by hand x0\.58$/);
});

test("measured alone, the layer that makes a place's peak comes down by its own factor; the others keep their level", () => {
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 10, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 10 }),
    createLayer("audio", { id: "step", name: "step", src: "/api/media/b.wav", volume: 1, mediaStart: 9.6, mediaSourceDuration: 0.3 })] })] });
  // A footstep at 0 dBFS over a song at -8 dBFS: the mix +3.1 dBTP, x0.58 to reach the ceiling.
  const place = (stepPeak, songPeak) => ({ at: 9.6, from: 9.6, to: 9.8, peakDbtp: 3.1, overDb: 4.6, factor: 0.58,
    playing: [{ layerId: "song", name: "song", peakDbfs: songPeak }, { layerId: "step", name: "step", peakDbfs: stepPeak }] });
  // Its share of the measured peak: (ceiling 0.83 - song 0.4) / (mix 1.43 - song 0.4).
  assert.deepEqual([...peakCauses(place(0, -8))], [["step", 0.41]]);
  const trim = peakTrims(document.scenes[0], [place(0, -8)]);
  assert.deepEqual(trim.ops, [{ op: "update_layer", sceneId: "s", layerId: "step", properties: { volume: 0.41 } }]);
  assert.deepEqual(trim.fixed, ["mix 9.6 s (9.6-9.8 s, 4.6 dB over): step x0.41 1->0.41 (alone 0 dBFS); kept song (alone -8 dBFS)"]);
  assert.deepEqual(trim.trimmed, [{ at: 9.6, from: 9.6, to: 9.8, peakDbtp: 3.1, layers: [{ name: "step", factor: 0.41 }] }]);
  // Three layers: the rest without the step is measured (-2.5 dBFS), not the song and hit summed in
  // phase (+0.9 dBFS, which left no layer able to clear it: every layer x0.58). The step alone would
  // need x0.11, so the hit shares the cut over the song alone.
  const three = { ...place(0, -8), playing: [...place(0, -8).playing, { layerId: "hit", name: "hit", peakDbfs: -3 }], restDbfs: [-2.5] };
  assert.deepEqual([...peakCauses(three)], [["step", 0.41], ["hit", 0.41]]);
  // Both near the ceiling alone: no one layer can clear it, so both take the place's x0.58.
  assert.equal(peakCauses(place(-2, -2.5)), null);
  assert.deepEqual(peakTrims(document.scenes[0], [place(-2, -2.5)]).fixed, ["mix 9.6 s (9.6-9.8 s, 4.6 dB over) x0.58: song 1->0.58, step 0.58"]);
});

// .scratch friction wave 4 (dm2-a board-S1): fix:auto took a kept line from +4.9 to +2.3 LU over the song.
test("a limiter place keeps the level keep_line set for a kept line and takes the trim from the song", () => {
  const ramp = (name, start, duration, from, to) => ({ id: name.replace(" ", "-"), name, kind: "custom", easing: "smooth", start, duration, from: { volume: from }, to: { volume: to } });
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 10, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 1, mediaSourceDuration: 10 }),
    createLayer("audio", { id: "line", name: "line", src: "/api/media/b.wav", volume: 1, voiceLevel: -12, mediaSourceDuration: 10,
      animations: [ramp("Line mute", 0, 0.001, 1, 0), ramp("Line up", 1.92, 0.08, 0, 1), ramp("Line down", 3, 0.12, 1, 0)] })] })] });
  // The line alone at -3 dBFS, the song at -4, the mix +1.5 dBTP (x0.7 to the ceiling).
  const place = { at: 2.4, from: 2.4, to: 2.6, peakDbtp: 1.5, overDb: 3, factor: 0.7,
    playing: [{ layerId: "line", name: "line", peakDbfs: -3 }, { layerId: "song", name: "song", peakDbfs: -4 }] };
  // Measured alone, the line is the loudest: it was the one turned down (x0.36).
  assert.deepEqual([...peakCauses(place)], [["line", 0.36]]);
  // The song alone would need x0.25: even at x0.3 (as low as any cause goes) it does not clear the place, so
  // the song keeps its level, and the line's factor that clears it with the song as it is is printed.
  const trim = peakTrims(document.scenes[0], [place], { bed: (layer) => layer.id === "song" });
  assert.deepEqual([trim.ops, trim.fixed], [[], []]);
  assert.deepEqual(trim.dropped, ["mix 2.4 s: with line at the level keep_line set, song even at x0.3 would leave about 0.2 dB over for the limiter (each layer's peak alone, summed in phase), so it keeps its level; volume x0.28 on line there clears it"]);
  // A clip that is not a song still comes down to x0.3 there, and what stays over is printed with the line's factor.
  const clip = peakTrims(document.scenes[0], [place], { bed: () => false });
  assert.deepEqual(clip.fixed, ["mix 2.4 s (2.4-2.6 s, 3 dB over): song x0.3 1->0.3 (alone -4 dBFS); kept line at the level keep_line set (line 2-3 s)"]);
  assert.deepEqual(clip.dropped, ["mix 2.4 s: the others come down to x0.3 at most, so with line at the level keep_line set about 0.2 dB stays over for the limiter (each layer's peak alone, summed in phase); volume x0.97 on line clears it"]);
  // A song that can share the cut comes down only as far as its measured share: line -8, song -4 dBFS.
  const shared = { ...place, playing: [{ layerId: "line", name: "line", peakDbfs: -8 }, { layerId: "song", name: "song", peakDbfs: -4 }] };
  const sharedTrim = peakTrims(document.scenes[0], [shared]);
  assert.deepEqual([sharedTrim.fixed, sharedTrim.dropped],
    [["mix 2.4 s (2.4-2.6 s, 3 dB over): song x0.54 1->0.54 (alone -4 dBFS); kept line at the level keep_line set (line 2-3 s)"], []]);
});

// .scratch friction replay 7 (dm4-b rev 13): places a kept line held over the ceiling cut the song to
// x0.3 there, and that factor took the whole song from 0.8 to 0.24 (-9.5 to -12.6 LUFS) at 23% share.
test("places a kept line holds over the ceiling leave the song's level alone; the song dips only at the stomps", () => {
  const ramp = (id, name, start, duration, from, to) => ({ id, name, kind: "custom", easing: "smooth", start, duration, from: { volume: from }, to: { volume: to } });
  const line = (id, from, to) => createLayer("audio", { id, name: id, src: `/api/media/${id}.wav`, volume: 1, voiceLevel: -12, mediaSourceDuration: 15,
    animations: [ramp(`${id}-mute`, "Line mute", 0, 0.001, 1, 0), ramp(`${id}-up`, "Line up", from - 0.08, 0.08, 0, 1), ...(to < 15 ? [ramp(`${id}-down`, "Line down", to, 0.12, 1, 0)] : [])] });
  const document = parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration: 15, layers: [
    createLayer("audio", { id: "song", name: "song", src: "/api/media/a.wav", volume: 0.8, mediaSourceDuration: 15 }),
    line("lineA", 5.14, 7.69), line("lineB", 13.6, 15),
    createLayer("audio", { id: "stomp4", name: "stomp4", src: "/api/media/c.wav", volume: 0.8, mediaStart: 9.5, mediaSourceDuration: 0.6 }),
    createLayer("audio", { id: "stomp5", name: "stomp5", src: "/api/media/d.wav", volume: 0.9, mediaStart: 11.1, mediaSourceDuration: 0.6 })] })] });
  const place = (at, from, to, peakDbtp, factor, playing) => ({ at, from, to, peakDbtp, overDb: round1(peakDbtp + 1.5), factor,
    playing: Object.entries(playing).map(([layerId, peakDbfs]) => ({ layerId, name: layerId, peakDbfs })) });
  const trim = peakTrims(document.scenes[0], [place(6.4, 6.4, 6.5, -0.5, 0.89, { song: -14, lineA: -1 }),
    place(9.5, 9.5, 10.1, 3.5, 0.56, { song: -2.5, stomp4: -1 }), place(11.2, 11.1, 11.7, 4.5, 0.5, { song: -2.5, stomp5: 0 }),
    place(14.3, 13.5, 14.8, 8.5, 0.31, { song: -3, lineB: 8 })], { bed: (layer) => layer.id === "song" });
  assert.equal(trim.ops.filter((op) => op.layerId === "song" && op.op === "update_layer").length, 0, "the song is not lowered whole");
  const scene = applyOperations(document, trim.ops.map(({ op, ...rest }) => ({ type: op, ...rest }))).scenes[0];
  for (const time of [1, 6.45, 8, 13, 14.3]) assert.equal(volumeAt(scene.layers[0], time), 0.8, `song at ${time} s`);
  assert.ok(volumeAt(scene.layers[0], 9.8) < 0.5, "the song dips at the stomps");
  assert.equal(churnRun(scene.layers[0], scene), null);
  assert.deepEqual(trim.dropped.map((line) => line.split(":")[0]), ["mix 6.4 s", "mix 14.3 s"]);
  assert.match(trim.dropped[1], /^mix 14\.3 s: with lineB at the level keep_line set, song even at x0\.3 would leave about 9\.8 dB over .*so it keeps its level; volume x0\.04 on lineB there clears it$/);
  // Ducked under lineA, with two small places there too: even one dip over all four churns, and at 12% of
  // its time the song is not lowered whole: it dips where it can without churning and keeps its level at the rest.
  const ducked = parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [{ ...document.scenes[0].layers[0],
    animations: [ramp("dd", "Duck down", 5, 0.14, 0.8, 0.2), ramp("du", "Duck up", 7.69, 0.2, 0.2, 0.8)] }, ...document.scenes[0].layers.slice(1)] }] });
  const four = peakTrims(ducked.scenes[0], [place(5.6, 5.6, 5.7, -1.46, 0.99, { song: -14.4, lineA: -1.9 }), place(6.9, 6.9, 7, -1.4, 0.98, { song: -13.9, lineA: -1.9 }),
    place(9.5, 9.5, 10.1, 3.5, 0.56, { song: -2.5, stomp4: -1 }), place(11.2, 11.1, 11.7, 4.5, 0.5, { song: -2.5, stomp5: 0 })], { bed: (layer) => layer.id === "song" });
  assert.equal(four.ops.filter((op) => op.layerId === "song" && op.op === "update_layer").length, 0, "not whole");
  const fourScene = applyOperations(ducked, four.ops.map(({ op, ...rest }) => ({ type: op, ...rest }))).scenes[0];
  for (const time of [1, 8, 9.8, 11.4, 13]) assert.equal(volumeAt(fourScene.layers[0], time), 0.8, `ducked song at ${time} s`);
  assert.equal(churnRun(fourScene.layers[0], fourScene), null);
  assert.match(four.dropped.find((line) => line.startsWith("mix 9.5 s song")), /churn \(volume_churn\), and its places cover 12% of its heard time, so it keeps its level here \(not whole\): lower it x0\.56 there/);
});
