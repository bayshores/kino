// The quality checker (agent/quality.mjs) keeps the models and findings of recent checks, so a
// check of an unchanged scene answers at once. A long scene's model is large (a ten-minute
// scene with captions is over 100 MB of samples), so what is kept is bounded by bytes too.
import assert from "node:assert/strict";
import test from "node:test";
import { defaultFonts } from "../engine/fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createFrameReuse } from "./agent/frame-reuse.mjs";
import { createQualityChecker } from "./agent/quality.mjs";
import { renderSceneFrames } from "./export.mjs";

function project(sceneId, words) {
  return parseDocument(createDocument({
    scenes: [createScene({
      id: sceneId, name: sceneId, width: 640, height: 360, duration: 2, background: "#101418",
      layers: [createLayer("text", { id: `${sceneId}-title`, name: "title", text: words, x: 60, y: 120, fontSize: 48, fill: "#F2F2F2", textResize: "width-height" })],
    })],
  }));
}

// A checker whose pixel rules render real frames, counting the renders and frames: a kept check
// renders none. `reuseFrames` off: every check that runs renders all its frames.
function countingChecker(cacheBytes, reuseFrames = false) {
  const counter = { renders: 0, frames: 0 };
  const checker = createQualityChecker({
    cacheBytes, reuseFrames,
    renderFrames: (scene, times, options) => { counter.renders += 1; counter.frames += times.length; return renderSceneFrames(scene, times, options); },
  });
  return { checker, counter };
}

const checkOf = (checker, document) => checker.check(document, { fonts: defaultFonts, pixels: true });

test("a check of an unchanged scene is kept, and past the byte budget the oldest is dropped", async () => {
  const first = project("one", "First words");
  const second = project("two", "Second words");

  const roomy = countingChecker(64 * 1024 * 1024);
  await checkOf(roomy.checker, first);
  const rendered = roomy.counter.renders;
  assert.ok(rendered > 0, "the pixel rules rendered frames");
  await checkOf(roomy.checker, second);
  await checkOf(roomy.checker, first);
  assert.equal(roomy.counter.renders, rendered * 2, "the first scene's check was kept");

  // A budget smaller than one model keeps only the newest check.
  const tight = countingChecker(1);
  await checkOf(tight.checker, first);
  await checkOf(tight.checker, first);
  assert.equal(tight.counter.renders, rendered, "the newest check is kept even over the budget");
  await checkOf(tight.checker, second);
  await checkOf(tight.checker, first);
  assert.equal(tight.counter.renders, rendered * 3, "the first scene was checked again");
});

test("a check after a change renders only the frames where a changed layer shows, with the same findings", async () => {
  // check {fix:"auto"} checks the scene again after each round of fixes: on a long video with
  // footage it rendered every frame each time, for minutes.
  const document = project("long", "Some words");
  const scene = document.scenes[0];
  scene.duration = 6;
  // A panel behind the title from 4 s on. Its color changes, so only frames from 4 s look different.
  scene.layers.unshift(createLayer("rectangle", { id: "panel", name: "panel", x: 0, y: 0, width: 640, height: 360, fill: "#202830",
    animations: [{ id: "panel-show", kind: "show", name: "Show", start: 4 }] }));
  const changed = structuredClone(document);
  changed.scenes[0].layers.find((layer) => layer.id === "panel").fill = "#C8C8C8";

  const reusing = countingChecker(undefined, true);
  await checkOf(reusing.checker, document);
  const first = reusing.counter.frames;
  const again = await checkOf(reusing.checker, changed);
  const fresh = countingChecker(undefined, false);
  const expected = await checkOf(fresh.checker, changed);
  assert.deepEqual(again.findings, expected.findings, "the same findings as a check that renders every frame");
  assert.ok(again.findings.some((finding) => finding.rule === "contrast"), "the light panel's frames were rendered again: the title fails contrast on it");
  const redrawn = reusing.counter.frames - first;
  assert.ok(redrawn > 0 && redrawn < fresh.counter.frames, `${redrawn} of ${fresh.counter.frames} frames rendered again`);
});

test("frames of a scene drawn many ways (each clip alone) are still reused on the next check", async () => {
  // The footage rules draw each clip alone, one call a clip: 40 ways of drawing one scene pushed
  // out the first check's frames, so each check {fix:"auto"} round rendered them all again.
  const clips = Array.from({ length: 40 }, (_, index) => createLayer("rectangle", { id: `clip-${index}`, x: 0, y: 0, width: 64, height: 36, fill: "#808080" }));
  const alone = (index) => ({ id: "s", width: 64, height: 36, layers: clips.map((layer, other) => (other === index ? layer : { ...layer, visible: false })) });
  const reuse = createFrameReuse();
  let rendered = 0;
  const render = async (scene, times) => { rendered += times.length; return times.map(() => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })); };
  for (let index = 0; index < 40; index += 1) {
    await reuse.framesFor(alone(index), [1], { width: 48, render });
    await reuse.framesFor(alone(index), [2], { width: 48, render });
  }
  assert.equal(rendered, 80);
  for (let index = 0; index < 40; index += 1) await reuse.framesFor(alone(index), [1, 2], { width: 48, render });
  assert.equal(rendered, 80, "every clip's two frames were kept, in one entry a clip");
  // A twin dropped by another call while this one renders: the newest kept scene stays.
  const small = createFrameReuse({ maxEntries: 2 });
  await small.framesFor(alone(0), [1], { width: 48, render });
  let release;
  const slow = small.framesFor(alone(0), [2], { width: 48, render: (scene, times) => new Promise((done) => { release = () => done(times.map(() => ({ data: new Uint8ClampedArray(4) }))); }) });
  await small.framesFor(alone(1), [1], { width: 48, render });
  await small.framesFor(alone(2), [1], { width: 48, render });
  release();
  await slow;
  rendered = 0;
  await small.framesFor(alone(2), [1], { width: 48, render });
  assert.equal(rendered, 0, "the newest kept scene was not taken out in the twin's place");
});

test("speech_cut reads transcripts through transcriptOf, and a transcript made later is not hidden by a kept check", async () => {
  const document = project("talk", "Talk");
  document.scenes[0].layers.push(createLayer("audio", { id: "voice", name: "voice", src: "/api/media/voice.wav", mediaDuration: 1.3 }));
  const transcript = { model: "small.en", version: 1, duration: 3, words: [{ text: "Nearest", start: 0.6, end: 1 }, { text: "target.", start: 1.1, end: 1.6 }] };
  const checker = createQualityChecker({});
  let saved = null;
  const run = () => checker.check(document, { fonts: defaultFonts, transcriptOf: () => saved });
  assert.match((await run()).notes.join("\n"), /speech_cut did not run on "voice": not transcribed yet/);
  // The file's peaks (loudnessOf) still hear the cut at 1.3 s inside loud sound: a warning.
  const peaks = { version: 2, available: true, duration: 3, secondsPerPeak: 0.01, peaks: Array.from({ length: 300 }, (_, index) => (index >= 60 && index < 170 ? 0.5 : 0.01)) };
  const heard = await checker.check(document, { fonts: defaultFonts, transcriptOf: () => null, loudnessOf: async () => peaks });
  assert.deepEqual(heard.findings.filter((entry) => entry.rule === "speech_cut").map((entry) => entry.severity), ["warn"]);
  saved = transcript;
  const [finding] = (await run()).findings.filter((entry) => entry.rule === "speech_cut");
  assert.deepEqual([finding.ref, finding.severity, finding.fix, finding.auto], ["voice", "error", { op: "update_layer", layerId: "voice", properties: { mediaDuration: 1.75 } }, true]);
  // A song is no voice for speech_cut, but its loudness reaches music_hard_stop: stopped loud at
  // 1.3 s, its fix is an add_animation fade out of the audio layer.
  const song = await checker.check(document, { fonts: defaultFonts, transcriptOf: async () => ({ music: true }), loudnessOf: async () => peaks });
  assert.deepEqual(song.findings.filter((entry) => entry.rule.startsWith("speech")), []);
  const [stop] = song.findings.filter((entry) => entry.rule === "music_hard_stop");
  assert.deepEqual([stop.auto, stop.fix.op, stop.fix.layerId, stop.fix.animation.start, stop.fix.animation.to], [true, "add_animation", "voice", 1.05, { volume: 0 }]);
  // A waiver that silences nothing is stale only when every rule had its input: not while a transcript is missing.
  const waiver = { code: "speech_cut", target: "voice", reason: "meant" };
  document.checkWaivers = [waiver];
  const full = (transcriptOf) => checker.check(document, { fonts: defaultFonts, pixels: true, transcriptOf });
  assert.deepEqual((await full(() => null)).stale, []);
  assert.deepEqual((await full(async () => ({ music: true }))).stale, [waiver]);
});

test("reference_drift measures in the background: the check answers with a note, the next check reads it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const checker = createQualityChecker({
    reuseFrames: false, renderFrames: renderSceneFrames, quietMs: 20,
    references: async () => [{ id: "yt:ref", measuredAt: "t" }],
    measureRender: async (pairs, { render }) => { calls.push(pairs.length); await gate; calls.push((await render(pairs[0])).length); return null; },
  });
  const document = project("drift", "Drift");
  const first = await checkOf(checker, document);
  assert.match(first.notes.join("\n"), /reference_drift is measuring .* in the background/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await checkOf(checker, document);
  assert.doesNotMatch(second.notes.join("\n"), /in the background/);
  assert.deepEqual(calls, [4, 2], "measured once, for the 2 s scene's 4 frame pairs, its frames rendered in the background");
});

test("reference_kinds reads labeled references that have no fingerprint, and its error carries the library search as its call", async () => {
  const labels = (id) => ({ id, fingerprint: null, moments: 6, seen: [1.8, 5.4, 9, 12.6, 16.2, 19.8].map((at, index) => ({ at, kinds: index < 2 ? ["made"] : ["plain"], words: "neon stair edges" })) });
  const checker = createQualityChecker({ references: async () => [labels("yt:AAAAAAAAAAA"), labels("yt:BBBBBBBBBBB")] });
  const found = (await checker.check(project("made", "Made"), { fonts: defaultFonts })).findings.filter((entry) => entry.rule === "reference_kinds");
  assert.deepEqual(found.map((entry) => entry.severity), ["error"]);
  assert.equal(found[0].call.tool, "library");
});
