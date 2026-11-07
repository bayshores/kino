import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { layerMatrix, multiply, parentMatrix, point } from "../engine/geometry.js";
import { textAnimationPlan, textAnimationUnitState } from "../engine/textAnimation.js";
import { exportScene } from "./export.mjs";
import { compositionBounds } from "./lottie-bounds.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();
const FPS = 4;
const TIMES = [0, 0.25, 0.5, 0.75, 1];

function clipAnimation(id, unit, from, to, extra = {}) {
  return {
    id,
    name: id,
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from,
    to,
    unit,
    stagger: 0,
    order: "forward",
    textAnchor: unit === "layer" ? "layer" : unit,
    textClip: true,
    ...extra,
  };
}

function scene(layers, { width = 180, height = 90 } = {}) {
  return createScene({
    id: "text-geometry-scene",
    name: "Text geometry",
    width,
    height,
    duration: 1,
    background: "transparent",
    layers,
  });
}

async function exportedLottie(input) {
  const result = await exportScene(input, { format: "lottie", fps: FPS }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

function allReferencedLayers(animation, startingLayers = animation.layers) {
  const assets = new Map((animation.assets ?? []).filter((asset) => Array.isArray(asset.layers)).map((asset) => [asset.id, asset]));
  const visited = new Set();
  const result = [];
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      result.push(layer);
      const asset = assets.get(layer.refId);
      if (asset && !visited.has(asset.id)) {
        visited.add(asset.id);
        visit(asset.layers);
      }
    }
  };
  visit(startingLayers);
  return result;
}

function textClipMasks(animation) {
  return allReferencedLayers(animation).flatMap((layer) =>
    (layer.masksProperties ?? [])
      .filter((mask) => mask.nm === "Text unit clipping mask")
      .map((mask) => ({ layer, mask })),
  );
}

function polygonAt(mask, frame) {
  const path = mask.pt;
  let shape;
  if (path.a === 0) shape = path.k;
  else {
    const keyframes = path.k;
    const keyframe = keyframes.find((item) => item.t === frame) ??
      [...keyframes].reverse().find((item) => item.t <= frame) ?? keyframes[0];
    shape = keyframe.s[0];
  }
  return shape.v;
}

function expectedClipPolygons(layer, sceneValue, time, parentMatrixOverride = null) {
  const plan = textAnimationPlan(layer, fonts);
  const matrix = parentMatrixOverride ?? parentMatrix(layer, sceneValue.layers,
    (ancestor) => evaluateLayer(ancestor, time, { fonts }));
  return plan.units.flatMap((_, unitIndex) =>
    (textAnimationUnitState(plan, unitIndex, time)._textClips ?? []).map((polygon) =>
      polygon.map(({ x, y }) => {
        const mapped = point(matrix, x, y);
        return [mapped.x, mapped.y];
      }),
    ),
  );
}

function assertPolygonsMatch(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: mask count`);
  const remaining = [...expected];
  for (const polygon of actual) {
    const match = remaining.findIndex((candidate) => candidate.length === polygon.length &&
      candidate.every(([x, y], index) => Math.abs(x - polygon[index][0]) < 1e-6 && Math.abs(y - polygon[index][1]) < 1e-6));
    assert.notEqual(match, -1, `${label}: exported polygon ${JSON.stringify(polygon)} must match shared text-unit geometry`);
    remaining.splice(match, 1);
  }
  assert.equal(remaining.length, 0, `${label}: every shared polygon is exported`);
}

function rgbaPixels(image) {
  const pixels = [];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) pixels.push(...image.pixel(x, y));
  return pixels;
}

function alphaCount(image) {
  let count = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.pixel(x, y)[3] > 0) count++;
  return count;
}

function visitObjects(value, predicate, found = []) {
  if (Array.isArray(value)) value.forEach((item) => visitObjects(item, predicate, found));
  else if (value && typeof value === "object") {
    if (predicate(value)) found.push(value);
    Object.values(value).forEach((item) => visitObjects(item, predicate, found));
  }
  return found;
}

function descendantsOf(animation, layer) {
  const referenced = allReferencedLayers(animation, [layer]).slice(1);
  return referenced;
}

test("PNG export clips text that starts fully offscreen and shows the complete text at its endpoint", async () => {
  const text = createLayer("text", {
    id: "masked-text",
    name: "Masked text",
    x: 24,
    y: 20,
    width: 120,
    height: 42,
    text: "MASK",
    fontSize: 30,
    fill: "#ffffff",
    animations: [clipAnimation("slide-clip", "layer", { x: -260 }, { x: 24 })],
  });
  const animated = scene([text]);
  const still = scene([createLayer("text", {
    id: "still-text", name: "Masked text", x: 24, y: 20, width: 120, height: 42,
    text: "MASK", fontSize: 30, fill: "#ffffff",
  })]);

  const start = await readImage((await exportScene(animated, { format: "png", time: 0 }, { fonts })).buffer);
  const end = await readImage((await exportScene(animated, { format: "png", time: 1 }, { fonts })).buffer);
  const expected = await readImage((await exportScene(still, { format: "png", time: 0 }, { fonts })).buffer);
  assert.equal(alphaCount(start), 0, "no text leaks into the scene while it is fully offscreen");
  assert.ok(alphaCount(end) > 0, "the mask reveals actual text by the endpoint");
  assert.deepEqual(rgbaPixels(end), rgbaPixels(expected), "the endpoint shows the complete static text");
});

test("Lottie per-unit clip vertices match shared geometry directly and through a mirrored animated group", async () => {
  const directText = createLayer("text", {
    id: "direct-text", name: "Direct", x: 18, y: 14, width: 120, height: 44,
    text: "ABC", fontSize: 27, fill: "#ffffff",
    animations: [clipAnimation("direct-clip", "letters", { x: -90 }, { x: 18 })],
  });
  const direct = scene([directText]);
  const directExport = await exportedLottie(direct);
  const directMasks = textClipMasks(directExport.animation);
  assert.equal(directMasks.length, 3, "one exported polygon mask for each shaped letter");
  for (const time of TIMES) {
    const frame = Math.round(time * FPS);
    assertPolygonsMatch(
      directMasks.map(({ mask }) => polygonAt(mask, frame)),
      expectedClipPolygons(directText, direct, time),
      `direct text at frame ${frame}`,
    );
  }

  const parent = createLayer("group", {
    id: "moving-parent", name: "Moving parent", x: 40, y: 16,
    width: 130, height: 70, scaleX: -1.2, scaleY: 0.85, rotation: 13,
    animations: [{
      id: "parent-motion", name: "Parent motion", kind: "custom", start: 0, duration: 1,
      easing: "linear", from: { x: 40 }, to: { x: 62 },
    }],
  });
  const child = createLayer("text", {
    id: "grouped-text", parentId: parent.id, name: "Grouped", x: 8, y: 12,
    width: 110, height: 42, text: "WXYZ", fontSize: 25, fill: "#ffffff",
    animations: [
      clipAnimation("layer-clip", "layer", { x: -120 }, { x: 8 }),
      clipAnimation("letter-clip", "letters", { y: -55 }, { y: 12 }),
    ],
  });
  const grouped = scene([parent, child], { width: 220, height: 130 });
  const groupedExport = await exportedLottie(grouped);
  const groupedMasks = textClipMasks(groupedExport.animation);
  assert.equal(groupedMasks.length, 8, "two nested masks are exported for each of four units");
  // An unclipped Lottie group places its children in a local composition whose origin is the
  // sampled content bounds. The group transform is applied to that composition as a whole.
  const contentBounds = compositionBounds([{ layer: child, children: [] }], TIMES, {
    sampleLayer: (layer, times) => times.map((time) => evaluateLayer(layer, time, { fonts })),
    localMatrix: (layer, state) => layerMatrix({ ...layer, ...state }),
    multiplyMatrix: multiply,
    fonts,
  });
  const groupedParentMatrix = [1, 0, 0, 1, -contentBounds.x, -contentBounds.y];
  for (const time of TIMES) {
    const frame = Math.round(time * FPS);
    assertPolygonsMatch(
      groupedMasks.map(({ mask }) => polygonAt(mask, frame)),
      expectedClipPolygons(child, grouped, time, groupedParentMatrix),
      `grouped mirrored text at frame ${frame}`,
    );
  }
});

test("nested unit clips constrain blurred outside-aligned strokes and remain above Lottie effects", async () => {
  const base = {
    id: "outlined-text", name: "Outlined", x: 22, y: 18, width: 105, height: 46,
    text: "AB", fontSize: 30, fill: "#ffffff", stroke: "#ff0000", strokeWidth: 8,
    strokeAlign: "outside", blur: 4,
  };
  const clippedText = createLayer("text", {
    ...base,
    animations: [
      clipAnimation("box-clip", "layer", { x: -240 }, { x: base.x }),
      clipAnimation("letter-clip", "letters", { y: -70 }, { y: base.y }),
    ],
  });
  const clipped = scene([clippedText]);
  const plain = scene([createLayer("text", { ...base, id: "plain-outlined-text", animations: [] })]);
  const first = await readImage((await exportScene(clipped, { format: "png", time: 0 }, { fonts })).buffer);
  const end = await readImage((await exportScene(clipped, { format: "png", time: 1 }, { fonts })).buffer);
  const unmasked = await readImage((await exportScene(plain, { format: "png", time: 0 }, { fonts })).buffer);
  assert.equal(alphaCount(first), 0, "the nested clips keep the offscreen text invisible");
  assert.ok(alphaCount(end) > 0, "nested clipping still reveals the text");
  assert.ok(Array.from({ length: base.x }, (_, x) => x).some((x) =>
    Array.from({ length: unmasked.height }, (_, y) => unmasked.pixel(x, y)[3]).some((alpha) => alpha > 0)),
  "the unmasked outside stroke and blur paint beyond the layer's left edge");
  assert.equal(Array.from({ length: base.x }, (_, x) => x).some((x) =>
    Array.from({ length: end.height }, (_, y) => end.pixel(x, y)[3]).some((alpha) => alpha > 0)), false,
  "the clip trims the outside stroke and blur at the text-unit bounds");

  const lottie = await exportedLottie(clipped);
  assert.ok(lottie.result.warnings?.some((warning) => warning.code === "lottie-text-clip-filter-edges"),
    "filtered clipped text keeps the explicit native-Lottie edge warning");
  const masks = textClipMasks(lottie.animation);
  assert.equal(masks.length, 4, "both clips are represented for both letters");
  for (const { layer } of masks) {
    const nested = descendantsOf(lottie.animation, layer);
    assert.ok(nested.some((item) => item.ef?.some((effect) => effect.ty === 29)),
      "each outer clip composition contains the blurred text effect");
  }
  const nestedLayers = allReferencedLayers(lottie.animation);
  assert.ok(visitObjects(nestedLayers, (item) => item.ty === "st" || item.ty === "gs").length > 0,
    "the Lottie text composition retains its aligned stroke paint under the clip wrappers");
  assert.ok(alphaCount(unmasked) > 0);
});
