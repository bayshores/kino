// One bad and one good example for each data rule in engine/quality/rules/polish.js (font_fallback,
// text_wrap, text_collision, text_ghost, cut_off_at_rest, held_static, off_brand_font). The rendered polish
// rules (text_on_busy, small_on_empty, render_artifact) are in server/quality-polish-pixels.test.mjs.
// The speech rules (engine/quality/rules/speech.js) are at the end, with a hand-written transcript.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { ruleOf, runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { soundAsWords, spokenWords } from "./quality/rules/speech.js";

const PAPER = "#f5f2ea";
const INK = "#1a1a1a";

function text(id, value, props = {}) {
  return { type: "text", id, name: id, text: value, fontFamily: "Inter", fontSize: 72, fill: INK, textResize: "width-height", x: 200, y: 200, ...props };
}
function rect(id, props = {}) {
  return { type: "rectangle", id, name: id, fill: "#3a5a40", x: 200, y: 200, width: 320, height: 180, ...props };
}
const picture = (id, props = {}) => ({ type: "image", id, name: id, src: "/api/media/frame.png", x: 0, y: 0, width: 600, height: 900, ...props });
const fadeIn = (start, duration = 0.5) => ({ kind: "in", start, duration, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } });
const move = (start, duration, from, to = {}) => ({ kind: "custom", start, duration, easing: "smooth", from, to });

function scene({ layers = [], ...sceneFields } = {}) {
  const built = layers.map(({ type, animations = [], ...fields }) =>
    createLayer(type, { ...fields, animations: animations.map((animation, index) => ({ id: `${fields.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation })) }));
  return parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 4, background: PAPER, ...sceneFields, layers: built })] }));
}

async function check(code, document, context = {}) {
  return runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes: [code], pixels: false, context });
}
async function fires(code, document, context) {
  const { findings } = await check(code, document, context);
  assert.ok(findings.length > 0, `${code} should fire on the bad example`);
  for (const finding of findings) assert.equal(finding.rule, code);
  return findings;
}
async function silent(code, document, context) {
  const { findings } = await check(code, document, context);
  assert.deepEqual(findings.map((finding) => finding.message), [], `${code} should stay silent on the good example`);
}

test("polish rules are registered with their levels", () => {
  assert.equal(ruleOf("font_fallback").level, "error");
  assert.equal(ruleOf("text_collision").level, "error");
  assert.equal(ruleOf("text_ghost").level, "error");
  assert.equal(ruleOf("frozen_footage").level, "error");
  for (const code of ["text_wrap", "cut_off_at_rest", "held_static", "off_brand_font", "text_on_busy", "small_on_empty", "render_artifact"]) assert.equal(ruleOf(code).level, "warn", code);
  for (const code of ["text_on_busy", "small_on_empty", "render_artifact"]) assert.equal(ruleOf(code).pixels, true, code);
});

test("font_fallback: a weight or family that is not loaded draws in another face", async () => {
  // Noto Serif ships at 400 and 700: 600 draws at the nearest of them.
  const titled = (props) => scene({ layers: [text("title", "oak.", { fontFamily: "Noto Serif", fontWeight: 600, ...props })] });
  const [finding] = await fires("font_fallback", titled({}));
  assert.equal(finding.severity, "error");
  assert.match(finding.measured, /Noto Serif (400|700)/);
  assert.equal(finding.required, "Noto Serif 600");
  // The fix asks for the weight kino has, so it draws what it asks for.
  assert.deepEqual({ ...finding.fix, why: undefined }, { kind: "font", itemIds: ["title"], family: "Noto Serif", weight: finding.font?.drawnWeight ?? Number(finding.measured.match(/(\d+)/)[1]), style: "normal", auto: true, why: undefined });
  // A family that is not loaded at all draws in Inter.
  const [missing] = await fires("font_fallback", titled({ fontFamily: "No Such Mono", fontWeight: 400 }));
  assert.match(missing.message, /another typeface/);
  await silent("font_fallback", titled({ fontWeight: 700 }));
});

test("text_wrap: an orphan, a lone punctuation mark and a broken short title", async () => {
  const caption = (width) => scene({ layers: [text("caption", "this is lowkey the best project", { fontSize: 92, textResize: "height", width, x: 200, textAlign: "center" })] });
  const [orphan] = await fires("text_wrap", caption(1020));
  assert.equal(orphan.severity, "warn");
  assert.match(orphan.measured, /"project" alone/);
  // The fix widens it to one line, keeping its center.
  assert.equal(orphan.fix.kind, "item");
  assert.ok(orphan.fix.properties.width > 1020, `width ${orphan.fix.properties.width}`);
  // Centered where it was, then pulled inside the safe area (5% from the left: 96 px).
  assert.equal(orphan.fix.properties.x, Math.max(96, Math.round(200 - (orphan.fix.properties.width - 1020) / 2)));
  assert.equal(orphan.fix.auto, true);
  await silent("text_wrap", caption(1500));
  // Punctuation alone on its own line is an error.
  const [lone] = await fires("text_wrap", scene({ layers: [text("title", "Hello !", { fontSize: 120, textResize: "height", width: 330 })] }));
  assert.equal(lone.severity, "error");
  // A two-word title stacked by the wrap is a warning; a typed line break is not a wrap.
  const [stacked] = await fires("text_wrap", scene({ layers: [text("title", "Big news", { fontSize: 120, textResize: "height", width: 320 })] }));
  assert.equal(stacked.severity, "warn");
  await silent("text_wrap", scene({ layers: [text("title", "Big\nnews", { fontSize: 120 })] }));
});

test("text_collision: a caption touching another text's plate (a status pill)", async () => {
  const layout = (captionY, extra = []) => scene({ layers: [
    rect("pill", { x: 80, y: 600, width: 840, height: 120, fill: "#000000bf", radius: 60, role: "decor" }),
    text("status", "is listening", { x: 260, y: 620, fontSize: 64, fill: "#ffffff" }),
    text("caption", "show me the closest", { x: 500, y: captionY, fontSize: 92, fill: "#ffffff" }),
    ...extra,
  ] });
  // The letters of the two texts do not touch, but the caption runs into the pill.
  const [finding] = await fires("text_collision", layout(690));
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /plate/);
  // The caption gives way (the status line stays): it moves down, clear of the pill.
  assert.equal(finding.itemId, "caption");
  assert.equal(finding.fix.kind, "group");
  assert.equal(finding.fix.auto, true);
  const [moved] = finding.fix.changes;
  assert.deepEqual([moved.kind, moved.itemId, moved.dx], ["move", "caption", 0]);
  assert.ok(moved.dy > 0, `moves the caption down: dy ${moved.dy}`);
  await silent("text_collision", layout(800));
  // A card that holds both texts is shared, not a collision.
  await silent("text_collision", scene({ layers: [
    rect("card", { x: 100, y: 100, width: 900, height: 500, fill: "#ffffff" }),
    text("title", "Plan the week", { x: 150, y: 150, fontSize: 72 }),
    text("body", "Everything in one view", { x: 150, y: 260, fontSize: 40 })] }));
});

test("text_ghost: two words crossfading in one place mix into a ghost word", async () => {
  // A first pass: "measure" fades out as "plan" fades in on the same spot ("plasure").
  const fadeOut = (start, duration = 0.3, extra = {}) => ({ kind: "out", start, duration, easing: "linear", from: { opacity: 1 }, to: { opacity: 0, ...extra } });
  const swap = ({ second = "plan", inAt = 1.5, outMove = {}, inFrom = {} } = {}) => scene({ layers: [
    text("word1", "measure", { x: 120, y: 390, fontSize: 96, animations: [fadeIn(0.2), fadeOut(1.5, 0.3, outMove)] }),
    text("word2", second, { x: 120, y: 390, fontSize: 96, animations: [{ ...fadeIn(inAt, 0.4), easing: "linear", from: { opacity: 0, ...inFrom } }, fadeOut(3.4)] })] });
  const [finding] = await fires("text_ghost", swap());
  assert.equal(finding.severity, "error");
  assert.deepEqual([finding.itemId, finding.otherId], ["word2", "word1"]);
  // The fix is a pure timing shift: plan's entrance starts once measure is gone.
  assert.deepEqual([finding.fix.kind, finding.fix.itemId, finding.fix.auto], ["retime", "word2", true]);
  assert.ok(finding.fix.start >= 1.75 && finding.fix.start <= 1.85, `starts at ${finding.fix.start}`);
  await silent("text_ghost", swap({ inAt: finding.fix.start }));
  // A slide swap (the old word slides up and out, the new one up from below), and the same
  // words twice (a shadow copy crossfading), are left alone.
  await silent("text_ghost", swap({ outMove: { y: 300 }, inFrom: { y: 480 } }));
  await silent("text_ghost", swap({ second: "measure" }));
  // A zoom through (sizes far apart) and a blur dissolve (both soft) do not mix into a word;
  // "plan" blurring in over a sharp "measure" (a blur-slide) still does.
  await silent("text_ghost", swap({ outMove: { scaleX: 1.8, scaleY: 1.8 }, inFrom: { scaleX: 0.4, scaleY: 0.4 } }));
  await silent("text_ghost", swap({ outMove: { blur: 30 }, inFrom: { blur: 30 } }));
  await fires("text_ghost", swap({ inFrom: { blur: 12 } }));
});

test("cut_off_at_rest: a picture crowding or cut by the frame edge while still", async () => {
  const placed = (y, height = 900) => scene({ layers: [picture("phone", { x: 600, y, height })] });
  // 20 px from the bottom: inside the 54 px margin of a 1080p frame.
  const [crowded] = await fires("cut_off_at_rest", placed(160));
  assert.equal(crowded.severity, "warn");
  assert.match(crowded.measured, /20px from the bottom/);
  // The fix moves it up into the safe zone (5% margin: bottom at 1026).
  assert.deepEqual([crowded.fix.kind, crowded.fix.dy], ["move", -34]);
  // 10% cut off at the bottom.
  const [cut] = await fires("cut_off_at_rest", placed(270));
  assert.match(cut.measured, /cut off at the bottom/);
  await silent("cut_off_at_rest", placed(90));
  // Flush with the edge, or mostly off the frame on purpose, is left alone.
  await silent("cut_off_at_rest", placed(180));
  await silent("cut_off_at_rest", placed(700));
  // Moving through the edge is not resting.
  await silent("cut_off_at_rest", scene({ layers: [picture("phone", { x: 600, y: 160, animations: [move(0, 4, { y: -900 }, { y: 1100 })] })] }));
  // A picture in a rounded tile (a mask group) is judged by the tile: the picture reaches past
  // the top of the frame, but only the tile shows. A tile crowding the edge moves as a whole.
  const tile = (y) => scene({ layers: [
    { type: "group", id: "tile", name: "tile", x: 600, y, width: 600, height: 500, isMaskGroup: true },
    rect("tile-mask", { parentId: "tile", x: 0, y: 0, width: 600, height: 500, radius: 40, isMask: true }),
    picture("tile-video", { parentId: "tile", x: 0, y: -200 }),
  ] });
  await silent("cut_off_at_rest", tile(160));
  const [tight] = await fires("cut_off_at_rest", tile(20));
  assert.match(tight.measured, /20px from the top/);
  assert.equal(tight.fix.itemId, "tile");
  // A split_image piece laid out in its group (an app layout) is placed on purpose: the fix is
  // listed, never applied by check {fix:"auto"}.
  const [piece] = await fires("cut_off_at_rest", scene({ layers: [
    { type: "group", id: "shot", name: "shot", x: 0, y: 0, width: 1920, height: 1080 },
    picture("shot-bg", { parentId: "shot", width: 1920, height: 1080, opacity: 0.55 }),
    { type: "group", id: "shot-view", name: "shot-view", parentId: "shot", x: 20, y: 160, width: 600, height: 500, clipContent: true },
    picture("shot-view-px", { parentId: "shot-view", x: 0, y: -100 }),
  ] }));
  assert.deepEqual([piece.fix.itemId, piece.fix.auto], ["shot-view", false]);
  assert.match(piece.message, /not applied: shot-view is part of a split_image layout/);
});

test("held_static and static_scene let a planned still (scene rests) hold, up to 4 s", async () => {
  // A tiny end logo holds still on black: marked as a rest, it is not a frozen card.
  const mark = (rests, duration = 5) => scene({ duration, rests, layers: [text("logo", "L", { role: "logo", fontSize: 40, animations: [fadeIn(0, 0.5)] })] });
  await silent("held_static", mark([{ at: 0.4, until: 5 }]));
  await fires("static_scene", mark([], 6));
  await silent("static_scene", mark([{ at: 0.4, until: 6 }], 6));
  // A rest counts for 4 s at most: a whole frozen scene still fires.
  await fires("held_static", mark([{ at: 0.4, until: 12 }], 12));
  // 4 s in all per scene: rests chained with small gaps do not excuse a frozen scene.
  await fires("held_static", mark([{ at: 0.4, until: 4.3 }, { at: 4.4, until: 8.3 }, { at: 8.4, until: 12.3 }, { at: 12.4, until: 16 }], 16));
  assert.throws(() => mark([{ at: 3, until: 2 }]), /rests\[0\]\.until must be after at/);
  assert.throws(() => mark([{ at: 0.4, until: 2 }, { at: 2, until: 4 }]), /must not overlap or touch/);
});

test("scene drift moves the camera through every hold but a rest, slowly, and only when the scene has it", async () => {
  const { expandComponents } = await import("./linkedComponents.js");
  const card = (fields) => scene({ duration: 5, ...fields, layers: [text("title", "The end", { animations: [fadeIn(0, 0.5)] })] });
  await fires("held_static", card({}));
  const drifting = card({ drift: { dir: "auto", speed: 0.02 } });
  await silent("held_static", drifting);
  const [camera] = expandComponents(drifting, "scene", { fonts: defaultFonts }).layers;
  assert.equal(camera.sceneCamera, true);
  // One steady push through the hold, within the slow push: 2% of the diagonal a second.
  assert.deepEqual(camera.animations.map((animation) => [animation.start, animation.duration, animation.easing]), [[0.5, 4.5, "linear"]]);
  const [leg] = camera.animations;
  assert.ok(Math.hypot(leg.to.x, leg.to.y) / leg.duration <= 0.02 * Math.hypot(1920, 1080) + 0.1);
  // A short hold between beats drifts too, and linear_motion lets the drawn camera be.
  const beats = (gap) => [0, 1, 2].map((index) => text(`word${index}`, `Word ${index}`, { y: 200 + index * 200, animations: [fadeIn(index * (0.5 + gap))] }));
  await silent("linear_motion", scene({ duration: 5, drift: { dir: "auto", speed: 0.02 }, layers: beats(1.2) }));
  // A run of holds goes out and back: never past 6 s of drift (12% of the diagonal) from rest.
  const { driftAnimations } = await import("./camera.js");
  const run = driftAnimations([[0, 2.9], [3, 4], [4.1, 7], [7.1, 8.1], [8.2, 20]], { width: 1920, height: 1080, speed: 0.04, cover: false });
  for (const { to } of run) assert.ok(Math.hypot(to.x, to.y) <= 0.12 * Math.hypot(1920, 1080) + 0.1);
  // A status-line badge is fixed to the screen: the picture drifts under it, the text above it
  // drifts in its own group with the same moves, and the stack keeps its order.
  const badge = text("status-line-status", "is listening", { x: 96, y: 900, fontSize: 40, move: { name: "status-line", instance: "status-line", part: "status" } });
  const overlaid = scene({ duration: 5, drift: { dir: "auto", speed: 0.02 }, layers: [picture("street", { width: 1920, height: 1080 }), badge, text("title", "The end", { animations: [fadeIn(0, 0.5)] })] });
  const drawn = expandComponents(overlaid, "scene", { fonts: defaultFonts }).layers;
  assert.deepEqual(drawn.map((layer) => [layer.id, layer.parentId ?? null]),
    [["scene-drift", null], ["street", "scene-drift"], ["status-line-status", null], ["scene-drift-2", null], ["title", "scene-drift-2"]]);
  assert.deepEqual(drawn[3].animations.map((animation) => animation.to), drawn[0].animations.map((animation) => animation.to));
  // A planned still gets no drift.
  assert.equal(expandComponents(card({ drift: { dir: "in", speed: 0.02 }, rests: [{ at: 0.4, until: 5 }] }), "scene").layers[0].id, "title");
  assert.equal(expandComponents(card({}), "scene").layers.length, 1);
  assert.throws(() => card({ drift: { speed: 0.1 } }), /drift\.speed: must be/);
});

test("held_static names what is drawn, never a cut_out's source or a mask helper", async () => {
  // A held frame: a big clip source (under its smaller cut-out copy) and the title. The largest
  // shown layer is the source, but the finding, and the drift its fix adds, belong to the copy.
  const copy = (source) => picture("subject", { x: 700, y: 100, width: 400, height: 500, ...(source ? { cutoutOf: source } : {}) });
  const held = (source) => scene({ duration: 5, layers: [picture("clip", { x: 0, y: 0, width: 1200, height: 900 }), copy(source), text("title", "The end", { y: 800, animations: [fadeIn(0, 0.5)] }),
    rect("bar", { x: 100, y: 950, width: 200, height: 100, animations: [move(3.5, 1.5, { x: 100 }, { x: 1500 })] })] });
  assert.equal((await fires("held_static", held(null)))[0].itemId, "clip");
  const [named] = await fires("held_static", held("clip"));
  assert.equal(named.itemId, "subject");
  // Its fix moves the copy and the clip it was cut from together, so the subject never shows twice.
  assert.deepEqual(named.fix.changes.map((change) => change.itemId).sort(), ["clip", "subject"]);
  // A mask made of a group of big shapes (a torn edge): the shapes inside the mask never draw, so
  // the finding names the masked layer (it named the largest shape inside the mask before).
  const torn = scene({ duration: 5, layers: [
    { type: "group", id: "field", name: "field", x: 0, y: 0, width: 1920, height: 1080, isMaskGroup: true },
    { type: "group", id: "edge", name: "edge", parentId: "field", x: 0, y: 0, width: 1920, height: 1080, isMask: true },
    rect("edge-a", { parentId: "edge", fill: "#ffffff", x: 0, y: -200, width: 2600, height: 1480 }),
    rect("tint", { parentId: "field", fill: "#ff66aa", x: 0, y: 0, width: 1920, height: 1080 }),
    rect("bar", { x: 100, y: 950, width: 200, height: 100, animations: [move(3.5, 1.5, { x: 100 }, { x: 1500 })] })] });
  assert.equal((await fires("held_static", torn))[0].itemId, "tint");
});

test("held_static: nothing on screen moves for more than 1.5 s", async () => {
  const card = (animations) => scene({ duration: 5, layers: [text("title", "The end", { animations: [fadeIn(0, 0.5), ...animations] })] });
  const [finding] = await fires("held_static", card([]));
  assert.equal(finding.severity, "warn");
  assert.ok(finding.at >= 0.4 && finding.at <= 1, `at ${finding.at}`);
  assert.equal(finding.until, 5);
  // A drift across the frame keeps it alive.
  await silent("held_static", card([move(0.5, 4.5, { x: 200 }, { x: 700 })]));
  // Words revealed on a text nobody can see (hidden the whole time) do not count as motion.
  const ghost = text("ghost", "one two three", { y: 700, animations: [{ ...fadeIn(0.5, 0.3), unit: "words", delays: [0, 1.5, 3] }, { kind: "hide", start: 0 }] });
  await fires("held_static", scene({ duration: 5, layers: [text("title", "The end", { animations: [fadeIn(0, 0.5)] }), ghost] }));
  // A still end card: 8 silent seconds after a moving open is dead air (an error, cut to 2.5 s);
  // under a steady song a warning; under a song that ends there, only a plain hold.
  const ending = (layers = []) => scene({ duration: 12, layers: [text("title", "oak", { animations: [move(0, 4, { x: 200 }, { x: 700 })] }), ...layers] });
  const song = (props) => ({ type: "audio", id: "song", name: "song", src: "/api/media/song.mp3", mediaDuration: 12, mediaSourceDuration: 40, ...props });
  const end = async (document) => (await check("held_static", document, { scene: document.scenes[0] })).findings;
  const [dead] = await end(ending());
  assert.deepEqual([dead.severity, dead.at, dead.until, dead.fix.kind, dead.fix.properties.duration], ["error", 3.47, 12, "scene", 5.97]);
  assert.match(dead.message, /^Nothing moves from 3\.47s to the end \(8\.53s\) and nothing is heard/);
  assert.equal((await end(ending([song()])))[0].severity, "error");
  const held = await end(ending([song({ mediaSourceDuration: 12 })]));
  assert.deepEqual(held.map((finding) => [finding.severity, finding.measured]), [["warn", "1 hold with nothing moving (longest 8.57s)"]]);
  // A 6.5 s still card (a wordmark and a line) under a steady song is an error too (over 4.5 s),
  // and so is one where only a slow push moves: the fix is a change, not a push.
  // Under 4.5 s it is a warning whose fix, one slow push on the whole card, clears it.
  const icon = picture("icon", { x: 420, y: -60, width: 1080, height: 1080 });
  const endCard = (animations = {}, duration = 7.5) => scene({ duration, layers: [text("title", "oak", { y: 800, animations: [move(0, 4, { x: 200 }, { x: 700 }), ...(animations.title ?? [])] }),
    { ...icon, animations: animations.icon ?? [] }, song({ mediaDuration: 10 })] });
  const [frozen] = await end(endCard({}, 10));
  assert.deepEqual([frozen.severity, frozen.at, frozen.fix.kind], ["error", 3.47, "hint"]);
  const creep = { icon: [move(4, 6, { scaleX: 1, scaleY: 1 }, { scaleX: 1.03, scaleY: 1.03 })] };
  assert.deepEqual((await end(endCard(creep, 10))).map((finding) => [finding.severity, finding.measured]), [["error", "only a slow creep moves from 3.47s to the end (6.53s)"]]);
  const [still] = await end(endCard());
  assert.deepEqual([still.severity, still.fix.auto, still.fix.push], ["warn", true, true]);
  const pushes = still.fix.changes;
  assert.deepEqual(pushes.map((push) => [push.itemId, push.technique]), [["title", "slow-push"], ["icon", "slow-push"]]);
  assert.ok(pushes.every((push) => push.scale === pushes[0].scale && push.scale >= 1.04 && push.scale <= 1.15), JSON.stringify(pushes));
  const pushed = Object.fromEntries(pushes.map((push) => {
    const at = { title: { x: 700, y: 800 }, icon: { x: 420, y: -60 } }[push.itemId];
    return [push.itemId, [{ ...move(push.start, push.duration, { scaleX: 1, scaleY: 1, ...at }, { scaleX: push.scale, scaleY: push.scale, x: at.x + push.dx, y: at.y + push.dy }), easing: push.easing }]];
  }));
  assert.deepEqual(await end(endCard(pushed)), []);
});

test("off_brand_font: texts outside the brand's fonts, or 3+ families with no brand", async () => {
  const set = (...families) => scene({ layers: families.map((family, index) => text(`t${index}`, `Line ${index}`, { fontFamily: family, y: 100 + index * 150 })) });
  const [finding] = await fires("off_brand_font", set("Inter", "Montserrat"), { brandFonts: ["Montserrat"] });
  assert.equal(finding.measured, "Inter");
  // With a brand the fix is automatic and keeps each layer's weight as near as the font has it.
  assert.deepEqual([finding.fix.kind, finding.fix.family, finding.fix.nearest, finding.fix.auto], ["font", "Montserrat", true, true]);
  await silent("off_brand_font", set("Montserrat", "Montserrat"), { brandFonts: [{ family: "Montserrat" }] });
  const [mixed] = await fires("off_brand_font", set("Inter", "Inter", "Montserrat", "Noto Serif"));
  assert.match(mixed.message, /third typeface/);
  // With no brand, which family to drop is a choice: the fix is not automatic.
  assert.equal(mixed.fix.auto, undefined);
  await silent("off_brand_font", set("Inter", "Montserrat"));
});

// ---------------------------------------------------------------- automatic fixes (check {fix:"auto"})

test("font_fallback fix: the brand font when the family is not loaded, else the face it draws now", async () => {
  const missing = scene({ layers: [text("title", "oak.", { fontFamily: "No Such Mono", fontWeight: 400 })] });
  const [branded] = await fires("font_fallback", missing, { brandFonts: ["JetBrains Mono"] });
  assert.deepEqual([branded.fix.family, branded.fix.nearest, branded.fix.auto], ["JetBrains Mono", true, true]);
  const [plain] = await fires("font_fallback", missing);
  assert.deepEqual([plain.fix.family, plain.fix.auto], ["Inter", true]);
});

test("text_wrap fix: a one-word title too wide for one line gets a smaller size over the type minimum", async () => {
  const title = (fontSize) => scene({ layers: [text("title", "Unbelievable!", { fontSize, textResize: "height", width: 900, x: 510, textAlign: "center" })] });
  const [finding] = await fires("text_wrap", title(330));
  assert.equal(finding.fix.auto, true);
  const { fontSize, width, x } = finding.fix.properties;
  assert.ok(fontSize < 330 && fontSize >= 64, `size ${fontSize}`);
  assert.ok(x >= 96 && x + width <= 1824, `inside the safe area: ${x} + ${width}`);
  // The floor is type_min's: an unmarked caption may shrink to 3% of the height (32 px), a headline only to 4% (43 px).
  const long = (words, role) => scene({ layers: [text("title", words, { fontSize: 100, textResize: "height", width: 900, x: 510, textAlign: "center", ...(role ? { role } : {}) })] });
  const words = "Counterrevolutionaries internationalization incomprehensibilities";
  const [caption] = await fires("text_wrap", long(words));
  assert.ok(caption.fix.properties.fontSize < 64 && caption.fix.properties.fontSize >= 32, `size ${caption.fix.properties?.fontSize}`);
  const [headline] = await fires("text_wrap", long("Counterrevolutionaries internationalizationalists incomprehensibilities", "headline"));
  assert.ok(headline.fix.properties.fontSize < 64 && headline.fix.properties.fontSize >= 43, `size ${headline.fix.properties?.fontSize}`);
});

test("text_collision fix: a caption gives way to a status line; the fix keeps it in the safe area", async () => {
  const layout = scene({ layers: [
    rect("pill", { x: 80, y: 600, width: 840, height: 120, fill: "#000000bf", radius: 60, role: "decor" }),
    text("status", "is listening", { x: 260, y: 620, fontSize: 64, fill: "#ffffff", animations: [fadeIn(0, 0.3)] }),
    text("caption", "show me the closest", { role: "caption", x: 500, y: 690, fontSize: 92, fill: "#ffffff", animations: [fadeIn(1, 0.3)] }),
  ] });
  const [finding] = await fires("text_collision", layout);
  assert.equal(finding.itemId, "caption");
  for (const change of finding.fix.changes) assert.equal(change.itemId, "caption");
});

test("cut_off_at_rest fix: a picture taller than the safe area is scaled around its middle", async () => {
  const [finding] = await fires("cut_off_at_rest", scene({ layers: [picture("phone", { x: 600, y: 30, height: 1030 })] }));
  assert.equal(finding.fix.kind, "transform");
  assert.equal(finding.fix.auto, true);
  assert.ok(finding.fix.scale < 0.95 && finding.fix.scale > 0.9, `scale ${finding.fix.scale}`);
});

test("held_static fix: a slow motion on the held text or picture, from the deck when it has one", async () => {
  // A long centered line: its letters spread slowly (a short one would need too much, so it drifts).
  // It fades out at the end: a still end card gets the whole-card push instead (test above).
  const fadeOut = { kind: "out", start: 5, duration: 0.5, easing: "smooth", from: { opacity: 1 }, to: { opacity: 0 } };
  const card = scene({ duration: 5.5, layers: [text("title", "github.com/someone/project", { fontSize: 120, textAlign: "center", animations: [fadeIn(0, 0.5), fadeOut] })] });
  const [finding] = await fires("held_static", card);
  assert.equal(finding.fix.kind, "group");
  const [motion] = finding.fix.changes;
  assert.deepEqual([motion.kind, motion.itemId, motion.technique], ["motion", "title", "type-kinetic"]);
  assert.ok(motion.spacing > 0 && motion.duration >= 4, JSON.stringify(motion));
  // With drift in the deck, the drift comes first.
  const [drifted] = await fires("held_static", card, { deck: { cards: [{ tag: "drift" }] } });
  assert.equal(drifted.fix.changes[0].technique, "drift");
  // A picture filling the frame gets a slow push of 2 to 4%.
  const still = scene({ duration: 4, layers: [picture("shot", { width: 1920, height: 1080 })] });
  const [pushed] = await fires("held_static", still);
  const [push] = pushed.fix.changes;
  assert.equal(push.technique, "slow-push");
  assert.ok(push.scale >= 1.02 && push.scale <= 1.04, `scale ${push.scale}`);
});

// A screenshot file (engine/imageFacts.js facts) and a photo of the same size.
const SCREEN = { mediaSizes: { "/api/media/frame.png": { width: 2880, height: 1620, edges: 0.08, flat: 0.8, busy: [60, 10, 40, 40] } } };
const PHOTO = { mediaSizes: { "/api/media/frame.png": { width: 2880, height: 1620, edges: 0.02, flat: 0.3, busy: [30, 30, 40, 40] } } };

test("frozen_screen: a screenshot still for 2.5 s with nothing moving over it; the fix pushes into its busy part", async () => {
  const shot = (layers = [], animations = []) => scene({ duration: 5, layers: [picture("app", { x: 160, y: 90, width: 1600, height: 900, animations }), ...layers] });
  const [finding] = await fires("frozen_screen", shot(), SCREEN);
  const [push] = finding.fix.changes;
  assert.deepEqual([finding.fix.auto, push.technique, push.itemId], [true, "slow-push", "app"]);
  // It grows about the busy region (right and top): the layer moves left and down.
  assert.ok(push.scale >= 1.06 && push.dx < 0 && push.dy > 0, JSON.stringify(push));
  // A photo, an even push of 12%, and a cursor moving over it are fine.
  const even = (from, to) => ({ ...move(0, 5, from, to), easing: [0.4, 0.2, 0.6, 0.8] });
  await silent("frozen_screen", shot(), PHOTO);
  await silent("frozen_screen", shot([], [even({ scaleX: 1, scaleY: 1 }, { scaleX: 1.12, scaleY: 1.12 })]), SCREEN);
  // A slow eased push (10% over 5 s, "smooth"): its slow ends are part of the push, not a stall.
  await silent("frozen_screen", shot([], [move(0, 5, { scaleX: 1, scaleY: 1 }, { scaleX: 1.1, scaleY: 1.1 })]), SCREEN);
  await silent("frozen_screen", shot([rect("cursor", { x: 600, y: 400, width: 40, height: 40, animations: [even({ x: 600 }, { x: 1400 })] })]), SCREEN);
});

test("screen_unreadable: a screenshot drawn under 55% of its width for over 1.5 s", async () => {
  const shot = (props, animations = []) => scene({ duration: 4, layers: [picture("app", { x: 400, y: 300, height: 450, ...props, animations })] });
  const [finding] = await fires("screen_unreadable", shot({ width: 700 }), SCREEN);
  assert.match(finding.measured, /49% of its 1440 px width \(a 2x capture, 2880 px\)/);
  // A 2x capture drawn at 52% of its file (104% of its points) reads fine.
  await silent("screen_unreadable", shot({ width: 1500 }), SCREEN);
  // The auto fix: a 1.45x push about the busy part (right and top), so the layer moves left and down.
  const [push] = finding.fix.changes;
  assert.deepEqual([finding.fix.auto, push.technique, push.scale], [true, "slow-push", 1.45]);
  assert.ok(push.dx < 0 && push.dy > 0 && push.duration >= 3.9, JSON.stringify(push));
  // That push clears it, though the screen leaves the small stretch part way through.
  await silent("screen_unreadable", shot({ width: 700 }, [{ ...move(0, 4, { scaleX: 1, scaleY: 1 }, { scaleX: 1.45, scaleY: 1.45 }), easing: push.easing }]), SCREEN);
  // A push that would cover the words beside it is a hint instead.
  const beside = scene({ duration: 4, layers: [picture("app", { x: 400, y: 300, width: 700, height: 450 }), text("words", "Plan the week", { x: 1120, y: 400 })] });
  const [hinted] = await fires("screen_unreadable", beside, SCREEN);
  assert.equal(hinted.fix.kind, "hint");
  assert.match(hinted.fix.text, /region:\[60,10,40,40\]/);
  await silent("screen_unreadable", shot({ width: 1800 }), SCREEN);
  await silent("screen_unreadable", shot({ width: 700 }, [move(0.5, 3, { scaleX: 1, scaleY: 1 }, { scaleX: 1.6, scaleY: 1.6 })]), SCREEN);
  await silent("screen_unreadable", shot({ width: 700 }), PHOTO);
});

// A 2x screen recording (frame facts read as UI) and camera footage of the same size.
const REC = "/api/media/rec.mp4";
const UI_CLIP = { mediaSizes: { [REC]: { width: 2560, height: 1536, edges: 0.12, flat: 0.6, busy: [0, 60, 40, 40] } } };
const CAMERA_CLIP = { mediaSizes: { [REC]: { width: 2560, height: 1536, edges: 0.1, flat: 0.2, busy: [30, 30, 40, 40] } } };

test("screen_unreadable: a screen recording shown whole under 2 px a screen point for over 1.5 s", async () => {
  const recording = (props = {}, animations = [], layers = []) => scene({ duration: 4, layers: [
    { type: "video", id: "rec", name: "rec", src: REC, mediaSourceDuration: 10, x: 0, y: -36, width: 1920, height: 1152, ...props, animations }, ...layers] });
  const [finding] = await fires("screen_unreadable", recording(), UI_CLIP);
  assert.match(finding.measured, /1\.5 px a screen point/);
  assert.match(finding.fix.text, /name:"perceive-insert", layer:"rec", region:\[0,60,40,40\]/);
  // Drawn 2400 wide (1.9 px a point) still fires; 2600 wide (2.03) reads.
  await fires("screen_unreadable", recording({ x: -240, y: -180, width: 2400, height: 1440 }), UI_CLIP);
  await silent("screen_unreadable", recording({ x: -340, y: -240, width: 2600, height: 1560 }), UI_CLIP);
  // A 2x push into a region, or an insert of the same file, shows the detail.
  await silent("screen_unreadable", recording({}, [move(0.5, 1, { scaleX: 1, scaleY: 1 }, { scaleX: 2, scaleY: 2 })]), UI_CLIP);
  const insert = { type: "video", id: "insert", name: "insert", src: REC, mediaSourceDuration: 10, x: -1920, y: -1500, width: 5120, height: 3072, animations: [move(1, 0.01, { opacity: 0 }, { opacity: 1 })], opacity: 0 };
  await silent("screen_unreadable", recording({}, [], [insert]), UI_CLIP);
  // Camera footage, and a clip with no frame facts (measured before kino read them), are left alone.
  await silent("screen_unreadable", recording(), CAMERA_CLIP);
  await silent("screen_unreadable", recording(), { mediaSizes: { [REC]: { width: 2560, height: 1536 } } });
  // A clip kino recorded knows its points: 1512 points drawn 1920 wide is 1.27 px a point.
  const recorded = { mediaSizes: { [REC]: { width: 1920, height: 1242, screen: true, points: 1512 } } };
  const [own] = await fires("screen_unreadable", recording({ height: 1242, y: -81 }), recorded);
  assert.match(own.fix.text, /name:"screen-recording", layer:"rec"/);
});

test("screen_unreadable: a phone recording is read as 3x; a blurred copy or a same-size twin is no insert", async () => {
  // An iPhone recording (1179 px, 393 pt) filling a 9:16 frame is 2.75 px a point; drawn 500 wide it is 1.27.
  const PHONE = { mediaSizes: { [REC]: { width: 1179, height: 2556, edges: 0.12, flat: 0.6, busy: [10, 10, 40, 40] } } };
  const phone = (props) => scene({ width: 1080, height: 1920, duration: 4, layers: [{ type: "video", id: "rec", name: "rec", src: REC, mediaSourceDuration: 10, ...props }] });
  await silent("screen_unreadable", phone({ x: 0, y: -210, width: 1080, height: 2341 }), PHONE);
  const [small] = await fires("screen_unreadable", phone({ x: 290, y: 418, width: 500, height: 1084 }), PHONE);
  assert.match(small.measured, /1\.27 px a screen point/);
  // A 1200 px card of a 2560 px recording (0.94 px a point): a blurred full-frame copy behind it or a
  // twin of the same size beside it shows no detail; a sharp copy drawn 1.4x larger does.
  const card = { type: "video", id: "rec", name: "rec", src: REC, mediaSourceDuration: 10, x: 360, y: 202, width: 1200, height: 720 };
  const copy = (props) => ({ type: "video", id: "copy", name: "copy", src: REC, mediaSourceDuration: 10, ...props });
  await fires("screen_unreadable", scene({ duration: 4, layers: [copy({ x: -200, y: -120, width: 2320, height: 1392, blur: 40 }), card] }), UI_CLIP);
  const twins = await fires("screen_unreadable", scene({ duration: 4, layers: [{ ...card, x: 60, width: 880, height: 528 }, copy({ x: 980, y: 202, width: 880, height: 528 })] }), UI_CLIP);
  assert.equal(twins.length, 2);
  await silent("screen_unreadable", scene({ duration: 4, layers: [copy({ x: -340, y: -240, width: 2600, height: 1560 }), card] }), UI_CLIP);
  // Blurred itself, the recording is a backdrop nobody reads.
  await silent("screen_unreadable", scene({ duration: 4, layers: [{ ...card, blur: 24 }] }), UI_CLIP);
});

test("a slow hold drift is left alone by duration_band", async () => {
  const drifting = scene({ duration: 5, layers: [text("title", "The end", { animations: [fadeIn(0, 0.5), move(0.6, 2.2, { y: 200 }, { y: 160 })] })] });
  await silent("duration_band", drifting);
  // A downbeat accent (engine/footage/ops.js): a 0.08 s scale punch named Accent is quick on purpose.
  const punch = (name, scale = { scaleX: 1.06, scaleY: 1.06 }) => ({ ...move(0.96, 0.08, { scaleX: 1, scaleY: 1 }, scale), name, easing: "ease-out" });
  const settle = { ...move(1.04, 0.3, { scaleX: 1.06, scaleY: 1.06 }, { scaleX: 1, scaleY: 1 }), name: "Accent settles", easing: "ease-out" };
  await silent("duration_band", scene({ layers: [picture("shot", { width: 1920, height: 1080, animations: [punch("Accent"), settle] })] }));
  // Unmarked, or a move that is not a small scale punch, is judged as before.
  await fires("duration_band", scene({ layers: [picture("shot", { width: 1920, height: 1080, animations: [punch("Zoom")] })] }));
  await fires("duration_band", scene({ layers: [picture("shot", { width: 1920, height: 1080, animations: [{ ...punch("Accent"), from: { x: 0 }, to: { x: 600 } }] })] }));
});

// A hand-written transcript (file seconds), as backend/speech/transcribe.mjs answers.
const SPOKEN = [["Find", 0, 0.3], ["me", 0.35, 0.5], ["the", 0.55, 0.65], ["nearest", 0.7, 1.1], ["target.", 1.15, 1.6],
  ["It", 2.5, 2.6], ["is", 2.65, 2.8], ["the", 2.85, 2.95], ["best", 3, 3.3], ["project", 3.35, 3.8], ["we", 3.85, 3.95], ["saw", 4, 4.3],
  ["in", 4.35, 4.45], ["this", 4.5, 4.7], ["hackathon.", 4.75, 5.4]];
const TRANSCRIPT = { model: "small.en", version: 1, duration: 6, words: SPOKEN.map(([text, start, end]) => ({ text, start, end, cut: start, p: 0.9 })) };
const voice = (id, props) => ({ type: "audio", id, name: id, src: "/api/media/voice.wav", mediaStart: 0, mediaOffset: 0, ...props });
const speechContext = (document, transcript = TRANSCRIPT) => {
  const [raw] = document.scenes;
  return { speechScene: raw, speech: raw.layers.filter((layer) => layer.type === "audio").map((layer) => ({ layer, transcript })) };
};
async function speechFindings(code, layers) {
  const document = scene({ layers });
  return (await check(code, document, speechContext(document))).findings;
}

test("speech_cut: a voice stopped inside a word or a sentence, or started inside one", async () => {
  assert.equal(ruleOf("speech_cut").level, "error");
  // A whoosh heard as "whoop, whoop, whoop" is a sound, not a voice.
  const heard = (text) => text.split(" ").map((word) => ({ text: word }));
  assert.deepEqual([soundAsWords(heard("whoop, whoop, whoop, whoop, whoop.")), soundAsWords(heard("upbeat upbeat upbeat")), soundAsWords(heard("turn right to two"))], [true, true, false]);
  // Tags are sound too, even split over words ("camera", "shutter]" for a click); real words stay.
  const timed = (text) => text.split(" ").map((word, index) => ({ text: word, start: index * 0.3, end: index * 0.3 + 0.3 }));
  const spoken = (text) => spokenWords(timed(text)).map((word) => word.text).join(" ");
  assert.deepEqual([spoken("camera shutter]"), spoken("(unclear) [Music] ♪"), spoken("whoop, whoop, whoop."), spoken("so [laughs loudly] turn right. (beep)"), spoken("upbeat music)(upbeat music)")], ["", "", "", "so turn right.", ""]);
  // A lost closing bracket hides only the bracketed word, not the voice after it.
  assert.deepEqual([spoken("[camera shutter so find me the nearest target."), spoken("so (laughing turn right now. find me")], ["shutter so find me the nearest target.", "so turn right now. find me"]);
  // "find me the nearest tar-": a word cut in half is an error; the fix plays on to the sentence end.
  const [word] = await speechFindings("speech_cut", [voice("voice", { mediaDuration: 1.3 })]);
  assert.equal(word.severity, "error");
  assert.match(word.message, /"target\." in half/);
  assert.deepEqual([word.fix.kind, word.fix.layerId, word.fix.properties, word.fix.auto], ["layer", "voice", { mediaDuration: 1.75 }, true]);
  // Faded out, the sentence still does not finish: a gate, and the fix is not automatic (the fade must move too).
  const [faded] = await speechFindings("speech_cut", [voice("voice", { mediaDuration: 1.3, animations: [move(0.8, 0.5, { volume: 1 }, { volume: 0 })] })]);
  assert.deepEqual([faded.severity, faded.fix.auto], ["error", false]);
  // A mute inside a longer clip: the fade is what moves, not mediaDuration.
  const [muted] = await speechFindings("speech_cut", [voice("voice", { mediaDuration: 3, animations: [move(0.8, 0.5, { volume: 1 }, { volume: 0 })] })]);
  assert.match(muted.fix.text, /volume fade out of "voice" ends the voice at 1\.13 s, inside "target\.": end the fade 0\.62 s later/);
  // "...the best project we saw" while the file goes on "in this hackathon": a gate too.
  const [sentence] = await speechFindings("speech_cut", [voice("judge", { mediaOffset: 2.4, mediaDuration: 1.95 })]);
  assert.equal(sentence.severity, "error");
  assert.match(sentence.message, /goes on "in this hackathon\."/);
  assert.deepEqual(sentence.fix.properties, { mediaDuration: 3.15 });
  // Past the scene end the fix is offered, not automatic.
  assert.equal((await speechFindings("speech_cut", [voice("judge", { mediaStart: 2.5, mediaOffset: 2.4, mediaDuration: 1.95 })]))[0].fix.auto, false);
  // Starting just after "best" (no pause) starts mid-sentence: the fix starts at "It".
  const [start] = await speechFindings("speech_cut", [voice("judge", { mediaStart: 1, mediaOffset: 3.32, mediaDuration: 2.2 })]);
  assert.match(start.message, /starts mid-sentence/);
  assert.equal(start.severity, "error");
  assert.deepEqual(start.fix.properties, { mediaOffset: 2.425, mediaStart: 0.105, mediaDuration: 3.095 });
  // A whole sentence is fine, and so is a join between two pieces of one cut_speech voice.
  assert.deepEqual(await speechFindings("speech_cut", [voice("judge", { mediaOffset: 2.4, mediaDuration: 3.1 })]), []);
  // Fillers are not words to cut: an app's beeps come out as "um".
  const beeps = { ...TRANSCRIPT, words: [0, 0.4, 0.8, 1.2].map((start) => ({ text: "um,", start, end: start + 0.3, cut: start, p: 0.9 })) };
  const beeping = scene({ layers: [voice("app", { mediaOffset: 0.1, mediaDuration: 1 })] });
  assert.deepEqual((await check("speech_cut", beeping, speechContext(beeping, beeps))).findings, []);
  assert.deepEqual(await speechFindings("speech_cut", [voice("voice", { mediaDuration: 1.3 }), voice("voice-2", { mediaStart: 1.3, mediaOffset: 1.3, mediaDuration: 0.45 })]), []);
  // Without a transcript the rule says it did not run; it never passes quietly.
  const document = scene({ layers: [voice("voice", { mediaDuration: 1.3 })] });
  const quiet = await check("speech_cut", document, { speechScene: document.scenes[0], speech: [{ layer: document.scenes[0].layers[0], transcript: null, missing: "no transcript: No whisper model file." }] });
  assert.deepEqual(quiet.findings, []);
  assert.match(quiet.notes.join("\n"), /speech_cut did not run on "voice": no transcript/);
  // A file with no sound, or a layer at volume 0, has nothing to read: no note (one edit had 21 a check).
  const mute = scene({ layers: [voice("silent", { mediaDuration: 1.3 }), voice("muted", { mediaDuration: 1.3, volume: 0 })] });
  const [silentLayer, mutedLayer] = mute.scenes[0].layers;
  const none = await check("speech_cut", mute, { speechScene: mute.scenes[0], speech: [{ layer: silentLayer, transcript: null, missing: "no transcript: The file has no sound." }, { layer: mutedLayer, transcript: null, missing: "no transcript" }] });
  assert.deepEqual(none.notes.filter((note) => /speech_cut/.test(note)), []);
});

// The room's swear cut out between two clips of one take on the same clock (r16, r17), or
// a mute inside a clip: neither is a cut line, and no fix brings the hidden word back.
test("speech_cut: words cut out between clips of one take on the same clock are not a cut line", async () => {
  // "It is the" | "best" cut | "project we saw in this hackathon." on one clock (scene = file - 2.4).
  const room = [voice("r16", { mediaOffset: 2.4, mediaDuration: 0.55 }), voice("r17", { mediaStart: 0.9, mediaOffset: 3.3, mediaDuration: 2.1 })];
  assert.deepEqual(await speechFindings("speech_cut", room), []);
  // On another clock r17 is a separate line: r16 stops and r17 starts mid-sentence.
  const moved = await speechFindings("speech_cut", [room[0], voice("r17", { mediaStart: 1.5, mediaOffset: 3.3, mediaDuration: 2.1 })]);
  assert.deepEqual(moved.map((finding) => finding.layerId), ["r16", "r17"]);
  // Trimmed too tight, r17 starts inside "best": its tail is heard, so it is still cut in half.
  const tight = await speechFindings("speech_cut", [room[0], voice("r17", { mediaStart: 0.75, mediaOffset: 3.15, mediaDuration: 2.25 })]);
  assert.match(tight.find((finding) => finding.layerId === "r17")?.message ?? "", /"r17" cuts the word "best" in half at its start/);
  // A muted video of the take (picture only) carries no words: the voice's own cut still counts.
  const picture = { type: "video", id: "pic", name: "pic", src: "/api/media/voice.wav", mediaStart: 0, mediaOffset: 0, mediaDuration: 6, volume: 0 };
  const [half] = await speechFindings("speech_cut", [voice("a", { mediaDuration: 1.3 }), picture]);
  assert.match(half.message, /"a" cuts the word "target\." in half at its end/);
});

// "target is on your right" then, 0.5 s later, "now I'll find the entrance";
// whisper lost the full stop, and words cut_speech removed still counted as the voice going on.
test("speech_cut: a pause ends a sentence, cut words are not said, and a fix over a cut is offered", async () => {
  const words = [["target", 0, 0.3], ["is", 0.32, 0.4], ["on", 0.42, 0.5], ["your", 0.52, 0.6], ["right", 0.62, 0.9],
    ["now", 1.4, 1.6], ["I'll", 1.62, 1.8], ["find", 1.82, 2], ["the", 2.02, 2.1], ["entrance", 2.12, 2.6]];
  const transcript = { ...TRANSCRIPT, duration: 3, words: words.map(([text, start, end]) => ({ text, start, end, cut: start, p: 0.9 })) };
  const findings = async (layers) => { const document = scene({ layers }); return (await check("speech_cut", document, speechContext(document, transcript))).findings; };
  assert.deepEqual(await findings([voice("app", { mediaDuration: 1.05 })]), []);
  // Mid-sentence (no pause after "your") is still a gate; the fix finishes only "right".
  const [mid] = await findings([voice("app", { mediaDuration: 0.61 })]);
  assert.equal(mid.severity, "error");
  assert.match(mid.fix.why, /finish "right" \(mediaDuration 0\.61 to 1\.05: its end moves 0\.44 s later/);
  // A filler is said, not a pause: stopping before "um right" is still mid-sentence.
  const um = { ...transcript, words: [...transcript.words.slice(0, 4), { text: "um", start: 0.62, end: 0.95 }, { ...transcript.words[4], start: 1, end: 1.3 }, ...transcript.words.slice(5)] };
  const filler = scene({ layers: [voice("app", { mediaDuration: 0.61 })] });
  assert.equal((await check("speech_cut", filler, speechContext(filler, um))).findings[0]?.severity, "error");
  // After "the" with "entrance" cut out by cut_speech, the voice says nothing more.
  assert.deepEqual(await findings([voice("app", { mediaDuration: 2.11, cutWords: [9] })]), []);
  // The same fix across a cut (a shot ends at 0.8 s) is offered, not applied by itself.
  const shot = { type: "video", id: "shot", name: "shot", src: "/api/media/shot.mp4", mediaStart: 0, mediaDuration: 0.8, x: 0, y: 0, width: 600, height: 900 };
  const [crossed] = await findings([voice("app", { mediaDuration: 0.61 }), shot]);
  assert.equal(crossed.fix.auto, false);
  assert.match(crossed.fix.why, /over the cut at 0\.8 s \("shot" ends\) into the next shot, so it is not applied by itself/);
});

// The file's waveform peaks (backend/audio-peaks.mjs, 100 a second): the voice really sounds a
// little past the transcript's word ends (0 to 1.8 s and 2.5 s on), quiet elsewhere.
const peaksOf = (duration, spans) => ({ version: 2, available: true, duration, secondsPerPeak: 0.01,
  peaks: Array.from({ length: Math.round(duration * 100) }, (_, index) => (spans.some(([from, to]) => index / 100 >= from && index / 100 < to) ? 0.5 : 0.01)) });
const LOUDNESS = peaksOf(6, [[0, 1.8], [2.5, 5.5]]);
async function heardFindings(layers, loudness, transcript = TRANSCRIPT) {
  const document = scene({ layers });
  const [raw] = document.scenes;
  const speech = raw.layers.map((layer) => ({ layer, transcript, loudness, ...(transcript ? {} : { missing: "no transcript" }) }));
  return check("speech_cut", document, { speechScene: raw, speech });
}

test("speech_cut by loudness: a cut inside the sound, and a file that ends mid-sentence", async () => {
  // 0.1 s after "target." the voice still rings: the transcript alone passes it, the loudness does not.
  const ringing = [voice("voice", { mediaDuration: 1.7 })];
  assert.deepEqual((await heardFindings(ringing, null)).findings, []);
  const [rings] = (await heardFindings(ringing, LOUDNESS)).findings;
  assert.equal(rings.severity, "error");
  assert.match(rings.message, /still sounding at its end/);
  assert.ok(rings.fix.properties.mediaDuration > 1.85 && rings.fix.properties.mediaDuration < 2.05, JSON.stringify(rings.fix));
  assert.match(rings.fix.why, /nearest pauses in the file: .* after/);
  // A file that ends loud right after "hackathon." (a text-to-speech file stops at its last word) is whole.
  const fileEnd = peaksOf(5.5, [[0, 1.8], [2.5, 5.5]]);
  assert.deepEqual((await heardFindings([voice("judge", { mediaOffset: 2.4, mediaDuration: 3.1 })], fileEnd)).findings, []);
  // Without the full stop the file cuts the sentence off; the fix drops only the unfinished words.
  const unfinished = { hackathon: "hackathon", saw: "saw." };
  const cutOff = { ...TRANSCRIPT, words: TRANSCRIPT.words.map((word) => ({ ...word, text: unfinished[word.text.replace(".", "")] ?? word.text })) };
  const [ends] = (await heardFindings([voice("judge", { mediaOffset: 2.4, mediaDuration: 3.1 })], fileEnd, cutOff)).findings;
  assert.equal(ends.severity, "error");
  assert.match(ends.message, /file itself ends mid-sentence/);
  assert.equal(ends.fix.properties.mediaDuration, 1.925);
  assert.match(ends.fix.why, /after "saw\."; drops the unfinished "in this hackathon"/);
  // Ending in the quiet after the sentence passes.
  assert.deepEqual((await heardFindings([voice("voice", { mediaDuration: 2.1 })], LOUDNESS)).findings, []);
  // A word the transcript hears over silence (a TTS track's quiet, under -40 dB) was not said: no word cut in half.
  const hallucinated = { ...TRANSCRIPT, words: [...TRANSCRIPT.words.slice(0, 5), { text: "so", start: 1.9, end: 2.3, cut: 1.9, p: 0.5 }, ...TRANSCRIPT.words.slice(5)] };
  const silence = { ...LOUDNESS, peaks: LOUDNESS.peaks.map((peak) => (peak < 0.1 ? 0.001 : peak)) };
  assert.match((await heardFindings([voice("voice", { mediaDuration: 2.1 })], null, hallucinated)).findings[0].message, /"so" in half/);
  assert.deepEqual((await heardFindings([voice("voice", { mediaDuration: 2.1 })], silence, hallucinated)).findings, []);
  // With no transcript a cut inside loud sound is a warning, and a cut in a pause passes.
  const unknown = await heardFindings([voice("voice", { mediaDuration: 1.3 })], LOUDNESS, null);
  assert.deepEqual(unknown.findings.map((finding) => [finding.severity, /inside loud sound/.test(finding.message)]), [["warn", true]]);
  assert.match(unknown.notes.join("\n"), /heard only the loudness of "voice"/);
  assert.deepEqual((await heardFindings([voice("voice", { mediaDuration: 2.1 })], LOUDNESS, null)).findings, []);
  // Sound effects are no voice: a whoosh cut on both sides inside its loud sound, and a 0.35 s
  // camera shutter whose transcript is the tag "camera shutter]", pass.
  const whoops = { ...TRANSCRIPT, words: [0.1, 0.7, 1.3, 1.9].map((start) => ({ text: "whoop,", start, end: start + 0.4, cut: start, p: 0.9 })) };
  assert.deepEqual((await heardFindings([voice("whoosh", { mediaOffset: 0.5, mediaDuration: 1 })], LOUDNESS, whoops)).findings, []);
  const click = { ...TRANSCRIPT, words: [{ text: "camera", start: 2.56, end: 2.61, cut: 2.56 }, { text: "shutter]", start: 2.61, end: 3.35, cut: 2.6 }] };
  assert.deepEqual((await heardFindings([voice("shutter", { mediaOffset: 2.5, mediaDuration: 0.35 })], LOUDNESS, click)).findings, []);
});

test("speech_captions: captions over a voice that leave out words it says", async () => {
  const judge = voice("judge", { mediaOffset: 2.4, mediaDuration: 3.1 });
  const captioned = (words) => [judge, text("caption", words, { role: "caption", fontSize: 48 })];
  const [missing] = await speechFindings("speech_captions", captioned("It is the best project we saw"));
  assert.equal(missing.severity, "warn");
  assert.match(missing.message, /leave out 3 words "judge" says: "in this hackathon\." at 1\.95 s/);
  assert.deepEqual(await speechFindings("speech_captions", captioned("It is the best project we saw in this hackathon.")), []);
  // A misheard word spelled right (add_captions fix) is no word left out; a word dropped still is.
  assert.deepEqual(await speechFindings("speech_captions", captioned("It is the best project we saw in this Hackfest.")), []);
  assert.match((await speechFindings("speech_captions", captioned("It is the best project we saw in Hackfest.")))[0].message, /leave out 1 word "judge" says/);
  // A whoosh under a caption is no voice the caption leaves out.
  const whoosh = scene({ layers: [voice("whoosh", { mediaDuration: 2 }), text("caption", "Oak", { role: "caption", fontSize: 48 })] });
  const whoops = { ...TRANSCRIPT, words: [0.1, 0.5, 0.9, 1.3].map((start) => ({ text: "Whoop.", start, end: start + 0.3, cut: start, p: 0.9 })) };
  assert.deepEqual((await check("speech_captions", whoosh, speechContext(whoosh, whoops))).findings, []);
});

test("speech_captions: a text shows the line of a clip that is muted there", async () => {
  const clip = (props) => ({ type: "video", id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaStart: 0, mediaOffset: 0, mediaDuration: 4, volume: 0, ...props });
  const shown = (words) => text("line", words, { fontSize: 64 });
  const line = { layer: "clip", layerId: "clip", text: "We leave at dawn today.", from: 1, to: 2.5 };
  const run = async (layers, lines = [line], speech = []) => {
    const document = scene({ layers });
    return (await check("speech_captions", document, { speechScene: document.scenes[0], speech, clipLines: lines })).findings;
  };
  const [muted] = await run([clip(), shown("We leave at dawn")]);
  assert.equal(muted.severity, "warn");
  assert.equal(muted.message, '"We leave at dawn" shows the line clip says, but clip is muted there: the viewer reads a voice they never hear.');
  assert.match(muted.fix.text, /^edit \{"ops":\[\{"op":"keep_line","layer":"clip","line":"We leave at dawn today\.","subtitle":false\},\{"op":"isolate_voice","layer":"clip"\}\]\}/);
  // A slowed layer is put back to speed 1, forwards, every frame, its Speed animations deleted; the check then returns the keep_line call.
  const slowed = { ...line, slowed: true, how: "speed 0.5", speedAnimations: ["A3"] };
  assert.match((await run([clip(), shown("We leave at dawn")], [slowed]))[0].fix.text, /^edit \{"ops":\[\{"op":"update_layer","layer":"clip","properties":\{"mediaSpeed":1,"mediaReverse":null,"mediaFrameRate":null\}\},\{"op":"delete_animation","animationId":"A3"\}\]\}: clip plays speed 0\.5/);
  // A line clipLines cut short ("...") is kept by its scene seconds.
  assert.match((await run([clip(), shown("We leave at dawn today and so")], [{ ...line, text: "We leave at dawn today and so we…" }]))[0].fix.text, /^edit \{"ops":\[\{"op":"keep_line","layer":"clip","from":1,"to":2\.5,"subtitle":false\}/);
  assert.deepEqual(await run([clip({ volume: 1 }), shown("We leave at dawn")]), []);
  assert.deepEqual(await run([clip(), shown("Nothing like it")]), []);
  assert.deepEqual(await run([clip(), shown("Dawn")], [{ ...line, text: "Dawn." }]), []);
  // A long title holding two common words of a short line is not that line; one word a layer (kinetic type) is.
  assert.deepEqual(await run([clip(), shown("We never leave the place we call home")], [{ ...line, text: "We leave." }]), []);
  const kinetic = (await run([clip(), ...["We", "leave", "at", "dawn"].map((word) => text(word, word, { fontSize: 64 }))]))[0];
  assert.match(kinetic.message, /^"We leave at dawn" shows the line clip says/);
  // A clip at 0.06 under a song at 1 is not heard either; at 0.5 it is.
  const song = { type: "audio", id: "song", name: "song", src: "/api/media/song.mp3", mediaStart: 0, mediaOffset: 0, mediaDuration: 4, volume: 1 };
  assert.equal((await run([clip({ volume: 0.06 }), song, shown("We leave at dawn")])).length, 1);
  assert.deepEqual(await run([clip({ volume: 0.5 }), song, shown("We leave at dawn")]), []);
  // Another sound that says the same words (a voice in the mix) means the viewer hears it.
  const said = ["we", "leave", "at", "dawn", "today"].map((word, index) => ({ text: word, start: 1 + index * 0.25, end: 1.2 + index * 0.25 }));
  const document = scene({ layers: [clip(), voice("vo", { mediaDuration: 4 }), shown("We leave at dawn")] });
  const mix = { speechScene: document.scenes[0], clipLines: [line], speech: [{ layer: document.scenes[0].layers.find((layer) => layer.id === "vo"), transcript: { words: said } }] };
  assert.deepEqual((await check("speech_captions", document, mix)).findings, []);
});

test("speech_unplayed: every clip muted where its saved lines are said warns once with the keep_line call for the best line", async () => {
  const clip = (id, props) => ({ type: "video", id, name: id, src: `/api/media/${id}.mp4`, x: 0, y: 0, width: 1920, height: 1080, mediaStart: 0, mediaOffset: 0, mediaDuration: 4, volume: 0, ...props });
  const lines = [{ layer: "a", layerId: "a", text: "Kill you.", from: 1, to: 1.6 }, { layer: "b", layerId: "b", text: "I can't, I can't!", from: 2, to: 3 }];
  const run = async (layers) => { const document = scene({ layers }); return (await check("speech_unplayed", document, { speechScene: document.scenes[0], savedLines: lines })).findings; };
  const [found] = await run([clip("a"), clip("b")]);
  assert.equal(found.severity, "warn");
  assert.match(found.message, /the clips say 2 lines and the edit plays none/);
  assert.match(found.fix.text, /^edit \{"ops":\[\{"op":"keep_line","layer":"b","line":"I can't, I can't!"\}\]\}.*waive_check \{code:"speech_unplayed"/);
  // One line heard (a keep_line volume animation) clears it.
  const heard = { animations: [{ id: "u", name: "Line up", kind: "custom", easing: "smooth", start: 0.9, duration: 0.1, from: { volume: 0 }, to: { volume: 1 } }] };
  assert.deepEqual(await run([clip("a", heard), clip("b")]), []);
  // Only part of a line plays (a trimmed clip): kept by its seconds with its words as the subtitle.
  lines.splice(0, 2, { layer: "a", layerId: "a", text: "Hahaha, I can't,", from: 0.3, to: 1.6, partial: true });
  assert.match((await run([clip("a")]))[0].fix.text, /^edit \{"ops":\[\{"op":"keep_line","layer":"a","from":0\.3,"to":1\.6,"text":"Hahaha, I can't,"\}\]\}/);
});

// The sound rules (engine/quality/rules/sound.js): each layer's transcript or song loudness comes in as ctx.speech.
async function soundFindings(code, layers, entryOf) {
  const document = scene({ duration: 6, layers });
  const [raw] = document.scenes;
  return (await check(code, document, { speechScene: raw, speech: raw.layers.map((layer) => ({ layer, ...entryOf(layer) })) })).findings;
}

test("speech_fragment: a sound layer that starts on the tail of a sentence said before it", async () => {
  // "Can you find target? Uh, at school. It is big." in file seconds.
  const words = [["Can", 0, 0.2], ["you", 0.25, 0.4], ["find", 0.45, 0.7], ["target?", 0.75, 1.1], ["Uh,", 1.4, 1.55], ["at", 1.7, 1.8], ["school.", 1.85, 2.3], ["It", 3.5, 3.6], ["is", 3.65, 3.8], ["big.", 3.85, 4.2]];
  const street = { model: "small.en", version: 1, duration: 6, words: words.map(([text, start, end]) => ({ text, start, end, cut: start, p: 0.9 })) };
  const ambience = (props) => voice("street", { mediaOffset: 1.2, mediaDuration: 3, volume: 0.6, ...props });
  const [tail] = await soundFindings("speech_fragment", [ambience()], () => ({ transcript: street }));
  assert.equal(tail.severity, "warn");
  assert.match(tail.message, /"at school\." is heard with nothing before it/);
  // A sound starts later on its own clock, so its end stays put.
  assert.deepEqual([tail.at, tail.fix.properties, tail.fix.auto], [0.2, { mediaOffset: 2.45, mediaStart: 1.25, mediaDuration: 1.75 }, false]);
  // The two rules agree (room chatter): this fix passes speech_cut, and speech_cut's start
  // fix for a clip begun inside "at school." walks back past the tail to "Can you", which passes this rule.
  const cutFindings = (layer) => soundFindings("speech_cut", [layer], () => ({ transcript: street }));
  assert.deepEqual(await cutFindings(ambience(tail.fix.properties)), []);
  const [inside] = await cutFindings(ambience({ mediaStart: 2, mediaOffset: 1.82, mediaDuration: 2.38 }));
  assert.match(inside.fix.why, /starts at "Can you find target\?"/);
  assert.deepEqual(await soundFindings("speech_fragment", [ambience(inside.fix.properties)], () => ({ transcript: street })), []);
  // Started after the tail, ducked low, or under a louder voice: nothing dangles.
  assert.deepEqual(await soundFindings("speech_fragment", [ambience({ mediaOffset: 2.45 })], () => ({ transcript: street })), []);
  assert.deepEqual(await soundFindings("speech_fragment", [ambience({ volume: 0.2 })], () => ({ transcript: street })), []);
  assert.deepEqual(await soundFindings("speech_fragment", [ambience(), voice("vo", { mediaDuration: 3 })], (layer) => ({ transcript: layer.id === "vo" ? TRANSCRIPT : street })), []);
});

test("mute_word: a mute ramp that starts after the word it hides begins", async () => {
  assert.equal(ruleOf("mute_word").level, "warn");
  // A mute meant for "project" (3.35 to 3.8 s) that only reaches silence at 3.53 s, back up at 3.85 s.
  const muted = (start) => [voice("voice", { mediaDuration: 5.5, animations: [move(start, 0.08, { volume: 1 }, { volume: 0 }), move(3.85, 0.08, { volume: 0 }, { volume: 1 })] })];
  const [late] = await soundFindings("mute_word", muted(3.45), () => ({ transcript: TRANSCRIPT }));
  assert.match(late.message, /starts after "project" begins: its first 0\.18 s is heard/);
  // The fix ends the ramp 0.03 s before the word; it would lower the end of "best", so it is offered.
  assert.deepEqual([late.fix.kind, late.fix.properties, late.fix.auto], ["layer_animation", { start: 3.24 }, false]);
  assert.deepEqual(await soundFindings("mute_word", muted(3.24), () => ({ transcript: TRANSCRIPT })), []);
  // A longer ramp that dips the end of "best" on its way down still names "project", the word in the quiet.
  const [long] = await soundFindings("mute_word", [voice("voice", { mediaDuration: 5.5, animations: [move(3.2, 0.3, { volume: 1 }, { volume: 0 }), move(3.85, 0.08, { volume: 0 }, { volume: 1 })] })], () => ({ transcript: TRANSCRIPT }));
  assert.deepEqual([long.message.match(/after "(\w+)"/)[1], long.fix.properties], ["project", { start: 3.02 }]);
  // A late duck makes the same mistake; a duck_audio dip to 0.25 (room for another voice) hides no word.
  const ducked = (name) => [voice("voice", { mediaDuration: 5.5, animations: [{ ...move(3.45, 0.08, { volume: 1 }, { volume: 0.25 }), name }, { ...move(3.85, 0.08, { volume: 0.25 }, { volume: 1 }), name: "Duck up" }] })];
  assert.equal((await soundFindings("mute_word", ducked("Hide name"), () => ({ transcript: TRANSCRIPT }))).length, 1);
  assert.deepEqual(await soundFindings("mute_word", ducked("Duck down"), () => ({ transcript: TRANSCRIPT })), []);
  // A fade out at the clip's end is speech_cut's, not a mute.
  const fade = [voice("voice", { mediaDuration: 5.5, animations: [move(5.3, 0.2, { volume: 1 }, { volume: 0 })] })];
  assert.deepEqual(await soundFindings("mute_word", fade, () => ({ transcript: TRANSCRIPT })), []);
});

test("music_stall: a loud stretch of the song with no shot at full strength and no cut, past 2.5 s", async () => {
  // Quiet to 2 s, then loud to the end (12 s).
  const loudness = peaksOf(12, [[2, 12]]);
  const song = voice("song", { src: "/api/media/song.wav", mediaDuration: 12, volume: 0.8 });
  const shot = (id, at, until, props = {}) => ({ type: "video", id, name: id, src: `/api/media/${id}.mp4`, mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080, ...props,
    animations: [{ kind: "show", start: at }, { kind: "hide", start: until }] });
  const run = async (layers) => {
    const document = scene({ duration: 12, layers: [song, ...layers] });
    const [raw] = document.scenes;
    return (await check("music_stall", document, { speechScene: raw, speech: [{ layer: raw.layers[0], music: true, loudness }] })).findings;
  };
  // A prompt typing over a blurred backdrop for 4 s of the loud part.
  const [stall] = await run([shot("a", 0, 4), shot("log", 4, 8, { blur: 40 }), text("prompt", "whip to the red shot", { y: 500 }), shot("b", 8, 12)]);
  assert.equal(stall?.rule, "music_stall");
  assert.match(stall.measured, /^4s with the music/);
  // The same 4 s over the shot at full strength, or before the music gets loud: left alone.
  assert.deepEqual(await run([shot("a", 0, 4), shot("log", 4, 8), text("prompt", "whip to the red shot", { y: 500 }), shot("b", 8, 12)]), []);
  assert.deepEqual(await run([shot("log", 0, 2, { blur: 40 }), shot("a", 2, 12)]), []);
});

test("music_turn: the music does nothing at the spine's turn", async () => {
  const loudness = peaksOf(20, [[0, 20]]);
  const spine = [{ role: "problem", from: 0, to: 10 }, { role: "turn", from: 10, to: 14 }, { role: "payoff", from: 14, to: 20 }];
  const run = async (props = {}, styleSpec = { spine }, cues = []) => {
    const document = scene({ duration: 20, layers: [voice("song", { src: "/api/media/song.wav", mediaDuration: 20, volume: 0.5, ...props })] });
    const [raw] = document.scenes;
    return (await check("music_turn", document, { speechScene: raw, speech: [{ layer: raw.layers[0], music: true, loudness }], styleSpec, cues })).findings;
  };
  // A flat level across the turn at 10 s warns and names fit_music.
  const [flat] = await run();
  assert.equal(flat?.at, 10);
  assert.match(flat.fix.text, /^fit_music \{layer:"song"\}/);
  // The suggested duck takes the song's own dip into account: a total of about 10 dB, never a negative duck.
  const withDip = (db, from, to) => ({ ...loudness, peaks: loudness.peaks.map((peak, index) => (index / 100 >= from && index / 100 < to ? peak * 10 ** (-db / 20) : peak)) });
  const duckFor = async (own) => {
    const document = scene({ duration: 20, layers: [voice("song", { src: "/api/media/song.wav", mediaDuration: 20, volume: 0.5 })] });
    const [raw] = document.scenes;
    return (await check("music_turn", document, { speechScene: raw, speech: [{ layer: raw.layers[0], music: true, loudness: own }], styleSpec: { spine }, cues: [{ name: "song-drop-1", time: 11.5, kind: "marker" }] })).findings[0];
  };
  const flatDuck = await duckFor(loudness);
  assert.match(flatDuck.fix.text, /duck it 10 dB for 0\.5 s/);
  assert.match(flatDuck.measured, /the song's own dip 0 dB/);
  assert.match((await duckFor(withDip(3, 9.4, 10))).fix.text, /duck it 7 dB for 0\.5 s just before the turn \(the song drops 3 dB there; 10 dB in all/);
  const noDuck = (await duckFor(withDip(12, 9.6, 9.9))).fix.text;
  assert.match(noDuck, /no duck is needed \(the song already drops 12 dB there/);
  assert.doesNotMatch(noDuck, /duck it/);
  // A dip that starts at the turn is not one before it: it does not count, so the hint still suggests the full duck.
  const afterTurn = await duckFor(withDip(12, 10, 10.4));
  assert.match(afterTurn.fix.text, /duck it 10 dB/);
  assert.match(afterTurn.measured, /the song's own dip 0 dB/);
  // Already fitted (song- cues), its drop 1.5 s off the turn: refitting gives the same cut, so the hint moves the turn to the drop.
  const [fitted] = await run({}, { spine }, [{ name: "song-build-1", time: 6, kind: "marker" }, { name: "song-drop-1", time: 11.5, kind: "marker" }]);
  assert.match(fitted?.fix.text, /^move the spine's turn to 11\.5 s \(song-drop-1\)/);
  assert.doesNotMatch(fitted.fix.text, /fit_music/);
  // The volume doubles (6 dB) at 10 s: the music changes, as it does with no turn beat at all.
  assert.deepEqual(await run({ animations: [{ kind: "custom", start: 10, duration: 0.05, easing: "linear", from: { volume: 0.5 }, to: { volume: 1 } }] }), []);
  assert.deepEqual(await run({}, { spine: spine.filter((beat) => beat.role !== "turn") }), []);
});

test("music_hard_stop: a song that stops dead while loud", async () => {
  // Loud all through, with a quiet bar at 2.8 to 3.2 s.
  const loudness = peaksOf(10, [[0, 2.8], [3.2, 10]]);
  const song = (props) => voice("song", { src: "/api/media/song.wav", mediaDuration: 5, volume: 0.5, ...props });
  const stops = (layers, context = {}) => soundFindings("music_hard_stop", layers, () => ({ transcript: null, music: true, loudness, ...context }));
  const [stop] = await stops([song()]);
  assert.equal(stop.severity, "warn");
  assert.match(stop.message, /stops dead at 5 s/);
  assert.match(stop.required, /^fit_music \{layer:"song"\} first/, "ending the song on its own ending comes before a plain fade");
  assert.deepEqual([stop.fix.kind, stop.fix.auto, stop.fix.animation.start, stop.fix.animation.from, stop.fix.animation.to], ["add_layer_animation", true, 4.75, { volume: 0.5 }, { volume: 0 }]);
  // Faded out, stopped in the quiet bar, or on a marker cue: left alone.
  assert.deepEqual(await stops([song({ animations: [{ kind: "out", start: 4.75, duration: 0.25, easing: "ease-in", from: { volume: 0.5 }, to: { volume: 0 } }] })]), []);
  assert.deepEqual(await stops([song({ mediaDuration: 3 })]), []);
  const document = scene({ duration: 6, layers: [song()] });
  const [raw] = document.scenes;
  assert.deepEqual((await check("music_hard_stop", document, { speechScene: raw, speech: [{ layer: raw.layers[0], music: true, loudness }], cues: [{ kind: "marker", time: 5 }] })).findings, []);
  // A piece of a fit_music song that the next piece of it takes over from (a jump to the drop) is the plan's join, not a stop;
  // the same two pieces with no fitMusic link are a song stopping dead.
  const pieces = (link) => [song({ mediaDuration: 2 }), song({ id: "song-2", name: "song-2", mediaStart: 2, mediaOffset: 5, mediaDuration: 2, ...link })];
  const atJoin = async (link) => (await stops(pieces(link))).filter((finding) => finding.at === 2);
  assert.deepEqual(await atJoin({ fitMusic: "song" }), []);
  assert.match((await atJoin({}))[0]?.message ?? "", /"song" stops dead at 2 s/);
  // A fade out still running at the stop leaves it loud (a shutter sound): the fix moves it to end there.
  const [running] = await stops([song({ animations: [{ id: "mine", kind: "out", start: 4.8, duration: 0.5, easing: "ease-in", from: { volume: 0.5 }, to: { volume: 0 } }] })]);
  assert.deepEqual([running.fix.kind, running.fix.animationId, running.fix.properties, running.fix.auto], ["layer_animation", "mine", { start: 4.5 }, true]);
  // A file that runs out before the layer ends stops where the file does, and says its own name.
  const [runsOut] = await stops([song({ mediaOffset: 6, mediaDuration: 8 })]);
  assert.equal(runsOut.at, 4);
  assert.match(runsOut.message, /"song" stops dead at 4 s while its own sound is still loud/);
});

// T4 mix rules, on measured loudness curves (LUFS every 0.1 s, backend/loudness-curve.mjs).
const curve = (lufs, seconds = 10) => ({ step: 0.1, momentary: Array(seconds * 10).fill(lufs) });
const LINE = { model: "small.en", version: 1, duration: 3, words: [["Ship", 0.2, 0.6], ["it", 0.7, 1], ["today.", 1.1, 1.8]].map(([text, start, end]) => ({ text, start, end, cut: start, p: 0.9 })) };

test("voice_under_bed: a spoken line less than 6 LU over the music under it", async () => {
  // The voice is leveled to -16 LUFS; the song at -10 LUFS and volume 1 sits 6 LU over it.
  const layers = (volume) => [voice("vo", { mediaDuration: 3 }), voice("song", { src: "/api/media/song.wav", mediaDuration: 6, volume })];
  const entryOf = (layer) => (layer.id === "vo" ? { transcript: LINE, levels: curve(-24) } : { transcript: null, music: true, levels: curve(-10) });
  const [under] = await soundFindings("voice_under_bed", layers(1), entryOf);
  assert.match(under.message, /"Ship it today\." \(vo\) is only -6 LU over song under it/);
  // Named on the voice, so waiving one line (bystander chatter) never hides the song from other lines.
  assert.equal(under.layerId, "vo");
  // At volume 0.2 (14 dB down) the voice is 8 LU over the music; unmeasured, nothing is said.
  assert.deepEqual(await soundFindings("voice_under_bed", layers(0.2), entryOf), []);
  assert.deepEqual(await soundFindings("voice_under_bed", layers(1), (layer) => (layer.id === "vo" ? { transcript: LINE } : { transcript: null, music: true })), []);
});

test("voice_under_bed: the end of a line trailing off under street sound", async () => {
  // "Ship" loud, "it today." 20 dB quieter in the file; street sound (no song) at -30 LUFS.
  const trailing = { step: 0.1, momentary: Array.from({ length: 30 }, (_, index) => (index < 6 ? -16 : -36)) };
  const layers = (volume) => [voice("vo", { mediaDuration: 3 }), voice("street", { src: "/api/media/street.wav", mediaDuration: 6, volume })];
  const entryOf = (layer) => (layer.id === "vo" ? { transcript: LINE, levels: trailing } : { transcript: null, levels: curve(-30) });
  const [buried] = await soundFindings("voice_under_bed", layers(1), entryOf);
  assert.match(buried.message, /^"it today\." in "Ship it today\." \(vo\) is buried: only -?\d.* LU over street/);
  assert.equal(buried.layerId, "vo");
  assert.match(buried.fix.text, /^Lift "it today\.": a volume ramp on vo up .* dB from 0\.6 to 1\.8 s, or dip street/);
  assert.deepEqual(await soundFindings("voice_under_bed", layers(0.2), entryOf), []);
});

test("bed_jump: street sound cut from 0.2 to 1.2 jumps 15 LU", async () => {
  const street = (id, props) => voice(id, { src: "/api/media/street.wav", mediaDuration: 3, ...props });
  const entryOf = () => ({ transcript: null, levels: curve(-20) });
  const fadeIn = { kind: "in", start: 3, duration: 0.06, easing: "smooth", from: { volume: 0 }, to: { volume: 1.2 } };
  const [jump] = await soundFindings("bed_jump", [street("a", { volume: 0.2 }), street("b", { mediaStart: 3, volume: 1.2, animations: [fadeIn] })], entryOf);
  assert.match(jump.message, /^The beds jump 1[56]\.\d LU at 3 s \(a to b\)/);
  assert.match(jump.fix.text, /^Start b 0\.5 s or more before the cut with a fade in of 0\.5 s or more/);
  // Matched levels, or a J-cut fading in over 0.5 s before the cut: no jump.
  assert.deepEqual(await soundFindings("bed_jump", [street("a", { volume: 0.2 }), street("b", { mediaStart: 3, volume: 0.25 })], entryOf), []);
  const jCut = street("b", { mediaStart: 2.5, mediaDuration: 3.5, volume: 1.2, animations: [move(2.5, 0.5, { volume: 0 }, { volume: 1.2 })] });
  assert.deepEqual(await soundFindings("bed_jump", [street("a", { volume: 0.2 }), jCut], entryOf), []);
  // A fit_music piece entered where the piece before it of the same song ends (a stop, then the drop) is the song's own join.
  const joined = street("b", { mediaStart: 3, volume: 1.2, animations: [fadeIn], fitMusic: "a" });
  assert.deepEqual(await soundFindings("bed_jump", [street("a", { volume: 0.2 }), joined], entryOf), []);
});

test("volume_churn: a song ducked and raised again and again", async () => {
  const steps = (...moves) => moves.map(([start, from, to]) => move(start, 0.2, { volume: from }, { volume: to }));
  const song = (animations) => [voice("song", { src: "/api/media/song.wav", mediaDuration: 6, volume: 0.25, animations })];
  const music = () => ({ transcript: null, music: true });
  const [churn] = await soundFindings("volume_churn", song(steps([1, 0.25, 0.12], [2, 0.12, 0.25], [3, 0.25, 0.12], [4, 0.12, 0.25])), music);
  assert.match(churn.message, /^"song" changes direction 3 times in 2 s/);
  // A fade in, one duck under the whole line and a fade out: one turn.
  assert.deepEqual(await soundFindings("volume_churn", song(steps([0, 0, 0.25], [2, 0.25, 0.12], [4, 0.12, 0.25], [5.5, 0.25, 0])), music), []);
});

test("voice_level_spread: spoken lines more than 3 dB apart as heard", async () => {
  // Both leveled to -16 LUFS; the second line's layer is turned down.
  const layers = (volume) => [voice("one", { mediaDuration: 2 }), voice("two", { mediaStart: 3, mediaDuration: 2, volume })];
  const entryOf = (layer) => ({ transcript: LINE, levels: curve(layer.id === "one" ? -12 : -26) });
  const [spread] = await soundFindings("voice_level_spread", layers(0.5), entryOf);
  assert.match(spread.message, /Spoken lines are 6 dB apart/);
  assert.equal(spread.layerId, "two");
  assert.deepEqual(await soundFindings("voice_level_spread", layers(0.8), entryOf), []);
  // Under volume 0.5 a layer is a bed (street sound, chatter): no line, and the export leaves it unleveled.
  assert.deepEqual(await soundFindings("voice_level_spread", layers(0.3), entryOf), []);
});

test("end_on_fade: the video ends on a fade while the song is mid-phrase", async () => {
  const loudness = peaksOf(10, [[0, 10]]);
  const fadeOut = { kind: "out", start: 5.5, duration: 0.5, easing: "ease-in", from: { volume: 1 }, to: { volume: 0 } };
  const song = (props) => voice("song", { src: "/api/media/song.wav", mediaDuration: 6, animations: [fadeOut], ...props });
  const ends = (layers, context = {}) => soundFindings("end_on_fade", layers, () => ({ transcript: null, music: true, loudness, ...context }));
  const [cut] = await ends([song()]);
  assert.match(cut.message, /ends on a fade of "song" while the song is mid-phrase \(4 s before its own ending\)/);
  // The song's own ending, or no fade at all (music_hard_stop's): left alone.
  assert.deepEqual(await ends([song({ mediaOffset: 4 })]), []);
  assert.deepEqual(await ends([song({ animations: [] })]), []);
  // On a section cue at the end.
  const document = scene({ duration: 6, layers: [song()] });
  const [raw] = document.scenes;
  assert.deepEqual((await check("end_on_fade", document, { speechScene: raw, speech: [{ layer: raw.layers[0], music: true, loudness }], cues: [{ name: "outro", kind: "marker", time: 6 }] })).findings, []);
});

test("no_music: a 10 s video with no song under it", async () => {
  const long = (layers) => scene({ duration: 12, layers });
  const run = (document, speech = [], soundSearch = false) => check("no_music", document, { speechScene: document.scenes[0], speech: speech.map((index) => ({ layer: document.scenes[0].layers[index], music: true })), soundSearch });
  // Silent, or only a 1 s whoosh: fires; with song search (YouTube, no switch) the fix is a real song.
  const [silent] = (await run(long([]))).findings;
  assert.deepEqual([silent.severity, silent.message], ["warn", "This 12 s video has no music: no sound layer at all."]);
  assert.match(silent.fix.text, /ask the person to name a song or send a track, or keep it silent/);
  const whoosh = long([voice("whoosh", { mediaDuration: 1 })]);
  assert.match((await run(whoosh, [], true)).findings[0].fix.text, /^a real song: library \{topic:"soundtrack", song:"<title> by <artist>"\}/);
  // A song kino heard a beat in, or a long unknown sound layer, is music; a short video needs none.
  assert.deepEqual((await run(long([voice("song", { mediaDuration: 2 })]), [0])).findings, []);
  assert.deepEqual((await run(long([voice("bed", { mediaDuration: 8 })]))).findings, []);
  assert.deepEqual((await run(scene({ duration: 8 }))).findings, []);
});

test("sfx_restraint: more than one sound effect every 4 s, or one sound on every repeat", async () => {
  const hit = (id, at, src = `/api/media/${id}.wav`) => voice(id, { src, mediaStart: at, mediaDuration: 0.5 });
  const run = (layers) => { const document = scene({ duration: 20, layers }); return check("sfx_restraint", document, { speechScene: document.scenes[0] }); };
  // 5 different hits in 8 s: too many; the same 3 at 0, 6 and 12 s: under the rate, but a repeat.
  const [busy] = (await run([0, 2, 4, 6, 8].map((at, i) => hit(`s${i}`, at)))).findings;
  assert.match(busy.measured, /^5 sound effects in 16 s/);
  const [repeat] = (await run([0, 6, 12].map((at, i) => hit(`w${i}`, at, "/api/media/whoosh.wav")))).findings;
  assert.match(repeat.measured, /^one sound 3 times \(0s, 6s, 12s\)/);
  // 4 different hits spread out, and a long bed under them: fine.
  assert.deepEqual((await run([...[0, 5, 10, 15].map((at, i) => hit(`ok${i}`, at)), voice("bed", { mediaDuration: 20 })])).findings, []);
});

test("speech_quotes: spoken captions that look like a line nobody says", async () => {
  assert.equal(ruleOf("speech_quotes").level, "warn");
  const judge = voice("judge", { mediaOffset: 2.4, mediaDuration: 3.1 });
  const said = (props = {}) => text("caption", "It is the best project we saw in this hackathon.", { role: "caption", fontSize: 48, y: 900, ...props });
  const explain = (props = {}) => text("how", "Oak reads the shelf labels aloud", { fontSize: 48, y: 120, ...props });
  const [finding] = await speechFindings("speech_quotes", [judge, said(), explain()]);
  assert.match(finding.message, /"caption" .* looks like "how"/);
  assert.deepEqual([finding.fix.kind, finding.fix.properties.text, finding.fix.auto], ["item", "“It is the best project we saw in this hackathon.”", false]);
  // In quotes, in another color, or with no unspoken line beside it: nothing to tell apart.
  assert.deepEqual(await speechFindings("speech_quotes", [judge, said({ text: "“It is the best project we saw in this hackathon.”" }), explain()]), []);
  assert.deepEqual(await speechFindings("speech_quotes", [judge, said(), explain({ fill: "#8a6d1f" })]), []);
  assert.deepEqual(await speechFindings("speech_quotes", [judge, said()]), []);
});

test("text_load: texts that ask for too much reading at once, or crowd the footage", async () => {
  assert.equal(ruleOf("text_load").level, "warn");
  const shown = (start, end) => [{ kind: "show", start }, { kind: "hide", start: end }];
  // Two 29-character lines for 2 s ask for 14.5 characters a second each: 29 together is too much.
  const line = (id, y, props = {}) => text(id, "Oak finds the aisle you need.", { fontSize: 48, y, animations: shown(1, 3), ...props });
  const [rate] = await fires("text_load", scene({ duration: 6, layers: [line("a", 120), line("b", 800)] }));
  assert.match(rate.measured, /^29 characters a second/);
  // One of them alone, or with a status label shown the whole video, is fine.
  await silent("text_load", scene({ duration: 6, layers: [line("a", 120), text("status", "is speaking", { fontSize: 40, y: 960 })] }));
  // Three short labels apart from each other over playing footage crowd it; over a flat frame,
  // or stacked into one block, they do not.
  const footage = { type: "video", id: "walk", name: "walk", src: "/api/media/walk.mp4", mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080 };
  const labels = (stacked = false) => [["l1", 100, 100], ["l2", 1300, 100], ["l3", 700, stacked ? 170 : 850]]
    .map(([id, x, y]) => text(id, "Aisle 4", { fontSize: 48, x, y: stacked && id === "l2" ? 240 : y, ...(stacked ? { x: 100 } : {}), animations: shown(1, 3) }));
  const [crowd] = await fires("text_load", scene({ duration: 6, layers: [footage, ...labels()] }));
  assert.match(crowd.measured, /^3 separate texts over footage/);
  await silent("text_load", scene({ duration: 6, layers: labels() }));
  await silent("text_load", scene({ duration: 6, layers: [footage, ...labels(true)] }));
});

// The footage rules (engine/quality/rules/footage.js): the file sizes come in as ctx.mediaSizes.
const clip = (id, src, props) => ({ type: "video", id, name: id, src, mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080, ...props });
const SIZES = { "/api/media/phone.mp4": { width: 590, height: 1280 }, "/api/media/walk.mp4": { width: 1920, height: 1080 }, "/api/media/tall.mp4": { width: 1080, height: 1920 } };
const footage = (layers) => {
  const document = scene({ layers });
  return [document, { mediaSizes: SIZES, scene: document.scenes[0] }];
};

test("soft_upscale: a phone recording zoomed past its pixels is a gate; full frame, smaller and blurred are not", async () => {
  const zoom = move(1, 1.5, { scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 3 });
  const [finding] = await fires("soft_upscale", ...footage([clip("phone", "/api/media/phone.mp4", { x: 711, width: 498, animations: [zoom] })]));
  assert.equal(finding.severity, "error");
  assert.match(finding.measured, /^2\.5\dx at 2\.5 s/);
  await silent("soft_upscale", ...footage([clip("walk", "/api/media/walk.mp4")]));
  // 1080p footage reframed to cover a 9:16 frame (1.78x) is a warning, not a gate.
  const [reframed] = await fires("soft_upscale", ...footage([clip("walk", "/api/media/walk.mp4", { x: -1167, width: 3413, height: 1920 })]));
  assert.equal(reframed.severity, "warn");
  await silent("soft_upscale", ...footage([clip("tall", "/api/media/tall.mp4", { x: 696, width: 528 })]));
  await silent("soft_upscale", ...footage([clip("phone", "/api/media/phone.mp4", { x: 711, width: 498, blur: 20, animations: [zoom] })]));
});

test("crop_no_subject: footage drawn past the frame needs a subject, and keeps it in the frame", async () => {
  const big = { x: -240, y: -135, width: 2400, height: 1350 };
  const [warn] = await fires("crop_no_subject", ...footage([clip("walk", "/api/media/walk.mp4", big)]));
  assert.equal(warn.severity, "warn");
  assert.match(warn.measured, /10% of the 1920x1080 file cut off/);
  await silent("crop_no_subject", ...footage([clip("walk", "/api/media/walk.mp4")]));
  // A head marked at the top is cut off by the crop: a gate. Marked in the middle it is kept.
  const marked = (box) => ({ ...big, subjectBoxes: { src: "/api/media/walk.mp4", boxes: [0, 1, 2, 3, 4].map((at) => ({ at, box, by: "agent" })) } });
  // Marks count only after a source look at the file on that layer (ctx.sourceLooks).
  const looked = ([document, context]) => [document, { ...context, sourceLooks: { walk: { src: "/api/media/walk.mp4", at: [0, 1, 2, 3, 4] } } }];
  const [head] = await fires("crop_no_subject", ...looked(footage([clip("walk", "/api/media/walk.mp4", marked([40, 0, 20, 30]))])));
  assert.equal(head.severity, "error");
  assert.match(head.message, /only 67% of it/);
  await silent("crop_no_subject", ...looked(footage([clip("walk", "/api/media/walk.mp4", marked([40, 30, 20, 30]))])));
  // The same marks made without a look are a guess: judged as if nothing were marked (a warning).
  const [guess] = await fires("crop_no_subject", ...footage([clip("walk", "/api/media/walk.mp4", marked([40, 30, 20, 30]))]));
  assert.equal(guess.severity, "warn");
  assert.match(guess.message, /marked without a look/);
});

test("frozen_footage: a clip whose picture stops on screen is a gate", async () => {
  const shown = (from, to) => [{ kind: "show", start: from }, { kind: "hide", start: to }];
  const take = (props) => clip("walk", "/api/media/walk.mp4", { mediaStart: 0, mediaDuration: 3, ...props });
  // Slowed to a stop for a second.
  const stop = [{ kind: "custom", start: 1, duration: 0.1, easing: "smooth", from: { speed: 1 }, to: { speed: 0 } }, { kind: "custom", start: 2, duration: 0.1, easing: "smooth", from: { speed: 0 }, to: { speed: 1 } }];
  const [stopped] = await fires("frozen_footage", ...footage([take({ animations: [...shown(0, 3), ...stop] })]));
  assert.equal(stopped.severity, "error");
  assert.match(stopped.message, /frozen picture from 1 to 2\.1 s/);
  // Placed on a shutter hit, or on a spoken line ("Stop."), the freeze is designed: a warning.
  const shutter = { type: "audio", id: "shutter", name: "shutter", src: "/api/media/shutter.wav", mediaSourceDuration: 1, mediaStart: 0.95, mediaDuration: 0.5 };
  const [onHit] = await fires("frozen_footage", ...footage([take({ animations: [...shown(0, 3), ...stop] }), shutter]));
  assert.equal(onHit.severity, "warn");
  assert.match(onHit.message, /placed on a sound hit/);
  // A clip held before its play range stalls at its own cut-in: a hit there does not excuse it.
  const [onCut] = await fires("frozen_footage", ...footage([take({ mediaStart: 1, mediaDuration: 2, mediaFreeze: "first", animations: shown(0, 3) }), { ...shutter, mediaStart: 0 }]));
  assert.equal(onCut.severity, "error");
  const voice = { type: "audio", id: "vo", name: "vo", src: "/api/media/vo.wav", mediaSourceDuration: 10, mediaStart: 0, mediaDuration: 3 };
  const [spokenDoc, spokenCtx] = footage([take({ animations: [...shown(0, 3), ...stop] }), voice]);
  const words = [{ text: "wait", start: 0.1, end: 0.4 }, { text: "for", start: 0.45, end: 0.6 }, { text: "it.", start: 0.65, end: 0.8 }, { text: "Stop.", start: 1.05, end: 1.4 }];
  const speech = [{ layer: spokenDoc.scenes[0].layers.find((layer) => layer.id === "vo"), transcript: { words } }];
  const [onLine] = await fires("frozen_footage", spokenDoc, { ...spokenCtx, speechScene: spokenDoc.scenes[0], speech });
  assert.match(onLine.message, /placed on a spoken line/);
  // Once it plays again it moves again: held_static does not call the rest of the scene a hold.
  await silent("held_static", ...footage([take({ mediaDuration: 6, animations: [...shown(0, 6), ...stop] })]));
  // Holding its last frame a second past its play range, or a still of it put where it ends.
  await fires("frozen_footage", ...footage([take({ mediaDuration: 2, mediaFreeze: "last", animations: shown(0, 3) })]));
  const still = { type: "image", id: "held", name: "held", src: "/api/media/held.png", x: 0, y: 0, width: 1920, height: 1080, animations: shown(2, 3) };
  const [made] = await fires("frozen_footage", ...footage([take({ mediaDuration: 2, animations: shown(0, 2) }), still]));
  assert.match(made.message, /a still in the place of "walk", right where it ends/);
  // Playing through, choppy frames, or a clip that ends under another shot are fine.
  await silent("frozen_footage", ...footage([take({ animations: shown(0, 3) })]));
  await silent("frozen_footage", ...footage([take({ mediaFrameRate: 6, animations: shown(0, 3) })]));
  await silent("frozen_footage", ...footage([take({ mediaDuration: 2, animations: shown(0, 3) }), clip("phone", "/api/media/phone.mp4", { mediaStart: 2, mediaDuration: 1, animations: shown(2, 3) })]));
});

test("jump_cut: one take cut to a little later in itself, framed alike, with no transition", async () => {
  const walk = (id, props) => clip(id, "/api/media/walk.mp4", props);
  const first = walk("walk-1", { mediaStart: 0, mediaOffset: 0, mediaDuration: 2 });
  const [finding] = await fires("jump_cut", ...footage([first, walk("walk-2", { mediaStart: 2, mediaOffset: 5, mediaDuration: 2 })]));
  assert.equal(finding.severity, "warn");
  assert.match(finding.message, /the same file 3 s later/);
  assert.match(finding.fix.text, /cutaway.*dissolve/);
  // A dissolve, another file, a punch-in, or a cut back to earlier in the take is not a jump cut.
  await silent("jump_cut", ...footage([first, walk("walk-2", { mediaStart: 1.7, mediaOffset: 4.7, mediaDuration: 2.3, animations: [fadeIn(1.7, 0.35)] })]));
  await silent("jump_cut", ...footage([first, clip("phone", "/api/media/phone.mp4", { mediaStart: 2, mediaDuration: 2 })]));
  // A phone screen shown smaller on black between the two is a cutaway.
  await silent("jump_cut", ...footage([first, clip("phone", "/api/media/phone.mp4", { mediaStart: 2, mediaDuration: 1, x: 700, width: 500 }), walk("walk-2", { mediaStart: 3, mediaOffset: 6, mediaDuration: 2 })]));
  await silent("jump_cut", ...footage([first, walk("walk-2", { mediaStart: 2, mediaOffset: 5, mediaDuration: 2, x: -192, y: -108, width: 2304, height: 1296 })]));
  await silent("jump_cut", ...footage([walk("walk-1", { mediaStart: 0, mediaOffset: 5, mediaDuration: 2 }), walk("walk-2", { mediaStart: 2, mediaOffset: 1, mediaDuration: 2 })]));
});

// Picture rules on fake renders: `look(shown, time)` gives a picture's [r, g, b] function for the
// video layers drawn (the ones not hidden) at a time.
const painted = (width, paint) => {
  const height = Math.round((width * 1080) / 1920), pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const [r, g, b] = paint(x, y); pixels.set([r, g, b, 255], (y * width + x) * 4); }
  return { width, height, pixels };
};
const fakeRender = (layers, look) => async (times, { width, hide = [] }) =>
  times.map((time) => painted(width, look(layers.filter((layer) => layer.type === "video" && !hide.includes(layer.id)).map((layer) => layer.id), time)));
const texture = (shift = 0, tint = 0) => (x, y) => { const v = ((x + shift) * 37 + y * 53) % 200 + 30; return [v, Math.min(255, v + tint), v]; };
async function pictureCheck(code, layers, look) {
  const document = scene({ layers });
  const context = { mediaSizes: SIZES, scene: document.scenes[0], renderFrames: fakeRender(layers, look) };
  return (await runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes: [code], pixels: true, context })).findings;
}

test("jump_cut with pixels: only pictures alike in framing and light read as a jump", async () => {
  const layers = [clip("walk-1", "/api/media/walk.mp4", { mediaStart: 0, mediaDuration: 2 }), clip("walk-2", "/api/media/walk.mp4", { mediaStart: 2, mediaOffset: 5, mediaDuration: 2 })];
  const [finding] = await pictureCheck("jump_cut", layers, () => texture());
  assert.match(finding.measured, /differ 0% in framing/);
  // The second shot shows another place: the walk moved on, so the cut reads as a new shot.
  assert.deepEqual(await pictureCheck("jump_cut", layers, (shown) => (shown.includes("walk-2") ? (x, y) => [x * 5, y * 9, 90] : texture())), []);
});

test("source_jump: a flash frame right where a clip starts; a steady start is quiet", async () => {
  const layers = [clip("ask", "/api/media/walk.mp4", { mediaStart: 1, mediaDuration: 2 })];
  const [finding] = await pictureCheck("source_jump", layers, (_, time) => (time < 1.05 ? texture(20, 60) : texture()));
  assert.equal(finding.severity, "warn");
  assert.match(finding.message, /after it starts \(its file at 0\.07 s\)/);
  assert.match(finding.fix.text, /raise mediaOffset by 0\.07 s/);
  // At twice the speed the file runs twice as far: mediaOffset is in file seconds.
  const fast = [clip("ask", "/api/media/walk.mp4", { mediaStart: 1, mediaDuration: 2, mediaSpeed: 2 })];
  assert.match((await pictureCheck("source_jump", fast, (_, time) => (time < 1.05 ? texture(20, 60) : texture())))[0].fix.text, /raise mediaOffset by 0\.13 s .*lower mediaDuration by 0\.07 s/);
  assert.deepEqual(await pictureCheck("source_jump", layers, () => texture()), []);
});

test("dark_under_title: a title over a near-black clip; over a picture or a plain card it is quiet", async () => {
  const title = text("reveal", "oak", { role: "headline", fontSize: 160, x: 760, y: 440, width: 400, height: 200, fill: "#ffffff" });
  const layers = [clip("burst", "/api/media/walk.mp4", { mediaDuration: 3 }), title];
  const [finding] = await pictureCheck("dark_under_title", layers, () => () => [8, 8, 10]);
  assert.match(finding.message, /"reveal" sits over "burst"/);
  assert.deepEqual(await pictureCheck("dark_under_title", layers, () => texture()), []);
  assert.deepEqual(await pictureCheck("dark_under_title", [title], () => () => [8, 8, 10]), []);
  // A full-frame card between the clip and the title: the title sits on the card.
  const card = rect("card", { x: 0, y: 0, width: 1920, height: 1080, fill: "#1b1b1b" });
  assert.deepEqual(await pictureCheck("dark_under_title", [layers[0], card, title], () => () => [8, 8, 10]), []);
});

test("low_fps_motion: a clip at 5 frames a second that moves, or whose footage moves; a still one on still footage is quiet", async () => {
  const pan = move(0, 3, { x: 0 }, { x: -400 });
  const [moving] = await fires("low_fps_motion", ...footage([clip("rewind", "/api/media/walk.mp4", { mediaFrameRate: 5, width: 2400, mediaDuration: 3, animations: [pan] })]));
  assert.match(moving.message, /5 new frames a second \(mediaFrameRate 5\) while it moves/);
  const still = [clip("rewind", "/api/media/walk.mp4", { mediaFrameRate: 5, mediaDuration: 3 })];
  const [stutter] = await pictureCheck("low_fps_motion", still, (_, time) => texture(Math.floor(time * 5) * 7));
  assert.match(stutter.fix.text, /Raise mediaFrameRate to 12/);
  assert.deepEqual(await pictureCheck("low_fps_motion", still, () => texture()), []);
});
