import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, parseDocument } from "../engine/model.js";
import { createMask } from "../engine/masking.js";
import { applyOperations } from "../engine/operations.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { readImage } from "./media.test.support.mjs";

// A white square mask (25..75) over a red layer, on a white background, as a mask group.
function scene(group = {}, mask = {}) {
  const document = createDocument();
  const base = Object.assign(document.scenes[0], { width: 100, height: 100, background: "#ffffff", duration: 1 });
  const box = (id, values) => createLayer("rectangle", { id, name: id, x: 0, y: 0, width: 100, height: 100, ...values });
  base.layers = [box("square", { x: 25, y: 25, width: 50, height: 50, fill: "#ffffff", ...mask }), box("red", { fill: "#ff0000" })];
  const { layers } = createMask(document, base.id, ["square", "red"], { id: "masked" });
  return { ...base, layers: layers.map((layer) => (layer.id === "masked" ? { ...layer, ...group } : layer)) };
}
const png = async (s) => readImage((await exportScene(s, { format: "png", time: 0 })).buffer);
const close = (actual, expected) => assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= 2), `${actual} is not ${expected}`);

test("maskInvert swaps the inside and outside of a mask", async () => {
  const plain = await png(scene());
  close(plain.pixel(50, 50), [255, 0, 0, 255]);
  close(plain.pixel(10, 10), [255, 255, 255, 255]);
  const inverted = await png(scene({ maskInvert: true }));
  close(inverted.pixel(50, 50), [255, 255, 255, 255]);
  close(inverted.pixel(10, 10), [255, 0, 0, 255]);
  // On the mask layer itself it works the same, and the group's false wins over it.
  close((await png(scene({}, { maskInvert: true }))).pixel(10, 10), [255, 0, 0, 255]);
  close((await png(scene({ maskInvert: false }, { maskInvert: true }))).pixel(10, 10), [255, 255, 255, 255]);
});

test("an inverted mask with opacity or blur exports as 1 - the mask", async () => {
  // These crashed the raster worker when the inverted mask nested the plain one.
  const green = async (group, mask) => (await png(scene(group, mask))).pixel(50, 50)[1];
  for (const maskMode of ["luminance", "alpha"]) {
    assert.ok(Math.abs(await green({ maskInvert: true, maskMode }, { opacity: 0.5 }) - 128) <= 2, maskMode);
    const edge = async (group) => (await png(scene(group, { blur: 6 }))).pixel(26, 50)[1];
    assert.ok(Math.abs((await edge({ maskMode })) + (await edge({ maskInvert: true, maskMode })) - 255) <= 3, maskMode);
  }
  // A gray mask: luminance halves, alpha (opaque gray) hides it all.
  assert.ok(Math.abs(await green({ maskInvert: true }, { fill: "#808080" }) - 128) <= 2);
  assert.equal(await green({ maskInvert: true, maskMode: "alpha" }, { fill: "#808080" }), 255);
});

test("maskMode alpha lets a picture's transparent hole through", async () => {
  // A white picture with a see-through hole (40..60) masks a red layer.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill-rule="evenodd" fill="white" d="M0 0H100V100H0Z M40 40V60H60V40Z"/></svg>';
  const src = `data:image/png;base64,${new Resvg(svg).render().asPng().toString("base64")}`;
  const picture = (group) => {
    const s = scene(group);
    s.layers = s.layers.map((layer) => (layer.id === "square" ? createLayer("image", { ...layer, type: "image", src, x: 0, y: 0, width: 100, height: 100 }) : layer));
    return s;
  };
  const alpha = await png(picture({ maskMode: "alpha" }));
  close(alpha.pixel(10, 10), [255, 0, 0, 255]);
  close(alpha.pixel(50, 50), [255, 255, 255, 255]);
  const cut = await png(picture({ maskMode: "alpha", maskInvert: true }));
  close(cut.pixel(50, 50), [255, 0, 0, 255], "inverted, only the hole shows");
  close(cut.pixel(10, 10), [255, 255, 255, 255]);
});

test("a mask without the new fields draws the same markup and Lottie matte as before", async () => {
  const s = scene();
  const svg = renderSceneSvg(s, 0);
  assert.match(svg, /<mask id="[^"]+" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" style="mask-type:luminance"><rect x="-100000" y="-100000" width="200000" height="200000" fill="black"\/>/);
  assert.equal(svg, renderSceneSvg(scene({ maskInvert: false, maskMode: "luminance" }), 0));
  assert.equal((svg.match(/<mask /g) ?? []).length, 1);
  const tt = async (group) => {
    const data = JSON.parse((await exportScene(scene(group), { format: "lottie", fps: 4 })).buffer.toString());
    const content = data.assets.find((item) => item.id === data.layers.find((item) => item.nm === "Mask group").refId).layers;
    return content.find((item) => item.tt).tt;
  };
  assert.deepEqual([await tt({}), await tt({ maskInvert: true }), await tt({ maskMode: "alpha" }), await tt({ maskMode: "alpha", maskInvert: true })], [3, 4, 1, 2]);
});

test("the fields are checked and reach only masks", () => {
  const document = createDocument();
  document.scenes[0].layers = scene().layers;
  assert.throws(() => parseDocument(JSON.stringify({ ...document, scenes: [{ ...document.scenes[0], layers: scene({ maskMode: "soft" }).layers }] })), /maskMode/);
  const sceneId = document.scenes[0].id;
  const edited = applyOperations(document, [{ type: "update_layer", sceneId, layerId: "masked", properties: { maskInvert: true, maskMode: "alpha" } }]);
  assert.deepEqual(["maskInvert", "maskMode"].map((key) => edited.scenes[0].layers.find((layer) => layer.id === "masked")[key]), [true, "alpha"]);
  assert.throws(() => applyOperations(document, [{ type: "update_layer", sceneId, layerId: "red", properties: { maskInvert: true } }]), /mask layer or a mask group/);
  const made = createDocument();
  made.scenes[0].layers = ["a", "b"].map((id) => createLayer("rectangle", { id, name: id }));
  const masked = applyOperations(made, [{ type: "create_mask", sceneId: made.scenes[0].id, layerIds: ["a", "b"], groupId: "g", maskInvert: true }]);
  assert.equal(masked.scenes[0].layers.find((layer) => layer.id === "g").maskInvert, true);
});

test("the quality checks see an inverted mask's layers outside the mask", async () => {
  const { kinoTimeline } = await import("../engine/quality/kinoTimeline.js");
  const { visibleBoxAt } = await import("../engine/quality/model.js");
  const { runDataQuality } = await import("../engine/quality/index.js");
  // A small square in the corner masks a title well away from it.
  const check = (maskInvert) => {
    const document = createDocument();
    const s = Object.assign(document.scenes[0], { width: 960, height: 540, duration: 3 });
    s.layers = [
      createLayer("rectangle", { id: "dot", name: "dot", x: 0, y: 0, width: 60, height: 60, fill: "#ffffff" }),
      createLayer("text", { id: "title", name: "title", x: 200, y: 220, text: "Launch day", fontSize: 90, fill: "#ffffff", textResize: "width-height" }),
    ];
    const edited = applyOperations(document, [{ type: "create_mask", sceneId: s.id, layerIds: ["dot", "title"], maskLayerId: "dot", groupId: "g", maskInvert }]);
    const model = kinoTimeline(edited, s.id, { fps: 10 });
    const box = visibleBoxAt(model, model.items.find((item) => item.id === "title"), 5);
    const result = runDataQuality(model);
    return { width: box.x1 - box.x0, reading: (result.findings ?? result).some((f) => f.rule === "reading_time" && f.severity === "error") };
  };
  const plain = check(false);
  assert.ok(plain.width <= 0 && plain.reading, "a plain mask hides it");
  const inverted = check(true);
  assert.ok(inverted.width > 400, `${inverted.width}`);
  assert.equal(inverted.reading, false);
});
