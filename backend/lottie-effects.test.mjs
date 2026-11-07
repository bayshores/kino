import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

const sourcePng = new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><rect width="20" height="20" fill="#f00"/><rect x="20" width="20" height="20" fill="#0f0"/><rect x="40" width="20" height="20" fill="#00f"/></svg>',
).render().asPng();
const sourceImage = `data:image/png;base64,${sourcePng.toString("base64")}`;

const shadow = {
  x: -12,
  y: 18,
  blur: 14,
  color: "#3366ff59",
};

function scene(layers, overrides = {}) {
  return createScene({
    id: "effects-test-scene",
    name: "Effects test",
    width: 640,
    height: 360,
    duration: 1,
    background: "transparent",
    layers,
    ...overrides,
  });
}

async function exportLottie(document, options = {}) {
  const before = structuredClone(document);
  const result = await exportScene(document, {
    format: "lottie",
    fps: 4,
    imageDPIRatio: "original",
    ...options,
  });
  assert.deepEqual(document, before, "Lottie export leaves the source document unchanged");
  return {
    animation: JSON.parse(result.buffer.toString("utf8")),
    warnings: result.warnings ?? [],
  };
}

function assetFor(animation, layer) {
  const asset = animation.assets.find((item) => item.id === layer.refId);
  assert.ok(asset, `missing asset for ${layer.nm}`);
  return asset;
}

function lottieLayers(animation) {
  const seen = new Set();
  const result = [];
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      result.push(layer);
      if (layer.ty !== 0 || !layer.refId || seen.has(layer.refId)) continue;
      seen.add(layer.refId);
      visit(assetFor(animation, layer).layers);
    }
  };
  visit(animation.layers);
  return result;
}

function staticValue(property) {
  assert.equal(property?.a, 0, "expected a static Lottie property");
  return property.k;
}

function effectOn(layer, type) {
  const effect = layer.ef?.find((entry) => entry.ty === type);
  assert.ok(effect, `missing Lottie effect type ${type} on ${layer.nm}`);
  return effect;
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: expected ${expected}, received ${actual}`);
}

function closeArray(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message} has the expected dimensions`);
  actual.forEach((value, index) => close(value, expected[index], `${message} dimension ${index + 1}`));
}

// Read the native Lottie transform for these static, uniformly scaled fixtures.
// Compose the exported wrappers as a player does, rather than inspecting one
// wrapper in isolation: the regression applied the same placement twice.
function transformMatrix(transform, read = staticValue) {
  const position = read(transform.p), anchor = read(transform.a);
  const scale = read(transform.s), angle = read(transform.r) * Math.PI / 180;
  close(transform.sk ? read(transform.sk) : 0, 0, "fixture has no shear");
  const a = Math.cos(angle) * scale[0] / 100, b = Math.sin(angle) * scale[0] / 100;
  const c = -Math.sin(angle) * scale[1] / 100, d = Math.cos(angle) * scale[1] / 100;
  return [a, b, c, d, position[0] - a * anchor[0] - c * anchor[1], position[1] - b * anchor[0] - d * anchor[1]];
}

test("aligned strokes with effects keep one placement and opacity through every composition", async () => {
  const { layerMatrix, multiply } = await import("../engine/geometry.js");
  for (const [type, rotation, scale] of [["rectangle", 0, 1], ["text", 23, 0.8], ["rectangle", 0, 0.00001]]) {
    const layer = createLayer(type, {
      id: "outlined", name: "Outlined", x: 65, y: 40, width: 140, height: 70,
      text: "Outline", textResize: "fixed", fontSize: 40, rotation,
      scaleX: scale, scaleY: scale, opacity: 0.4, fill: "#123456",
      stroke: "#ff9900", strokeWidth: 3, strokeAlign: "outside", shadow,
    });
    const { animation } = await exportLottie(scene([layer]));
    const outer = animation.layers.find((item) => item.nm === "Outlined");
    const inner = assetFor(animation, outer).layers[0];
    const drawings = assetFor(animation, inner).layers;
    assert.ok(drawings.some((item) => item.td === 1), "aligned stroke retains its matte");
    for (const drawing of drawings) {
      const actual = multiply(multiply(transformMatrix(outer.ks), transformMatrix(inner.ks)), transformMatrix(drawing.ks));
      closeArray(actual, layerMatrix(layer), `${type} placement at scale ${scale}`);
      close(staticValue(outer.ks.o) * staticValue(inner.ks.o) * staticValue(drawing.ks.o) / 1_000_000,
        layer.opacity, "opacity is applied once");
    }
  }
});

// These fixtures have linear transforms. Read the exported properties between
// keyframes, as Lottie players do with subframes enabled by default.
function linearValueAt(property, frame) {
  if (property.a === 0) return property.k;
  const keys = property.k;
  let index = 0;
  while (index + 1 < keys.length && keys[index + 1].t <= frame) index++;
  const key = keys[index], next = keys[index + 1];
  const progress = !next || key.h ? 0 : (frame - key.t) / (next.t - key.t);
  const values = key.s.map((value, part) => value + ((key.e ?? next?.s ?? key.s)[part] - value) * progress);
  return values.length === 1 ? values[0] : values;
}

test("aligned stroke effects keep scale and rotation between frames, including Counter compositions", async () => {
  const { layerMatrix, multiply } = await import("../engine/geometry.js");
  const { evaluateLayer } = await import("../engine/animation.js");
  for (const kind of ["rectangle", "text", "counter"]) {
    const layer = createLayer(kind === "rectangle" ? "rectangle" : "text", {
      id: "scaled", name: "Scaled", x: 80, y: 60, width: 140, height: 70,
      text: "Count 1", textResize: "fixed", fontSize: 32, opacity: 0.4,
      fill: "#123456", stroke: "#ff9900", strokeWidth: 3, strokeAlign: "outside", shadow,
      animations: [
        { id: "scale", name: "Scale", kind: "custom", start: 0, duration: 1, easing: "linear",
          from: { scaleX: 1, scaleY: 1, rotation: 0 }, to: { scaleX: 2, scaleY: 2, rotation: 90 } },
        ...(kind === "counter" ? [{ id: "count", name: "Counter", kind: "counter", start: 0.25,
          duration: 0.5, easing: "linear", from: 1, to: 2, step: 1, in: null, out: null }] : []),
      ],
    });
    const { animation } = await exportLottie(scene([layer]));
    for (const frame of [0.5, 1.5, 2.5, 3.5]) {
      const active = animation.layers.filter((item) => item.ef && item.ip <= frame && item.op > frame);
      assert.equal(active.length, 1, `${kind} has one active drawing at ${frame}`);
      const outer = active[0];
      const inner = assetFor(animation, outer).layers[0];
      const read = (property) => linearValueAt(property, frame);
      for (const drawing of assetFor(animation, inner).layers) {
        const actual = multiply(multiply(transformMatrix(outer.ks, read), transformMatrix(inner.ks)), transformMatrix(drawing.ks));
        closeArray(actual, layerMatrix(evaluateLayer(layer, frame / animation.fr)), `${kind} at fractional frame ${frame}`);
      }
    }
  }
});

test("real Lottie export keeps native shadow and blur units, padded bounds, image crop, and vector geometry", async () => {
  const shape = createLayer("rectangle", {
    id: "shadow-shape",
    name: "Shadow Shape",
    x: 10,
    y: 10,
    width: 300,
    height: 300,
    fill: "#20a050",
    stroke: "none",
    shadow,
    blur: 6,
  });
  const image = createLayer("image", {
    id: "cropped-image",
    name: "Cropped Image",
    x: 330,
    y: 10,
    width: 300,
    height: 300,
    src: sourceImage,
    shadow,
    blur: 6,
  });
  const { animation, warnings } = await exportLottie(scene([shape, image]));
  assert.deepEqual(warnings, []);

  const expectedPadding = Math.hypot(-12, 18) + 2 * 14 + 6;
  const expectedSize = 300 + expectedPadding * 2;
  const shapeWrapper = animation.layers.find((layer) => layer.nm === shape.name);
  const imageWrapper = animation.layers.find((layer) => layer.nm === image.name);
  assert.ok(shapeWrapper?.ef, "shape effects are emitted on a native precomposition layer");
  assert.ok(imageWrapper?.ef, "image effects are emitted on a native precomposition layer");
  close(shapeWrapper.w, expectedSize, "effect wrapper expands the 300px shape by local effect padding");
  close(shapeWrapper.h, expectedSize, "effect wrapper expands the 300px shape by local effect padding");

  const shadowEffect = effectOn(shapeWrapper, 25);
  assert.deepEqual(shadowEffect.ef.map((parameter) => parameter.ty), [2, 0, 1, 0, 0]);
  const [color, opacity, direction, distance, softness] = shadowEffect.ef;
  staticValue(color.v).forEach((channel, index) => close(channel, [51 / 255, 102 / 255, 1][index], "shadow RGB channel"));
  assert.equal(staticValue(opacity.v), 89, "35% shadow alpha is represented on Lottie's 0–255 scale");
  close(staticValue(direction.v), Math.atan2(18, -12) * 180 / Math.PI + 90 - 360, "shadow direction in degrees");
  close(staticValue(distance.v), Math.hypot(-12, 18), "shadow distance in Lottie units");
  assert.equal(staticValue(softness.v), 28, "14px shadow blur maps to 28 softness units");

  const blurEffect = effectOn(shapeWrapper, 29);
  assert.equal(blurEffect.ef[0].ty, 0);
  assert.equal(staticValue(blurEffect.ef[0].v), 10, "6px layer blur maps to 10 Lottie radius units");
  assert.equal(staticValue(blurEffect.ef[1].v), 1, "Gaussian blur includes both dimensions");
  assert.equal(staticValue(blurEffect.ef[2].v), 0, "Gaussian blur does not repeat edge pixels");

  const shapeEffectAsset = assetFor(animation, shapeWrapper);
  const vectorContent = shapeEffectAsset.layers.find((layer) => layer.nm !== "Effect bounds");
  assert.equal(vectorContent.ty, 4, "the effect precomposition retains a native vector layer");
  assert.ok(vectorContent.shapes.some((group) => group.it?.some((item) => item.ty === "rc")), "the rectangle stays editable vector geometry");
  assert.equal(animation.assets.filter((asset) => asset.p).length, 1, "only the real image is raster data");

  const imageEffectAsset = assetFor(animation, imageWrapper);
  const clippedContent = imageEffectAsset.layers.find((layer) => layer.nm !== "Effect bounds");
  assert.equal(clippedContent.hasMask, true, "the image crop mask stays inside the effects precomposition");
  assert.deepEqual(clippedContent.masksProperties[0].pt.k.v, [[0, 0], [300, 0], [300, 300], [0, 300]]);
  const cropAsset = assetFor(animation, clippedContent);
  const croppedImageLayer = cropAsset.layers.find((layer) => layer.ty === 2);
  assert.ok(croppedImageLayer, "the crop precomposition contains the source image layer");
  close(croppedImageLayer.ks.p.k[0], -300, "cover fit centers the source image horizontally before clipping");
  close(croppedImageLayer.ks.p.k[1], 0, "cover fit does not add vertical letterboxing");
  assert.deepEqual(
    [animation.assets.find((asset) => asset.id === croppedImageLayer.refId).w, animation.assets.find((asset) => asset.id === croppedImageLayer.refId).h],
    [60, 20],
    "the crop uses the original 60×20 bitmap rather than rasterizing its layer bounds",
  );
});

test("nested parent and child effects keep their local transforms and apply opacity once", async () => {
  const parent = createLayer("group", {
    id: "effect-parent",
    name: "Effect Parent",
    x: 40,
    y: 25,
    width: 180,
    height: 120,
    rotation: 27,
    scaleX: 1.6,
    scaleY: 0.55,
    opacity: 0.6,
    blur: 2,
    shadow: { ...shadow, blur: 3, color: "rgba(0, 0, 0, 0.25)" },
  });
  const child = createLayer("rectangle", {
    id: "effect-child",
    name: "Effect Child",
    parentId: parent.id,
    x: 12,
    y: 15,
    width: 70,
    height: 40,
    rotation: -18,
    scaleX: 0.8,
    scaleY: 1.4,
    opacity: 0.5,
    fill: "#20a050",
    stroke: "none",
    blur: 4,
    shadow,
  });
  const { animation } = await exportLottie(scene([parent, child]));
  const parentWrapper = animation.layers.find((layer) => layer.nm === parent.name);
  assert.ok(parentWrapper?.ef, "parent group keeps its effects on an outer native layer");
  closeArray(parentWrapper.ks.s.k, [160, 55, 100], "the parent's nonuniform scale");
  close(parentWrapper.ks.r.k, 27, "the parent's rotation remains on its outer effects wrapper");
  assert.equal(parentWrapper.ks.o.k, 60, "the parent's opacity is applied once on its outer wrapper");

  const parentEffectAsset = assetFor(animation, parentWrapper);
  const parentContent = parentEffectAsset.layers.find((layer) => layer.nm !== "Effect bounds");
  assert.equal(parentContent.ks.o.k, 100, "parent opacity is not repeated on the effect content");
  closeArray(parentContent.ks.s.k, [100, 100, 100], "the parent's content reset scale");
  assert.equal(parentContent.ks.r.k, 0);

  const groupAsset = assetFor(animation, parentContent);
  const childWrapper = groupAsset.layers.find((layer) => layer.nm === child.name);
  assert.ok(childWrapper?.ef, "child effects remain inside the parent composition");
  closeArray(childWrapper.ks.s.k, [80, 140, 100], "the child's nonuniform local scale");
  close(childWrapper.ks.r.k, -18, "the child's rotation stays local to its parent composition");
  assert.equal(childWrapper.ks.o.k, 50, "the child's opacity remains separate from the parent opacity");
  const childPadding = child.blur + Math.hypot(shadow.x, shadow.y) + 2 * shadow.blur;
  close(childWrapper.w, child.width + 2 * childPadding, "child effects pad the untransformed local width before scale and rotation");
  close(childWrapper.h, child.height + 2 * childPadding, "child effects pad the untransformed local height before scale and rotation");

  const childEffectAsset = assetFor(animation, childWrapper);
  const childContent = childEffectAsset.layers.find((layer) => layer.nm !== "Effect bounds");
  assert.equal(childContent.ks.o.k, 100, "child opacity is not repeated on the effect content");
  closeArray(childContent.ks.s.k, [100, 100, 100], "the child's content reset scale");
  assert.equal(childContent.ks.r.k, 0);
  assert.equal(childContent.ef, undefined, "shadow and blur are not applied a second time inside the wrapper");
});

test("per-letter blur remains staggered in actual exported Lottie keyframes", async () => {
  const caption = createLayer("text", {
    id: "letter-blur",
    name: "Letter Blur",
    x: 10,
    y: 10,
    width: 160,
    height: 40,
    text: "AB",
    fontSize: 28,
    lineHeight: 1.2,
    textResize: "width-height",
    blur: 0,
    animations: [{
      id: "staggered-blur",
      name: "Staggered blur",
      kind: "in",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { blur: 12 },
      to: { blur: 0 },
      unit: "letters",
      stagger: 0.25,
      order: "forward",
    }],
  });
  const { animation } = await exportLottie(scene([caption]), { fps: 4, duration: 1 });
  const letters = lottieLayers(animation)
    .filter((layer) => layer.nm === caption.name && layer.ef?.some((effect) => effect.ty === 29))
    .sort((left, right) => left.ind - right.ind);
  assert.equal(letters.length, 2, "text exports as two independently animated letter layers");
  const blurFrames = letters.map((layer) => effectOn(layer, 29).ef[0].v.k.map((frame) => frame.s[0]));
  assert.deepEqual(blurFrames[0], [20, 15, 10, 5, 0], "the first glyph starts its blur animation immediately");
  assert.deepEqual(blurFrames[1], [20, 20, 15, 10, 5], "the second glyph keeps its quarter-second stagger");
});

test("visible blend layers warn once and export as normal while hidden-parent blends stay silent", async () => {
  const multiply = createLayer("rectangle", {
    id: "multiply",
    name: "Multiply",
    x: 10,
    y: 10,
    width: 40,
    height: 30,
    blendMode: "multiply",
  });
  const screen = createLayer("ellipse", {
    id: "screen",
    name: "Screen",
    x: 60,
    y: 10,
    width: 40,
    height: 30,
    blendMode: "screen",
  });
  const visible = await exportLottie(scene([multiply, screen]));
  assert.deepEqual(visible.warnings.map(({ code }) => code), ["lottie-blend-mode-normalized"]);
  assert.deepEqual(
    visible.animation.layers.filter((layer) => [multiply.name, screen.name].includes(layer.nm)).map((layer) => layer.bm),
    [0, 0],
    "visible Multiply and Screen layers use normal Lottie blending",
  );

  const hiddenParent = createLayer("group", {
    id: "hidden-parent",
    name: "Hidden Parent",
    visible: false,
  });
  const hiddenBlend = createLayer("rectangle", {
    id: "hidden-multiply",
    name: "Hidden Multiply",
    parentId: hiddenParent.id,
    blendMode: "multiply",
  });
  const hidden = await exportLottie(scene([hiddenParent, hiddenBlend]));
  assert.deepEqual(hidden.warnings, [], "an unrendered blend layer does not produce a warning");
  assert.deepEqual(hidden.animation.layers, [], "hidden-parent content is omitted from the export");
});
