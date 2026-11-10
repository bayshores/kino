// effect_fit (engine/quality/rules/effectFit.js): one case per reason. Each scene is one full-frame
// clip with wiggle shakes placed by hand; the cues come in as ctx.triggerCues, as the checker passes them.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { blocksFinal, runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";

// A shake: a wiggle of `px` at `rate` cycles a second for `frames` frames.
const shake = (start, { px = 20, rate = 8, frames = 3 } = {}) => ({ kind: "effect", effect: "wiggle", start, duration: frames / 30, easing: "linear", keepStill: "both", to: { wiggleX: px, wiggleY: 0, speed: rate } });
function edit(animations, more = []) {
  const clip = createLayer("video", { id: "shot", name: "shot", src: "/api/media/shot.mp4", mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080,
    animations: animations.map((animation, index) => ({ id: `shot.${index + 1}`, name: `shake ${index + 1}`, ...animation })) });
  return parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "Edit", width: 1920, height: 1080, duration: 12, layers: [clip, ...more.map((layer) => createLayer(layer.type, layer))] })] }));
}
const accent = (name, time, weight = 0.9) => ({ name, kind: "accent", time, weight, rank: 1 });
const seam = (kind, time) => ({ name: `song-${kind}-1`, kind: "marker", time, fitted: true });
async function reasons(document, triggerCues, more = {}) {
  const { findings } = await runQuality(kinoTimeline(document, "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues, scene: document.scenes[0], ...more } });
  return findings.map((finding) => finding.reason);
}

test("effect_fit: quiet outside a music edit and on a shake its cue motivates", async () => {
  assert.deepEqual(await reasons(edit([shake(2)]), []), []);
  assert.deepEqual(await reasons(edit([shake(2)]), [accent("hit", 2)]), []);
  // Up to 2 frames early is on the cue; late is not.
  assert.deepEqual(await reasons(edit([shake(2 - 2 / 30)]), [accent("hit", 2)]), []);
  assert.deepEqual(await reasons(edit([shake(2.1)]), [accent("hit", 2)]), ["untriggered"]);
});

test("effect_fit: untriggered, and a gate at the final render", async () => {
  const { findings } = await runQuality(kinoTimeline(edit([shake(5)]), "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: [accent("hit", 2)] } });
  assert.equal(findings[0].reason, "untriggered");
  assert.match(findings[0].fix.text, /cue:hit/);
  assert.equal(blocksFinal(findings[0], false), true);
});

test("effect_fit: strength ranks with the trigger's weight", async () => {
  // The intro seam (0.5) gets a full shake, the drop (1) a small one.
  assert.deepEqual(await reasons(edit([shake(1, { px: 38 }), shake(6, { px: 8 })]), [seam("intro", 1), seam("drop", 6)]), ["strength"]);
  assert.deepEqual(await reasons(edit([shake(1, { px: 8 }), shake(6, { px: 38 })]), [seam("intro", 1), seam("drop", 6)]), []);
});

test("effect_fit: budget per section, none inside a rest but on its edges", async () => {
  const cues = [seam("break", 0), seam("drop", 8), accent("a", 3), accent("b", 8)];
  assert.deepEqual(await reasons(edit([shake(3)]), cues), ["budget"]);
  assert.deepEqual(await reasons(edit([shake(8)]), cues), []);
});

test("effect_fit: stacked, at most 2 effects within 0.15 s", async () => {
  const cues = [accent("a", 2), accent("b", 2.07), accent("c", 2.13), seam("drop", 0)];
  assert.deepEqual(await reasons(edit([shake(2), shake(2.07), shake(2.13)]), cues), ["stacked"]);
});

test("effect_fit: jitter, a shake faster than a third of the frame rate or held steady", async () => {
  assert.deepEqual(await reasons(edit([shake(2, { rate: 28 })]), [accent("hit", 2)]), ["jitter"]);
  assert.deepEqual(await reasons(edit([shake(2, { frames: 12 })]), [accent("hit", 2)]), ["jitter"]);
});

test("effect_fit: no shake on a talking face", async () => {
  const voice = { type: "audio", id: "vo", name: "vo", src: "/api/media/shot.mp4", mediaSourceDuration: 30, mediaStart: 0, mediaDuration: 12 };
  const document = edit([shake(2)], [voice]);
  const [raw] = document.scenes;
  const words = [{ text: "Never", start: 1.9, end: 2.3 }, { text: "again.", start: 2.35, end: 2.8 }];
  const speech = [{ layer: raw.layers.find((layer) => layer.id === "vo"), transcript: { words } }];
  assert.deepEqual(await reasons(document, [accent("hit", 2)], { speechScene: raw, speech }), ["face"]);
});
