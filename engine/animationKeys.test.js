// A custom animation with keys: 3 or more {t, value, ease?}, t a share of the duration.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "./animation.js";
import { animationProblem, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { renderSceneSvg } from "./render.js";
import { carryAnimations, shiftAnimation } from "./animationShift.js";
import { defaultFonts } from "./fonts.js";
import { runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";

const keyed = (keys, extra = {}) => ({ id: "k", name: "Keys", kind: "custom", start: 1, duration: 2, easing: "linear", from: {}, to: {}, keys, ...extra });

function parsed(layer) {
  const scene = createScene({ id: "s", name: "S", width: 400, height: 300, duration: 4, layers: [layer] });
  return parseDocument(createDocument({ scenes: [scene] })).scenes[0].layers[0];
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("three keys move x and opacity through the middle key with per-key eases", () => {
  const layer = parsed(createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 50, height: 50, animations: [keyed([
    { t: 0, value: { x: 0, opacity: 0 } },
    { t: 0.5, value: { x: 100, opacity: 1 }, ease: "ease-in" },
    { t: 1, value: { x: 40, opacity: 0.5 } },
  ])] }));
  const saved = layer.animations[0];
  assert.deepEqual(saved.from, { x: 0, opacity: 0 });
  assert.deepEqual(saved.to, { x: 40, opacity: 0.5 });
  const at = (time) => evaluateLayer(layer, time);
  close(at(0.5).x, 0); // before the start a custom animation leaves the layer alone
  close(at(1.5).x, 50); // linear first step, halfway
  close(at(1.5).opacity, 0.5);
  close(at(2).x, 100); // the middle key
  assert.ok(at(2.5).x > 70, "ease-in leaves the middle key slowly"); // linear would be 70
  close(at(3).x, 40);
  close(at(3.9).opacity, 0.5); // holds the last key after the end
});

test("keys after 0 and before 1 hold the first and last values inside the animation", () => {
  const layer = parsed(createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 50, height: 50, animations: [keyed([
    { t: 0.25, value: { x: 10 } }, { t: 0.5, value: { x: 20 } }, { t: 0.75, value: { x: 30 } },
  ])] }));
  close(evaluateLayer(layer, 1.2).x, 10);
  close(evaluateLayer(layer, 2.75).x, 30);
});

test("keys animate an effect preset's parameter", () => {
  const value = (pixelSize, progress) => ({ effectPreset: { id: "pixel", parameters: { pixelSize }, progress } });
  const layer = parsed(createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 50, height: 50, animations: [keyed([
    { t: 0, value: value(4, 0) }, { t: 0.5, value: value(64, 0.5) }, { t: 1, value: value(8, 1) },
  ])] }));
  close(evaluateLayer(layer, 1.5).effectPreset.parameters.pixelSize, 34);
  close(evaluateLayer(layer, 2.5).effectPreset.parameters.pixelSize, 36);
  assert.ok(renderSceneSvg(createScene({ id: "s", name: "S", width: 400, height: 300, duration: 4, layers: [layer] }), 2.5).includes("<svg"));
});

test("bad keys are refused with the field that is wrong", () => {
  const layer = createLayer("rectangle", { id: "r", name: "R" });
  assert.match(animationProblem(keyed([{ t: 0, value: { x: 0 } }, { t: 1, value: { x: 1 } }]), layer), /3 or more keys/);
  assert.match(animationProblem(keyed([{ t: 0, value: { x: 0 } }, { t: 0, value: { x: 1 } }, { t: 1, value: { x: 2 } }]), layer), /keys\[1\]\.t/);
  assert.match(animationProblem(keyed([{ t: 0, value: { x: 0 } }, { t: 0.5, value: { y: 1 } }, { t: 1, value: { x: 2 } }]), layer), /same properties/);
  assert.match(animationProblem(keyed([{ t: 0, value: { x: 0 } }, { t: 0.5, value: { x: 1 }, ease: "nope" }, { t: 1, value: { x: 2 } }]), layer), /keys\[1\]\.ease/);
  assert.match(animationProblem({ ...keyed([{ t: 0, value: { x: 0 } }, { t: 0.5, value: { x: 1 } }, { t: 1, value: { x: 2 } }]), kind: "in" }, layer), /only a custom/);
});

test("an animation without keys renders exactly as before", () => {
  const plain = { id: "p", name: "Move", kind: "custom", start: 0, duration: 1, easing: "smooth", from: { x: 0 }, to: { x: 100 } };
  const layer = parsed(createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 50, height: 50, animations: [plain] }));
  assert.equal(Object.hasOwn(layer.animations[0], "keys"), false);
  const scene = createScene({ id: "s", name: "S", width: 400, height: 300, duration: 2, layers: [layer] });
  const svg = renderSceneSvg(scene, 0.4);
  const twoKeyed = parsed(createLayer("rectangle", { id: "r", name: "R", x: 0, y: 0, width: 50, height: 50, animations: [plain] }));
  assert.equal(renderSceneSvg({ ...scene, layers: [twoKeyed] }, 0.4), svg);
});

test("Lottie export samples the keys frame by frame through the middle key", async () => {
  const { exportScene } = await import("../backend/export.mjs");
  const layer = parsed(createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 10, width: 20, height: 20, fill: "#ff0000", strokeWidth: 0, animations: [
    keyed([{ t: 0, value: { opacity: 0 } }, { t: 0.5, value: { opacity: 1 } }, { t: 1, value: { opacity: 0 } }], { start: 0 }),
  ] }));
  const scene = createScene({ id: "s", name: "S", width: 80, height: 60, duration: 2, background: "#ffffff", layers: [layer] });
  const out = await exportScene(scene, { format: "lottie", fps: 4, width: 80, height: 60 });
  const box = JSON.parse(out.buffer.toString("utf8")).layers.find((item) => item.nm === "Box");
  const values = box.ks.o.k.map((key) => key.s[0]);
  assert.deepEqual(values, [0, 25, 50, 75, 100, 75, 50, 25, 0]);
});

test("moving a layer moves every key of its keyed animation, and old animations are kept as they are", () => {
  const layer = parsed(createLayer("rectangle", { id: "a", x: 10, y: 20, width: 40, height: 40,
    animations: [keyed([{ t: 0, value: { x: 0 } }, { t: 0.5, value: { x: 100 } }, { t: 1, value: { x: 50 } }])] }));
  const shifted = shiftAnimation(layer.animations[0], 5, 7);
  assert.deepEqual(shifted.keys.map((key) => key.value.x), [5, 105, 55]);
  assert.deepEqual([shifted.from, shifted.to], [{ x: 5 }, { x: 55 }]);
  const carried = carryAnimations(layer.animations, { x: 10, y: 20 }, { x: 30, y: 20 });
  assert.deepEqual(carried[0].keys.map((key) => key.value.x), [20, 120, 70]);
  const plain = { id: "p", kind: "custom", start: 0, duration: 1, from: { opacity: 0 }, to: { opacity: 1 } };
  assert.equal(shiftAnimation(plain, 5, 7), plain);
  assert.equal(carryAnimations([plain], { x: 0, y: 0 }, { x: 9, y: 0 })[0], plain);
});

test("every data quality rule runs on keyed x, opacity, scale and rotation animations without a checker error", async () => {
  const keys = (name, values) => values.map((value, index) => ({ t: index / (values.length - 1), value: { [name]: value } }));
  const layer = createLayer("rectangle", { id: "a", x: 10, y: 20, width: 80, height: 60, fill: "#e0e0e0", animations: [
    keyed(keys("x", [0, 200, 120, 300])), { ...keyed(keys("opacity", [0, 1, 0.4])), id: "o" },
    { ...keyed(keys("scaleX", [1, 1.4, 0.9, 1])), id: "s", start: 2 }, { ...keyed(keys("rotation", [0, 30, -10])), id: "r", start: 0.5 }] });
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "S", width: 400, height: 300, duration: 4, background: "#202020", layers: [layer] })] }));
  const { findings } = await runQuality(kinoTimeline(document, "s", { fonts: defaultFonts }), { pixels: false });
  assert.deepEqual(findings.filter((finding) => finding.internal).map((finding) => finding.message), []);
});

test("grouping, ungrouping, a group resize and a light-sweep band move every key too", async () => {
  const { applyOperations } = await import("./operations.js");
  const { worldMatrix, point } = await import("./geometry.js");
  const { resizeGroup } = await import("./groupResize.js");
  const xs = [{ t: 0, value: { x: 100 } }, { t: 0.5, value: { x: 300 } }, { t: 1, value: { x: 200 } }];
  const docOf = (layers) => parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "S", width: 800, height: 600, duration: 3, layers })] }));
  const worldX = (doc) => [1, 2, 3].map((time) => {
    const states = doc.scenes[0].layers.map((layer) => evaluateLayer(layer, time));
    return point(worldMatrix(states.find((state) => state.id === "r"), states), 0, 0).x;
  });
  const doc = docOf([createLayer("rectangle", { id: "r", name: "Box", x: 100, y: 100, width: 50, height: 50, animations: [keyed(xs)] }),
    createLayer("rectangle", { id: "o", name: "Other", x: 300, y: 300, width: 50, height: 50 })]);
  const grouped = docOf(applyOperations(doc, [{ type: "group_layers", sceneId: "s", layerIds: ["r", "o"], groupId: "g" }]).scenes[0].layers);
  assert.deepEqual(worldX(grouped), worldX(doc));
  assert.deepEqual(worldX(grouped), [100, 300, 200]);
  const ungrouped = docOf(applyOperations(grouped, [{ type: "ungroup_layer", sceneId: "s", layerId: "g" }]).scenes[0].layers);
  assert.deepEqual(worldX(ungrouped), [100, 300, 200]);

  // Twice as wide: the plain child's from/to and the keyed child's keys both double.
  const inGroup = docOf([createLayer("group", { id: "g", name: "G", x: 0, y: 0, width: 400, height: 200 }),
    createLayer("rectangle", { id: "c", name: "C", parentId: "g", x: 100, y: 50, width: 50, height: 50, animations: [keyed(xs)] })]).scenes[0].layers;
  const changes = resizeGroup(inGroup, "g", { x: 0, y: 0, width: 800, height: 200 });
  const stretched = docOf(inGroup.map((layer) => ({ ...layer, ...(changes.find((change) => change.id === layer.id) ?? {}) }))).scenes[0].layers[1].animations[0];
  assert.deepEqual(stretched.keys.map((key) => key.value.x), [200, 600, 400]);
  assert.deepEqual([stretched.from.x, stretched.to.x], [200, 400]);

  // The band of a light-sweep on a keyed picture keeps its offset after a save.
  const { styleFor } = await import("./blocks/looks.js");
  const { readMoveInput, runMove } = await import("./blocks/move.js");
  const { MOVES } = await import("./blocks/moves/index.js");
  const logo = docOf([createLayer("image", { id: "logo", x: 800, y: 400, width: 300, height: 300, src: "/api/media/logo.png", animations: [keyed(
    [{ t: 0, value: { x: 800, opacity: 1 } }, { t: 0.5, value: { x: 1000, opacity: 1 } }, { t: 1, value: { x: 900, opacity: 1 } }], { start: 0 })] })]).scenes[0].layers[0];
  const scene = createScene({ id: "s", name: "S", width: 1920, height: 1080, duration: 6, layers: [logo] });
  const result = runMove(MOVES["light-sweep"], { id: "m", input: readMoveInput(MOVES["light-sweep"], { layer: "logo", angle: 20 }), scene,
    style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.5, dur: null, reduced: false, media: () => null });
  const band = result.added.find((entry) => entry.layer.move.part === "overlay-paint").layer;
  const follow = docOf([{ ...band, parentId: null }]).scenes[0].layers[0].animations.find((animation) => animation.id.includes("follow"));
  const dx = band.x - 800;
  assert.deepEqual(follow.keys.map((key) => key.value), [{ x: 800 + dx }, { x: 1000 + dx }, { x: 900 + dx }]);
  assert.deepEqual([follow.from, follow.to], [{ x: 800 + dx }, { x: 900 + dx }]);
});
