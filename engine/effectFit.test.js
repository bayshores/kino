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
function edit(animations, more = [], scene = {}) {
  const clip = createLayer("video", { id: "shot", name: "shot", src: "/api/media/shot.mp4", mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080,
    animations: animations.map((animation, index) => ({ id: `shot.${index + 1}`, name: `shake ${index + 1}`, ...animation })) });
  return parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "Edit", width: 1920, height: 1080, duration: 12, layers: [clip, ...more.map((layer) => createLayer(layer.type, layer))], ...scene })] }));
}
// An exposure lift up to `stops` by `at` and back, as impact-accent's flash builds it (ids given).
const lift = (at, stops = 1.5, ids = []) => [
  { ...(ids[0] ? { id: ids[0] } : {}), kind: "effect", effect: "color-grade", start: at - 1 / 30, duration: 1 / 30, easing: "linear", from: { stops: 0 }, to: { stops }, keepStill: "off" },
  { ...(ids[1] ? { id: ids[1] } : {}), kind: "effect", effect: "color-grade", start: at, duration: 0.2, easing: "linear", from: { stops }, to: { stops: 0 }, keepStill: "off" }];
// A zoom punch of `amount` that starts to rise at `start` (compose's Accent: 0.08 s up, 0.3 s back).
const punch = (start, amount = 0.06) => [
  { kind: "custom", start, duration: 0.08, easing: "ease-out", from: { scaleX: 1, scaleY: 1 }, to: { scaleX: 1 + amount, scaleY: 1 + amount } },
  { kind: "custom", start: start + 0.08, duration: 0.3, easing: "ease-out", from: { scaleX: 1 + amount, scaleY: 1 + amount }, to: { scaleX: 1, scaleY: 1 } }];
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
  assert.match(findings[0].message, /cue:hit/);
  // Its fix takes the shake off (check fix:"auto").
  assert.deepEqual(findings[0].fix, { kind: "remove", animationIds: ["shot.1"], auto: true });
  assert.equal(blocksFinal(findings[0], false), true);
});

test("effect_fit: an impact-accent record keeps its cue through a save", async () => {
  // The flash on the drop seam and the strobe whose last light is on it, as the move records them.
  const record = (kind, cue, at, motive, start) => ({ id: "hit", name: "impact-accent", settings: { kind }, tags: ["flash"], start, end: at + 0.2, trigger: { cue, at, motive, weight: 1, kind } });
  const saved = edit(lift(3, 2, ["hit.impact-flash-up", "hit.impact-flash-down"]), [], { moves: [record("strobe", "song-drop-1", 3, "seam", 2.4)] });
  assert.deepEqual(saved.scenes[0].moves[0].trigger, { cue: "song-drop-1", at: 3, motive: "seam", weight: 1, kind: "strobe" });
  assert.deepEqual(await reasons(saved, [seam("drop", 3)]), []);
  // A flash on light in the clip that leads its cue by 3 frames (the light rises before it peaks).
  const light = { name: "light-1", kind: "marker", time: 3, layer: "shot", media: 3 };
  const early = edit([{ ...lift(3, 1.2, ["hit.impact-flash-up"])[0], start: 2.9, duration: 0.1 }, { ...lift(3, 1.2, [null, "hit.impact-flash-down"])[1] }], [], { moves: [record("flash", "light-1", 3, "light", 2.9)] });
  assert.deepEqual(await reasons(early, [light, accent("a", 8)]), []);
  assert.throws(() => edit([], [], { moves: [{ ...record("flash", "x", 3, "seam", 2.9), trigger: { cue: "x", at: 3, motive: "seam", weight: 2, kind: "flash" } }] }), /trigger/);
});

test("effect_fit: hand-made flashes, shakes, impact frames and punches are asked for their cue", async () => {
  const cues = [accent("hit", 9)];
  const ink = { contrast: 2, colorThreshold: 0.5, softness: 0, defaultColor: "#0A0A0C", invertLuma: false };
  const card = { type: "rectangle", id: "red", name: "red", x: 0, y: 0, width: 1920, height: 1080, fill: "#E01010", opacity: 0, animations: [
    { id: "red.up", name: "up", kind: "custom", start: 4.99, duration: 0.01, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } },
    { id: "red.down", name: "down", kind: "custom", start: 5.09, duration: 0.01, easing: "linear", from: { opacity: 1 }, to: { opacity: 0 } }] };
  const cases = {
    exposure: edit(lift(5)),
    oscillate: edit([{ kind: "custom", start: 5, duration: 0.125, easing: "linear", from: { x: 0 }, to: {}, fromCurrent: true, behavior: { oscillate: { amount: { x: 30 }, period: 0.1, phase: 0.25, decay: 14 } } }]),
    "red card": edit([], [card]),
    "impact frame": edit([{ kind: "effect", effect: "threshold-color", start: 5, duration: 2 / 30, easing: "linear", from: ink, to: ink, keepStill: "off" }]),
    "big punch": edit(punch(5, 0.2)),
  };
  for (const [name, document] of Object.entries(cases)) assert.deepEqual(await reasons(document, cues), ["untriggered"], name);
  // On the accent's frame each is quiet; a punch is timed from where it starts to rise (its peak is 2 frames later).
  assert.deepEqual(await reasons(edit(lift(9)), cues), []);
  assert.deepEqual(await reasons(edit(punch(9 - 0.04)), cues), []);
  // The red card's fix deletes it; the punch's takes off both its halves.
  const fixes = async (document) => (await runQuality(kinoTimeline(document, "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: cues } })).findings.map((finding) => finding.fix);
  assert.deepEqual(await fixes(cases["red card"]), [{ kind: "remove", layerItemId: "red", auto: true }]);
  assert.deepEqual(await fixes(edit(punch(5))), [{ kind: "remove", animationIds: ["shot.1", "shot.2"], auto: true }]);
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
