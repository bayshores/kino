// Syncing two clips by sound: the match (made from sounds built here, sample by sample) and where
// sync_clips puts the layer. Real files decoded by FFmpeg are tested in server/agent-sync.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { SYNC_CONFIDENT, SYNC_SAMPLE_RATE as RATE, currentLag, matchEnvelopes, syncEnvelopes } from "./clipSync.js";
import { defaultFonts } from "./fonts.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { runDataQuality } from "./quality/index.js";

// The same "random" numbers from the same seed, from 0 to 1.
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// A place's sound: short sounds (clicks, beeps, knocks) at uneven moments, each at its own pitch.
function placeSound(seconds, seed) {
  const random = randomFrom(seed);
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let at = 0.2; at < seconds - 0.5; at += 0.15 + random() * 0.9) {
    const hz = 300 + random() * 3000;
    const length = Math.round((0.02 + random() * 0.15) * RATE);
    const loud = 0.2 + random() * 0.6;
    const start = Math.round(at * RATE);
    for (let i = 0; i < length && start + i < samples.length; i += 1)
      samples[start + i] += loud * Math.exp(-i / (length / 4)) * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return samples;
}

// What one microphone records of `sound` from `from` for `seconds`: its own loudness and its own hiss.
function recording(sound, from, seconds, { gain = 1, hiss = 0.02, seed = 7 } = {}) {
  const random = randomFrom(seed);
  const start = Math.round(from * RATE);
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => gain * (sound[start + i] ?? 0) + hiss * (random() - 0.5));
}

test("a short quiet clip is found inside a long loud one", () => {
  const place = placeSound(60, 1);
  const long = syncEnvelopes(recording(place, 0, 60, { gain: 1, seed: 2 }));
  const short = syncEnvelopes(recording(place, 23.4, 10, { gain: 0.08, hiss: 0.004, seed: 3 }));
  // The short clip's time T is the long one's T + 23.4: its offset against the long one is -23.4.
  const match = matchEnvelopes(short, long);
  assert.ok(Math.abs(match.offset + 23.4) < 0.02, `offset ${match.offset}`);
  assert.ok(match.confidence >= 0.5, `confidence ${match.confidence}`);
  assert.equal(Math.round(match.overlap), 10);
  // The other way round gives the opposite offset.
  assert.ok(Math.abs(matchEnvelopes(long, short).offset - 23.4) < 0.02);
});

test("search only looks near the offset it is given", () => {
  const place = placeSound(40, 4);
  const a = syncEnvelopes(recording(place, 5, 30, { seed: 5 }));
  const b = syncEnvelopes(recording(place, 0, 40, { seed: 6 }));
  assert.ok(Math.abs(matchEnvelopes(a, b, { around: -4.5, search: 1 }).offset + 5) < 0.02);
  // Nowhere near the right offset: the best it finds there is not confident.
  assert.ok(matchEnvelopes(a, b, { around: 3, search: 1 }).confidence < SYNC_CONFIDENT);
});

test("two different places, a steady beat and silence are not matched", () => {
  const one = syncEnvelopes(recording(placeSound(30, 8), 0, 30, { seed: 9 }));
  const other = syncEnvelopes(recording(placeSound(30, 10), 0, 20, { seed: 11 }));
  assert.ok(matchEnvelopes(other, one).confidence < SYNC_CONFIDENT);
  // The same click every half second fits at every half second.
  const clicks = new Float32Array(30 * RATE);
  for (let at = 0.25; at < 29.5; at += 0.5) for (let i = 0; i < 200; i += 1) clicks[Math.round(at * RATE) + i] = 0.5 * Math.exp(-i / 40) * Math.sin(i);
  const beat = syncEnvelopes(clicks);
  assert.ok(matchEnvelopes(beat.map((band) => band.slice(300, 1500)), beat).confidence < SYNC_CONFIDENT);
  const silent = syncEnvelopes(new Float32Array(20 * RATE));
  assert.ok(!(matchEnvelopes(silent, one).confidence >= SYNC_CONFIDENT));
  // Less than a second of sound overlaps nothing.
  assert.equal(matchEnvelopes(syncEnvelopes(new Float32Array(RATE / 2)), one).offset, null);
});

const clip = (id, values = {}) => createLayer("video", { id, name: `${id}.mp4`, src: `/api/media/${id}.mp4`, mediaSourceDuration: 20, ...values });
function documentWith(layers, duration = 30) {
  return parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration, layers })] });
}
function sync(document, fields) {
  const operation = { type: "sync_clips", sceneId: "s", layerId: "cam", toId: "screen", ...fields };
  const reports = new Map();
  const next = parseDocument(applyOperations(document, [operation], { reports }));
  const layers = Object.fromEntries(next.scenes[0].layers.map((layer) => [layer.id, layer]));
  return { layers, report: reports.get(operation) };
}
// File time at scene time t, at speed 1.
const fileTime = (layer, t) => (layer.mediaOffset ?? 0) + t - (layer.mediaStart ?? 0);

test("sync_clips moves the layer so the same moment plays at the same time", () => {
  // The camera's file starts 1.04 s after the screen recording's (its offset against it: -1.04).
  const document = documentWith([clip("cam"), clip("screen", { mediaSourceDuration: 25 })]);
  const { layers, report } = sync(document, { match: { offset: -1.04, confidence: 0.62, overlap: 18.9 } });
  assert.equal(layers.cam.mediaStart, 1.04);
  assert.equal(layers.cam.mediaOffset, 0);
  assert.ok(Math.abs(fileTime(layers.cam, 10) - (fileTime(layers.screen, 10) - 1.04)) < 1e-9);
  assert.equal(report.by, "sound");
  assert.equal(report.confidence, 0.62);
  assert.equal(report.same, '0 s of "cam.mp4" = 1.04 s of "screen.mp4"');
  assert.equal(report.inStep, "1.04–21.04 s of the scene");
  assert.equal(currentLag(layers.cam, layers.screen), -1.04);

  // Wherever `to` sits: the screen recording starts at 3 s of the scene, 5 s into its file.
  const moved = documentWith([clip("cam", { mediaStart: 2 }), clip("screen", { mediaStart: 3, mediaOffset: 5, mediaSourceDuration: 25 })]);
  const again = sync(moved, { match: { offset: 4, confidence: 0.5, overlap: 12 } });
  assert.equal(again.layers.cam.mediaStart, 2, "the layer keeps its start when its file has that moment");
  for (const t of [3, 8, 14]) assert.ok(Math.abs(fileTime(again.layers.cam, t) - (fileTime(again.layers.screen, t) + 4)) < 1e-9);
});

test("sync_clips with at uses the moment the agent names", () => {
  const document = documentWith([clip("cam", { mediaStart: 4 }), clip("screen")]);
  // 3.2 s into the camera's file is 7.5 s into the screen recording's.
  const { layers, report } = sync(document, { at: { layer: 3.2, to: 7.5 } });
  assert.equal(report.by, "at");
  assert.equal(layers.cam.mediaStart, 4.3);
  assert.ok(Math.abs(fileTime(layers.cam, 7.5) - 3.2) < 1e-9);
  assert.throws(() => sync(document, { at: { layer: 3.2 } }), /at is \{layer, to\}/);
  assert.throws(() => sync(document, { at: { layer: 30, to: 1 } }), /its file is 20 s long/);
});

test("sync_clips refuses an unsure match and changes nothing", () => {
  const document = documentWith([clip("cam"), clip("screen")]);
  assert.throws(() => sync(document, { match: { offset: 2, confidence: 0.12, overlap: 15 } }),
    /could not be matched by sound: confidence 0\.12.*Nothing was changed\. Tell the person.*at: \{layer/);
  assert.throws(() => sync(document, { match: { offset: null, reason: "too short" } }), /overlap too little/);
  assert.throws(() => sync(document, {}), /overlap too little/);
});

test("sync_clips refuses clips it cannot place", () => {
  const document = documentWith([clip("cam"), clip("screen", { mediaDuration: 5 }), createLayer("text", { id: "title", name: "title", text: "Hi" })]);
  // In step the camera would start at 15 s of the scene, after the screen recording stopped at 5 s.
  assert.throws(() => sync(document, { at: { layer: 0, to: 15 } }), /never play together/);
  assert.throws(() => sync(document, { toId: "title", at: { layer: 0, to: 1 } }), /only video and audio layers/);
  assert.throws(() => sync(document, { toId: "cam", at: { layer: 0, to: 1 } }), /the same layer/);
  const fast = documentWith([clip("cam", { mediaSpeed: 2 }), clip("screen")]);
  assert.throws(() => sync(fast, { at: { layer: 0, to: 1 } }), /another speed/);
});

test("sync_clips links the two files, and out_of_sync holds a line to the picture of its moment", () => {
  // The app's line is 30 s into the screen recording; the walk filmed with it is the camera from 10 s.
  const voice = createLayer("audio", { id: "screen", name: "voice", src: "/api/media/screen.m4a", mediaSourceDuration: 40, mediaOffset: 30, mediaDuration: 3 });
  const walk = clip("cam", { x: 0, y: 0, width: 640, height: 360, volume: 0, mediaSourceDuration: 40 });
  const synced = parseDocument(applyOperations(documentWith([walk, voice], 4), [{ type: "sync_clips", sceneId: "s", layerId: "cam", toId: "screen", at: { layer: 10, to: 30 } }]));
  // Kept by file: the screen recording at t is the camera at t - 20 s.
  assert.deepEqual(synced.clipLinks, [{ a: "/api/media/screen.m4a", b: "/api/media/cam.mp4", lag: -20 }]);
  const findings = (document) => runDataQuality(kinoTimeline(document, "s", { fonts: defaultFonts }), { codes: ["out_of_sync"], context: { scene: document.scenes[0], clipLinks: document.clipLinks } }).findings;
  assert.deepEqual(findings(synced), []);
  // The walk swapped for another moment of the same take (5 s in): the line plays over the wrong picture.
  const moved = structuredClone(synced);
  const layer = (id) => moved.scenes[0].layers.find((entry) => entry.id === id);
  layer("cam").mediaOffset = 5;
  const [late] = findings(moved);
  assert.equal(late.severity, "error");
  assert.match(late.message, /from 30 s of its recording, but the picture shown \("cam.mp4"\) is from 5 s/);
  assert.deepEqual(late.fix, { kind: "layer", layerId: "cam", properties: { mediaOffset: 10 }, auto: true });
  // A muted line is not heard.
  layer("screen").volume = 0;
  assert.deepEqual(findings(moved), []);
  // The right moment slowed down on purpose is left alone (the moment is stretched).
  const slow = structuredClone(synced);
  slow.scenes[0].layers.find((entry) => entry.id === "cam").mediaSpeed = 0.5;
  assert.deepEqual(findings(slow), []);
  // A line from before the phone started (screen 15 s is cam -5 s): no frame of it, a hint.
  const before = structuredClone(synced);
  before.scenes[0].layers.find((entry) => entry.id === "screen").mediaOffset = 15;
  const [missing] = findings(before);
  assert.equal(missing.fix.kind, "hint");
  assert.match(missing.fix.text, /no frame of that moment/);
  // The moment is in the file but the clip starts too early to reach it: start it later.
  const early = structuredClone(synced);
  Object.assign(early.scenes[0].layers.find((entry) => entry.id === "screen"), { mediaStart: 2, mediaOffset: 20.5, mediaDuration: 2 });
  early.scenes[0].layers.find((entry) => entry.id === "cam").mediaOffset = 0;
  assert.deepEqual(findings(early).map((finding) => finding.fix), [{ kind: "layer", layerId: "cam", properties: { mediaStart: 1.5, mediaOffset: 0 }, auto: false }]);
  // A J cut: the next shot's line starts 0.5 s before the cut, over the last shot of the walk.
  const jCut = structuredClone(synced);
  const shotB = jCut.scenes[0].layers.find((entry) => entry.id === "cam");
  Object.assign(shotB, { mediaStart: 1.5, mediaOffset: 10.5 });
  jCut.scenes[0].layers.unshift({ ...structuredClone(shotB), id: "camA", mediaStart: 0, mediaOffset: 2, mediaDuration: 1.5 });
  Object.assign(jCut.scenes[0].layers.find((entry) => entry.id === "screen"), { mediaStart: 1, mediaOffset: 30, mediaDuration: 3 });
  assert.deepEqual(findings(parseDocument(jCut)), []);
});

test("sync_clips links two long files filmed over 10 minutes apart", () => {
  // A 30 minute screen recording read from 15 minutes in, and the phone started then.
  const screen = createLayer("audio", { id: "screen", name: "voice", src: "/api/media/screen.m4a", mediaSourceDuration: 1800, mediaOffset: 900, mediaDuration: 3 });
  const synced = parseDocument(applyOperations(documentWith([clip("cam", { mediaSourceDuration: 60 }), screen], 4), [{ type: "sync_clips", sceneId: "s", layerId: "cam", toId: "screen", at: { layer: 5, to: 905 } }]));
  assert.equal(synced.clipLinks[0].lag, -900);
  assert.deepEqual(parseDocument(structuredClone(synced)).clipLinks, synced.clipLinks);
});
