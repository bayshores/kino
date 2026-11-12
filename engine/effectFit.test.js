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
  // The message carries a ready op with the effect's own kind and layer, not a template.
  assert.match(findings[0].message, /edit \{ops:\[\{op:"move", name:"impact-accent", kind:"shake", layer:"[^"]+", at:"cue:hit"\}\]\}/);
  // Its fix takes the shake off (check fix:"auto").
  assert.deepEqual(findings[0].fix, { kind: "remove", animationIds: ["shot.1"], auto: true });
  assert.equal(blocksFinal(findings[0], false), true);
  // A shake that scales up as it shakes is one effect: one finding, and its fix takes both off.
  const both = await runQuality(kinoTimeline(edit([shake(5), ...punch(5)]), "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: [accent("hit", 2)] } });
  assert.deepEqual(both.findings.map((finding) => finding.reason), ["untriggered"]);
  assert.deepEqual(both.findings[0].fix.animationIds, ["shot.1", "shot.2", "shot.3"]);
  // The shake move's own timing: its scale comes back 0.3 s after the grow, inside the shake; the fix takes that off too (no pop).
  const [grow, back] = punch(5);
  const late = await runQuality(kinoTimeline(edit([shake(5, { frames: 15 }), grow, { ...back, start: 5.3, duration: 0.2 }]), "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: [accent("hit", 2)] } });
  assert.deepEqual(late.findings[0].fix.animationIds.sort(), ["shot.1", "shot.2", "shot.3"]);
  // A hit at a raw time (no cue): its light and shake are one finding, and the fix takes the whole move off.
  const raw = { id: "hit", name: "impact-accent", settings: { kind: "hit" }, tags: ["flash", "shake"], start: 5 - 1 / 30, end: 5.6 };
  const loose5 = await runQuality(kinoTimeline(edit(lift(5, 2, ["hit.impact-flash-up", "hit.impact-flash-down"]), [], { moves: [raw] }), "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: [accent("hit", 2)] } });
  assert.deepEqual(loose5.findings.map((finding) => [finding.reason, finding.fix]), [["untriggered", { kind: "remove", move: { name: "impact-accent", id: "hit" }, auto: true }]]);
  // A hit that names a beat number as its cue is on it; a hand shake on the same beat (no move names it) is not.
  const beat = { name: "beat-8", kind: "beat", time: 5 };
  const onBeat = { ...raw, trigger: { cue: "beat-8", at: 5, motive: "beat", weight: 0.3, kind: "hit" } };
  assert.deepEqual(await reasons(edit(lift(5, 1, ["hit.impact-flash-up", "hit.impact-flash-down"]), [], { moves: [onBeat] }), [accent("hit", 2), beat]), []);
  assert.deepEqual(await reasons(edit([shake(5)]), [accent("hit", 2), beat]), ["untriggered"]);
  // A title sliding in 0.1 to 0.3 s after the start (first_entrance's delay) is on that cut; at 1 s it is on nothing.
  const title = (start) => ({ type: "text", id: "title", name: "title", text: "Hi", x: 200, y: 200, width: 800, height: 200, fontSize: 120,
    animations: [{ id: "title.in", name: "Slide in", kind: "in", start, duration: 0.5, easing: "ease-out", from: { x: 120, opacity: 0 }, to: { x: 200, opacity: 1 } }] });
  assert.deepEqual(await reasons(edit([], [title(0.23)]), [accent("hit", 2)]), []);
  assert.deepEqual(await reasons(edit([], [title(1)]), [accent("hit", 2)]), ["untriggered"]);
  // Its hint names the nearest place it could start.
  const loose = await runQuality(kinoTimeline(edit([], [title(1)]), "s", { fonts: defaultFonts }), { codes: ["effect_fit"], pixels: false, context: { triggerCues: [accent("hit", 2)] } });
  assert.match(loose.findings[0].fix.text, /^Start it at (the cut \(0s|"cue:hit" \(2s), the nearest place/);
  // The same delay after a named marker (compose's end-card cue) is on it; a song marker set by hand is not a moment.
  const marker = (name, time) => ({ name, kind: "marker", time });
  assert.deepEqual(await reasons(edit([], [title(1.1)]), [accent("hit", 2), marker("end-card", 1)]), []);
  assert.deepEqual(await reasons(edit([], [title(1.1)]), [accent("hit", 2), marker("song-drop-1", 1)]), ["untriggered"]);
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
  // A flat frame on a cut (move flash frames:1) is part of the join, as the cut is; the same frame over one shot is a flash.
  const next = { type: "video", id: "shot2", name: "shot2", src: "/api/media/shot2.mp4", mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080, animations: [{ id: "shot2.show", name: "Show", kind: "show", start: 5 }] };
  const flat = { type: "rectangle", id: "flat", name: "flat", x: 0, y: 0, width: 1920, height: 1080, fill: "#FFFFFF", animations: [
    { id: "flat.show", name: "Show", kind: "show", start: 5 }, { id: "flat.hide", name: "Hide", kind: "hide", start: 5 + 1 / 30 - 0.0005 }] };
  assert.deepEqual(await reasons(edit([], [next, flat]), cues), []);
  assert.deepEqual(await reasons(edit([], [flat]), cues), ["untriggered"]);
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
  // An impact-accent hit (light and shake from one move) is one effect, and a sound on its cue is part of it: a title on the next cue makes 2, not 4.
  const hit = { id: "hit", name: "impact-accent", settings: { kind: "hit" }, tags: ["flash", "shake"], start: 2 - 1 / 30, end: 2.2, trigger: { cue: "a", at: 2, motive: "accent", weight: 0.9, kind: "hit" } };
  const title = { type: "text", id: "title", name: "title", text: "Hi", x: 200, y: 200, width: 800, height: 200, fontSize: 120,
    animations: [{ id: "title.in", name: "Slide in", kind: "in", start: 2.07, duration: 0.5, easing: "ease-out", from: { x: 120, opacity: 0 }, to: { x: 200, opacity: 1 } }] };
  const sound = { type: "audio", id: "boom", name: "boom", src: "/api/media/boom.wav", mediaSourceDuration: 1, mediaStart: 2, mediaDuration: 0.5 };
  const hitEdit = edit([], [title, sound], { moves: [hit] });
  assert.deepEqual(await reasons(hitEdit, cues), []);
  assert.deepEqual(await reasons(edit([], [title, sound], { moves: [{ ...hit, trigger: { ...hit.trigger, kind: "flash" } }] }), cues), ["stacked"]);
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
