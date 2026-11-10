// One bad and one good example for each data rule of the quality checker (engine/quality/).
//
// Each test builds a small kino document the way an agent would (layers with animations),
// turns it into the checker's model with kinoTimeline, and runs only the rule under test.
// The bad and good scenes differ only in the thing the rule is about, so each pair shows
// where the rule draws its line. The pixel rules (contrast, flashing) are tested in
// backend/quality-pixels.test.mjs because they need the renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { RULES, blocksFinal, ruleOf, runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { judderBlurId } from "./quality/techniques.js";

// ---------------------------------------------------------------- builders

const PAPER = "#f5f2ea"; // an off-white background, so pure_frame stays quiet by default
const INK = "#1a1a1a";

// A text layer. `textResize: "width-height"` sizes the box to the words, and x, y is its top left.
function text(id, value, props = {}) {
  return { type: "text", id, name: id, text: value, fontFamily: "Noto Serif", fontSize: 72, fill: INK, textResize: "width-height", x: 200, y: 200, ...props };
}

function rect(id, props = {}) {
  return { type: "rectangle", id, name: id, fill: "#3a5a40", x: 200, y: 200, width: 320, height: 180, ...props };
}

// Animations. Each takes its start and duration in seconds.
const fadeIn = (start, duration = 0.5, easing = "smooth") => ({ kind: "in", start, duration, easing, from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = (start, duration = 0.35, easing = "ease-in") => ({ kind: "out", start, duration, easing, from: { opacity: 1 }, to: { opacity: 0 } });
const show = (start) => ({ kind: "show", start });
const hide = (start) => ({ kind: "hide", start });
// A move from one place to another; `to` left out means "to the layer's own place".
const move = (start, duration, easing, from, to = {}, kind = "custom") => ({ kind, start, duration, easing, from, to });

/**
 * A parsed kino document with one scene. `layers` come from text() and rect() (or any layer
 * fields); the rest are scene fields (duration, width, height, background, assertions) or
 * document fields (videoType, rhythm).
 */
function scene({ layers = [], videoType, rhythm, ...sceneFields } = {}) {
  const built = layers.map((layer) => {
    const { type, animations = [], ...fields } = layer;
    // Animation IDs must be unique in the document: the layer ID plus a number.
    const named = animations.map((animation, index) => ({ id: `${fields.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation }));
    return createLayer(type, { ...fields, animations: named });
  });
  const document = createDocument({
    scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 4, background: PAPER, ...sceneFields, layers: built })],
    ...(videoType ? { videoType } : {}),
    ...(rhythm ? { rhythm } : {}),
  });
  return parseDocument(document);
}

/** The checker's model of the document's scene. */
function modelOf(document) {
  return kinoTimeline(document, "scene", { fonts: defaultFonts });
}

/**
 * Runs one rule on the document's scene. Resolves to {findings, notes}. A test can pass a model
 * instead, changed to stand for what another tool's adapter would put in it.
 */
async function check(code, document, context = {}) {
  const model = document.items ? document : modelOf(document);
  return runQuality(model, { codes: [code], pixels: false, context });
}

const covered = new Set();

/** Runs the rule and asserts it fires; returns its findings. */
async function fires(code, document, context) {
  covered.add(code);
  const { findings } = await check(code, document, context);
  assert.ok(findings.length > 0, `${code} should fire on the bad example`);
  for (const finding of findings) {
    assert.equal(finding.rule, code);
    assert.ok(!finding.internal, finding.message);
  }
  assert.equal(findings[0].severity, ruleOf(code).level);
  return findings;
}

/** Runs the rule and asserts it finds nothing. Resolves to the run's notes. */
async function silent(code, document, context) {
  covered.add(code);
  const { findings, notes } = await check(code, document, context);
  assert.deepEqual(findings.map((finding) => finding.message), [], `${code} should stay silent on the good example`);
  return notes;
}

// ---------------------------------------------------------------- text rules

// 60 characters: they need 3 s of reading time.
const LONG_LINE = "Fresh bread from our ovens every morning, delivered by nine.";
const readFor = (exitAt, exitEasing = "ease-in", props = {}) => scene({ duration: 5, layers: [
  text("line", LONG_LINE, { fontSize: 48, ...props, animations: [fadeIn(0.2, 0.4), fadeOut(exitAt, 0.35, exitEasing)] })] });

test("reading_time: text must stay readable for its characters ÷ 20 seconds", async () => {
  // The text settles at 0.6 s. Bad: its exit starts at 1.6 s. Good: at 4 s.
  const [finding] = await fires("reading_time", readFor(1.6));
  assert.equal(finding.required, 3);
  assert.ok(finding.measured < 2, `measured ${finding.measured}`);
  await silent("reading_time", readFor(4));
  // The product's own text (role ui: a screen's row, shown briefly) is read with the screen.
  await silent("reading_time", readFor(1.6, "ease-in", { role: "ui" }));
});

test("reading_time: a typed line is read while it types, if the whole line then holds 20 frames", async () => {
  // 60 characters need 3 s. Typed letter by letter from 0.2 s to about 2.65 s (0.04 s a letter).
  const typed = (exitAt) => scene({ duration: 5, layers: [text("line", LONG_LINE, { fontSize: 48,
    animations: [{ ...fadeIn(0.2, 0.05), unit: "letters", stagger: 0.04 }, fadeOut(exitAt, 0.2, "ease-in")] })] });
  // Good: held about 0.9 s after the last letter. Bad: gone 0.15 s after it.
  await silent("reading_time", typed(3.6));
  await fires("reading_time", typed(2.8));
});

// A camera tour: a 1920x1080 group "arch" holds at x 0 until 1 s, travels to `stopX` (1.4 s),
// holds until 2.3 s, then pulls back to x 0 at half size (2.8 s) and holds to the end. Its
// texts are laid out on a canvas wider than the frame.
const tour = (texts, { stopX = -1100, duration = 4 } = {}) => scene({ duration, layers: [
  { type: "group", id: "arch", name: "arch", x: 0, y: 0, width: 1920, height: 1080, animations: [
    move(1, 0.4, "smooth", { x: 0 }, { x: stopX }),
    move(2.3, 0.5, "smooth", { x: stopX, scaleX: 1, scaleY: 1 }, { x: 0, scaleX: 0.5, scaleY: 0.5 })] },
  ...texts.map((layer) => ({ ...layer, parentId: "arch" }))] });

test("reading_time: a camera tour's text is read at its stop and again in the pull-back", async () => {
  // Cut by the frame edge at the first stop, then shown 0.9 s at its own stop and 1.2 s in the
  // pull-back: 2.1 s in all for the 1.45 s it needs. Bad: the video ends 0.4 s into the pull-back.
  const card = text("sees-model", "yolo11n · owlv2 qwen2.5-vl-7b", { fontSize: 48, x: 1500, y: 500 });
  const [finding] = await fires("reading_time", tour([card], { duration: 3.2 }));
  assert.ok(finding.measured < 1.2, `measured ${finding.measured}`);
  await silent("reading_time", tour([card]));
  // Bad: a text that shrinks itself to a speck (0.08) and holds there is not read while it holds.
  const speck = text("speck", LONG_LINE.slice(0, 41), { fontSize: 72, animations: [move(0.3, 0.4, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: 0.08, scaleY: 0.08 })] });
  const [tiny] = await fires("reading_time", scene({ layers: [speck] }));
  assert.ok(tiny.measured < 1, `measured ${tiny.measured}`);
});

test("reading_time: the fix starts the exit later", async () => {
  const [finding] = await fires("reading_time", readFor(1.6, "smooth"));
  assert.equal(finding.fix.kind, "tween");
  assert.equal(finding.fix.tweenId, "line.2");
  assert.ok(finding.fix.properties.start >= 3.3, `start ${finding.fix.properties.start}`);
});

test("reading_time: the fix starts the exit later when the exit eases in", async () => {
  const [finding] = await fires("reading_time", readFor(1.6, "ease-in"));
  assert.equal(finding.fix.kind, "tween");
});

test("type_min: body text must be drawn at 36 px or more in a 1080p frame", async () => {
  // Bad: the body line is 20 px. Good: 40 px. The headline is 96 px in both.
  const page = (bodySize) => scene({ layers: [
    text("headline", "Bake with us", { role: "headline", fontSize: 96, y: 200 }),
    text("body", "Classes every Saturday", { role: "body", fontSize: bodySize, y: 420 }),
  ] });
  const [finding] = await fires("type_min", page(20));
  assert.equal(finding.itemId, "body");
  assert.equal(finding.required, 36);
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.fontSize, 36);
  await silent("type_min", page(40));
  // A small UI row in the product's own words (role ui) keeps its size.
  await silent("type_min", scene({ layers: [text("headline", "Bake with us", { role: "headline", fontSize: 96, y: 200 }), text("row", "Classes every Saturday", { role: "ui", fontSize: 20, y: 420 })] }));
});

test("type_min: the headline must be drawn at 64 px or more", async () => {
  const page = (size) => scene({ layers: [text("headline", "Bake with us", { role: "headline", fontSize: size })] });
  const [finding] = await fires("type_min", page(56));
  assert.equal(finding.required, 64);
  await silent("type_min", page(72));
  // A web address under the logo on an end card is a label, not the headline, even with no role.
  await silent("type_min", scene({ layers: [text("logo", "oak", { role: "logo", fontSize: 160 }), text("url", "oak.dev", { fontSize: 44, y: 700 })] }));
});

test("hold: text stays on screen for its recommended hold (0.2 s a word + 2 s)", async () => {
  // Five words need 3 s. Bad: shown for 2 s. Good: 3.5 s.
  const shown = (hideAt) => scene({ duration: 5, layers: [text("line", "Fresh bread every single morning", { animations: [show(0.5), hide(hideAt)] })] });
  const [finding] = await fires("hold", shown(2.5));
  assert.equal(finding.required, 3);
  assert.equal(finding.measured, 2);
  assert.match(finding.message, /^"line" "Fresh bread every single morning" is on screen 2s/);
  await silent("hold", shown(4));
});

test("hold: a layer named after its text is named once", async () => {
  const LINE = "Fresh bread every single morning";
  const document = scene({ duration: 5, layers: [text("line", LINE, { name: LINE, animations: [show(0.5), hide(2.5)] })] });
  const [finding] = await fires("hold", document);
  assert.match(finding.message, /^"Fresh bread every single morning" is on screen 2s/);
});

// ---------------------------------------------------------------- motion rules

test("linear_motion: a move must not use linear easing", async () => {
  // Bad: the slide in is linear. Good: ease-out. The fix for an entrance is expo-out.
  const slide = (easing) => scene({ layers: [text("title", "Launch day", { y: 400, animations: [move(0.2, 0.6, easing, { y: 500, opacity: 0 }, { opacity: 1 }, "in")] })] });
  const [finding] = await fires("linear_motion", slide("linear"));
  assert.equal(finding.fix.kind, "tween");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.easing, "smooth");
  await silent("linear_motion", slide("ease-out"));
});

test("linear_motion: a layer marked perpetual may loop at a constant speed", async () => {
  // A spinning badge: linear on purpose when it is marked perpetual.
  const spinner = (perpetual) => scene({ layers: [rect("spinner", { width: 120, height: 120, perpetual, animations: [move(0, 4, "linear", { rotation: 0 }, { rotation: 360 })] })] });
  await fires("linear_motion", spinner(false));
  await silent("linear_motion", spinner(true));
  // A loop behavior (engine/behavior.js) counts as perpetual too.
  await silent("linear_motion", scene({ layers: [rect("spinner", { width: 120, height: 120,
    animations: [{ ...move(0, 1, "linear", { rotation: 0 }, { rotation: 360 }), behavior: { loop: { mode: "cycle" } } }] })] }));
});

test("linear_motion and duration_band: a slow camera push may be linear and long", async () => {
  // In one edit a 3 s push-in from scale 1 to 1.12 with linear easing was an error, and a
  // warning said to make it 2 s. Its corners move about 2% of the frame's diagonal a second.
  const push = ({ duration = 3, to = 1.12, easing = "linear", width = 1080, height = 1920, extra = {} } = {}) => scene({ width, height, duration: 6,
    layers: [rect("plate", { x: 0, y: 0, width, height, animations: [move(0, duration, easing, { scaleX: 1, scaleY: 1, ...extra.from }, { scaleX: to, scaleY: to, ...extra.to })] })] });
  await silent("linear_motion", push());
  await silent("duration_band", push());
  await silent("duration_band", push({ easing: "smooth" }));
  await silent("linear_motion", push({ width: 1920, height: 1080, duration: 4, to: 1.15 }));
  // A drift of 60 px over 3 s is slow too.
  await silent("linear_motion", push({ to: 1, extra: { from: { x: 0 }, to: { x: 60 } } }));
  // Faster is still a move that should ease: 1 to 1.2 in 2 s (5% a second), 1 to 1.5 in 3 s,
  // a 600 px slide over 3 s, a slow push that also turns, and any push under 2 s.
  for (const document of [push({ duration: 2, to: 1.2 }), push({ to: 1.5 }), push({ to: 1, extra: { from: { x: 0 }, to: { x: 600 } } }),
    push({ extra: { from: { rotation: 0 }, to: { rotation: 2 } } }), push({ duration: 1.5, to: 1.05 })]) {
    const [finding] = await fires("linear_motion", document);
    assert.equal(finding.severity, "error");
  }
  await fires("duration_band", push({ to: 1.5, easing: "smooth" }));
});

test("linear_motion and duration_band: only a big layer's slow move is a push; a slow text entrance or a small drift is not", async () => {
  // The review of the slow push: on a 1080x1920 scene a headline that rises 160 px over 2 s
  // ("Rise", kind in) and a body text that drifts in 180 px over 2.2 s ("Drift in") with linear
  // easing were silent, and so was the drift's duration_band warning. They enter and stop dead.
  const tall = (layers) => scene({ width: 1080, height: 1920, duration: 6, layers });
  const rise = tall([text("title", "Launch day", { role: "headline", fontSize: 120, x: 140, y: 700, animations: [move(0, 2, "linear", { y: 860, opacity: 0 }, { opacity: 1 }, "in")] })]);
  const [risen] = await fires("linear_motion", rise);
  assert.equal(risen.severity, "error");
  assert.equal(risen.itemId, "title");
  const drift = tall([text("sub", "Fresh every morning", { role: "body", fontSize: 40, x: 140, y: 900, animations: [{ ...move(0, 2.2, "linear", { x: -40, opacity: 0 }, { opacity: 1 }, "in"), name: "Drift in" }] })]);
  assert.equal((await fires("linear_motion", drift))[0].severity, "error");
  const [band] = await fires("duration_band", drift);
  assert.match(band.message, /takes 2\.2s to enter; for its size that is slow \(standard: 0\.3–1\.1s\)/);
  // A text is not a camera push even as a custom move, nor is a small card that drifts 60 px.
  await fires("linear_motion", tall([text("sub", "Fresh every morning", { fontSize: 40, x: 140, y: 900, animations: [move(0, 3, "linear", { x: 80 }, { x: 140 })] })]));
  await fires("linear_motion", tall([rect("card", { x: 100, y: 300, width: 400, height: 300, animations: [move(0, 3, "linear", { x: 100 }, { x: 160 })] })]));
  // The same small card as the background is a drift of the picture.
  await silent("linear_motion", tall([rect("card", { role: "background", x: 100, y: 300, width: 400, height: 300, animations: [move(0, 3, "linear", { x: 100 }, { x: 160 })] })]));
});

test("linear_motion: a slow push is measured on screen, so a layer bigger than the frame passes as the frame would", async () => {
  // The review: a full-frame push 1 -> 1.2 over 4 s passed, but the same push of a 3413x1920
  // layer centred on the frame (x -1166.667) was an error, because its corners far off screen
  // were measured; and one edit's world group (5837x3168) pushed 1 -> 1.12 over 3 s was an
  // error with a duration_band warning.
  const push = (layers) => scene({ width: 1080, height: 1920, duration: 6, layers });
  const grow = (start, duration, to) => move(start, duration, "linear", { scaleX: 1, scaleY: 1 }, { scaleX: to, scaleY: to });
  await silent("linear_motion", push([rect("plate", { x: 0, y: 0, width: 1080, height: 1920, animations: [grow(0, 4, 1.2)] })]));
  await silent("linear_motion", push([rect("wide", { x: -1166.667, y: 0, width: 3413.333, height: 1920, animations: [grow(0, 4, 1.2)] })]));
  const world = push([
    { type: "group", id: "world", name: "world", x: -2378.5, y: -624, width: 5837, height: 3168, animations: [grow(0, 3, 1.12)] },
    rect("plate", { x: 0, y: 0, width: 5837, height: 3168, parentId: "world" }),
  ]);
  await silent("linear_motion", world);
  await silent("duration_band", world);
  // On screen the same as a fast push, it is still an error: 1 -> 1.5 over 3 s.
  const [fast] = await fires("linear_motion", push([rect("wide", { x: -1166.667, y: 0, width: 3413.333, height: 1920, animations: [grow(0, 3, 1.5)] })]));
  assert.equal(fast.itemId, "wide");
  // An entrance of a full-frame layer is not a push either.
  await fires("linear_motion", push([rect("plate", { x: 0, y: 0, width: 1080, height: 1920, animations: [{ ...grow(0, 3, 1.12), kind: "in" }] })]));
});

test("motion rules leave a hidden layer alone: no first_entrance, linear_motion or duration_band for visible:false or opacity 0", async () => {
  // In the review, check warned "The first entrance after the start (miasma) begins at once" for a
  // layer hidden with visible:false, and its fix moved the hidden layer's animation.
  // (A fade-in would show a layer at opacity 0: the animation's value is drawn over the layer's.)
  const overlay = (fields) => scene({ layers: [rect("miasma", { x: 0, y: 0, width: 1920, height: 1080, ...fields,
    animations: [move(0, 0.5, "ease-out", { y: 200 }, {}, "in"), move(0.5, 3, "linear", { x: 0 }, { x: 600 })] }), text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  const [first] = await fires("first_entrance", overlay({}));
  // Its fix starts the entrance 0.2 s after the cut, automatically.
  assert.deepEqual([first.fix.changes[0].properties.start, first.fix.auto], [0.2, true]);
  await fires("linear_motion", overlay({}));
  for (const hidden of [{ visible: false }, { opacity: 0 }]) {
    await silent("first_entrance", overlay(hidden));
    await silent("linear_motion", overlay(hidden));
    await silent("duration_band", overlay(hidden));
  }
  // A layer in a hidden group is not drawn either.
  const grouped = scene({ layers: [
    { type: "group", id: "pack", name: "pack", x: 0, y: 0, width: 1920, height: 1080, visible: false },
    rect("miasma", { x: 0, y: 0, width: 1920, height: 1080, parentId: "pack", animations: [fadeIn(0, 0.5)] }),
    text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  await silent("first_entrance", grouped);
});

// The findings of a run as "rule: message", without the technique rules: those count techniques
// (engine/quality/techniques.js), so they see a speed ramp, a blur or a flare on purpose.
const TECHNIQUE_RULES = new Set(["text_slides", "few_techniques", "plain_beats", "technique_repeat", "metronome", "cut_motivation", "beat_kick", "flat_sections", "style_avoided", "style_wanted", "deck_unused", "busy_edit"]);
const motionMessages = (result) => result.findings.filter((finding) => !TECHNIQUE_RULES.has(finding.rule)).map((finding) => `${finding.rule}: ${finding.message}`);

test("clip speed is not motion: a linear Speed ramp, mediaSpeed, mediaReverse and mediaFrameRate add no findings", async () => {
  const clip = (timing) => ({ type: "video", id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaSourceDuration: 20, ...timing });
  const plain = scene({ layers: [clip({}), text("title", "Launch day", { animations: [fadeIn(0.2)] })] });
  const sped = scene({ layers: [clip({ mediaSpeed: 2, mediaReverse: true, mediaFrameRate: 12, mediaPitch: "follow",
    animations: [{ kind: "custom", start: 0, duration: 2, easing: "linear", from: { speed: 1 }, to: { speed: 0.25 } }] }), text("title", "Launch day", { animations: [fadeIn(0.2)] })] });
  const model = modelOf(sped);
  assert.deepEqual(model.tweens.filter((tween) => tween.keys.includes("speed")), [], "a Speed animation is not a tween");
  const messages = async (document) => motionMessages(await runQuality(modelOf(document), { pixels: false }));
  assert.deepEqual(await messages(sped), await messages(plain));
});

test("blur and edge effects are not motion: a whip's blur that falls back to 0 adds no duration_band or other finding", async () => {
  const blur = (start, duration, easing, from, to) => ({ kind: "effect", effect: "directional-blur", start, duration, easing, ...(from ? { from } : {}), to });
  const whip = move(1, 0.4, "natural", { x: -1400 }, { x: 560 });
  const plain = scene({ layers: [rect("panel", { width: 800, height: 400, animations: [whip] })] });
  const blurred = scene({ layers: [rect("panel", { width: 800, height: 400, animations: [whip,
    blur(1, 0.2, "ease-in", { length: 0, angle: 0 }, { length: 400, angle: 0 }), blur(1.2, 0.2, "ease-out", undefined, { length: 0, angle: 0 }),
    { kind: "effect", effect: "edge-fill", start: 1, duration: 0.4, to: { mode: "mirror", extend: 0.5 } },
    { kind: "effect", effect: "kaleidoscope", start: 2, duration: 0.2, easing: "linear", from: { angle: 0 }, to: { segments: 8, angle: 90 } }] })] });
  assert.equal(modelOf(blurred).tweens.length, 1, "only the move is a tween");
  const messages = async (document) => motionMessages(await runQuality(modelOf(document), { pixels: false }));
  assert.deepEqual(await messages(blurred), await messages(plain));
});

test("effect parameters are not layer properties: a lens flare's x and y are no move, and a steady glow or flare is no motion", async () => {
  const flare = (to, from) => ({ kind: "effect", effect: "lens-flare", start: 0, duration: 2, easing: "linear", keepStill: "both", to, ...(from ? { from } : {}) });
  const glow = { kind: "effect", effect: "glow", start: 0, duration: 2, easing: "linear", keepStill: "both", to: { strength: 1, color: "#FF2A6D", colorMix: 1 } };
  const layers = (flareAnimation) => [rect("sun", { width: 120, height: 120, animations: [flareAnimation] }),
    text("title", "Launch day", { animations: [fadeIn(0.2), glow] })];
  const plain = scene({ layers: [rect("sun", { width: 120, height: 120 }), text("title", "Launch day", { animations: [fadeIn(0.2)] })] });
  const messages = async (document) => motionMessages(await runQuality(modelOf(document), { pixels: false }));
  // A steady glow and a steady flare, held for the whole 2 s, add no findings.
  const steady = scene({ layers: layers(flare({ x: 0.7, y: 0.2 })) });
  assert.deepEqual(modelOf(steady).tweens.map((tween) => tween.itemId), ["title"], "only the fade is a tween");
  assert.deepEqual(await messages(steady), await messages(plain));
  // A flare that sweeps linearly moves its light, not the layer: no linear_motion error.
  const sweep = scene({ layers: layers(flare({ x: 1.2, y: 0.4 }, { x: -0.1, y: 0.2 })) });
  const keys = modelOf(sweep).tweens.find((tween) => tween.itemId === "sun").keys;
  assert.ok(keys.includes("effect.lens-flare.x") && keys.every((key) => key.startsWith("effect.lens-flare.")), keys.join(", "));
  await silent("linear_motion", sweep);
});

test("a problem that lasts 2 samples or less is info, not an error", async () => {
  // A linear move of 0.05 s is 1.5 samples at 30 a second.
  const { findings } = await check("linear_motion", scene({ layers: [rect("blip", { animations: [move(1, 0.05, "linear", { x: 180 })] })] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
});

test("spring_on_fade: no bounce on opacity", async () => {
  // Bad: the fade uses bounce easing, so it flickers. Good: smooth.
  const fade = (easing) => scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2, 0.8, easing)] })] });
  const [finding] = await fires("spring_on_fade", fade("bounce"));
  assert.equal(finding.fix.kind, "tween");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.easing, "smooth");
  await silent("spring_on_fade", fade("smooth"));
});

test("same_motion: four animated layers must not all share one easing and duration", async () => {
  // Bad: all four fade in over 0.5 s with smooth easing. Good: the headline takes 1 s.
  const four = (headlineDuration) => scene({ layers: [
    text("headline", "Bake with us", { y: 120, animations: [fadeIn(0.2, headlineDuration)] }),
    text("one", "Sourdough", { fontSize: 48, y: 360, animations: [fadeIn(0.4)] }),
    text("two", "Rye", { fontSize: 48, y: 480, animations: [fadeIn(0.6)] }),
    text("three", "Brioche", { fontSize: 48, y: 600, animations: [fadeIn(0.8)] }),
  ] });
  const [finding] = await fires("same_motion", four(0.5));
  assert.equal(finding.fix.kind, "hint");
  await silent("same_motion", four(1));
});

test("easing_repeat: at most two separate motions share an easing and duration", async () => {
  // Three cards, entering one after another. Bad: all smooth 0.5 s. Good: the third eases out.
  const three = (thirdEasing, props = {}) => scene({ layers: [
    rect("one", { y: 100, ...props, animations: [fadeIn(0.2)] }),
    rect("two", { y: 400, ...props, animations: [fadeIn(0.8)] }),
    rect("three", { y: 700, ...props, animations: [fadeIn(1.4, 0.5, thirdEasing)] }),
  ] });
  const [finding] = await fires("easing_repeat", three("smooth"));
  assert.equal(finding.measured, 3);
  await silent("easing_repeat", three("ease-out"));
  // A move's parts (a tile wall) share the move's timing by design.
  await silent("easing_repeat", three("smooth", { move: { name: "tile-ring", instance: "tile-ring", part: "tile" } }));
  // Captions that arrive one way are one type style (busy_edit asks for that), not a machine tell.
  await silent("easing_repeat", scene({ layers: [
    text("say1", "Sourdough", { y: 200, animations: [fadeIn(0.2)] }),
    text("say2", "Rye", { y: 400, animations: [fadeIn(0.8)] }),
    text("say3", "Brioche", { y: 600, animations: [fadeIn(1.4)] }),
  ] }));
});

test("reading_time: text that pops in past its size and settles is read at its settled size", async () => {
  // "overshoot" grows the title to about 112% before it settles at 100%.
  const title = text("title", "Hello", { animations: [move(0.3, 0.6, "overshoot", { scaleX: 0.4, scaleY: 0.4 }, {}, "in")] });
  await silent("reading_time", scene({ layers: [title] }));
});

test("bouncy_layers: at most one layer bounces", async () => {
  // Two icons pop in. Bad: both bounce. Good: the second eases out.
  const pop = (easing) => move(0.3, 0.8, easing, { scaleX: 0.4, scaleY: 0.4 }, {}, "in");
  const icons = (secondEasing) => scene({ layers: [
    rect("icon-a", { x: 300, width: 160, height: 160, animations: [pop("bounce")] }),
    rect("icon-b", { x: 700, width: 160, height: 160, animations: [pop(secondEasing)] }),
  ] });
  const [finding] = await fires("bouncy_layers", icons("bounce"));
  assert.deepEqual(finding.itemIds, ["icon-a", "icon-b"]);
  await silent("bouncy_layers", icons("ease-out"));
});

test("bouncy_layers: a curve that wobbles bounces, whatever its easing is called", async () => {
  // Easings can come with outside names ("elastic.out(1,0.6)"), so the rule reads the curve's shape.
  // Bad: both icons' curves wobble under an outside name. Good: the second is a plain ease-out.
  const renamed = (secondEasing) => {
    const model = modelOf(scene({ layers: [
      rect("icon-a", { x: 300, width: 160, height: 160, animations: [move(0.3, 0.8, "elastic", { scaleX: 0.4, scaleY: 0.4 }, {}, "in")] }),
      rect("icon-b", { x: 700, width: 160, height: 160, animations: [move(0.3, 0.8, secondEasing, { scaleX: 0.4, scaleY: 0.4 }, {}, "in")] }),
    ] }));
    for (const tween of model.tweens) tween.easing = tween.wobbles ? "elastic.out(1,0.6)" : "power2.out";
    return model;
  };
  const [finding] = await fires("bouncy_layers", renamed("elastic"));
  assert.deepEqual(finding.itemIds, ["icon-a", "icon-b"]);
  await silent("bouncy_layers", renamed("ease-out"));
});

test("duration_band: a button-sized layer enters in 0.3–1.1 s", async () => {
  // A 360×120 button (2% of the frame). Bad: 0.12 s. Good: 0.4 s.
  const button = (duration) => scene({ layers: [rect("button", { width: 360, height: 120, y: 700, animations: [move(0.2, duration, "ease-out", { y: 740, opacity: 0 }, { opacity: 1 }, "in")] })] });
  const [finding] = await fires("duration_band", button(0.12));
  assert.equal(finding.required, "0.3–1.1s");
  assert.equal(finding.fix.kind, "tweens");
  assert.equal(finding.fix.changes[0].properties.duration, 0.3);
  await silent("duration_band", button(0.4));
  // A whip preset is quick on purpose.
  const whip = button(0.12);
  whip.scenes[0].layers[0].animations[0].preset = { id: "whip", mode: "in", parameters: { direction: "up", distance: 120 } };
  await silent("duration_band", whip);
});

test("duration_band: a quick fade, a key press and an exit that ends on a cut are not rushed moves", async () => {
  // A full-frame plate fading in over 0.1 s reads as a soft cut; sliding in over 0.1 s is rushed.
  const plate = (from) => scene({ layers: [rect("plate", { x: 0, y: 0, width: 1920, height: 1080, animations: [move(0.5, 0.1, "ease-out", from, { opacity: 1 }, "in")] })] });
  await silent("duration_band", plate({ opacity: 0 }));
  await fires("duration_band", plate({ x: 300, opacity: 0 }));
  // A key pressed in 0.08 s (scale 0.95) is quick on purpose; a card shrinking by half that fast is not.
  const press = (scale) => scene({ layers: [rect("key", { width: 360, height: 120, animations: [move(1, 0.08, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: scale, scaleY: scale })] })] });
  await silent("duration_band", press(0.95));
  await fires("duration_band", press(0.5));
  // A label that slides out in 0.08 s right as the shot cuts (one title gives way to the next at
  // 2 s) is part of the cut; the same exit in the middle of the shot is rushed.
  const exit = (start) => scene({ layers: [
    text("one", "Sourdough", { animations: [hide(2)] }),
    text("two", "Rye", { animations: [show(2)] }),
    text("label", "Fresh daily", { y: 600, fontSize: 40, animations: [move(start, 0.08, "ease-in", {}, { x: 600 }, "out"), hide(start + 0.08)] }),
  ] });
  await silent("duration_band", exit(1.92));
  await fires("duration_band", exit(1.2));
});

test("exit_ratio: an exit takes 55–75% of its entrance", async () => {
  // Entrance 0.6 s. Bad: exit 0.6 s (100%). Good: exit 0.4 s (67%).
  const inOut = (exitDuration) => scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2, 0.6, "ease-out"), fadeOut(3, exitDuration)] })] });
  const [finding] = await fires("exit_ratio", inOut(0.6));
  assert.equal(finding.measured, "100%");
  assert.equal(finding.fix.kind, "tweens");
  // Automatic: 65% of the entrance, ending where the exit ended (3.6 s).
  assert.deepEqual([finding.fix.changes[0].properties, finding.fix.auto], [{ start: 3.21, duration: 0.39 }, true]);
  await silent("exit_ratio", inOut(0.4));
  // An exit past the 4 s scene end is kept inside it: 1 s in, so 0.65 s out, ending at 4 s.
  const late = scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2, 1, "ease-out"), fadeOut(3.7, 0.3)] })] });
  const [cut] = await fires("exit_ratio", late);
  assert.deepEqual(cut.fix.changes[0].properties, { start: 3.35, duration: 0.65 });
  // An exit inside a long entrance (a drift) has no room to keep its end: a hint, not a refused auto fix.
  const [inside] = await fires("exit_ratio", scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2, 2, "ease-out"), fadeOut(1.5, 0.3)] })] }));
  assert.deepEqual([inside.fix.kind, inside.fix.auto], ["hint", undefined]);
});

test("stagger_long: a word-by-word entrance reaches its last word within 0.5 s", async () => {
  // Six words. Bad: 0.2 s between words (1 s to the last). Good: 0.06 s (0.3 s).
  const words = (stagger) => scene({ layers: [text("line", "Bread baked fresh every single morning", { fontSize: 64,
    animations: [{ ...fadeIn(0.2, 0.4), unit: "words", stagger }] })] });
  const [finding] = await fires("stagger_long", words(0.2));
  assert.equal(finding.measured, 1);
  assert.equal(finding.fix.kind, "tween");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.stagger, 0.1);
  await silent("stagger_long", words(0.06));
});

test("stagger_long: layers entering one after another finish their stagger within 0.5 s", async () => {
  // Four cards with the same entrance. Bad: 0.3 s apart (0.9 s in all). Good: 0.1 s apart.
  const cards = (gap) => scene({ layers: [0, 1, 2, 3].map((index) =>
    rect(`card-${index}`, { x: 120 + index * 440, width: 400, height: 300, animations: [fadeIn(0.2 + index * gap, 0.4)] })) });
  const [finding] = await fires("stagger_long", cards(0.3));
  assert.equal(finding.itemIds.length, 4);
  // The fix keeps the order at 0.16 s apart (0.48 s in all), automatically.
  assert.equal(finding.fix.auto, true);
  assert.deepEqual(finding.fix.changes.map((change) => [change.itemId, change.properties.start]), [["card-0", 0.2], ["card-1", 0.366], ["card-2", 0.532], ["card-3", 0.698]]);
  await silent("stagger_long", cards(0.1));
});

test("stagger_order: the headline enters before the body text", async () => {
  // Bad: body first. Good: headline first.
  const page = (headlineAt, bodyAt) => scene({ layers: [
    text("headline", "Bake with us", { role: "headline", fontSize: 96, y: 200, animations: [fadeIn(headlineAt)] }),
    text("body", "Classes every Saturday", { role: "body", fontSize: 40, y: 420, animations: [fadeIn(bodyAt)] }),
  ] });
  const [finding] = await fires("stagger_order", page(0.8, 0.2));
  assert.equal(finding.itemId, "body");
  await silent("stagger_order", page(0.2, 0.8));
});

test("first_entrance: the first entrance starts 0.1–0.3 s after the start", async () => {
  // Bad: it starts at 0 s. Good: 0.2 s.
  const opening = (start) => scene({ layers: [text("title", "Hello", { animations: [fadeIn(start)] })] });
  const [finding] = await fires("first_entrance", opening(0));
  assert.equal(finding.fix.kind, "tweens");
  assert.equal(finding.fix.changes[0].properties.start, 0.2);
  await silent("first_entrance", opening(0.2));
  // A stagger right behind it moves along, so its order stays: 0, 0.1, 0.2 s become 0.2, 0.3, 0.4 s.
  const cards = scene({ layers: [0, 1, 2].map((index) => rect(`card-${index}`, { x: 120 + index * 440, animations: [fadeIn(index * 0.1, 0.4)] })) });
  const [stagger] = await fires("first_entrance", cards);
  assert.deepEqual(stagger.fix.changes.map((change) => [change.itemId, change.properties.start]), [["card-0", 0.2], ["card-1", 0.3], ["card-2", 0.4]]);
});

test("speed_jump: speed matches where two moves join", async () => {
  // A dot speeds up to x 700, then slows down to x 1300. Bad: the second move takes 0.5 s, so it
  // starts twice as fast as the first ends. Good: it takes 1 s, the mirror of the first.
  const dot = (secondDuration) => scene({ duration: 3, layers: [rect("dot", { x: 100, y: 440, width: 200, height: 200, animations: [
    move(0, 1, "ease-in", { x: 100 }, { x: 700 }),
    move(1, secondDuration, "ease-out", { x: 700 }, { x: 1300 }),
  ] })] });
  const [finding] = await fires("speed_jump", dot(0.5));
  assert.ok(Number.parseInt(finding.measured, 10) > 5, finding.measured);
  await silent("speed_jump", dot(1));
  // The auto fix roves the hand-off: the 1.5 s is shared by distance (0.75 s each) and both ends
  // of the join are re-eased to one speed. Start, end and values stay.
  assert.equal(finding.fix.auto, true);
  assert.deepEqual(finding.fix.changes.map((change) => [change.tweenId, change.properties.start, change.properties.duration]), [["dot.1", undefined, 0.75], ["dot.2", 0.75, 0.75]]);
  await silent("speed_jump", withChanges(dot(0.5), finding.fix.changes));
});

// The document with the tween changes of a fix applied to its animations.
function withChanges(document, changes) {
  const copy = structuredClone(document);
  for (const { tweenId, properties } of changes)
    for (const layer of copy.scenes[0].layers) Object.assign(layer.animations.find((animation) => animation.id === tweenId) ?? {}, properties);
  return parseDocument(copy);
}

test("speed_jump: scale and rotation are judged at the layer's size, a corner eases to rest, a hold is not a jump", async () => {
  const card = (animations) => scene({ duration: 3, layers: [rect("card", { x: 760, y: 340, width: 400, height: 400, animations })] });
  const cases = {
    // Grows 1 to 1.5 in 1 s, then 1.5 to 2 in 0.4 s: its corners speed up at the join.
    grow: card([move(0, 1, "ease-in", { scaleX: 1, scaleY: 1 }, { scaleX: 1.5, scaleY: 1.5 }), move(1, 0.4, "ease-out", { scaleX: 1.5, scaleY: 1.5 }, { scaleX: 2, scaleY: 2 })]),
    // Turns 90 degrees in 1 s, then 90 more in 0.4 s.
    spin: card([move(0, 1, "ease-in", { rotation: 0 }, { rotation: 90 }), move(1, 0.4, "ease-out", { rotation: 90 }, { rotation: 180 })]),
    // Right at full speed, then down: a corner.
    corner: card([move(0, 1, "linear", { x: 160 }, { x: 760 }), move(1, 1, "linear", { y: 340 }, { y: 640 })]),
    // Fast into far slower: both sides ease to rest in one pass (the slow side is not left moving).
    slower: card([move(0, 1, "ease-in", { x: 160 }, { x: 760 }), move(1, 0.5, "linear", { x: 760 }, { x: 960 })]),
  };
  for (const [name, document] of Object.entries(cases)) {
    const [finding] = await fires("speed_jump", document);
    assert.equal(finding.fix.auto, true, name);
    await silent("speed_jump", withChanges(document, finding.fix.changes));
  }
  // In a run of 3, roving the jumpy pair would retime the middle move and break its smooth join
  // with the third: the times stay and the join takes the pair's average speed (auto-Bezier).
  const glide = (easing) => [0.33, 0.33, 0.67, easing];
  const three = card([move(0, 1, [0.4, 0, 0.7, 0.7], { x: 160 }, { x: 760 }),
    move(1, 0.5, glide(0.67), { x: 760 }, { x: 960 }), move(1.5, 0.5, glide(1), { x: 960 }, { x: 1160 })]);
  const [run] = await fires("speed_jump", three);
  assert.equal(run.fix.auto, true);
  assert.ok(run.fix.changes.every((change) => change.properties.start === undefined && change.properties.duration === undefined));
  await silent("speed_jump", withChanges(three, run.fix.changes));
  // A move that stops dead and holds before the next one (a still tween, or a gap) is deliberate.
  await silent("speed_jump", card([move(0, 1, "linear", { x: 160 }, { x: 760 }), move(1, 0.5, "linear", { x: 760 }, { x: 760 }), move(1.5, 0.5, "linear", { x: 760 }, { x: 1160 })]));
  await silent("speed_jump", card([move(0, 1, "linear", { x: 160 }, { x: 760 }), move(1.5, 0.5, "linear", { x: 760 }, { x: 1160 })]));
});

test("speed_jump: an instant set at the join is a jump on purpose", async () => {
  // The same uneven join, but the second move starts with an instant set that places the dot
  // (a 0.001 s move here, the shortest kino allows). Placing it
  // is not a speed change.
  const dot = (withSet) => scene({ duration: 3, layers: [rect("dot", { x: 100, y: 440, width: 200, height: 200, animations: [
    move(0, 1, "ease-in", { x: 100 }, { x: 700 }),
    ...(withSet ? [move(1, 0.001, "linear", { x: 700 }, { x: 700 })] : []),
    move(1, 0.5, "ease-out", { x: 700 }, { x: 1300 }),
  ] })] });
  await fires("speed_jump", dot(false));
  await silent("speed_jump", dot(true));
});

test("judder: a large layer does not pan fast at 30 fps", async () => {
  // A panel covering 32% of the frame slides in over 2 s. Bad: 1500 px. Good: a 300 px drift.
  const pan = (distance) => scene({ layers: [rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [move(0, 2, "smooth", { x: 400 - distance })] })] });
  const [finding] = await fires("judder", pan(1500));
  await silent("judder", pan(100));
  // The auto fix is motion blur along the pan (a 180 degree shutter: 59 px at its fastest), from
  // and back to 0 around the fast part, and the pan with it is fine. A 300 px drift strobes too.
  assert.equal(finding.fix.kind, "smear");
  const keys = finding.fix.animations;
  assert.deepEqual([keys[0].from.length, Math.max(...keys.map((key) => key.to.length)), keys.at(-1).to.length, keys[0].to.angle], [0, 59, 0, 0]);
  const blurred = (distance, fix) => scene({ layers: [rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [move(0, 2, "smooth", { x: 400 - distance }),
    ...fix.animations.map((animation) => ({ kind: "effect", effect: "directional-blur", ...animation }))] })] });
  await silent("judder", blurred(1500, finding.fix));
  const [slow] = await fires("judder", pan(300));
  await silent("judder", blurred(300, slow.fix));
  // A phone whipping in (presetCatalog.js) is smeared along its path; the same move without the
  // preset judders.
  const { presetAnimation } = await import("./animation.js");
  const phone = { id: "phone", x: 240, y: 360, width: 600, height: 1200 };
  const whip = presetAnimation("whip-in", phone, 0.5, undefined, { parameters: { direction: "up" } });
  const whipped = (animation) => scene({ width: 1080, height: 1920, layers: [rect("phone", { ...phone, animations: [animation] })] });
  const { preset, ...plain } = whip;
  await fires("judder", whipped(plain));
  await silent("judder", whipped(whip));
});

test("judder: a long pan gets a few blur keys that keep to the shutter blur", async () => {
  // A 30 s pan across 20000 px. The fix keys the blur where it changes (8 keys at most, plus the
  // ramps in and out), and the blur drawn at every fast sample stays within 10% of the peak (or
  // 2 px, and 1 px of rounding) of a 180 degree shutter's.
  const long = (fix = null) => scene({ duration: 30, layers: [rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [move(0, 30, "smooth", { x: -19600 }),
    ...(fix?.animations ?? []).map((animation) => ({ kind: "effect", effect: "directional-blur", ...animation }))] })] });
  const [finding] = await fires("judder", long());
  assert.ok(finding.fix.animations.length <= 9, `${finding.fix.animations.length} keys`);
  const keyed = modelOf(long(finding.fix));
  const panel = keyed.items.find((item) => item.id === "panel");
  const shutter = (at) => Math.abs(panel.samples.x0[at] - panel.samples.x0[at - 1]) * keyed.fps / 2 / 30;
  const [first, last] = [Math.round(finding.at * keyed.fps), Math.round(finding.until * keyed.fps)];
  const peak = Math.max(...finding.fix.animations.map((key) => key.to.length));
  for (let at = first; at <= last; at += 1) {
    const drawn = panel.samples.blur[at] * Math.sqrt(12);
    assert.ok(Math.abs(drawn - shutter(at)) <= Math.max(2, 0.1 * peak) + 1, `at ${at}: ${drawn} px for ${shutter(at)} px`);
  }
  await silent("judder", long(finding.fix));
});

test("judder: a group that pans its cards together is blurred once", async () => {
  // Two cards ride in a group that slides 1500 px: one fix, on the group. When a card also moves
  // on its own inside the group, the group no longer moves as a whole: each card gets its own fix.
  const cards = (ownMove, fix = null) => scene({ layers: [
    { type: "group", id: "deck", name: "deck", x: 0, y: 0, width: 1920, height: 1080, animations: [move(0, 2, "smooth", { x: -1500 }),
      ...(fix?.animations ?? []).map((animation) => ({ kind: "effect", effect: "directional-blur", ...animation }))] },
    rect("left", { x: 100, y: 240, width: 800, height: 600, parentId: "deck" }),
    rect("right", { x: 1000, y: 240, width: 800, height: 600, parentId: "deck", animations: ownMove ? [move(0, 2, "smooth", { y: -600 })] : [] })] });
  const [finding, ...more] = await fires("judder", cards(false));
  assert.deepEqual([finding.itemId, more.length], ["deck", 0]);
  await silent("judder", cards(false, finding.fix));
  const apart = await fires("judder", cards(true));
  assert.deepEqual(apart.map((entry) => entry.itemId).sort(), ["left", "right"]);
});

test("judder: the same fast pan is fine when the video is rendered at 60 fps", async () => {
  const pan = scene({ layers: [rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [move(0, 1, "smooth", { x: -1100 })] })] });
  await fires("judder", pan, { outputFps: 30 });
  await silent("judder", pan, { outputFps: 60 });
});

test("judder: a fast pan with a directional, zoom or spin blur while it moves is fine; a 2 px smear is not enough", async () => {
  const blurred = (effect, to) => scene({ layers: [rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [
    move(0, 2, "smooth", { x: -1100 }),
    { kind: "effect", effect, start: 0, duration: 1, easing: "ease-out", to },
    { kind: "effect", effect, start: 1, duration: 1, easing: "ease-in", to: Object.fromEntries(Object.keys(to).map((key) => [key, 0])) },
  ] })] });
  await silent("judder", blurred("directional-blur", { length: 300 }));
  await silent("judder", blurred("zoom-blur", { amount: 0.2 }));
  await silent("judder", blurred("spin-blur", { angle: 12 }));
  await fires("judder", blurred("directional-blur", { length: 2 }));
});

// ---------------------------------------------------------------- layout rules

test("overlap: two texts must not overlap", async () => {
  // The subhead sits under the headline. Bad: 40 px lower, inside it. Good: 180 px lower.
  const page = (subheadY) => scene({ layers: [
    text("headline", "Bake with us", { fontSize: 96, y: 300 }),
    text("subhead", "Classes every Saturday", { fontSize: 48, y: subheadY }),
  ] });
  const [finding] = await fires("overlap", page(340));
  assert.equal(finding.itemId, "subhead");
  assert.equal(finding.otherId, "headline");
  // Automatic: the subhead moves just below the headline, where it no longer overlaps.
  assert.deepEqual([finding.fix.kind, finding.fix.auto, finding.fix.dx], ["move", true, 0]);
  await silent("overlap", page(340 + finding.fix.dy));
  await silent("overlap", page(480));
  // Two texts in the same spot are a timing problem: the fix stays a hint.
  const [same] = await fires("overlap", scene({ layers: [text("first", "Bake with us"), text("second", "every Saturday")] }));
  assert.equal(same.fix.kind, "hint");
});

test("overlap: allowOverlap marks an overlap as intended", async () => {
  const page = (allowOverlap) => scene({ layers: [
    text("headline", "Bake with us", { fontSize: 96, y: 300 }),
    text("subhead", "Classes every Saturday", { fontSize: 48, y: 340, allowOverlap }),
  ] });
  await fires("overlap", page(false));
  await silent("overlap", page(true));
});

test("overlap: a solid box must not be drawn over text", async () => {
  // A 600×200 box across the title. Bad: above the title in the layer order. Good: below it.
  const box = rect("box", { x: 150, y: 150, width: 600, height: 200, fill: "#e8dcc4" });
  const title = text("title", "Bake with us", { fontSize: 72, y: 200 });
  const [finding] = await fires("overlap", scene({ layers: [title, box] }));
  assert.equal(finding.itemId, "title");
  assert.equal(finding.otherId, "box");
  await silent("overlap", scene({ layers: [box, title] }));
  // Above the title but in a mask group whose mask stops short of it: only the tile shows.
  const tile = (maskHeight) => scene({ layers: [title,
    { type: "group", id: "tile", name: "tile", x: 150, y: 0, width: 600, height: 400, isMaskGroup: true },
    rect("tile-mask", { parentId: "tile", x: 0, y: 0, width: 600, height: maskHeight, isMask: true }),
    rect("tile-video", { parentId: "tile", x: 0, y: 0, width: 600, height: 400, fill: "#e8dcc4" })] });
  await silent("overlap", tile(180));
  assert.equal((await fires("overlap", tile(400)))[0].otherId, "tile-video");
});

test("overlap: a layer at scale 0 is not drawn, so it overlaps nothing", async () => {
  // The subhead waits at scale 0 on top of the headline (it pops in later in a real scene).
  const page = (scale) => scene({ layers: [
    text("headline", "Bake with us", { fontSize: 96, y: 300 }),
    text("subhead", "Classes every Saturday", { fontSize: 48, y: 340, scaleX: scale, scaleY: scale }),
  ] });
  await fires("overlap", page(1));
  await silent("overlap", page(0));
});

test("overlap: text partly cut off by its clipping group, not text waiting outside it", async () => {
  // A 600×300 clipping group. Bad: the title sticks out of its right edge. Good: the title
  // waits wholly outside the group (to slide in later), so it is not shown at all.
  const panel = (titleX) => scene({ layers: [
    { type: "group", id: "panel", name: "panel", x: 200, y: 200, width: 600, height: 300, clipContent: true },
    // A child's x and y are measured from its group's corner.
    text("title", "Bake with us", { fontSize: 72, x: titleX, y: 100, parentId: "panel" }),
  ] });
  const [finding] = await fires("overlap", panel(500));
  assert.equal(finding.otherId, "panel");
  assert.match(finding.measured, /cut off/);
  await silent("overlap", panel(1200));
});

test("safe_zone: text at rest stays inside the 5% safe zone", async () => {
  // The safe zone starts 96 px from the left of a 1920 px frame. Bad: x 40. Good: x 200.
  const placed = (x) => scene({ layers: [text("offer", "Limited offer", { x, y: 400 })] });
  const [finding] = await fires("safe_zone", placed(40));
  assert.equal(finding.fix.kind, "move");
  assert.equal(finding.fix.auto, true);
  // The move puts the letters' left edge 4 px inside the safe zone's edge (96 px). The ink
  // starts a few pixels right of x, where the first letter's outline begins.
  assert.ok(Math.abs(finding.bbox[0] + finding.fix.dx - 100) <= 1, `ink at ${finding.bbox[0]}, moved ${finding.fix.dx}`);
  assert.equal(finding.fix.dy, 0);
  await silent("safe_zone", placed(200));
});

test("safe_zone: the move goes a few pixels past the edge, scaled with the frame", async () => {
  // In one edit a title's ink top was 269 with the zone at 270, and the fix moved it 1 px,
  // right onto the line. Now it moves 4 px past the line at 1080 px wide, 8 px at 4K, and only
  // as far as the zone has room for a layer that nearly fills it.
  // At 4K (`big`) the frame, the place and the type are twice the size.
  const safeTitle = (y, big) => scene({ width: big ? 2160 : 1080, height: big ? 3840 : 1920, layers: [text("t-title", "AREA", { x: big ? 280 : 140, y, fontSize: big ? 240 : 120 })] });
  const missBy = async (pixels, size) => {
    // Where the ink and the zone are at y 100, then y so the ink is `pixels` above the zone.
    const [probe] = await fires("safe_zone", safeTitle(100, size));
    const y = 100 + (probe.required[1] - pixels) - probe.bbox[1];
    const [finding] = await fires("safe_zone", safeTitle(y, size));
    return { y, finding, zoneTop: finding.required[1] };
  };
  const portrait = await missBy(1);
  assert.ok(portrait.finding.bbox[1] + portrait.finding.fix.dy >= portrait.zoneTop + 3, `ink at ${portrait.finding.bbox[1]}, moved ${portrait.finding.fix.dy}`);
  assert.ok(portrait.finding.fix.dy <= 6, `moved ${portrait.finding.fix.dy}`);
  await silent("safe_zone", safeTitle(portrait.y + portrait.finding.fix.dy));

  const big = true;
  const uhd = await missBy(1, big);
  assert.ok(uhd.finding.bbox[1] + uhd.finding.fix.dy >= uhd.zoneTop + 7, `ink at ${uhd.finding.bbox[1]}, moved ${uhd.finding.fix.dy}`);
  await silent("safe_zone", safeTitle(uhd.y + uhd.finding.fix.dy, big));

  // A logo 2 px narrower than the zone (96 to 1824 of 1920) that sits 10 px left moves 12 px:
  // only the room there is.
  const logo = (x) => scene({ layers: [rect("logo", { x, y: 400, width: 1726, height: 100, role: "logo" })] });
  const [wide] = await fires("safe_zone", logo(86));
  assert.deepEqual([wide.fix.kind, wide.fix.dx, wide.fix.dy], ["move", 12, 0]);
  await silent("safe_zone", logo(98));
});

test("safe_zone: text wholly outside the frame is not shown, so it is not checked", async () => {
  const placed = (x) => scene({ layers: [text("offer", "Limited offer", { x, y: 400 })] });
  await fires("safe_zone", placed(40));
  await silent("safe_zone", placed(-1200));
});

test("safe_zone: a camera tour is judged at each stop on its own", async () => {
  // Bad: the card peeks in, cut by the frame's right edge, at the first stop (then sits at
  // x 200 at its own stop). The places at the two stops are not one span, and a move of the
  // card is not the fix. Good: the card is wholly off screen at the first stop.
  const card = (x) => tour([text("sees-label", "Sees the room", { fontSize: 48, x, y: 500 })], { stopX: -1500 });
  const [finding] = await fires("safe_zone", card(1700));
  assert.equal(finding.at, 0);
  assert.ok(finding.until <= 1, `until ${finding.until}`);
  assert.equal(finding.fix.kind, "hint");
  assert.match(finding.fix.text, /rests in 3 places while it shows \(from 0s, 1.4s, 2.8s\)/);
  await silent("safe_zone", card(2000));
  // A group that slides once between two rests is no tour: one move of the text fits both.
  const slide = (x) => scene({ layers: [
    { type: "group", id: "row", name: "row", x: 0, y: 0, width: 1920, height: 1080, animations: [move(1, 0.5, "smooth", { x: 0 }, { x: 200 })] },
    text("near-edge", "Near the edge", { fontSize: 48, x, y: 500, parentId: "row" })] });
  const [slid] = await fires("safe_zone", slide(1500));
  assert.equal(slid.fix.kind, "move");
  await silent("safe_zone", slide(1500 + slid.fix.dx));
});

test("centered_run: not every section is centred three times in a row", async () => {
  // Three sections cut one after another. Bad: all centred. Good: the middle one is left-aligned.
  const centred = (id, value) => text(id, value, { textResize: "height", width: 1600, x: 160, y: 460, textAlign: "center" });
  const flow = (middle) => scene({ duration: 7.5, layers: [
    { ...centred("one", "Fresh every morning"), animations: [hide(2)] },
    { ...middle, animations: [show(2), hide(5)] },
    { ...centred("three", "Visit us today"), animations: [show(5)] },
  ] });
  const [finding] = await fires("centered_run", flow(centred("two", "Baked by hand")));
  assert.equal(finding.measured, "3 sections centred");
  await silent("centered_run", flow(text("two", "Baked by hand", { x: 200, y: 460, textAlign: "left" })));
});

test("card_grid: no row of three identical rounded cards", async () => {
  // Bad: three 480×320 cards in a row. Good: the middle card is larger.
  const card = (id, x, width = 480, height = 320) => rect(id, { x, y: 380, width, height, radius: 24, fill: "#e8dcc4" });
  const [finding] = await fires("card_grid", scene({ layers: [card("card-a", 120), card("card-b", 720), card("card-c", 1320)] }));
  assert.equal(finding.itemIds.length, 3);
  await silent("card_grid", scene({ layers: [card("card-a", 120), card("card-b", 660, 600, 380), card("card-c", 1320)] }));
});

test("accent_stripe: no thin stripe on the left edge of text", async () => {
  // Bad: an 8×100 stripe just left of the title. Good: the same accent as an underline.
  const title = text("title", "Our story", { x: 240, y: 400 });
  const [finding] = await fires("accent_stripe", scene({ layers: [rect("stripe", { x: 216, y: 394, width: 8, height: 100, fill: "#c0392b" }), title] }));
  assert.equal(finding.itemId, "stripe");
  assert.equal(finding.otherId, "title");
  await silent("accent_stripe", scene({ layers: [rect("underline", { x: 240, y: 510, width: 240, height: 8, fill: "#c0392b" }), title] }));
});

test("glow_blob_pill: not a glow, a blurred blob and a pill button together", async () => {
  // A glowing button over a blurred blob. Bad: the button is a pill. Good: it has 12 px corners.
  const layout = (radius) => scene({ layers: [
    { type: "ellipse", id: "blob", name: "blob", x: 600, y: 200, width: 700, height: 700, fill: "#d9a441", blur: 80 },
    rect("button", { x: 780, y: 700, width: 360, height: 100, radius, fill: "#d9a441", shadow: { color: "#d9a441", x: 0, y: 0, blur: 40 } }),
    text("label", "Get started", { fontSize: 40, x: 850, y: 726 }),
  ] });
  const [finding] = await fires("glow_blob_pill", layout(50));
  assert.deepEqual(finding.itemIds, ["button", "blob", "button"]);
  await silent("glow_blob_pill", layout(12));
});

test("glow_blob_pill: a thin rounded bar with text across it is not a pill button", async () => {
  // A 400×16 progress bar with a label centred on it: the label does not fit inside the bar.
  const layout = (height) => scene({ layers: [
    { type: "ellipse", id: "blob", name: "blob", x: 600, y: 200, width: 700, height: 700, fill: "#d9a441", blur: 80 },
    rect("bar", { x: 760, y: 750 - height / 2, width: 400, height, radius: height / 2, fill: "#d9a441", shadow: { color: "#d9a441", x: 0, y: 0, blur: 40 } }),
    text("label", "Loading", { fontSize: 40, x: 880, y: 726 }),
  ] });
  await fires("glow_blob_pill", layout(100));
  await silent("glow_blob_pill", layout(16));
});

test("glow_blob_pill: small text from elsewhere lying on a thin bar does not make it a pill", async () => {
  // A product promo has a 400×16 rounded bar that a 10 px "PM" crosses.
  // Bad: a 100 px pill holds "Get started". Good: the 16 px bar holds only the "PM".
  const layout = (button) => scene({ layers: [
    { type: "ellipse", id: "blob", name: "blob", x: 600, y: 200, width: 700, height: 700, fill: "#d9a441", blur: 80 },
    button
      ? rect("button", { x: 780, y: 700, width: 360, height: 100, radius: 50, fill: "#d9a441", shadow: { color: "#d9a441", x: 0, y: 0, blur: 40 } })
      : rect("bar", { x: 760, y: 742, width: 400, height: 16, radius: 8, fill: "#d9a441", shadow: { color: "#d9a441", x: 0, y: 0, blur: 40 } }),
    button ? text("label", "Get started", { fontSize: 40, x: 850, y: 726 }) : text("time", "PM", { fontSize: 10, x: 900, y: 744 }),
  ] });
  await fires("glow_blob_pill", layout(true));
  await silent("glow_blob_pill", layout(false));
});

// ---------------------------------------------------------------- pacing and promise rules

test("assertions: visible_by holds when the layer is fully shown by its time", async () => {
  // The logo fades in from 3 s to 3.5 s. Bad: promised by 2 s. Good: by 4 s.
  const promise = (time) => scene({ assertions: [{ type: "visible_by", target: "logo", time }],
    layers: [text("logo", "Acme", { animations: [fadeIn(3)] })] });
  const [finding] = await fires("assertions", promise(2));
  assert.equal(finding.itemId, "logo");
  assert.equal(finding.required, "visible_by");
  await silent("assertions", promise(4));
});

test("assertions: before holds when the layer appears first", async () => {
  // Promise: the headline appears before the CTA. Bad: the CTA comes first. Good: the headline does.
  const page = (headlineAt, ctaAt) => scene({ assertions: [{ type: "before", target: "headline", other: "cta" }], layers: [
    text("headline", "Bake with us", { y: 200, animations: [fadeIn(headlineAt)] }),
    text("cta", "Book a class", { y: 600, animations: [fadeIn(ctaAt)] }),
  ] });
  const [finding] = await fires("assertions", page(2, 0.2));
  assert.equal(finding.required, "before");
  await silent("assertions", page(0.2, 2));
});

test("assertions: inside_frame holds when the layer never leaves the frame", async () => {
  // The badge slides to x 200. Bad: from x -300, outside the frame. Good: from x 100.
  const slide = (fromX) => scene({ assertions: [{ type: "inside_frame", target: "badge" }],
    layers: [rect("badge", { x: 200, animations: [move(0.2, 0.6, "ease-out", { x: fromX }, {}, "in")] })] });
  const [finding] = await fires("assertions", slide(-300));
  assert.equal(finding.required, "inside_frame");
  await silent("assertions", slide(100));
});

test("assertions: the brief's length holds the video to the asked seconds within its tolerance", async () => {
  // Asked 300 s within 6 s (2%). Bad: a 578 s video. Good: 299 s.
  const page = scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  const [finding] = await fires("assertions", page, { length: { seconds: 300, tolerance: 6, video: 578 } });
  assert.equal(finding.measured, "578 s");
  assert.equal(finding.required, "300 s (within 6 s)");
  assert.match(finding.message, /278 s too long/);
  await silent("assertions", page, { length: { seconds: 300, tolerance: 6, video: 299 } });
});

test("promo_basics: a promo keeps its call to action on screen in the last 20%", async () => {
  // A 10 s promo with a logo by 0.8 s, a headline by 1.6 s, a hero covering 34% and a CTA from 5 s.
  // Bad: the CTA leaves at 7 s. Good: it stays to the end.
  const promo = (ctaAnimations, videoType = "promo") => scene({ duration: 10, videoType, layers: [
    text("logo", "Acme", { role: "logo", fontSize: 64, y: 100, animations: [fadeIn(0.3)] }),
    text("headline", "Bread, baked at dawn", { role: "headline", fontSize: 96, y: 260, animations: [fadeIn(0.8, 0.8)] }),
    rect("hero", { role: "hero", x: 700, y: 400, width: 1100, height: 600, animations: [fadeIn(1.5, 0.8)] }),
    text("cta", "Order now", { role: "cta", fontSize: 56, y: 860, animations: ctaAnimations }),
  ] });
  const [finding] = await fires("promo_basics", promo([fadeIn(5), fadeOut(7)]));
  assert.equal(finding.part, "CTA in last 20%");
  await silent("promo_basics", promo([fadeIn(5)]));
  // No call to action is needed when the end is the logo alone (a tiny mark) or black.
  const ending = (layers, { hero = [fadeOut(8)], headline = [fadeOut(8)], background } = {}) => scene({ duration: 10, videoType: "promo", ...(background ? { background } : {}), layers: [
    text("logo", "Acme", { role: "logo", fontSize: 64, y: 100, animations: [fadeIn(0.3)] }),
    text("headline", "Bread, baked at dawn", { role: "headline", fontSize: 96, y: 260, animations: [fadeIn(0.8, 0.8), ...headline] }),
    rect("hero", { role: "hero", x: 700, y: 400, width: 1100, height: 600, animations: [fadeIn(1.5, 0.8), ...hero] }), ...layers] });
  await silent("promo_basics", ending([]));
  // A logo up the whole time over the hero is a watermark, not an end mark.
  await fires("promo_basics", ending([], { hero: [] }));
  const black = rect("black", { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", animations: [fadeIn(9, 0.5)] });
  await silent("promo_basics", ending([black], { hero: [] }));
  await fires("promo_basics", ending([{ ...black, fill: "#3A5A40" }, text("note", "Fresh daily", { y: 600, fontSize: 64 })]));
  // A dark scene background is not a dip to black while the headline is still on screen.
  const [dark] = await fires("promo_basics", ending([], { hero: [], headline: [], background: "#0b1020" }));
  assert.equal(dark.part, "CTA in last 20%");
});

test("promo_basics: only checks promos and ads, and says so when no video type is set", async () => {
  const unbranded = (videoType) => scene({ duration: 10, videoType, layers: [text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  await fires("promo_basics", unbranded("ad"));
  await silent("promo_basics", unbranded("explainer"));
  const notes = await silent("promo_basics", unbranded(undefined));
  assert.ok(notes.some((note) => note.includes("videoType")), notes.join("; "));
});

test("scene_lengths: sections are not all the same length", async () => {
  // Three sections cut one after another. Bad: 2.5 s each. Good: 1.5, 4 and 2 s.
  const sections = (firstCut, secondCut, end) => scene({ duration: end, layers: [
    text("one", "Fresh every morning", { y: 460, animations: [hide(firstCut)] }),
    text("two", "Baked by hand", { y: 460, animations: [show(firstCut), hide(secondCut)] }),
    text("three", "Visit us today", { y: 460, animations: [show(secondCut)] }),
  ] });
  const [finding] = await fires("scene_lengths", sections(2.5, 5, 7.5));
  assert.equal(finding.measured, "2.5, 2.5, 2.5");
  await silent("scene_lengths", sections(1.5, 5.5, 7.5));
});

test("scene_lengths: three equal 1.5 s sections are an even beat too", async () => {
  const sections = scene({ duration: 4.5, layers: [
    text("one", "Fresh every morning", { y: 460, animations: [hide(1.5)] }),
    text("two", "Baked by hand", { y: 460, animations: [show(1.5), hide(3)] }),
    text("three", "Visit us today", { y: 460, animations: [show(3)] }),
  ] });
  await fires("scene_lengths", sections);
});

test("no_rhythm: a scene with sound declares its beat", async () => {
  // A music layer under a title. Bad: no rhythm. Good: rhythm 120 bpm from 0 s.
  const withMusic = (rhythm) => scene({ rhythm, layers: [{ type: "audio", id: "music", name: "music", src: "" }, text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  const [finding] = await fires("no_rhythm", withMusic(undefined));
  assert.equal(finding.fix.kind, "hint");
  await silent("no_rhythm", withMusic({ bpm: 120, offset: 0 }));
});

test("transitions_dense: at most two large transitions in 6 beats", async () => {
  // At 120 bpm, 6 beats are 3 s. Three panels slide in. Bad: at 0.5, 1.5 and 2.5 s. Good: the
  // third waits until 4 s.
  const panel = (id, y, start) => rect(id, { x: 360, y, width: 1200, height: 600, animations: [move(start, 0.6, "ease-out", { x: 1920 }, {}, "in")] });
  const slides = (thirdAt) => scene({ duration: 6, rhythm: { bpm: 120, offset: 0 }, layers: [panel("panel-a", 240, 0.5), panel("panel-b", 240, 1.5), panel("panel-c", 240, thirdAt)] });
  const [finding] = await fires("transitions_dense", slides(2.5));
  assert.equal(finding.measured, "3 in 6 beats");
  await silent("transitions_dense", slides(4));
});

test("static_scene: something changes within the text's hold plus 2 s", async () => {
  // Two words need a 2.4 s hold, so 4.4 s without change is the most. The title settles at 0.7 s.
  // Bad: then nothing happens until the end at 10 s. Good: a second line comes in at 4 s.
  const title = text("title", "Hello there", { y: 300, animations: [fadeIn(0.2)] });
  const [finding] = await fires("static_scene", scene({ duration: 10, layers: [title] }));
  assert.equal(finding.required, "≤4.4s");
  await silent("static_scene", scene({ duration: 10, layers: [title,
    text("second", "Come in", { y: 500, animations: [fadeIn(4), fadeOut(8)] })] }));
});

test("static_scene: a slow push-in counts as a change", async () => {
  // The fix the rule suggests: add a slow move while the text is read.
  const title = text("title", "Hello there", { y: 300, animations: [fadeIn(0.2)] });
  const hero = rect("hero", { x: 460, y: 500, width: 1000, height: 500, animations: [move(0.7, 9.3, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: 1.05, scaleY: 1.05 })] });
  await fires("static_scene", scene({ duration: 10, layers: [title, { ...hero, animations: [] }] }));
  await silent("static_scene", scene({ duration: 10, layers: [title, hero] }));
});

test("static_scene: falling snow counts as a change while its clock runs", async () => {
  // A particle generator moves inside a box that stands still. Snow for the whole scene keeps it
  // from being still; snow that stops at 2 s (keepStill "end" holds its last frame) does not.
  const title = text("title", "Hello there", { y: 300, animations: [fadeIn(0.2)] });
  const snow = (duration) => rect("snow", { x: 0, y: 0, width: 1920, height: 1080, fillEnabled: false, strokeWidth: 0,
    animations: [{ kind: "effect", effect: "snow", start: 0, duration, easing: "linear", keepStill: "both", to: { count: 200 } }] });
  await silent("static_scene", scene({ duration: 10, layers: [title, snow(10)] }));
  const [finding] = await fires("static_scene", scene({ duration: 10, layers: [title, snow(2)] }));
  assert.equal(finding.at, 2);
});

test("off_beat: an accent that nearly hits the beat lands on it; one clearly between beats is left alone", async () => {
  // 120 bpm from 0 s: beats every 0.5 s. Bad: the entrance starts at 1.05 s, 50 ms late, a near
  // miss. Good: at 1 s (on the beat), and at 1.1 s or 1.25 s (clearly between beats: syncopation,
  // a choice). Before 2026-10-26 any accent more than a frame off was flagged, which pulled every
  // accent onto the beat.
  const accent = (start) => scene({ rhythm: { bpm: 120, offset: 0 }, layers: [text("title", "Hello", { animations: [fadeIn(start)] })] });
  const [finding] = await fires("off_beat", accent(1.05));
  assert.equal(finding.measured, "50ms off");
  assert.equal(finding.fix.kind, "tweens");
  assert.equal(finding.fix.changes[0].properties.start, 1);
  await silent("off_beat", accent(1));
  await silent("off_beat", accent(1.1));
  await silent("off_beat", accent(1.25));
  // 70 ms is still a near miss; 80 ms is not.
  await fires("off_beat", accent(0.93));
  await silent("off_beat", accent(0.92));
  // A quick exit that ends on the beat (1.44 s + 0.06 s) lands on it; a 0.06 s one that starts
  // 50 ms after the beat does not.
  const exit = (start) => scene({ rhythm: { bpm: 120, offset: 0 }, layers: [text("title", "Hello", { animations: [fadeOut(start, 0.06)] })] });
  await silent("off_beat", exit(1.44));
  await fires("off_beat", exit(1.55));
  // A move's part (a logo-settle name typing on after its mark lands) is timed by the move.
  await silent("off_beat", scene({ rhythm: { bpm: 120, offset: 0 }, layers: [text("title", "Hello", { move: { name: "logo-settle", instance: "logo-settle", part: "name" }, animations: [fadeIn(1.05)] })] }));
});

test("advice rules come as info: taste notes that never count as warnings or hold a final render", async () => {
  for (const code of ["busy_edit", "pacing_jump", "gradient_banding", "deck_unused", "vocabulary_budget", "flat_sections", "exit_ratio"]) assert.equal(ruleOf(code).level, "info", code);
  const [finding] = await fires("exit_ratio", scene({ layers: [text("title", "Hello", { animations: [fadeIn(0.2, 0.6, "ease-out"), fadeOut(3, 0.6)] })] }));
  assert.equal(finding.severity, "info");
  assert.equal(blocksFinal(finding), false);
});

test("off_beat: the first entrance's 0.1–0.3 s delay is not an off-beat accent", async () => {
  // 120 bpm from 0 s. The title comes in 0.2 s after the start, as first_entrance asks.
  // Neither rule should ask for a change the other one would undo.
  const opening = scene({ rhythm: { bpm: 120, offset: 0 }, layers: [text("title", "Hello", { animations: [fadeIn(0.2)] })] });
  await silent("off_beat", opening);
  await silent("first_entrance", opening);
});

// ---------------------------------------------------------------- look rules

test("gradient_text: text has a solid colour", async () => {
  const sunset = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#c0392b" }, { offset: 1, color: "#d9a441" }] };
  const titled = (fill) => scene({ layers: [text("title", "Golden hour", { fill })] });
  const [finding] = await fires("gradient_text", titled(sunset));
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.properties.fill, "#c0392b");
  await silent("gradient_text", titled("#c0392b"));
});

test("neon_on_dark: no neon cyan on a near-black background", async () => {
  // A near-black scene. Bad: neon cyan text. Good: warm amber text.
  const dark = (fill) => scene({ background: "#0b0b0c", layers: [text("title", "Night mode", { fill })] });
  await fires("neon_on_dark", dark("#00e5ff"));
  await silent("neon_on_dark", dark("#d9a441"));
});

test("pure_frame: the background is not pure black", async () => {
  // Bad: #000000. Good: the off-black the fix suggests. kino's model draws the scene background
  // as its own full-frame item, so the fix changes that item's fill (the agent service turns it
  // into update_scene background).
  const backed = (background) => scene({ background, layers: [text("title", "Hello", { fill: "#f5f2ea" })] });
  const findings = await fires("pure_frame", backed("#000000"));
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.itemId, "#scene-background");
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.fill, "#0b0b0c");
  await silent("pure_frame", backed("#0b0b0c"));
});

test("pure_frame: a full-frame layer is not pure white", async () => {
  const backed = (fill) => scene({ layers: [rect("backdrop", { x: 0, y: 0, width: 1920, height: 1080, fill }), text("title", "Hello")] });
  const [finding] = await fires("pure_frame", backed("#ffffff"));
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.auto, true);
  assert.equal(finding.fix.properties.fill, "#fafaf7");
  await silent("pure_frame", backed("#fafaf7"));
});

test("default_font: text is not set in a common default font", async () => {
  // Bad: Inter. Good: Noto Serif.
  const set = (fontFamily) => scene({ layers: [text("title", "Hello", { fontFamily })] });
  const [finding] = await fires("default_font", set("Inter"));
  assert.equal(finding.measured, "Inter");
  await silent("default_font", set("Noto Serif"));
});

test("default_font: a font the brand chose is not a default", async () => {
  const inter = scene({ layers: [text("title", "Hello", { fontFamily: "Inter" })] });
  await fires("default_font", inter, { brandFonts: [] });
  await silent("default_font", inter, { brandFonts: ["Inter"] });
});

test("gradient_banding: no dark gradient across the whole frame", async () => {
  // Bad: a near-black to dark navy background. Good: a light gradient.
  const gradient = (from, to) => ({ type: "linear", angle: 90, stops: [{ offset: 0, color: from }, { offset: 1, color: to }] });
  const backed = (background) => scene({ background, layers: [text("title", "Hello")] });
  await fires("gradient_banding", backed(gradient("#0b0b0c", "#1c1f2b")));
  await silent("gradient_banding", backed(gradient("#f5f2ea", "#e6dccb")));
});

test("gradient_banding: one dark background is reported once", async () => {
  const dark = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#0b0b0c" }, { offset: 1, color: "#1c1f2b" }] };
  const findings = await fires("gradient_banding", scene({ background: dark, layers: [text("title", "Hello")] }));
  assert.equal(findings.length, 1);
  // Final renders dither by default (backend/export-batches.mjs), so the warning says where
  // bands still show instead of claiming kino never dithers.
  assert.match(findings[0].message, /wherever it is not dithered: drafts, look frames, Lottie, dither:false/);
  assert.match(findings[0].message, /A final render dithers by default/);
  assert.doesNotMatch(findings[0].message, /does not dither/);
  assert.equal(ruleOf("gradient_banding").summary, "no dark full-frame gradient (final renders dither it; drafts and look do not)");
});

// ---------------------------------------------------------------- AI tells

test("own_words: on-screen words come from the saved sources", async () => {
  const sources = [{ name: "readme", text: "smokescreen watches wildfire cameras all night and texts the nearest station." }];
  const titled = (value) => scene({ layers: [text("title", value, { fontSize: 64 })] });
  const [finding] = await fires("own_words", titled("Revolutionary vigilance for tomorrow"), { sources });
  assert.match(finding.message, /revolutionary/);
  await silent("own_words", titled("Watches wildfire cameras all night"), { sources });
  // Plurals and -ing forms match the source's words.
  await silent("own_words", titled("Watching the camera, texting stations"), { sources });
  // A credit line names other people's work by design.
  await silent("own_words", titled('Music: "Hot Pursuit" Kevin MacLeod (incompetech.com) CC BY 4.0'), { sources });
  await silent("own_words", titled("Footage by Mariana Velasquez Ortega"), { sources });
  // No sources saved: a note says how to save one. Not run at all outside kino's service.
  const notes = await silent("own_words", titled("Revolutionary vigilance for tomorrow"), { sources: [] });
  assert.ok(notes.some((note) => note.includes('op:"source"')), notes.join("; "));
  await silent("own_words", titled("Revolutionary vigilance for tomorrow"));
});

test("stock_copy: no stock phrases, three-beat slogans or emoji", async () => {
  const titled = (value) => scene({ layers: [text("title", value, { fontSize: 64 })] });
  const [finding] = await fires("stock_copy", titled("Introducing Orbit"));
  assert.equal(finding.measured, '"Introducing"');
  await fires("stock_copy", titled("Seamless planning"));
  await fires("stock_copy", titled("Fast. Simple. Secure."));
  await fires("stock_copy", titled("Plan the week 🚀"));
  const beats = scene({ layers: ["Fast.", "Simple.", "Secure."].map((value, index) => text(`beat${index}`, value, { y: 100 + index * 200 })) });
  await fires("stock_copy", beats);
  await silent("stock_copy", titled("Plan the week in one view"));
  // A decimal or a question is not a sentence break: "smoke? 0.6" is two words, not three beats.
  await silent("stock_copy", titled("smoke? 0.6"));
  // A word that only contains a stock phrase is fine.
  await silent("stock_copy", titled("Seamstress © 2026"));
});

test("same_entrance: 4+ texts do not all enter with one preset", async () => {
  const preset = (id, start) => ({ kind: "in", start, duration: 0.5, easing: "smooth", preset: { id, mode: "in" }, from: { opacity: 0 }, to: { opacity: 1 } });
  const lines = (ids, more = []) => scene({ duration: 6, layers: [...ids.map((id, index) => text(`line${index}`, `Line ${index}`, { y: 100 + index * 200, animations: [preset(id, 0.2 + index)] })), ...more] });
  const [finding] = await fires("same_entrance", lines(["fade", "fade", "fade", "fade"]));
  assert.match(finding.measured, /4 texts, all fade/);
  await silent("same_entrance", lines(["fade", "fade", "fade", "blur"]));
  await silent("same_entrance", lines(["fade", "fade", "fade"]));
  // A fifth text that cuts in (no entrance): not every text enters the same way.
  await silent("same_entrance", lines(["fade", "fade", "fade", "fade"], [text("cut", "Cut in", { x: 1200, animations: [show(1)] })]));
});

test("word_by_word: every text revealed word by word; no cap while one line lands whole", async () => {
  const reveal = (start, unit) => ({ kind: "in", start, duration: 0.8, easing: "smooth", unit, stagger: 0.1, from: { opacity: 0 }, to: { opacity: 1 } });
  const lines = (count) => scene({ duration: 6, layers: [0, 1, 2, 3].map((index) => text(`line${index}`, `Say it word by word ${index}`, { y: 100 + index * 200, animations: [reveal(0.2 + index, index < count ? "words" : "layer")] })) });
  await fires("word_by_word", lines(4));
  await silent("word_by_word", lines(3));
});

test("soft_cuts: not a fade at every section change", async () => {
  // Four sections, one text each. Bad: each leaves with a fade. Good: two of them cut.
  const sectioned = (fades) => scene({ duration: 8, layers: [0, 1, 2, 3].map((index) => text(`part${index}`, `Part ${index}`, {
    animations: [...(index ? [show(index * 2)] : []), ...(index < 3 ? [fades[index] ? fadeOut(index * 2 + 1.65, 0.35) : hide(index * 2 + 2)] : [])],
  })) });
  await fires("soft_cuts", sectioned([true, true, true]));
  await silent("soft_cuts", sectioned([true, false, false]));
});

test("blurred_backdrop: centered titles over blurred footage beat after beat, not one hook", async () => {
  const backed = (blur, x = 760, count = 3) => scene({ duration: 6, layers: [
    rect("footage", { type: "image", src: "/api/media/frame.png", x: 0, y: 0, width: 1920, height: 1080, blur }),
    ...Array.from({ length: count }, (_, index) => text(`title${index}`, `Hello ${index}`, { x, width: 400, height: 100, textResize: "fixed",
      animations: [...(index ? [show(index * 2)] : []), ...(index < count - 1 ? [hide(index * 2 + 2)] : [])] }))] });
  const [finding] = await fires("blurred_backdrop", backed(20));
  assert.deepEqual(finding.itemIds, ["title0", "title1", "title2"]);
  await silent("blurred_backdrop", backed(20, 760, 1));
  // One designed hook made of three texts at once is one beat.
  await silent("blurred_backdrop", scene({ duration: 6, layers: [rect("footage", { type: "image", src: "/api/media/frame.png", x: 0, y: 0, width: 1920, height: 1080, blur: 20 }),
    ...[0, 1, 2].map((index) => text(`hook${index}`, `Hello ${index}`, { x: 760, y: 300 + index * 150, width: 400, height: 100, textResize: "fixed" }))] }));
  await silent("blurred_backdrop", backed(0));
  await silent("blurred_backdrop", backed(20, 120));
  // A blurred fill behind a sharp clip (a 16:9 clip in a 9:16 frame) is not the look: captions over it are fine.
  const filled = scene({ width: 1080, height: 1920, layers: [
    rect("fill", { type: "video", src: "/api/media/clip.mp4", mediaSourceDuration: 30, x: -1166, y: 0, width: 3413, height: 1920, blur: 40 }),
    rect("clip", { type: "video", src: "/api/media/clip.mp4", mediaSourceDuration: 30, x: 0, y: 656, width: 1080, height: 608 }),
    text("cap", "she walks to the store", { x: 240, y: 1400, width: 600, height: 80, textResize: "fixed", role: "caption" })] });
  await silent("blurred_backdrop", filled);
});

test("text_glow: no glow on text", async () => {
  const titled = (shadow) => scene({ layers: [text("title", "Hello", { shadow })] });
  const [finding] = await fires("text_glow", titled({ color: "#ffd166", blur: 30, x: 0, y: 0 }));
  assert.equal(finding.fix.kind, "item");
  assert.equal(finding.fix.properties.shadow, null);
  await silent("text_glow", titled({ color: "#00000066", blur: 12, x: 0, y: 8 }));
  await silent("text_glow", titled(null));
});

test("stacked_label: a small label right above a headline, not a caption under it or a label beside or far from it", async () => {
  const titled = (label) => scene({ layers: [text("head", "5 VIEWS AFTER DARK", { fontSize: 140, y: 400 }), text("label", "CITY GUIDE", { fontSize: 32, fill: "#d9480f", ...label })] });
  const [finding] = await fires("stacked_label", titled({ y: 340 }));
  assert.deepEqual([finding.itemId, finding.fix.kind, finding.fix.itemId], ["label", "delete_item", "label"]);
  assert.match(finding.measured, /caps, another color/);
  await silent("stacked_label", titled({ y: 600 }));
  await silent("stacked_label", titled({ y: 100 }));
  await silent("stacked_label", titled({ x: 1650, y: 440 }));
});

// Defaults nobody chose (engine/quality/rules/aiTells.js). A plain edit: full-frame shots cut in at
// uneven lengths, locked off, with a caption that cuts in.
const AI_TELLS = ["fade_only_entrances", "drift_on_every_shot", "even_shot_lengths", "split_card_layout", "page_chrome"];
const shotsOf = (lengths, extra = () => []) => {
  const starts = lengths.map((_, index) => lengths.slice(0, index).reduce((sum, value) => sum + value, 0));
  return lengths.map((length, index) => ({ type: "video", id: `shot${index}`, name: `shot${index}`, src: `/api/media/s${index}.mp4`, mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080,
    animations: [...(index ? [show(starts[index])] : []), ...(index < lengths.length - 1 ? [hide(starts[index] + length)] : []), ...extra(starts[index], length)] }));
};
const UNEVEN = [0.8, 1.2, 4, 1, 3.5, 1.5];
const plainEdit = (layers = shotsOf(UNEVEN)) => scene({ duration: 12, layers: [...layers, text("cap", "she walks to the store", { y: 900, animations: [show(1)] })] });

test("AI tells: fades on everything, drift on every shot, even shots, a split card, page chrome", async () => {
  for (const code of AI_TELLS) await silent(code, plainEdit());
  // Five layers that only fade in (and the caption cuts in) over one shot.
  const fades = plainEdit([...shotsOf([12]), ...[0, 1, 2, 3, 4].map((index) => rect(`dot${index}`, { x: 200 + index * 340, animations: [fadeIn(1 + index)] }))]);
  const [fade] = await fires("fade_only_entrances", fades);
  assert.match(fade.measured, /^5 of 6 entrances only fade/);
  // Every shot drifts 3%.
  await fires("drift_on_every_shot", plainEdit(shotsOf(UNEVEN, (start, length) => [move(start, length, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: 1.03, scaleY: 1.03 })])));
  // Six shots of 2 s.
  const [even] = await fires("even_shot_lengths", plainEdit(shotsOf([2, 2, 2, 2, 2, 2])));
  assert.match(even.measured, /^spread 0 over 6 shots/);
  // A big number left, a rounded clipped card right, over a flat rectangle.
  const split = scene({ duration: 6, layers: [rect("bg", { x: 0, y: 0, width: 1920, height: 1080, fill: "#101010" }),
    text("number", "78.9", { fontSize: 220, x: 120, y: 300, fill: "#ffffff" }),
    { type: "group", id: "card", name: "card", x: 1100, y: 140, width: 700, height: 800, radius: 36, clipContent: true },
    { type: "video", id: "rec", name: "rec", parentId: "card", src: "/api/media/rec.mp4", mediaSourceDuration: 30, x: 0, y: 0, width: 700, height: 800 }] });
  await fires("split_card_layout", split);
  // A tracked caps label and a row of thin bars held 10 s.
  const chrome = plainEdit([...shotsOf(UNEVEN), text("unit", "M TO TARGET", { fontSize: 30, letterSpacing: 6, y: 600 }),
    ...[0, 1, 2, 3, 4].map((index) => rect(`seg${index}`, { x: 120 + index * 40, y: 680, width: 32, height: 20 }))]);
  assert.deepEqual((await fires("page_chrome", chrome)).map((finding) => finding.measured.split(" ")[0]), ["label", "a"]);
});

// ---------------------------------------------------------------- camera rules

const plate = (id, props = {}) => ({ type: "image", id, name: id, src: `/api/media/${id}.png`, x: 0, y: 0, width: 1920, height: 1080, ...props });
const grow = (start, duration, to) => move(start, duration, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: to, scaleY: to });

test("lone_zoom: a clip pushed in alone over a still shot (a push hidden under a 96% black is not seen)", async () => {
  const pushed = (overlay) => scene({ duration: 3, layers: [
    plate("street", { type: "video", src: "/api/media/street.mp4", mediaSourceDuration: 20, animations: [grow(0.5, 1, 1.08)] }),
    ...(overlay ? [rect("lights-out", { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", opacity: 0.96 })] : []),
    { type: "video", id: "phone", name: "phone", src: "/api/media/screen.mp4", mediaSourceDuration: 20, x: 760, y: 190, width: 400, height: 700, animations: [grow(0.5, 1, 1.5)] }] });
  const [finding] = await fires("lone_zoom", pushed(true));
  assert.deepEqual(finding.itemIds, ["phone", "lights-out"]);
  assert.match(finding.message, /grows x1\.50 from 0\.5 to 1\.5 s/);
  await silent("lone_zoom", pushed(false));
  // Over a flat brand color with no shot under it, a product zoom; a picture popping in is an entrance.
  const lone = (layers) => scene({ duration: 3, layers: [rect("brand", { x: 0, y: 0, width: 1920, height: 1080 }), ...layers] });
  await silent("lone_zoom", lone([{ type: "video", id: "ui", name: "ui", src: "/api/media/ui.mp4", mediaSourceDuration: 20, x: 760, y: 190, width: 400, height: 700, animations: [grow(0.5, 1, 1.5)] }]));
  await silent("lone_zoom", scene({ duration: 3, layers: [plate("street", { type: "video", src: "/api/media/street.mp4", mediaSourceDuration: 20 }),
    { type: "video", id: "cam", name: "cam", src: "/api/media/cam.mp4", mediaSourceDuration: 20, x: 1200, y: 600, width: 600, height: 400, animations: [fadeIn(1, 0.15), grow(1, 0.4, 1.5)] }] }));
  // Letterboxed footage (16:9 in 9:16) is the shot behind too; a slow drift after the push is not the push.
  const [boxed] = await fires("lone_zoom", scene({ duration: 5, width: 1080, height: 1920, layers: [
    plate("street", { type: "video", src: "/api/media/street.mp4", mediaSourceDuration: 20, y: 656, width: 1080, height: 608 }),
    { type: "video", id: "phone", name: "phone", src: "/api/media/screen.mp4", mediaSourceDuration: 20, x: 340, y: 660, width: 400, height: 600,
      animations: [grow(0.5, 0.5, 1.4), move(1, 3, "linear", { scaleX: 1.4, scaleY: 1.4 }, { scaleX: 1.45, scaleY: 1.45 })] }] }));
  assert.deepEqual(boxed.itemIds, ["phone", "street"]);
  assert.ok(boxed.until <= 1.2, `the push ends near 1 s, not with the drift: ${boxed.until}`);
  // A slow push's long ease-out is still the push (it slows down; a drift does not).
  const [slow] = await fires("lone_zoom", scene({ duration: 4, layers: [plate("street"),
    { type: "video", id: "phone", name: "phone", src: "/api/media/screen.mp4", mediaSourceDuration: 20, x: 760, y: 190, width: 400, height: 700, animations: [grow(0.5, 3, 1.5)] }] }));
  assert.ok(slow.until >= 3.3, `the push runs to its end near 3.5 s: ${slow.until}`);
});

test("edge_linger: a layer crawling at the frame edge as a sliver, not one leaving at speed", async () => {
  const card = (animations) => scene({ duration: 3, layers: [rect("card", { x: 1500, y: 340, width: 400, height: 400, animations })] });
  const [finding] = await fires("edge_linger", card([move(0.2, 1, "smooth", { x: 1500 }, { x: 1850 }, "custom"), move(1.2, 1.4, "smooth", { x: 1850 }, { x: 1880 }, "custom"), move(2.6, 0.3, "ease-in", { x: 1880 }, { x: 2000 }, "out")]));
  assert.match(finding.message, /sliver/);
  await silent("edge_linger", card([move(1, 0.3, "ease-in", { x: 1500 }, { x: 2000 }, "out")]));
  // An ease-out exit crawls off the edge at its end.
  await fires("edge_linger", card([move(0.5, 1.2, "ease-out", { x: 1200 }, { x: 1940 }, "out")]));
  // A shape never seen half in frame bleeds off the edge by design (a cropped accent).
  await silent("edge_linger", scene({ duration: 3, layers: [rect("accent", { x: 1750, y: 140, width: 800, height: 800, animations: [move(0, 3, "linear", { x: 1760 }, { x: 1740 })] })] }));
});

test("transition_dip: a dissolve that fades both shots at once dips; fading only the top one does not", async () => {
  const dissolve = (both) => scene({ duration: 3, layers: [
    plate("a", { animations: both ? [fadeOut(1, 0.6, "linear")] : [hide(1.6)] }),
    plate("b", { animations: [fadeIn(1, 0.6, "linear")] })] });
  const [finding] = await fires("transition_dip", dissolve(true));
  assert.match(finding.measured, /7\d% covered/);
  await silent("transition_dip", dissolve(false));
  // A quick dip through black on purpose: A fades out, then B fades in, overlapping a little (24% at the lowest).
  await silent("transition_dip", scene({ duration: 3, layers: [plate("a", { animations: [fadeOut(1, 0.4, "linear")] }), plate("b", { animations: [fadeIn(1.3, 0.4, "linear")] })] }));
});

test("cut_mid_move: a hard cut that chops a fast push with the next shot still", async () => {
  const cutAt = (time) => scene({ duration: 3, layers: [
    plate("a", { animations: [grow(0.5, 1, 1.6), hide(time)] }),
    plate("b", { animations: [show(time)] })] });
  const [finding] = await fires("cut_mid_move", cutAt(0.95));
  assert.match(finding.message, /cut while still moving/);
  await silent("cut_mid_move", cutAt(1.7));
});

// ---------------------------------------------------------------- consistency

test("role_font_drift: two families among captions, or a caption at another size", async () => {
  const person = (family, size = 40) => [text("c1", "she walks to the store", { fontSize: 40, role: "caption" }),
    text("c2", "the phone tells her where", { fontSize: size, fontFamily: family, role: "caption", y: 600 })];
  const captions = (family, size) => scene({ layers: person(family, size) });
  const [finding] = await fires("role_font_drift", captions("Inter"));
  assert.equal(ruleOf("role_font_drift").level, "warn");
  assert.equal(finding.fix.kind, "font");
  const [size] = await fires("role_font_drift", captions("Noto Serif", 52));
  assert.match(size.measured, /caption at 40, 52/);
  await silent("role_font_drift", captions("Noto Serif"));
  // Each voice (a judge in yellow beside the person's captions) keeps its own face and size; inside a voice (one color however written) it still drifts.
  const judge = (id, fontSize, y, fill = "#ffff00") => text(id, "the judges were not convinced", { fontSize, fontFamily: "Inter", fill, role: "caption", y });
  await silent("role_font_drift", scene({ layers: [...person("Noto Serif"), judge("j1", 52, 800)] }));
  const [inVoice] = await fires("role_font_drift", scene({ layers: [...person("Noto Serif"), judge("j1", 52, 800), judge("j2", 62, 900, "#FF0")] }));
  assert.match(inVoice.measured, /caption \(voice #ffff00\) at 52, 62/);
  // Against the style bible's caption face one caption is enough; it warns (a second face can have a job).
  const bible = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { caption: { family: "JetBrains Mono", size: 40 } } } };
  const { findings: locked } = await check("role_font_drift", captions("Noto Serif"), bible);
  assert.deepEqual([locked[0].severity, locked[0].fix.family], ["warn", "JetBrains Mono"]);
  // An off-size caption against the style's size names where the size comes from; a body note is not a caption.
  const styled = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { caption: { family: "Inter", size: 44 } } } };
  const notes = scene({ layers: [text("c1", "she walks to the store", { fontSize: 60, fontFamily: "Inter", role: "caption" }), text("n1", "always look up from the screen", { fontSize: 36, fontFamily: "Inter", role: "body", y: 600 })] });
  const { findings: [styleSize] } = await check("role_font_drift", notes, styled);
  assert.match(styleSize.message, /"c1" is caption text at another size than the style says \(caption 44 px\)/);
  assert.deepEqual(styleSize.itemIds, ["c1"]);
  // A wordmark text named logo is the logo's, not a caption's or a title's.
  await silent("role_font_drift", scene({ layers: [text("c1", "she walks to the store", { fontSize: 40, fontFamily: "JetBrains Mono", role: "caption" }), text("logo", "oak", { fontSize: 160, y: 600 })] }), bible);
  // A brand's serif and sans headlines, and a mock screen's small copy beside captions, are choices.
  await silent("role_font_drift", scene({ layers: [text("h1", "Plan less", { fontSize: 140 }), text("h2", "Ship more", { fontSize: 72, fontFamily: "Inter", y: 500 }),
    text("ui", "your order is on the way", { fontSize: 24, fontFamily: "Inter", y: 700 }), text("cap", "she checks the app again", { fontSize: 44, fontFamily: "Inter", role: "caption", y: 800 }),
    text("cap2", "and it finally arrives home", { fontSize: 44, fontFamily: "Inter", role: "caption", y: 900 })] }), { brandFonts: ["Noto Serif", "Inter"] });
  // A quote face (style.fonts.quote) gives a pull quote its own job at any size; off it, a quoted line drifts.
  const quoted = (family) => scene({ layers: [text("h1", "Plan less", { fontSize: 120, fontFamily: "Inter" }), text("q1", "“it finally clicked”", { fontSize: 150, fontFamily: family, y: 500 })] });
  const voice = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { display: { family: "Inter", size: 120 }, quote: { family: "Noto Serif", size: 80 } } } };
  await silent("role_font_drift", quoted("Noto Serif"), voice);
  assert.equal((await check("role_font_drift", quoted("JetBrains Mono"), voice)).findings[0].fix.family, "Inter");
  // A big number is a stat, its own role: another face than the bible's display is fine.
  const titled = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { display: { family: "Noto Serif", size: 120 } } } };
  await silent("role_font_drift", scene({ layers: [text("h1", "Plan less", { fontSize: 120 }), text("n1", "40%", { fontSize: 200, fontFamily: "Inter", y: 500 })] }), titled);
  // With a stat face in the bible, a big line that leads with a number in it is a stat; in a third face it is off-face display.
  const stats = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { display: { family: "Noto Serif", size: 120 }, stat: { family: "Inter", size: 200 } } } };
  const statLine = (family) => scene({ layers: [text("h1", "Plan less", { fontSize: 120, fontFamily: "Noto Serif" }), text("n1", "3x faster", { fontSize: 160, fontFamily: family, y: 500 })] });
  await silent("role_font_drift", statLine("Inter"), stats);
  const { findings: [offStat] } = await check("role_font_drift", statLine("JetBrains Mono"), stats);
  assert.deepEqual([offStat.severity, offStat.itemId], ["warn", "n1"]);
  // The bible's label face holds texts marked label; its display size flags an off-size title, not its kicker.
  const labeled = { styleSpec: { wants: [], avoids: [], by: "guessed", fonts: { label: { family: "Noto Serif", size: 30 }, display: { family: "Noto Serif", size: 120 } } } };
  const { findings: [label] } = await check("role_font_drift", scene({ layers: [text("l1", "new", { fontSize: 30, fontFamily: "Inter", role: "label" })] }), labeled);
  assert.equal(label.severity, "warn");
  const sized = (kicker) => scene({ duration: 4, layers: [text("h1", "Plan less", { fontSize: 120, animations: [hide(2)] }), text("h2", "ship more", { fontSize: 72, y: 500, animations: kicker ? [hide(2)] : [hide(0), show(2)] })] });
  const [display] = await fires("role_font_drift", sized(false), labeled);
  assert.deepEqual([display.severity, display.itemId], ["warn", "h2"], display.message);
  await silent("role_font_drift", sized(true), labeled);
});

test("vocabulary_budget: only the style bible's moves; how many ways text enters is busy_edit's", async () => {
  const enter = (presets) => scene({ duration: 10, layers: presets.map((preset, index) => text(`t${index}`, `line number ${index}`, { y: 100 + index * 150, animations: [{ kind: "in", preset: { id: preset, mode: "in" }, start: index * 2, duration: 0.5, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } }] })) });
  await fires("busy_edit", enter(["fade", "slide", "blur", "grow"]));
  await silent("vocabulary_budget", enter(["fade", "slide", "blur", "grow"]));
  // With style.moves, a technique outside them is named.
  const moves = (tags) => ({ styleSpec: { wants: [], avoids: [], by: "guessed", moves: tags.map((tag) => ({ tag, where: "every line" })) } });
  const [outside] = await fires("vocabulary_budget", enter(["fade", "slide", "fade", "slide"]), moves(["type-fade"]));
  assert.match(outside.measured, /outside the moves: type-slide/);
  await silent("vocabulary_budget", enter(["fade", "slide", "fade", "slide"]), moves(["type-fade", "type-slide"]));
  // Motion blur that judder's auto fix added (its IDs) is not a move of the style; the same blur
  // added by hand is.
  const blurred = (id) => scene({ duration: 10, layers: [text("t0", "line number 0", { animations: [fadeIn(0)] }),
    rect("panel", { x: 400, y: 240, width: 1100, height: 600, animations: [move(4, 2, "smooth", { x: -1100 }),
      { id: `${id}.1`, kind: "effect", effect: "directional-blur", start: 4, duration: 1, easing: "linear", from: { length: 0 }, to: { length: 50 } },
      { id: `${id}.2`, kind: "effect", effect: "directional-blur", start: 5, duration: 1, easing: "linear", to: { length: 0 } }] })] });
  await silent("vocabulary_budget", blurred(judderBlurId("panel", 4)), moves(["type-fade"]));
  const [handmade] = await fires("vocabulary_budget", blurred("panel.streak"), moves(["type-fade"]));
  assert.match(handmade.measured, /motion-blur/);
});

test("brand_consistency: a logo shown three times, or in two looks", async () => {
  const logo = (id, start, props = {}) => rect(id, { role: "logo", fill: "#111111", animations: [show(start), hide(start + 1)], ...props });
  await fires("brand_consistency", scene({ duration: 9, layers: [logo("l1", 0), logo("l2", 4), logo("l3", 7)] }));
  await fires("brand_consistency", scene({ duration: 9, layers: [logo("l1", 0), logo("l2", 7, { shadow: { color: "#ff5ca8", blur: 24, x: 0, y: 0 } })] }));
  // A color swap (a dark mark on a light card) is the same look.
  await silent("brand_consistency", scene({ duration: 9, layers: [logo("l1", 0), logo("l2", 7, { fill: "#ff5ca8" })] }));
  // The style bible's logo.max: over it warns, never a gate.
  const { findings: [over] } = await check("brand_consistency", scene({ duration: 9, layers: [logo("l1", 0), logo("l2", 7)] }), { styleSpec: { wants: [], avoids: [], by: "guessed", logo: { asset: "l1", max: 1 } } });
  assert.deepEqual([over.severity, over.at], ["warn", 7]);
});

test("story_stall and hook_readable: a dark gap with no picture, an opening with only small type", async () => {
  const dark = (gap) => scene({ duration: 20, background: "#050505", layers: [
    rect("shot", { type: "image", src: "/api/media/x.png", x: 0, y: 0, width: 1920, height: 1080, animations: [hide(6), show(6 + gap)] }),
    text("hook", "watch this", { fontSize: 120, fill: "#ffffff" })] });
  const [stall] = await fires("story_stall", dark(6));
  assert.equal(stall.at, 6);
  await silent("story_stall", dark(3));
  // Inside a signature range the stall is the designed moment; one that runs on past it is not.
  const range = (to) => ({ styleSpec: { by: "guessed", spine: [{ role: "signature", from: 5, to, purpose: "the blackout" }] } });
  assert.match((await silent("story_stall", dark(6), range(13))).join("\n"), /story_stall: 1 inside the signature moment left alone/);
  await fires("story_stall", dark(6), range(8));
  // A big lit card drawn in shapes is a picture too.
  const card = scene({ duration: 20, background: "#050505", layers: [
    rect("shot", { type: "image", src: "/api/media/x.png", x: 0, y: 0, width: 1920, height: 1080, animations: [hide(6), show(12)] }),
    rect("card", { fill: "#f0e6d2", x: 360, y: 140, width: 1200, height: 800, animations: [hide(0), show(6), hide(12)] })] });
  await silent("story_stall", card);
  await silent("story_stall", scene({ duration: 20, background: "#000000", layers: [text("kinetic", "every word lands", { fontSize: 140, fill: "#ffffff" })] }));
  const opening = (size) => scene({ duration: 10, background: "#050505", layers: [text("hook", "the best project", { fontSize: size, fill: "#ffffff" })] });
  await fires("hook_readable", opening(50));
  await silent("hook_readable", opening(120));
});

test("text_only_open: a promo's first 4 s are not text on a plain frame; a text hook over footage is fine", async () => {
  const promo = (shotAt, { videoType = "promo", extra = [] } = {}) => scene({ duration: 12, videoType, background: "#050505", layers: [
    rect("app", { type: "image", src: "/api/media/app.png", x: 0, y: 0, width: 1920, height: 1080, animations: [hide(0), show(shotAt)] }),
    text("hook", "your inbox, finally quiet", { fontSize: 120, fill: "#ffffff" }), ...extra] });
  const [open] = await fires("text_only_open", promo(9));
  assert.match(open.fix.text, /^Open on "app" under the line/);
  await silent("text_only_open", promo(0.5));
  // The logo sting a promo opens on (promo_basics) and an explainer's title card are not text alone.
  await silent("text_only_open", promo(9, { extra: [rect("logo", { type: "image", src: "/api/media/logo.png", x: 860, y: 40, width: 200, height: 200 })] }));
  await silent("text_only_open", promo(9, { videoType: "explainer" }));
  // Not a promo (no type, no logo): a title card first is the video's call.
  await silent("text_only_open", scene({ duration: 12, background: "#050505", layers: [text("hook", "your inbox, finally quiet", { fontSize: 120, fill: "#ffffff" })] }));
});

test("accent_budget: the style bible's accent stays a small part of the frame", async () => {
  const accent = { styleSpec: { wants: [], avoids: [], by: "guessed", accent: { color: "#ff5ca8", share: 0.1 } } };
  const slab = (width) => scene({ duration: 4, layers: [rect("scan", { fill: "#ff5ca8", x: 0, y: 0, width, height: 1080 })] });
  const [finding] = await fires("accent_budget", slab(960), accent);
  assert.match(finding.measured, /50% of the frame/);
  await silent("accent_budget", slab(120), accent);
  await silent("accent_budget", slab(960));
  // A gradient counts as its main stop; a thick accent outline counts too.
  const gradient = (main) => scene({ duration: 4, layers: [rect("wash", { x: 0, y: 0, width: 960, height: 1080, fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: main }, { offset: 0.9, color: main }, { offset: 1, color: main === "#ff5ca8" ? "#111111" : "#ff5ca8" }] } })] });
  await fires("accent_budget", gradient("#ff5ca8"), accent);
  await silent("accent_budget", gradient("#111111"), accent);
  await fires("accent_budget", scene({ duration: 4, layers: [rect("frame", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff00", stroke: "#ff5ca8", strokeWidth: 80 })] }), accent);
});

test("pacing_jump: the cut rate jumps 3x with no music or story turn", async () => {
  // 8 s of 4 s shots, then 8 s of 0.5 s shots.
  const times = [0, 4, ...Array.from({ length: 16 }, (unused, index) => 8 + index * 0.5)];
  const pace = scene({ duration: 16, layers: times.map((at, index) => plate(`s${index}`, { animations: [...(at ? [hide(0), show(at)] : []), ...(times[index + 1] ? [hide(times[index + 1])] : [])] })) });
  const [jump] = await fires("pacing_jump", pace);
  assert.match(jump.measured, /median shot 4s .* then 0\.5s/);
  // A marker cue at the change (the drop) is the reason.
  await silent("pacing_jump", pace, { cues: [{ name: "drop", time: 8, kind: "marker" }] });
  // A turn 3 s from where the change starts explains nothing, nor does a spine beat edge: the
  // pace changes inside a beat.
  await fires("pacing_jump", pace, { cues: [{ name: "drop", time: 5, kind: "marker" }] });
  await fires("pacing_jump", pace, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: [{ role: "hook", from: 0, to: 5, purpose: "open" }, { role: "proof", from: 5, to: 16, purpose: "show" }] } });
  // A trailer's whiplash: 11 s of slow shots, 19 cuts in 8.4 s, a
  // slow stretch again. Beat edges where it starts and stops do not excuse a burst that jumps back.
  const burst = [0, 3.7, 7.4, ...Array.from({ length: 19 }, (unused, index) => 11 + index * 0.44), 19.4, 23.4, 27.4];
  const whiplash = scene({ duration: 32, layers: burst.map((at, index) => plate(`w${index}`, { animations: [...(at ? [hide(0), show(at)] : []), ...(burst[index + 1] ? [hide(burst[index + 1])] : [])] })) });
  const spine = { styleSpec: { wants: [], avoids: [], by: "guessed", spine: [{ role: "product", from: 0, to: 11, purpose: "code" }, { role: "proof", from: 11, to: 19.4, purpose: "walk" }, { role: "proof", from: 19.4, to: 32, purpose: "arrive" }] } };
  const [lurch] = await fires("pacing_jump", whiplash, spine);
  assert.match(lurch.message, /whiplashes/);
});

test("ending_count: a payoff and an end card, not four closing titles", async () => {
  // The last 20% of 30 s starts at 24 s; closing titles 1.6 s apart.
  const ending = (count) => scene({ duration: 30, layers: [plate("story"),
    ...Array.from({ length: count }, (unused, index) => text(`end${index}`, `closing line ${index}`, { fontSize: 120, y: 100 + index * 200, animations: [hide(0), show(24.5 + index * 1.6)] }))] });
  const [finding] = await fires("ending_count", ending(4));
  assert.match(finding.measured, /4 closing beats/);
  await silent("ending_count", ending(2));
  // The idea spine closes on a coda, like an end card: the titles after the story still count.
  const coda = { styleSpec: { by: "guessed", spine: [{ role: "how", from: 0, to: 24, purpose: "a" }, { role: "payoff", from: 24, to: 27, purpose: "b" }, { role: "coda", from: 27, to: 30, purpose: "c" }] } };
  await fires("ending_count", ending(4), coda);
  // Big running captions with no gap since before the closing stretch are one track, not endings;
  // big closing titles marked caption after a gap still count.
  const captions = (starts, length) => scene({ duration: 30, layers: [plate("story"),
    ...starts.map((at, index) => text(`cap${index}`, `line number ${index}`, { role: "caption", fontSize: 120, y: 400, animations: [hide(0), show(at), hide(at + length)] }))] });
  await silent("ending_count", captions([22, 24, 26, 28], 2));
  await fires("ending_count", captions([24.5, 26.5, 28.5], 1.5));
  // A track that starts in the closing stretch (a closing line read out) is one ending.
  await silent("ending_count", captions([24.5, 26.5, 28.5], 2));
});

test("overlay_covers_subject: a layer over the marked subject for over 0.5 s is a gate", async () => {
  const walk = { type: "video", id: "walk", name: "walk", src: "/api/media/walk.mp4", mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080,
    subjectBoxes: { src: "/api/media/walk.mp4", boxes: [0, 1, 2, 3, 4].map((at) => ({ at, box: [40, 20, 20, 60], by: "agent" })) } };
  const over = (x) => scene({ duration: 4, layers: [walk, rect("phone", { x, y: 300, width: 400, height: 600 })] });
  const run = (document) => check("overlay_covers_subject", document, { scene: document.scenes[0] });
  covered.add("overlay_covers_subject");
  const { findings: [finding] } = await run(over(800));
  assert.deepEqual([finding.severity, finding.itemId], ["error", "phone"]);
  // The auto fix slides the phone to the nearest free place in the safe area (right of the subject).
  assert.deepEqual([finding.fix.kind, finding.fix.auto, finding.fix.dy], ["move", true, 0]);
  assert.ok(800 + finding.fix.dx >= 1152);
  assert.deepEqual((await run(over(1450))).findings, []);
  // A see-through tint, or big type, over the subject is a warning.
  const tint = await run(scene({ duration: 4, layers: [walk, rect("tint", { x: 700, y: 200, width: 560, height: 700, fill: "#ff5ca866" })] }));
  assert.equal(tint.findings[0].severity, "warn");
  const type = await run(scene({ duration: 4, layers: [walk, text("big", "WALK", { fontSize: 400, x: 700, y: 300 })] }));
  assert.equal(type.findings[0].severity, "warn");
  // A caption over the subject's middle is a gate (its move is a suggestion: the track keeps one
  // place); so is big type mid-video, unless the style asks for type over the footage.
  const face = { ...walk, subjectBoxes: { ...walk.subjectBoxes, boxes: [0, 1, 2, 3, 4].map((at) => ({ at, box: [45, 40, 10, 10], by: "agent" })) } };
  const caption = await run(scene({ duration: 4, layers: [face, text("cap", "she walks to the store", { role: "caption", fontSize: 44, x: 700, y: 460, width: 520 })] }));
  assert.deepEqual([caption.findings[0].severity, caption.findings[0].fix.auto], ["error", false]);
  const midTitle = scene({ duration: 10, layers: [{ ...walk, subjectBoxes: { ...walk.subjectBoxes, boxes: [0, 2, 4, 6, 8, 10].map((at) => ({ at, box: [40, 20, 20, 60], by: "agent" })) } },
    text("big", "WALK", { fontSize: 400, x: 700, y: 300, animations: [hide(0), show(4), hide(6)] })] });
  assert.equal((await run(midTitle)).findings[0].severity, "error");
  const wanted = await check("overlay_covers_subject", midTitle, { scene: midTitle.scenes[0], styleSpec: { wants: [], avoids: [], by: "guessed", lines: [{ text: "giant type over the footage" }] } });
  assert.equal(wanted.findings[0].severity, "warn");
  // Words that turn it down ("never put text over faces") ask the opposite: still a gate.
  const turnedDown = await check("overlay_covers_subject", midTitle, { scene: midTitle.scenes[0], styleSpec: { wants: [], avoids: [], by: "you", quote: "never put text over faces" } });
  assert.equal(turnedDown.findings[0].severity, "error");
  // An outline ring around the subject (no fill) leaves it in view.
  assert.deepEqual((await run(scene({ duration: 4, layers: [walk, rect("ring", { x: 740, y: 180, width: 440, height: 720, fill: "#ffffff00", stroke: "#ffffff", strokeWidth: 6 })] }))).findings, []);
  // No subject marked: nothing to judge.
  const { subjectBoxes, ...plain } = walk;
  assert.ok(subjectBoxes);
  const unmarked = scene({ duration: 4, layers: [plain, rect("phone", { x: 800, y: 300, width: 400, height: 600 })] });
  assert.deepEqual((await run(unmarked)).findings, []);
  // A person Apple Vision found stands in for the mark: a warning, its move only a suggestion.
  const person = { box: [0.4, 0.25, 0.2, 0.75], head: 3, top: 0.35, headBox: [0.45, 0.3, 0.1, 0.2] };
  const people = { [walk.src]: { samples: [0, 1, 2, 3, 4].map((t) => ({ t, faces: [], people: [person] })) } };
  const found = await check("overlay_covers_subject", unmarked, { scene: unmarked.scenes[0], people });
  assert.deepEqual([found.findings[0].severity, found.findings[0].fix.auto], ["warn", false]);
  assert.match(found.findings[0].message, /person's face/);
  // Over the person's legs (not the head or raised hands): quiet.
  const legs = scene({ duration: 4, layers: [plain, rect("phone", { x: 800, y: 760, width: 400, height: 300 })] });
  assert.deepEqual((await check("overlay_covers_subject", legs, { scene: legs.scenes[0], people })).findings, []);
  // A face found with no body around it (a close-up) counts too.
  const faceOnly = { [walk.src]: { samples: [0, 1, 2, 3, 4].map((t) => ({ t, faces: [[0.45, 0.3, 0.1, 0.2]], people: [] })) } };
  assert.equal((await check("overlay_covers_subject", unmarked, { scene: unmarked.scenes[0], people: faceOnly })).findings[0]?.severity, "warn");
});

test("head_cut_off: a person's head out of the picture for a second is a warning", async () => {
  const walk = { type: "video", id: "walk", name: "walk", src: "/api/media/walk.mp4", mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080 };
  const at = (person) => ({ [walk.src]: { samples: [0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => ({ t, faces: [], people: [person] })) } });
  const doc = (layer) => scene({ duration: 3, layers: [layer] });
  const run = (document, people) => check("head_cut_off", document, { scene: document.scenes[0], people });
  covered.add("head_cut_off");
  // Filmed that way: the body touches the top and the pose finds no head.
  const [finding] = (await run(doc(walk), at({ box: [0.4, 0, 0.3, 1], head: 0 }))).findings;
  assert.deepEqual([finding.severity, finding.itemId], ["warn", "walk"]);
  assert.match(finding.message, /filmed that way/);
  // The head in the picture (a close-up whose box reaches the top but the eyes sit low): quiet.
  assert.deepEqual((await run(doc(walk), at({ box: [0.4, 0, 0.3, 1], head: 3, top: 0.25 }))).findings, []);
  // The crop cuts it off: the layer pushed up past the top of the frame.
  const pushed = { ...walk, y: -400, height: 1480, width: 2632, x: -356 };
  const [cropped] = (await run(doc(pushed), at({ box: [0.4, 0.05, 0.3, 0.95], head: 3, top: 0.12 }))).findings;
  assert.match(cropped.message, /crop cuts it off/);
  // A blurred backdrop is not framing anyone.
  assert.deepEqual((await run(doc({ ...walk, blur: 30 }), at({ box: [0.4, 0, 0.3, 1], head: 0 }))).findings, []);
});

// ---------------------------------------------------------------- restraint, request_unmet

test("restraint: a grade stacked on a grade, one footage moment twice and letterboxed footage warn; one grade and fresh footage are quiet", async () => {
  const grade = (effect, start, duration) => ({ kind: "effect", effect, start, duration, easing: "smooth", to: {} });
  const clip = (id, start, offset, props = {}) => ({ type: "video", id, name: id, src: "/api/media/walk.mp4", x: 0, y: 0, width: 1920, height: 1080, start, duration: 2, mediaStart: start, mediaDuration: 2, mediaOffset: offset, mediaSourceDuration: 20, ...props });
  const bad = scene({ duration: 6, layers: [clip("a", 0, 3, { animations: [grade("color-wheels", 0, 2), grade("white-balance", 0.5, 1.5)] }), clip("b", 2, 3.5), { type: "video", id: "c", name: "c", src: "/api/media/city.mp4", x: 0, y: 290, width: 1920, height: 500, start: 4, duration: 2, mediaSourceDuration: 20 }] });
  const found = await fires("restraint", bad, { scene: bad.scenes[0] });
  assert.deepEqual(found.map((finding) => finding.measured.split(" ")[0]).sort(), ["a", "color-wheels", "footage"].sort());
  const good = scene({ duration: 4, layers: [clip("a", 0, 3, { animations: [grade("color-wheels", 0, 2)] }), clip("b", 2, 9)] });
  await silent("restraint", good, { scene: good.scenes[0] });
  // color_filter "film" is two grades that make one look: not a grade stacked on a grade.
  const look = (effect, number) => ({ ...grade(effect, 0, 2), id: `A${number + 7}`, name: number ? `Filter film ${number + 1}` : "Filter film" });
  const filtered = scene({ duration: 4, layers: [clip("a", 0, 3, { animations: [look("color-wheels", 0), look("hue-saturation", 1)] }), clip("b", 2, 9)] });
  await silent("restraint", filtered, { scene: filtered.scenes[0] });
  // A tile a move made (a recap wall of the clips) shows the moment again by design.
  const recap = scene({ duration: 4, layers: [clip("a", 0, 3), clip("tile", 2, 3.5, { width: 320, height: 180, move: { name: "tile-ring", instance: "tile-ring", part: "tile1" } })] });
  await silent("restraint", recap, { scene: recap.scenes[0] });
});

// ---------------------------------------------------------------- seam_lock, rest_fit (fit_music's song cues)

// Full-frame shots back to back: [start, end] each, from different files.
const shots = (...spans) => scene({ duration: 4, layers: spans.map(([start, end], index) => ({ type: "video", id: `s${index + 1}`, name: `s${index + 1}`, src: `/api/media/shot${index + 1}.mp4`,
  x: 0, y: 0, width: 1920, height: 1080, start, duration: end - start, mediaStart: start, mediaDuration: end - start, mediaSourceDuration: 20, ...(spans[index][2] ?? {}) })) });
const songCues = (pairs) => pairs.map(([name, time]) => ({ name, time, kind: "marker" }));
const withCues = (document, pairs) => ({ scene: document.scenes[0], cues: songCues(pairs) });

test("seam_lock: a cut 6 frames after the drop and a return with no change warn; a cut on the drop, a cut away from any seam and no song cues are quiet", async () => {
  const late = shots([0, 2.2], [2.2, 4]);
  const [miss] = await fires("seam_lock", late, withCues(late, [["song-drop-1", 2]]));
  assert.match(miss.measured, /song-drop-1 at 2 s: cut at 2\.2 s, 6 frames late/);
  const held = shots([0, 4]);
  const [unmarked] = await fires("seam_lock", held, withCues(held, [["song-return-1", 2]]));
  assert.match(unmarked.measured, /no picture change/);
  const locked = shots([0, 2], [2, 4]);
  await silent("seam_lock", locked, withCues(locked, [["song-drop-1", 2], ["song-vocal-in-1", 3.1], ["song-ending", 3.9]]));
  await silent("seam_lock", late);
  // A held shot that pans or punches in on the drop marks it with no cut.
  const pan = shots([0, 4, { animations: [move(2, 0.3, "smooth", { x: 0 }, { x: -300 })] }]);
  await silent("seam_lock", pan, withCues(pan, [["song-drop-1", 2]]));
  const punch = shots([0, 4, { animations: [move(2, 0.2, "smooth", { scaleX: 1, scaleY: 1 }, { scaleX: 1.15, scaleY: 1.15 })] }]);
  await silent("seam_lock", punch, withCues(punch, [["song-drop-1", 2]]));
  // A format variant or another scene is not judged against the video's song.
  await silent("seam_lock", held, { ...withCues(held, [["song-return-1", 2]]), videoScene: false });
});

test("rest_fit: a cut inside a dropout, a late restart and a fast move while the music rests warn; a held shot cut on the return is quiet", async () => {
  const rest = [["song-dropout-1", 1.5], ["song-return-1", 2.5]];
  const busy = shots([0, 1.8], [1.8, 4]);
  const found = await fires("rest_fit", busy, withCues(busy, rest));
  assert.deepEqual(found.map((finding) => finding.measured.split(": ")[1].split(" ")[0]), ["cut", "nothing"]);
  const late = shots([0, 2.7], [2.7, 4]);
  const [slow] = await fires("rest_fit", late, withCues(late, rest));
  assert.match(slow.measured, /restarts at 2\.7 s \(cut\), 6 frames late/);
  const shake = shots([0, 2.5, { animations: [move(1.8, 0.3, "smooth", { x: -200 })] }], [2.5, 4]);
  const [moved] = await fires("rest_fit", shake, withCues(shake, rest));
  assert.match(moved.measured, /"s1" moving/);
  const calm = shots([0, 2.5], [2.5, 4]);
  await silent("rest_fit", calm, withCues(calm, rest));
});

test("request_unmet: quoted words, music and 'no logo' are checked against the edit; a vague note is listed to confirm by looking", async () => {
  const doc = scene({ layers: [text("title", "Launch day", { animations: [fadeIn(0.2)] }), rect("logo", { width: 200, height: 100 })] });
  const asks = [{ id: "N1", note: true, text: 'Title should say "Launch day"' }, { id: "N2", note: true, text: "add music under it" },
    { id: "N3", note: true, text: "no logo please" }, { id: "N4", note: true, text: "make it pop more" }];
  const found = await fires("request_unmet", doc, { scene: doc.scenes[0], asks });
  assert.deepEqual(found.map((finding) => finding.measured.split(":")[0]), ["N2", "N3", "1 note kino cannot check from the document"]);
  assert.equal(found[0].final, true);
  assert.equal(found[2].final, undefined);
  await silent("request_unmet", doc, { scene: doc.scenes[0], asks: asks.slice(0, 1) });
});

// ---------------------------------------------------------------- coverage

test("every data rule has a bad and a good example above", () => {
  // The technique and spine rules have theirs in engine/qualityStyle.test.js, the polish and speech rules in engine/qualityPolish.test.js, out_of_sync in src/clipSync.test.js, seen_before and ending_seen in engine/layoutSignature.test.js, template_end in engine/qualityEnding.test.js, clip_reuse in engine/qualityClipReuse.test.js.
  const polish = new Set(["seen_before", "ending_seen", "template_end", "clip_reuse", "music_stall", "music_turn", "spine_drift", "rejected_text", "signature_missing", "font_fallback", "text_wrap", "text_collision", "text_ghost", "cut_off_at_rest", "held_static", "frozen_screen", "screen_unreadable", "off_brand_font", "speech_cut", "speech_captions", "speech_quotes", "speech_fragment", "mute_word", "music_hard_stop", "voice_under_bed", "voice_level_spread", "bed_jump", "volume_churn", "end_on_fade", "text_load", "soft_upscale", "crop_no_subject", "jump_cut", "frozen_footage", "low_fps_motion", "no_music", "sfx_restraint", "out_of_sync", "track_lost"]);
  const dataCodes = RULES.filter((entry) => !entry.pixels && !TECHNIQUE_RULES.has(entry.code) && !polish.has(entry.code)).map((entry) => entry.code);
  assert.deepEqual(dataCodes.filter((code) => !covered.has(code)), []);
});
