// One bad and one good example for each pixel rule of the quality checker (contrast, flashing,
// luma_jump, frozen_picture). They render real frames with the export renderer, the way the agent service does
// (backend/agent/quality.mjs). The data rules are tested in src/qualityRules.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { evaluateLayer } from "../engine/animation.js";
import { effectDefaults } from "../engine/effects/catalog.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { ruleOf, runQuality } from "../engine/quality/index.js";
import { brightness } from "../engine/quality/motionPixels.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { makeVideo, skipWithoutMediaTools } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();
const PAPER = "#f5f2ea";

function text(id, value, props = {}) {
  return { type: "text", id, name: id, text: value, fontFamily: "Noto Serif", fontSize: 72, fill: "#1a1a1a", textResize: "width-height", x: 200, y: 200, ...props };
}

function rect(id, props = {}) {
  return { type: "rectangle", id, name: id, fill: "#3a5a40", x: 200, y: 200, width: 320, height: 180, ...props };
}

const show = (start) => ({ kind: "show", start });
const hide = (start) => ({ kind: "hide", start });

/** A kino document with one 1920×1080 scene, with its animations as written (not yet stored). */
function rawScene({ layers = [], ...sceneFields } = {}) {
  const built = layers.map(({ type, animations = [], ...fields }) =>
    createLayer(type, { ...fields, animations: animations.map((animation, index) => ({ id: `${fields.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation })) }));
  return createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, background: PAPER, ...sceneFields, layers: built })] });
}

/** A parsed kino document with one 1920×1080 scene, the way kino stores it. */
const scene = (fields) => parseDocument(rawScene(fields));

// ctx.renderFrames for the checker: renders the drawn scene at those times, with the layers in
// `hide` left out (the contrast rule hides the text to see what is behind it).
// With `solo`, only those layers are drawn, over a plain `background` (as backend/agent/quality.mjs).
function frameRenderer(document, mediaRoot) {
  const expanded = expandComponents(document, "scene", { fonts });
  return (times, { width, hide: hidden = [], solo = null, background = null }) => {
    const left = new Set(hidden);
    if (solo) for (const layer of expanded.layers) if (!solo.includes(layer.id)) left.add(layer.id);
    let drawn = { ...expanded, layers: expanded.layers.map((layer) => (left.has(layer.id) ? { ...layer, visible: false } : layer)) };
    if (background) drawn = { ...drawn, background, backgroundEnabled: true, backgroundAnimations: [] };
    return renderSceneFrames(drawn, times, { fonts, width, mediaRoot });
  };
}

// A 4x4 PNG of one color, without color tags.
async function solidPng(rgb) {
  const canvas = createCanvas(4, 4), context = canvas.getContext("2d");
  context.fillStyle = `rgb(${rgb.join(",")})`;
  context.fillRect(0, 0, 4, 4);
  return pngWith(await canvas.encode("png"));
}

// `png` with its color chunks dropped and a chunk of `type` and `data` added before the pixels.
function pngWith(png, type, data) {
  const chunks = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) chunks.push(png.subarray(at, at + 12 + png.readUInt32BE(at)));
  const added = [];
  if (type) {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]), head = Buffer.alloc(4), crc = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body) >>> 0);
    added.push(Buffer.concat([head, body, crc]));
  }
  const kept = chunks.filter((chunk) => !["sRGB", "iCCP", "gAMA", "cHRM"].includes(chunk.toString("latin1", 4, 8)));
  return Buffer.concat([png.subarray(0, 8), kept[0], ...added, ...kept.slice(1)]);
}

// A 64x32 JPEG, red left and blue right, whose EXIF says to turn it a quarter clockwise.
async function turnedJpeg() {
  const canvas = createCanvas(64, 32), context = canvas.getContext("2d");
  context.fillStyle = "#ff0000"; context.fillRect(0, 0, 32, 32);
  context.fillStyle = "#0000ff"; context.fillRect(32, 0, 32, 32);
  const jpeg = await canvas.encode("jpeg", 100);
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]), length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, body, jpeg.subarray(2)]);
}

async function check(code, document, mediaRoot) {
  const model = kinoTimeline(document, "scene", { fonts });
  const { findings } = await runQuality(model, { codes: [code], pixels: true, context: { renderFrames: frameRenderer(document, mediaRoot), scene: document.scenes[0] } });
  return findings;
}

async function fires(code, document, mediaRoot) {
  const findings = await check(code, document, mediaRoot);
  assert.ok(findings.length > 0, `${code} should fire on the bad example`);
  for (const finding of findings) assert.equal(finding.rule, code);
  assert.equal(findings[0].severity, ruleOf(code).level);
  return findings;
}

async function silent(code, document, mediaRoot) {
  const findings = await check(code, document, mediaRoot);
  assert.deepEqual(findings.map((finding) => finding.message), [], `${code} should stay silent on the good example`);
}

test("contrast: body text has 4.5:1 contrast with what is behind it", async () => {
  // 40 px text on the paper background. Bad: light grey (about 2.3:1). Good: dark grey (about 8:1).
  const body = (fill) => scene({ layers: [text("body", "Classes every Saturday", { fontSize: 40, fill })] });
  const [finding] = await fires("contrast", body("#a39e93"));
  assert.equal(finding.itemId, "body");
  assert.equal(finding.required, 4.5);
  assert.ok(finding.measured < 3, `measured ${finding.measured}`);
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
  assert.equal(typeof finding.fix.properties.fill, "string");
  await silent("contrast", body("#4a4740"));
});

test("contrast: measures the real pixels behind the text", async () => {
  // White text. Bad: straight on the paper background. Good: on a dark plate drawn behind it.
  const title = text("title", "Bake with us", { fill: "#ffffff", x: 240, y: 240 });
  const plate = rect("plate", { x: 200, y: 200, width: 640, height: 180, fill: "#2b2620" });
  const [finding] = await fires("contrast", scene({ layers: [title] }));
  assert.equal(finding.required, 3, "72 px is large text");
  await silent("contrast", scene({ layers: [plate, title] }));
  // A halo shadow (dark, centered, soft) is the text's background (WCAG 1.4.3); a drop shadow is not.
  await silent("contrast", scene({ layers: [{ ...title, shadow: { color: "#000000e6", x: 0, y: 0, blur: 24 } }] }));
  await fires("contrast", scene({ layers: [{ ...title, shadow: { color: "#000000e6", x: 18, y: 18, blur: 4 } }] }));
});

test("contrast: a layer drawn over the text on purpose (allowOverlap) is not what it is read against", async () => {
  // White text on a dark plate, with a light shape over half of it: a subject cut out in front of
  // its title (cut_out marks it allowOverlap). It covers the text, so it is left out of the backdrop.
  const plate = rect("plate", { x: 200, y: 200, width: 640, height: 180, fill: "#2b2620" });
  const title = text("title", "Bake with us", { fill: "#ffffff", x: 240, y: 240 });
  const subject = (props) => rect("subject", { x: 300, y: 180, width: 260, height: 220, fill: "#f2e6cf", ...props });
  await silent("contrast", scene({ layers: [plate, title, subject({ allowOverlap: true })] }));
  // Not marked: it is measured as before (and the overlap gate flags it).
  await fires("contrast", scene({ layers: [plate, title, subject()] }));
  // A text drawn above it still reads against it.
  const [finding] = await fires("contrast", scene({ layers: [plate, subject({ allowOverlap: true }), title] }));
  assert.equal(finding.itemId, "title");
});

test("contrast: where a cut-out in front of a word hides it, what is behind the word there does not count", async () => {
  // A word behind a person (masked-type): white letters on a dark plate at the left, light paper at
  // the right, and an opaque cut-out over the right half. The right half of the word cannot be
  // seen, so the light paper behind it there is not what the word is read against.
  const plate = rect("plate", { x: 200, y: 200, width: 330, height: 180, fill: "#2b2620" });
  const title = text("title", "Bake with us", { fill: "#ffffff", x: 240, y: 240 });
  const person = (x) => rect("person", { x, y: 160, width: 560, height: 280, fill: "#151311", allowOverlap: true });
  await silent("contrast", scene({ layers: [plate, title, person(530)] }));
  // The person away from the word: the right half shows on the paper and fails.
  await fires("contrast", scene({ layers: [plate, title, person(1300)] }));
});

test("contrast: uses the colour a fill animation gives the text at the time it samples", async () => {
  // White text over a white impact flash on a dark scene. Its "Ink" animation turns the fill
  // black from `inkStart` (the shape an agent reported). The text and flash show 1–2 s.
  const impact = (inkStart, inkDuration) => scene({ background: "#111111", layers: [
    rect("flash", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [show(1), hide(2)] }),
    text("you", "YOU.", { fill: "#ffffff", fontSize: 120, x: 800, y: 460, animations: [
      show(1), hide(2),
      { kind: "custom", name: "Ink", from: { fill: "#000000" }, to: { fill: "#000000" }, start: inkStart, duration: inkDuration, easing: "linear" },
    ] }),
  ] });
  // Black for the whole flash: easy to read, though the layer's own fill is white.
  await silent("contrast", impact(1, 1));
  // Black only from 1.5 s: before that it really is white on white, and is still flagged there.
  const [finding] = await fires("contrast", impact(1.5, 0.5));
  assert.equal(finding.itemId, "you");
  assert.ok(finding.at < 1.5, `flagged at ${finding.at}s, before the Ink animation`);
  assert.ok(finding.measured < 1.1, `measured ${finding.measured}`);
  assert.match(finding.message, /\(#ffffff\)/i);
  // The white there is the layer's own fill, so changing that fill is the fix.
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
});

test("contrast: a colour that comes from a fill animation is fixed in that animation", async () => {
  // Dark text that a "Fade to white" animation turns white over a white panel: changing the
  // layer's own fill would not change what is drawn, so the fix says to change the animation.
  const document = scene({ layers: [
    rect("panel", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff" }),
    text("title", "Bake with us", { fill: "#1a1a1a", animations: [
      { kind: "custom", name: "Fade to white", from: { fill: "#ffffff" }, to: { fill: "#ffffff" }, start: 0, duration: 3, easing: "linear" },
    ] }),
  ] });
  const [finding] = await fires("contrast", document);
  assert.match(finding.message, /\(#ffffff\)/i);
  assert.equal(finding.fix.kind, "hint");
  assert.match(finding.fix.text, /Fade to white/);
});

test("contrast: a fill that an animation fades to transparent is hidden, not dim", async () => {
  // White text on a dark scene. Fading its fill to #ffffff00 hides it the way an opacity fade
  // does, so the see-through times are not judged (nor those of a fade-in from #ffffff00).
  const faded = (animation) => scene({ background: "#151515", layers: [text("t", "Bake with us", { fill: "#ffffff", animations: [animation] })] });
  await silent("contrast", faded({ kind: "custom", name: "Fade out", from: { fill: "#ffffff" }, to: { fill: "#ffffff00" }, start: 1.5, duration: 0.7, easing: "linear" }));
  await silent("contrast", faded({ kind: "custom", name: "Fade in", from: { fill: "#ffffff00" }, to: { fill: "#ffffff" }, start: 0, duration: 0.7, easing: "linear" }));
  // A fill that is see-through all along is still judged, as dim text.
  const [finding] = await fires("contrast", scene({ background: "#151515", layers: [text("t", "Bake with us", { fill: "#ffffff33" })] }));
  assert.match(finding.message, /\(#ffffff33\)/i);
});

test("contrast: a fill animation is named only while it sets the colour", async () => {
  // Light grey text on white with an "Ink in" animation written with only a From fill (black,
  // 0.2–0.5 s). After 0.5 s it is grey on white. Which fix works depends on its To (animation.js).
  const inked = (make) => make({ background: "#ffffff", layers: [text("t", "Bake with us", { fill: "#eeeeee", animations: [
    { kind: "in", name: "Ink in", from: { fill: "#000000" }, to: {}, start: 0.2, duration: 0.3, easing: "linear" },
  ] })] });
  // As written, with no To fill, it ends on the layer's own fill: changing that fill is the fix.
  const [own] = await fires("contrast", inked(rawScene));
  assert.ok(own.at >= 0.5, `flagged at ${own.at}s, after the animation`);
  assert.equal(own.fix.kind, "item");
  assert.equal(own.fix.auto, true);
  const written = inked(rawScene).scenes[0].layers[0];
  assert.equal(evaluateLayer({ ...written, fill: own.fix.properties.fill }, 1.5).fill, own.fix.properties.fill);
  // Stored by kino (add_animation stores it the same way), its To holds a copy of that fill,
  // #eeeeee, drawn after it ends whatever the layer's fill is: the fix is in the animation.
  const [kept] = await fires("contrast", inked(scene));
  const stored = inked(scene).scenes[0].layers[0];
  assert.equal(evaluateLayer({ ...stored, fill: "#0b0b0c" }, 1.5).fill, "#eeeeee");
  assert.equal(kept.fix.kind, "hint");
  assert.match(kept.fix.text, /Ink in/);
});

test("contrast: says how long the text fails, and a failure under 0.2 s (a beat flash) is a warning", async () => {
  // White 120 px text with a black stroke on a dark scene, shown 0-3 s. A full-frame white
  // flash is behind it for `flashFor` seconds from 1.5 s, the middle of the text's shown time
  // (a real edit's "1.87:1 at 19.2s" was such a flash, and was an error).
  const flashed = (flashFor) => scene({ background: "#111111", layers: [
    rect("flash", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [show(1.5), hide(1.5 + flashFor)] }),
    text("save", "SAVE", { fill: "#ffffff", stroke: "#000000", strokeWidth: 4, fontSize: 120, x: 800, y: 460 }),
  ] });
  const [brief] = await check("contrast", flashed(0.1));
  assert.equal(brief.severity, "warn");
  assert.equal(brief.at, 1.5);
  assert.match(brief.message, /has 1(\.\d+)?:1 contrast with what is behind it at 1\.5s; it needs 3:1\. It fails at 1\.5–1\.6 s \(0\.1 s\)\.$/);
  assert.equal(brief.fix.kind, "hint");
  assert.equal(brief.fix.text, "It fails only briefly (each time under 0.2 s), as when a flash or a passing layer is behind it. Leave it if that is on purpose, or keep the flash off the text.");

  // Behind it for 0.5 s: an error, with how long it lasts. A dark fill passes over the flash
  // but not over the dark scene the rest of the time, so the fix is a plate, not that fill (the
  // review: the fill op flipped the text between two colours, check after check).
  const [long] = await fires("contrast", flashed(0.5));
  assert.match(long.message, /It fails at 1\.5–2 s \(0\.5 s\)\. #\w{6} passes there but not everywhere it shows; a solid plate behind it works everywhere\.$/);
  assert.equal(long.fix.kind, "hint");
  assert.match(long.fix.text, /^No one colour passes everywhere it shows \(#\w{6} passes where it fails, then fails where it passes now\)\. Try, in order: a scrim gradient: \[\{"op":"add_layer".*Only if none fits, a solid plate: \[/);
});

test("contrast: a flash inside a longer failure is still an error, with one stretch", async () => {
  // Light grey text on a mid-grey plate while it shows, 0.5-2.5 s (about 1.8:1), with a 0.1 s
  // flash of its own grey at 1.5 s (1:1). The worst moment is the flash, the stretch is the
  // whole 2 s, and the fill fix passes on both (a dark fill).
  const document = scene({ background: "#111111", duration: 3, layers: [
    rect("plate", { x: 0, y: 0, width: 1920, height: 1080, fill: "#8a8a8a" }),
    rect("flash", { x: 0, y: 0, width: 1920, height: 1080, fill: "#bbbbbb", animations: [show(1.5), hide(1.6)] }),
    text("title", "Bake with us", { fill: "#bbbbbb", fontSize: 120, x: 400, y: 460, animations: [show(0.5), hide(2.5)] }),
  ] });
  const [finding] = await fires("contrast", document);
  // The time and contrast are the plate's, not the flash's (a review of agent edits).
  assert.notEqual(finding.at, 1.5, "the flash is not the moment reported");
  assert.ok(finding.measured > 1.5 && finding.measured < 2.2, `about 1.8:1 over the plate: ${finding.message}`);
  assert.match(finding.message, /It fails at 0\.5–2\.5 s \(2 s\)\.$/);
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.properties.fill.toLowerCase(), "#111111");
  assert.equal(finding.fix.auto, true);
});

// A review of agent edits: white text over a grey panel the whole time, with a near-white flash
// for 0.12 s at the middle of the text's shown time (the first frame measured). The time, the
// contrast and the fill came from the flash: a mid grey that passes against the flash but not
// against the panel, so fix:"auto" left the text failing and a second round was needed.
test("contrast: a fill fix passes over the whole failing stretch, not only at a flash inside it", async () => {
  const build = (fill) => scene({ background: "#101418", duration: 6, layers: [
    rect("panel", { x: 90, y: 300, width: 1740, height: 500, fill: "#b0b0b0" }),
    rect("chip", { x: 90, y: 900, width: 200, height: 100, fill: "#6e6e6e" }),
    text("save", "SAVE", { fill, fontWeight: 700, fontSize: 160, x: 700, y: 440 }),
    rect("flash", { x: 0, y: 0, width: 1920, height: 1080, fill: "#fafaf7", opacity: 0, animations: [{ kind: "custom", start: 3, duration: 0.12, easing: "linear", from: { opacity: 0.9 }, to: { opacity: 0 } }] }),
  ] });
  const [finding] = await fires("contrast", build("#ffffff"));
  assert.match(finding.message, /It fails at 0–6 s \(6 s\)\.$/);
  assert.notEqual(finding.at, 3, "not the flash");
  assert.ok(finding.measured > 1.8, `the panel's contrast, not the flash's 1.1:1: ${finding.message}`);
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
  // Before: #6e6e6e (2.35:1 over the panel). The fill given passes, so one round is enough.
  assert.notEqual(finding.fix.properties.fill, "#6e6e6e");
  await silent("contrast", build(finding.fix.properties.fill));
});

test("contrast: a long failure behind a panel is timed in one more render call, and a stretch ends at the scene's end", async () => {
  // The review: a 24 s scene with three white texts over light panels shown for 6-9 s each took
  // 9 render calls and 50 frames (about 6 times as long as before the stretches were timed),
  // halving from the passing picks to each edge one frame a round. Here white text is shown the
  // whole 12 s and a light panel is behind it 3-9 s.
  const document = scene({ background: "#111111", duration: 12, layers: [
    rect("panel", { x: 0, y: 300, width: 1920, height: 480, fill: "#eeeeee", animations: [show(3), hide(9)] }),
    text("save", "SAVE", { fill: "#ffffff", fontSize: 120, x: 800, y: 460 }),
  ] });
  const model = kinoTimeline(document, "scene", { fonts });
  const draw = frameRenderer(document);
  const calls = [];
  const renderFrames = (times, options) => { calls.push(times.length); return draw(times, options); };
  const { findings: [finding] } = await runQuality(model, { codes: ["contrast"], pixels: true, context: { renderFrames } });
  assert.equal(finding.severity, "error");
  // A dark fill passes over the panel but not over the dark scene: named, and the fix is a plate.
  assert.match(finding.message, /It fails at 3–9 s \(6 s\)\. #111111 passes there but not everywhere it shows; a solid plate behind it works everywhere\.$/);
  assert.equal(finding.fix.kind, "hint");
  // The plate the hint gives (a rectangle around the text, below it) passes everywhere.
  const [plate, below] = JSON.parse(finding.fix.text.match(/a solid plate: (\[\{"op":"add_layer".*?\}\])/)[1]);
  assert.deepEqual(below, { op: "move_layers", layers: ["save-plate"], position: "below", referenceId: "save" });
  assert.equal(plate.properties.fill, "#0b0b0c");
  await silent("contrast", scene({ background: "#111111", duration: 12, layers: [
    rect("panel", { x: 0, y: 300, width: 1920, height: 480, fill: "#eeeeee", animations: [show(3), hide(9)] }),
    rect("save-plate", plate.properties),
    text("save", "SAVE", { fill: "#ffffff", fontSize: 120, x: 800, y: 460 }),
  ] }));
  // The picks (0, 3, 6, 9 and 12 s), then the frames on each side of each edge in one call.
  assert.deepEqual(calls, [5, 2], `render calls and frames: ${calls}`);

  // Failing until the scene ends: the last sample is at 3 s, and the stretch ends there.
  const [whole] = await fires("contrast", scene({ background: "#111111", layers: [text("save", "SAVE", { fill: "#222222", fontSize: 120, x: 800, y: 460 })] }));
  assert.match(whole.message, /It fails at 0–3 s \(3 s\)\.$/);
});

// A review of agent edits: a light panel behind white text for the text's first 4.6 s (or its
// last 4.8 s) was a warning, "is fully shown at 0s while what is behind it still changes ... It
// passes once settled.", with no times, because only the first (or last) measured frame failed.
// A failure at the start or end of the text's shown time is now judged on how long it lasts.
test("contrast: a long failure at the start or end of the text's shown time is an error with its times; a short one is a warning with its times", async () => {
  const panelled = (animation) => scene({ background: "#000000", duration: 20, layers: [
    rect("panel", { x: 240, y: 160, width: 1440, height: 760, fill: "#e8e8e8", animations: [animation] }),
    text("cap", "SAVE", { fill: "#ffffff", fontFamily: "Inter", fontWeight: 700, fontSize: 140, x: 700, y: 440 }),
  ] });
  const fade = (start, duration, out) => ({ kind: out ? "out" : "in", start, duration, easing: "linear", from: { opacity: out ? 1 : 0 }, to: { opacity: out ? 0 : 1 } });

  // The panel fades out at 4.6-4.8 s: the text fails from 0 s to then.
  const [start] = await fires("contrast", panelled(fade(4.6, 0.2, true)));
  assert.equal(start.severity, "error");
  assert.ok(start.measured < 1.5, start.message);
  assert.match(start.message, /; it needs 3:1\. It fails at 0–4\.[6-8]\d* s \(4\.[6-8]\d* s\)\./);
  assert.doesNotMatch(start.message, /passes once settled/);

  // The mirror: the panel fades in at 15.2 s and stays to the end.
  const [end] = await fires("contrast", panelled(fade(15.2, 0.2, false)));
  assert.equal(end.severity, "error");
  assert.match(end.message, /It fails at 15\.[2-4]\d* ?–20 s \(4\.[6-8]\d* s\)\./);

  // A panel that is gone after 0.1 s: the text is readable once it settles, a warning that
  // still says when and how long it fails.
  const [brief] = await check("contrast", panelled(fade(0, 0.1, true)));
  assert.equal(brief.severity, "warn");
  assert.match(brief.message, /is fully shown at 0s while what is behind it still changes: .* It fails at 0–0\.\d+ s \(0\.\d+ s\), under 0\.2 s each time, and passes once settled\.$/);

  // A panel that fades in at 19.85 s for 0.1 s and stays: short, but the scene ends on it. This
  // said "is fully shown at 20s while what is behind it still changes … and passes once settled"
  // with the hint to bring the text in later.
  const [last] = await check("contrast", panelled(fade(19.85, 0.1, false)));
  assert.equal(last.severity, "warn");
  assert.match(last.message, /has 1\.\d+:1 contrast with what is behind it at (19\.9\d*|20)s; it needs 3:1\. It fails at 19\.9\d*–20 s \(0\.\d+ s\), until the scene ends\./);
  assert.doesNotMatch(last.message, /passes once settled/);
  assert.equal(last.fix.kind, "hint");
  const [plate] = JSON.parse(last.fix.text.match(/a solid plate: (\[\{"op":"add_layer".*?\}\])/)[1]);
  await silent("contrast", scene({ background: "#000000", duration: 20, layers: [
    rect("panel", { x: 240, y: 160, width: 1440, height: 760, fill: "#e8e8e8", animations: [fade(19.85, 0.1, false)] }),
    rect("cap-plate", plate.properties),
    text("cap", "SAVE", { fill: "#ffffff", fontFamily: "Inter", fontWeight: 700, fontSize: 140, x: 700, y: 440 }),
  ] }));

  // The same short stretch when the text leaves at 10 s, not at the scene's end: a light panel
  // fades in behind it at 9.88 s for 0.04 s. This said "is fully shown at 9.97s while what is
  // behind it still changes … and passes once settled" with the hint to bring the text in later,
  // although the panel had settled and the text never showed again.
  const leaving = scene({ background: "#111111", duration: 20, layers: [
    rect("panel", { x: 0, y: 0, width: 1920, height: 1080, fill: "#e8e8e8", animations: [fade(9.88, 0.04, false)] }),
    text("cap", "SAVE", { fill: "#ffffff", fontFamily: "Inter", fontWeight: 700, fontSize: 140, x: 700, y: 440, animations: [hide(10)] }),
  ] });
  const [gone] = await check("contrast", leaving);
  assert.equal(gone.severity, "warn");
  assert.match(gone.message, /has 1\.\d+:1 contrast with what is behind it at 9\.9\d*s; it needs 3:1\. It fails at 9\.9\d*–10 s \(0\.\d+ s\), until it leaves\./);
  assert.doesNotMatch(gone.message, /passes once settled|still changes/);
  assert.doesNotMatch(gone.fix.text ?? "", /Bring the text in/);
  const [leftPlate] = JSON.parse(gone.fix.text.match(/a solid plate: (\[\{"op":"add_layer".*?\}\])/)[1]);
  await silent("contrast", scene({ background: "#111111", duration: 20, layers: [
    rect("panel", { x: 0, y: 0, width: 1920, height: 1080, fill: "#e8e8e8", animations: [fade(9.88, 0.04, false)] }),
    rect("cap-plate", leftPlate.properties),
    text("cap", "SAVE", { fill: "#ffffff", fontFamily: "Inter", fontWeight: 700, fontSize: 140, x: 700, y: 440, animations: [hide(10)] }),
  ] }));
});

test("flashing: at most 3 flashes a second over a large area", async () => {
  // A dark panel covering a quarter of the frame blinks for 2 s. Bad: it switches every 0.1 s
  // (5 flashes a second). Good: every 0.3 s (under 2 a second).
  const blinking = (every) => {
    const animations = [];
    for (let time = 0.5, on = false; time < 2.5 - 1e-9; time += every, on = !on) animations.push(on ? show(time) : hide(time));
    return scene({ layers: [rect("panel", { x: 480, y: 270, width: 960, height: 540, fill: "#111111", animations })] });
  };
  const [finding] = await fires("flashing", blinking(0.1));
  assert.equal(finding.itemId, "panel");
  assert.equal(finding.fix.kind, "hint");
  assert.match(finding.required, /^at most 3 a second over \d+(\.\d)?%$/);
  await silent("flashing", blinking(0.3));
  // Flat frames made by separate layers (each plate alone changes twice) are one run: four white
  // frames 0.15 s apart are 8 changes in a second, although no one layer is over the rate.
  const plates = (gap) => scene({ background: "#111111", layers: [0, 1, 2, 3].map((index) =>
    rect(`plate-${index}`, { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [show(1 + index * gap), hide(1 + index * gap + 1 / 30)] })) });
  const [run] = await fires("flashing", plates(0.15));
  assert.match(run.itemId, /^plate-/);
  await silent("flashing", plates(0.5));
});

test("flashing: particles that twinkle fast over a large area flash although their layer holds still", async () => {
  // Bad: 800 big sparks standing still all over the frame, each twinkling fully 8 to 14 times a
  // second. Good: the sparks look at its default settings (small, moving, partly twinkling).
  const sparks = (to) => scene({ background: "#101418", duration: 4, layers: [rect("sparks", { x: 0, y: 0, width: 1920, height: 1080, fillEnabled: false, strokeWidth: 0, blendMode: "add",
    animations: [{ kind: "effect", effect: "sparks", start: 0, duration: 4, easing: "linear", keepStill: "both", to: { ...effectDefaults("sparks"), ...to } }] })] });
  const [finding] = await fires("flashing", sparks({ count: 800, size: 32, flicker: 1, speed: 0, gravity: 0, emitter: "area", trail: 0, glow: 0, softness: 0, lifetime: 4 }));
  assert.equal(finding.itemId, "sparks");
  assert.match(finding.measured, /^1[0-4] flashes a second/);
  await silent("flashing", sparks({}));
  await silent("flashing", sparks({ count: 800, size: 32, flicker: 0, speed: 0, gravity: 0, emitter: "area", trail: 0, glow: 0, softness: 0, lifetime: 4 }));
});

test("luma_jump: brightness stays between the two shots' brightness through a dissolve", async () => {
  // Two light plates over a black background. Bad: both fade at once (1 to 1.5 s), so the black
  // shows through mid-dissolve. Good: the new plate fades in over the old one, still full.
  const fade = (from, to) => ({ kind: "custom", start: 1, duration: 0.5, easing: "linear", from: { opacity: from }, to: { opacity: to } });
  const dissolve = (outgoing) => scene({ background: "#000000", duration: 2.5, layers: [
    rect("first", { x: 0, y: 0, width: 1920, height: 1080, fill: "#c8c8c8", animations: [outgoing, hide(1.5)] }),
    rect("second", { x: 0, y: 0, width: 1920, height: 1080, fill: "#d0d0d0", opacity: 0, animations: [fade(0, 1)] }),
  ] });
  const [finding] = await fires("luma_jump", dissolve(fade(1, 0)));
  assert.equal(finding.itemId, "second");
  assert.match(finding.measured, /^brightness 1[89]\d to 1[45]\d to 20\d \(0-255\) in the dissolve at 1\.\d+s$/);
  await silent("luma_jump", dissolve(fade(1, 1)));
  // A shade over a lit plate: fading in over 0.15 s (192 to 77) is a pop, over 0.3 s a fade.
  // A plate snapping dark with a 0.1 s color change is a pop too.
  const shaded = (layer) => scene({ background: "#c0c0c0", duration: 3, layers: [layer] });
  const shade = (duration) => rect("shade", { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", opacity: 0,
    animations: [{ kind: "custom", start: 1, duration, easing: "linear", from: { opacity: 0 }, to: { opacity: 0.6 } }] });
  assert.equal((await fires("luma_jump", shaded(shade(0.15))))[0].itemId, "shade");
  await silent("luma_jump", shaded(shade(0.3)));
  await fires("luma_jump", shaded(rect("plate", { x: 0, y: 0, width: 1920, height: 1080, fill: "#c0c0c0",
    animations: [{ kind: "custom", start: 1, duration: 0.1, easing: "linear", from: { fill: "#c0c0c0" }, to: { fill: "#202020" } }] })));
  // A zoom-through: a light plate pushes in 1.5x, then fades in 0.1 s off a dark plate. Only the
  // two shots show, covering the frame: their own brightness, silent. Bad: the dark plate fades
  // in with it, so the black background shows between them.
  const zoom = (under) => scene({ background: "#000000", duration: 2, layers: [
    rect("dark", { x: 0, y: 0, width: 1920, height: 1080, fill: "#202020", ...under }),
    rect("light", { x: 0, y: 0, width: 1920, height: 1080, fill: "#c8c8c8", animations: [
      { kind: "custom", start: 0.4, duration: 0.6, easing: "ease-in", from: { scaleX: 1, scaleY: 1 }, to: { scaleX: 1.5, scaleY: 1.5 } },
      { kind: "custom", start: 0.9, duration: 0.1, easing: "linear", from: { opacity: 1 }, to: { opacity: 0 } }] }),
  ] });
  await silent("luma_jump", zoom({}));
  await fires("luma_jump", zoom({ opacity: 0, animations: [{ kind: "custom", start: 0.9, duration: 0.1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }] }));
  // A shot that turns as it lands: its box covers the frame but its corners do not (black shows).
  await fires("luma_jump", scene({ background: "#000000", duration: 2, layers: [
    rect("old", { x: 0, y: 0, width: 1920, height: 1080, fill: "#c8c8c8", animations: [hide(1)] }),
    rect("new", { x: 0, y: 0, width: 1920, height: 1080, fill: "#c8c8c8", animations: [hide(0), show(1),
      { kind: "custom", start: 1, duration: 0.4, easing: "ease-out", from: { scaleX: 1.3, scaleY: 1.3, rotation: 45 }, to: { scaleX: 1, scaleY: 1, rotation: 0 } }] }),
  ] }));
  // A pop is judged on the frames its own opacity changes in: a light glow fading out over 0.4 s
  // just before a near-black panel pops off does not count. Bad: the panel is light.
  const popOff = (fill) => scene({ background: "#000000", duration: 2, layers: [
    rect("glow", { x: 0, y: 0, width: 1920, height: 1080, fill: "#808080", animations: [{ kind: "custom", start: 0.6, duration: 0.4, easing: "linear", from: { opacity: 1 }, to: { opacity: 0 } }] }),
    rect("panel", { x: 0, y: 0, width: 960, height: 540, fill, animations: [hide(1)] }),
  ] });
  await silent("luma_jump", popOff("#080808"));
  assert.equal((await fires("luma_jump", popOff("#c0c0c0")))[0].itemId, "panel");
  // A deliberate flash (a white full-frame shape for 0.2 s) is planned: the flashing gate holds it.
  await silent("luma_jump", scene({ background: "#202020", duration: 2, layers: [
    rect("hit", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [hide(0), show(1), hide(1.2)] })] }));
});

test("frozen_picture: a small clip whose picture holds still is a freeze", { skip: skipWithoutMediaTools }, async (t) => {
  // A 2 s clip in a box 6% of the frame (too small for frozen_footage). Bad: every frame of the
  // file is the same grey. Good: its brightness changes every frame.
  const root = await mkdtemp(join(tmpdir(), "kino-frozen-picture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"));
  await makeVideo(join(root, "media", "still.mp4"), { fps: 30, frames: 60, frameColor: () => [128, 128, 128] });
  await makeVideo(join(root, "media", "moving.mp4"), { fps: 30, frames: 60, frameColor: (n) => [n * 4, n * 4, n * 4] });
  const clip = (file, animations = []) => scene({ background: "#202020", duration: 2, layers: [
    { type: "video", id: "screen", name: "screen", x: 800, y: 300, width: 400, height: 300, src: `/api/media/${file}`, mediaFreeze: "none", animations },
  ] });
  const [finding] = await fires("frozen_picture", clip("still.mp4"), join(root, "media"));
  assert.equal(finding.itemId, "screen");
  assert.ok(finding.until - finding.at >= 1.5, `${finding.at} to ${finding.until}`);
  assert.match(finding.message, /^"screen" shows a still picture from 0 to 2 s \(its file from 0 to 2 s\)/);
  // Its ready fix, an eased push over the hold, leaves frozen_picture and linear_motion quiet.
  const { fix } = finding;
  assert.deepEqual([fix.kind, fix.technique], ["motion", "slow-push"]);
  const pushed = clip("still.mp4", [{ id: "screen.hold", kind: "custom", name: "Slow push", start: fix.start, duration: fix.duration, easing: fix.easing,
    from: { scaleX: 1, scaleY: 1 }, to: { scaleX: fix.scale, scaleY: fix.scale } }]);
  await silent("frozen_picture", pushed, join(root, "media"));
  await silent("linear_motion", pushed, join(root, "media"));
  assert.deepEqual(await check("frozen_footage", clip("still.mp4"), join(root, "media")), []);
  await silent("frozen_picture", clip("moving.mp4"), join(root, "media"));
});

test("a blurred full-frame clip keeps its edges, so a blur-through does not dim", { skip: skipWithoutMediaTools }, async (t) => {
  // A light clip filling a black frame blurs 0 to 48 and cuts to another at 48 back to 0: the
  // blur reads only the picture, so the edge stays as light as the middle and luma_jump is silent.
  // A dark plate snapping on mid-transition still fails.
  const root = await mkdtemp(join(tmpdir(), "kino-blur-edge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"));
  await makeVideo(join(root, "media", "light.mp4"), { width: 32, height: 18, fps: 30, frames: 60, frameColor: () => [200, 200, 200] });
  const blur = (start, from, to) => ({ kind: "custom", start, duration: 0.25, easing: "linear", from: { blur: from }, to: { blur: to } });
  const shot = (id, extra) => ({ type: "video", id, name: id, x: 0, y: 0, width: 1920, height: 1080, src: "/api/media/light.mp4", mediaFreeze: "none", ...extra });
  const through = (more = []) => scene({ background: "#000000", duration: 2, layers: [
    shot("out", { animations: [blur(0.75, 0, 48), hide(1)] }),
    shot("in", { animations: [hide(0), show(1), blur(1, 48, 0)] }),
    ...more,
  ] });
  const [frame] = await frameRenderer(through(), join(root, "media"))([1], { width: 192 });
  const middle = brightness(frame, { x0: 80, y0: 40, x1: 112, y1: 68 }), corner = brightness(frame, { x0: 0, y0: 0, x1: 4, y1: 4 });
  assert.ok(middle - corner < 3, `edge ${corner} vs middle ${middle}`);
  await silent("luma_jump", through(), join(root, "media"));
  await fires("luma_jump", through([rect("pop", { x: 0, y: 0, width: 1920, height: 1080, fill: "#202020", animations: [hide(0), show(1.05), hide(1.15)] })]), join(root, "media"));
});

test("a BT.709 clip draws the same pixels when another layer of the file needs Chromium", { skip: skipWithoutMediaTools }, async (t) => {
  // A product trailer: "walk-p2" measured 102.8 alone and 94.8 beside "setoff" (the same file, off screen
  // then, with a zoom blur that makes Chromium draw the scene). Chromium read the color tags FFmpeg
  // wrote into the picture and resvg did not, so luma_jump saw a step that was not in the edit.
  const root = await mkdtemp(join(tmpdir(), "kino-video-tags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"));
  await makeVideo(join(root, "media", "count.mp4"), { width: 32, height: 18, fps: 10, frames: 40, bt709: true, frameColor: (n) => [40 + n * 4, 40 + n * 4, 40 + n * 4] });
  const shot = (id, extra) => ({ type: "video", id, name: id, x: 0, y: 0, width: 1920, height: 1080, src: "/api/media/count.mp4", mediaFreeze: "none", ...extra });
  const late = shot("late", { mediaStart: 2, mediaDuration: 1, mediaOffset: 2 });
  const early = shot("early", { mediaStart: 0, mediaDuration: 1, animations: [{ kind: "effect", effect: "zoom-blur", start: 0, duration: 0.5, from: { amount: 0 }, to: { amount: 0.3 } }] });
  const draw = async (layers) => (await frameRenderer(scene({ background: "#000000", duration: 3, layers }), join(root, "media"))([2.5], { width: 192 }))[0];
  const alone = brightness(await draw([late])), beside = brightness(await draw([late, early]));
  assert.ok(Math.abs(alone - beside) < 1, `alone ${alone.toFixed(1)}, beside a Chromium layer ${beside.toFixed(1)}`);
});

test("a tagged PNG and a turned JPEG draw the same pixels when another layer of the file needs Chromium", async (t) => {
  // Chromium reads a PNG's gAMA chunk and a JPEG's EXIF orientation, resvg reads neither, so one
  // picture drew two ways depending on another layer. Both now draw it as a browser shows it:
  // the gAMA 1.0 purple brightened, the 64x32 red|blue JPEG turned upright (red on top).
  const root = await mkdtemp(join(tmpdir(), "kino-image-tags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"));
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(100000);
  await writeFile(join(root, "media", "gamma.png"), pngWith(await solidPng([128, 64, 200]), "gAMA", gamma));
  await writeFile(join(root, "media", "turned.jpg"), await turnedJpeg());
  const blur = { type: "rectangle", id: "blur", name: "blur", x: 0, y: 0, width: 10, height: 10, fill: "#000000",
    animations: [{ kind: "effect", effect: "zoom-blur", start: 0, duration: 0.5, from: { amount: 0 }, to: { amount: 0.3 } }] };
  const picture = (src) => ({ type: "image", id: "picture", name: "picture", x: 0, y: 0, width: 1920, height: 1080, src });
  const draw = async (layers) => (await frameRenderer(scene({ background: "#000000", duration: 1, layers }), join(root, "media"))([0.25], { width: 192 }))[0];
  const color = (frame, x, y) => [...frame.pixels.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3)];
  for (const [src, x, y, expected] of [["/api/media/gamma.png", 96, 54, [188, 137, 229]], ["/api/media/turned.jpg", 60, 20, [255, 0, 0]], ["/api/media/turned.jpg", 60, 88, [0, 0, 255]]]) {
    const alone = color(await draw([picture(src)]), x, y), beside = color(await draw([picture(src), blur]), x, y);
    for (const drawn of [alone, beside])
      assert.ok(drawn.every((value, index) => Math.abs(value - expected[index]) <= 8), `${src} at ${x},${y}: alone ${alone}, beside a Chromium layer ${beside}, want ${expected}`);
  }
});

// A review of agent edits: with 21 or more texts failing, only the first 40 edges were searched and
// the others kept the longest stretch they could be, so a 0.1 s flash behind the 21st text was
// timed as most of a second and made an error. Edges that share frames are now searched together,
// and an edge that is not searched never makes a failure longer.
test("contrast: 21 texts behind one 0.1 s flash are each a warning with the flash's times", async () => {
  const texts = Array.from({ length: 21 }, (_, index) => text(`t${index + 1}`, "SAVE", {
    fill: "#ffffff", stroke: "#000000", strokeWidth: 4, fontSize: 80, x: 60 + (index % 7) * 260, y: 120 + Math.floor(index / 7) * 300 }));
  const findings = await check("contrast", scene({ background: "#111111", layers: [
    rect("flash", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [show(1.5), hide(1.6)] }), ...texts] }));
  assert.equal(findings.length, 21);
  for (const finding of findings) {
    assert.equal(finding.severity, "warn", finding.message);
    assert.match(finding.message, /It fails at 1\.5–1\.6 s \(0\.1 s\)\.$/);
  }
});

test("a rendered check stopped by a layer with no file says to fix the layer; another stop is the checker's", async () => {
  const document = scene({ background: "#111111", duration: 2, layers: [text("save", "SAVE", { fill: "#ffffff", fontSize: 120, x: 800, y: 460 })] });
  const model = kinoTimeline(document, "scene", { fonts });
  const stopped = async (message) => (await runQuality(model, { codes: ["contrast"], pixels: true, context: { renderFrames: () => { throw new Error(message); } } })).findings[0];
  const noFile = await stopped("Video layer “build-target” has no src (no media file).");
  assert.equal(noFile.message, "The contrast check could not run: Video layer “build-target” has no src (no media file).");
  assert.match(noFile.fix.text, /^Fix that layer: import its file/);
  assert.match((await stopped("out of memory")).fix.text, /checker problem/);
});
