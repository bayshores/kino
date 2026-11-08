// A custom animation with keys: 3 or more {t, value, ease?}, t a share of the duration.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "./animation.js";
import { animationProblem, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { renderSceneSvg } from "./render.js";

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
