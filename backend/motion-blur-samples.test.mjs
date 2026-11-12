// Motion blur from layer movement with more shutter samples (render options shutterAngle and
// motionSamples), drawn by both export renderers and checked pixel by pixel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { exportScene, renderStills } from "./export.mjs";
import { applyProjectUpdate } from "../engine/projectSettings.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { LOOK_MOTION_SAMPLES, sceneShutterOptions } from "../engine/previewBlur.js";
import { shutterNote } from "./agent/shutter-notes.mjs";
import { readImage } from "./media.test.support.mjs";

// A 20 px white bar that crosses 3600 px a second. At 30 fps a 180° shutter is open for 1/60 s,
// so the bar travels 60 px while it is open: from x=330 to x=390 around the frame at 0.1 s.
function barScene({ add = false } = {}) {
  const bar = createLayer("rectangle", { id: "bar", name: "Bar", x: 0, y: 0, width: 20, height: 40, fill: "#FFFFFF", radius: 0, strokeWidth: 0,
    ...(add ? { blendMode: "add" } : {}),
    animations: [{ id: "bar.move", name: "Move", kind: "custom", start: 0, duration: 0.2, easing: "linear", from: { x: 0 }, to: { x: 720 } }] });
  return parseDocument(createDocument({ id: "bar", name: "Bar",
    scenes: [createScene({ id: "main", name: "Main", width: 800, height: 40, duration: 0.2, background: "#000000", layers: [bar] })] })).scenes[0];
}

async function row(scene, options) {
  const { buffer } = await exportScene(scene, { format: "png", time: 0.1, fps: 30, shutterAngle: 180, ...options });
  const image = await readImage(buffer);
  return Array.from({ length: 120 }, (_, index) => image.pixel(300 + index, 20)[0]);
}

const at = (values, x) => values[x - 300];
const largestStep = (values) => Math.max(...values.slice(1).map((value, index) => Math.abs(value - values[index])));

test("two shutter samples leave a gap between two copies of a fast bar; eight smear it in even steps, as the default does", async (t) => {
  for (const add of [false, true]) {
    // add: true is drawn by Chromium (backend/raster-policy.mjs), the plain bar by resvg.
    const scene = barScene({ add });
    const two = await row(scene, { motionSamples: 2 });
    const eight = await row(scene, { motionSamples: 8 });
    // Without motionSamples a frame draws as many as its fastest move needs (60 px over 8 px apart).
    assert.deepEqual(await row(scene, {}), eight);
    const sixteen = await row(scene, { motionSamples: 16 });
    const label = add ? "Chromium" : "resvg";
    const every5 = (values) => Array.from({ length: 17 }, (_, index) => at(values, 330 + index * 5)).join(",");
    t.diagnostic(`${label}, x=330..410 every 5 px: 2 samples ${every5(two)}; 8 samples ${every5(eight)}`);
    // Two samples: bars at 345..365 and 375..395, black between them.
    assert.ok(at(two, 355) > 120 && at(two, 385) > 120 && at(two, 370) < 8, `${label} 2 samples: ${two.join(" ")}`);
    // Eight samples, 7.5 px apart: no gap, and the middle is about a third white (20 of 60 px).
    for (let x = 336; x <= 404; x += 1) assert.ok(at(eight, x) > 20, `${label} 8 samples: no gap at x=${x}: ${eight.join(" ")}`);
    assert.ok(Math.abs(at(eight, 360) - 85) <= 20, `${label} 8 samples: middle ${at(eight, 360)}`);
    assert.ok(largestStep(eight) <= 40, `${label} 8 samples: steps ${largestStep(eight)}`);
    assert.ok(largestStep(sixteen) <= 22, `${label} 16 samples: steps ${largestStep(sixteen)}`);
    assert.ok(at(eight, 320) < 4 && at(eight, 412) < 4, `${label} 8 samples: the smear ends where the shutter does`);
  }
});

test("a frame where nothing moves is the same with one sample or sixteen", async () => {
  const scene = barScene();
  scene.layers[0].animations = [];
  const still = await exportScene(scene, { format: "png", time: 0.1, fps: 30, dither: true });
  const sixteen = await exportScene(scene, { format: "png", time: 0.1, fps: 30, dither: true, shutterAngle: 360, motionSamples: 16 });
  assert.deepEqual(sixteen.buffer, still.buffer);
});

test("a queued final render leaves the sample count to each frame unless motionSamples is given", async () => {
  const { sceneOptions } = await import("./export-batches.mjs");
  const scene = barScene();
  const auto = sceneOptions({ format: "mp4", renderQuality: "final" }, scene);
  assert.equal(auto.motionBlur, 0.5);
  assert.equal("motionSamples" in auto, false);
  assert.equal(sceneOptions({ format: "mp4", renderQuality: "final", motionSamples: 4 }, scene).motionSamples, 4);
});

// A 300 px bar turning 90 degrees in 0.1 s: its center holds still, so the cheap look smear
// (previewBlur.js, which follows the center) leaves it sharp.
function turnDocument(shutterAngle) {
  const bar = createLayer("rectangle", { id: "bar", name: "Bar", x: 250, y: 190, width: 300, height: 20, fill: "#FFFFFF", radius: 0, strokeWidth: 0,
    animations: [{ id: "bar.turn", name: "Turn", kind: "custom", start: 0, duration: 0.1, easing: "linear", from: { rotation: 0 }, to: { rotation: 90 } }] });
  const document = parseDocument(createDocument({ id: "turn", name: "Turn",
    scenes: [createScene({ id: "main", name: "Main", width: 800, height: 400, duration: 0.2, background: "#000000", layers: [bar] })] }));
  if (shutterAngle !== undefined) applyProjectUpdate(document, { shutterAngle });
  return parseDocument(document);
}

test("the project's shutter rides on each drawn scene and sets drafts and finals; without it nothing changes", async () => {
  const { sceneOptions } = await import("./export-batches.mjs");
  const on = expandComponents(turnDocument(180), "main");
  assert.equal(on.shutterAngle, 180);
  const draft = sceneOptions({ format: "mp4", renderQuality: "draft" }, on);
  assert.deepEqual([draft.motionBlur, draft.maxMotionSamples, "motionSamples" in draft], [0.5, LOOK_MOTION_SAMPLES, false]);
  assert.equal(sceneOptions({ format: "mp4", renderQuality: "final" }, expandComponents(turnDocument(90), "main")).motionBlur, 0.25);
  assert.equal(sceneOptions({ format: "mp4", renderQuality: "draft", shutterAngle: 0 }, on).motionBlur, 0, "a render's own option wins");
  const off = expandComponents(turnDocument(), "main");
  assert.equal("shutterAngle" in off, false);
  assert.equal(sceneOptions({ format: "mp4", renderQuality: "draft" }, off).motionBlur, 0);
  assert.equal(sceneOptions({ format: "mp4", renderQuality: "final" }, off).motionBlur, 0.5);
  assert.deepEqual(sceneShutterOptions(off), {});
  assert.throws(() => turnDocument(400), /shutterAngle must be a number of degrees from 0 to 360/);
  assert.throws(() => applyProjectUpdate(turnDocument(), { motionBlur: true }), /motion blur is \{shutterAngle:180\}/, "a guessed name gets the call that works");
  const sharpScene = turnDocument(180);
  sharpScene.scenes[0].shutterAngle = 0;
  assert.equal(expandComponents(parseDocument(sharpScene), "main").shutterAngle, 0, "a scene's own shutter wins over the project's");
  sharpScene.scenes[0].shutterAngle = "on";
  assert.throws(() => parseDocument(sharpScene), /shutterAngle must be a number/);
});

test("look stills with the project's shutter smear a turn that the cheap preview draws sharp", async () => {
  const scene = expandComponents(turnDocument(180), "main");
  const partial = async (shutter) => {
    const [still] = await renderStills(scene, [0.05], { width: 800, previewBlur: true, shutter });
    const image = await readImage(still.buffer);
    let count = 0;
    for (let y = 0; y < image.height; y += 2) for (let x = 0; x < image.width; x += 2) { const value = image.pixel(x, y)[0]; if (value > 24 && value < 220) count += 1; }
    return count;
  };
  const sharp = await partial({});
  const smeared = await partial(sceneShutterOptions(scene));
  assert.ok(smeared > sharp * 4, `grey pixels: ${sharp} sharp, ${smeared} with the shutter`);
});

test("a fast move says once that motion blur is off, and turning the shutter on says what it does", () => {
  const before = turnDocument();
  const after = turnDocument();
  const note = shutterNote(before, after, [], ["bar.turn"]);
  assert.match(note, /^motion blur is off: project \{shutterAngle:180\} shows the smear/);
  assert.equal(shutterNote(before, after, [], []), null, "an edit that made no fast move says nothing");
  assert.match(shutterNote(before, after, [{ type: "move", name: "whip-pan" }], []), /motion blur is off/);
  assert.match(shutterNote(before, turnDocument(180), [], ["bar.turn"]), /^shutterAngle 180: look frames, sheets and draft renders draw motion blur, up to 6 moments/);
  assert.equal(shutterNote(before, turnDocument(0), [], ["bar.turn"]), null, "0 is off on purpose");
});
