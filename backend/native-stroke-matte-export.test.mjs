import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { exportScene } from "./export.mjs";

const linear = (start, end, angle = 0) => ({
  type: "linear",
  angle,
  stops: [
    { offset: 0, color: start },
    { offset: 1, color: end },
  ],
});

const radial = (start, end) => ({
  type: "radial",
  angle: 0,
  stops: [
    { offset: 0, color: start },
    { offset: 1, color: end },
  ],
});

function layer(type, id, values = {}) {
  return createLayer(type, {
    id: id.toLowerCase().replace(/[^a-z0-9:_-]+/g, "-"),
    name: id,
    fill: "#ffcc0080",
    stroke: "#00000000",
    strokeWidth: 0,
    strokeAlign: "center",
    ...values,
  });
}

function animation(id, name, from, to, { kind = "custom", unit = "layer", stagger = 0 } = {}) {
  return {
    id,
    name,
    kind,
    start: 0,
    duration: 1,
    easing: "linear",
    from,
    to,
    unit,
    stagger,
    order: "forward",
  };
}

function documentFor(artboard) {
  return parseDocument(createDocument({ name: "Native stroke matte export", scenes: [artboard] }));
}

function flattenItems(items = []) {
  return items.flatMap((item) => item.ty === "gr" ? flattenItems(item.it ?? []) : [item]);
}

function compositions(animationData) {
  const assetById = new Map((animationData.assets ?? []).map((asset) => [asset.id, asset]));
  const visited = new Set();
  const result = [];
  const visit = (id, layers) => {
    if (visited.has(id)) return;
    visited.add(id);
    result.push({ id, layers });
    for (const item of layers) {
      if (item.ty !== 0 || !assetById.has(item.refId)) continue;
      visit(item.refId, assetById.get(item.refId).layers ?? []);
    }
  };
  visit("root", animationData.layers ?? []);
  for (const asset of animationData.assets ?? []) {
    if (!visited.has(asset.id)) visit(asset.id, asset.layers ?? []);
  }
  return result;
}

function assertAllMatteLinksAreLocal(animationData) {
  const all = compositions(animationData);
  let pairCount = 0;
  for (const composition of all) {
    const byIndex = new Map(composition.layers.map((item) => [item.ind, item]));
    for (const target of composition.layers.filter((item) => item.tt !== undefined)) {
      assert.ok([1, 2, 3].includes(target.tt), `${target.nm} uses a supported native matte type`);
      assert.ok(Number.isInteger(target.tp), `${target.nm} explicitly points to its matte in the same composition`);
      const source = byIndex.get(target.tp);
      assert.ok(source, `${target.nm} resolves tp=${target.tp} in composition ${composition.id}`);
      assert.equal(source.td, 1, `${source.nm} is a native matte source`);
      assert.equal(source.ks.o.k, 100, `${source.nm} remains fully opaque as a matte source`);
      pairCount += 1;
    }
  }
  assert.ok(pairCount > 0, "native JSON contains actual matte-linked layers");
  assert.equal(all.flatMap((composition) => composition.layers).some((item) => item.ty === 2), false,
    "all paint and matte content remains vector data rather than image layers");
  return all;
}

function rootLayer(animationData, name) {
  const item = animationData.layers.find((candidate) => candidate.nm === name);
  assert.ok(item, `root composition contains ${name}`);
  return item;
}

function assetFor(animationData, layerValue) {
  const asset = animationData.assets.find((candidate) => candidate.id === layerValue.refId);
  assert.ok(asset, `${layerValue.nm} references a native precomposition`);
  return asset;
}

function mattePairFor(animationData, wrapper) {
  const asset = assetFor(animationData, wrapper);
  const targets = asset.layers.filter((item) => item.tt === 1 || item.tt === 2);
  assert.equal(targets.length, 1, `${wrapper.nm} has one aligned-stroke matte target`);
  const target = targets[0];
  const source = asset.layers.find((item) => item.ind === target.tp);
  assert.ok(source, `${target.nm} points to a local silhouette`);
  return { asset, target, source };
}

function nativePaints(layerValue) {
  return flattenItems(layerValue.shapes ?? []).filter((item) => ["st", "gs"].includes(item.ty));
}

function scalarSamples(property) {
  if (property?.a === 0) return [Number(property.k)];
  return (property?.k ?? []).flatMap((frame) => [
    ...(frame.s ?? []),
    ...(frame.e ?? []),
  ]).map(Number);
}

function shapeFixture() {
  const insideEllipse = layer("ellipse", "Inside solid ellipse", {
    x: 12, y: 14, width: 74, height: 48,
    fill: "#ffcc0080",
    stroke: linear("#0066ffff", "#00dd88a0", 35),
    strokeWidth: 4,
    strokeAlign: "inside",
    opacity: 0.65,
  });
  const outsideDonut = layer("ellipse", "Outside gradient donut", {
    x: 104, y: 12, width: 92, height: 64,
    donut: 0.42,
    fill: linear("#ff224480", "#2288ffaa", 0),
    stroke: "#00aa00c0",
    strokeWidth: 3,
    strokeAlign: "outside",
    opacity: 0.8,
  });
  const animatedEllipse = layer("ellipse", "Animated zero width", {
    x: 16, y: 94, width: 66, height: 50,
    fill: radial("#ffee0080", "#ee2288c0"),
    stroke: radial("#0088ffff", "#ee2288a0"),
    strokeWidth: 0,
    strokeAlign: "inside",
    animations: [animation("stroke-growth", "Stroke growth", { strokeWidth: 0 }, { strokeWidth: 4 })],
  });
  const compoundPath = layer("path", "Compound outside path", {
    x: 116, y: 100, width: 72, height: 46,
    path: "M0 0H72V46H0Z M18 12H54V34H18Z",
    pathBounds: { x: 0, y: 0, width: 72, height: 46 },
    fill: radial("#ff880080", "#0033ff90"),
    stroke: linear("#00eeffee", "#bb00ffb0", 90),
    strokeWidth: 2,
    strokeAlign: "outside",
  });

  const clippedGroup = layer("group", "Clipped group", {
    x: 210, y: 12, width: 100, height: 74,
    fill: "#00000000",
    opacity: 0.6,
    clipContent: true,
  });
  const clippedEllipse = layer("ellipse", "Clipped inside ellipse", {
    parentId: clippedGroup.id,
    x: 12, y: 13, width: 68, height: 40,
    fill: linear("#ff008880", "#0088ff90"),
    stroke: "#2020ffff",
    strokeWidth: 2,
    strokeAlign: "inside",
    opacity: 0.75,
  });
  const skewGroup = layer("group", "Skewed group", {
    x: 215, y: 112, width: 88, height: 52,
    fill: "#00000000",
    scaleX: 1.15,
    skewX: 16,
    opacity: 0.5,
  });
  const nestedPath = layer("path", "Nested outside path", {
    parentId: skewGroup.id,
    x: -8, y: 5, width: 55, height: 34,
    path: "M0 0H55V34H0Z M12 9H42V25H12Z",
    pathBounds: { x: 0, y: 0, width: 55, height: 34 },
    fill: "#22aa8880",
    stroke: linear("#ff6600ff", "#5500ffaa", 0),
    strokeWidth: 3,
    strokeAlign: "outside",
    opacity: 0.7,
  });

  const luminanceMask = layer("ellipse", "Existing luminance mask", {
    x: 324, y: 20, width: 58, height: 54,
    isMask: true,
    fill: "#ffffff80",
    opacity: 1,
  });
  const maskedVector = layer("ellipse", "Masked aligned vector", {
    x: 318, y: 24, width: 72, height: 62,
    fill: linear("#ffcc00a0", "#0066ff90", 45),
    stroke: radial("#00ccffff", "#bb00ff90"),
    strokeWidth: 3,
    strokeAlign: "outside",
    opacity: 0.9,
  });

  return createScene({
    id: "native-stroke-matte-scene",
    name: "Native stroke mattes",
    width: 420,
    height: 190,
    duration: 1,
    background: "#ffffff",
    layers: [
      insideEllipse,
      outsideDonut,
      animatedEllipse,
      compoundPath,
      clippedGroup,
      clippedEllipse,
      skewGroup,
      nestedPath,
      luminanceMask,
      maskedVector,
    ],
  });
}

test("native ellipse, donut, path, group, and user-mask strokes use local vector matte pairs", async () => {
  const document = documentFor(shapeFixture());
  const scene = document.scenes[0];
  const native = JSON.parse((await exportScene(scene, { format: "lottie", fps: 4, duration: 1 })).buffer.toString("utf8"));
  const allCompositions = assertAllMatteLinksAreLocal(native);
  const insideEllipse = rootLayer(native, "Inside solid ellipse");
  const outsideDonut = rootLayer(native, "Outside gradient donut");
  const animatedEllipse = rootLayer(native, "Animated zero width");
  const compound = rootLayer(native, "Compound outside path");

  assert.equal(insideEllipse.ty, 0, "inside stroke paints through a wrapper that owns layer opacity");
  assert.equal(insideEllipse.ks.o.k, 65);
  const inside = mattePairFor(native, insideEllipse);
  assert.equal(inside.target.tt, 1);
  assert.equal(insideEllipse.ks.o.k, 65);
  assert.ok(inside.asset.layers.every((item) => item.ks.o.k === 100), "fill, doubled stroke, and silhouette children stay opaque under the shared wrapper");
  assert.equal(inside.source.td, 1);
  assert.ok(flattenItems(inside.asset.layers.find((item) => item.nm.includes("content"))?.shapes).some((item) => item.ty === "el"), "ellipse fill preserves native ellipse geometry");
  const insideStroke = nativePaints(inside.target).find((item) => item.ty === "gs");
  assert.ok(insideStroke, "gradient stroke remains a native gradient stroke paint");
  assert.deepEqual(scalarSamples(insideStroke.w), [8], "native stroke width doubles the entered four-unit width");

  const outside = mattePairFor(native, outsideDonut);
  assert.equal(outside.target.tt, 2);
  assert.equal(outsideDonut.ks.o.k, 80);
  assert.ok(outside.asset.layers.every((item) => item.ks.o.k === 100), "outside stroke mattes do not apply layer opacity twice");
  const donutContent = outside.asset.layers.find((item) => item.nm.includes("content"));
  const donutItems = flattenItems(donutContent?.shapes);
  assert.ok(donutItems.some((item) => item.ty === "gf"), "the donut keeps its original gradient fill");
  assert.equal(donutItems.filter((item) => item.ty === "sh").length, 2, "the compound annulus retains both native contours");
  const outsideStroke = nativePaints(outside.target).find((item) => item.ty === "st");
  assert.deepEqual(scalarSamples(outsideStroke.w), [6], "outside matte uses twice the entered three-unit stroke width");

  const compoundPair = mattePairFor(native, compound);
  assert.equal(compoundPair.target.tt, 2);
  const compoundContent = compoundPair.asset.layers.find((item) => item.nm.includes("content"));
  const compoundItems = flattenItems(compoundContent?.shapes);
  assert.ok(compoundItems.some((item) => item.ty === "gf"), "compound path retains its native gradient");
  assert.equal(compoundItems.filter((item) => item.ty === "sh").length, 2, "compound path keeps both editable outline contours");
  assert.ok(nativePaints(compoundPair.target).some((item) => item.ty === "gs"), "compound path gradient stroke is not rasterized");

  const animated = mattePairFor(native, animatedEllipse);
  assert.equal(animated.target.tt, 1);
  const animatedStroke = nativePaints(animated.target).find((item) => item.ty === "gs");
  assert.ok(animatedStroke?.w?.a === 1, "zero-to-positive stroke weight remains animated in native output");
  const animatedWidths = scalarSamples(animatedStroke.w);
  assert.equal(animatedWidths[0], 0);
  assert.equal(animatedWidths.at(-1), 8, "animated native weight reaches twice the entered four-unit endpoint");

  const clipped = rootLayer(native, "Clipped group");
  assert.equal(clipped.ty, 0);
  assert.equal(clipped.hasMask, true, "the existing clipped-group matte stays attached");
  assert.equal(clipped.ks.o.k, 60);
  const clippedAsset = assetFor(native, clipped);
  assert.ok(clippedAsset.layers.some((item) => item.nm === "Clipped inside ellipse" && item.ty === 0), "aligned child remains nested in the clipped group composition");
  const clippedChild = clippedAsset.layers.find((item) => item.nm === "Clipped inside ellipse");
  assert.equal(mattePairFor(native, clippedChild).target.tt, 1, "inside matte link stays local to the clipped precomposition");

  const skewGroup = rootLayer(native, "Skewed group");
  assert.equal(skewGroup.ty, 0);
  assert.equal(skewGroup.ks.o.k, 50);
  assert.ok(Math.abs(skewGroup.ks.sk.k) > 1, "non-clipped group skew remains on its native composition transform");
  const skewAsset = assetFor(native, skewGroup);
  const nested = skewAsset.layers.find((item) => item.nm === "Nested outside path");
  assert.ok(nested, "negative local path geometry remains inside the measured skewed group bounds");
  assert.equal(mattePairFor(native, nested).target.tt, 2, "outside matte link stays local to the skewed precomposition");

  const userMasked = rootLayer(native, "Masked aligned vector");
  assert.equal(userMasked.tt, 3, "existing luminance mask remains on the aligned vector wrapper");
  const userMaskSource = native.layers.find((item) => item.ind === userMasked.tp);
  assert.equal(userMaskSource?.nm, "Existing luminance mask");
  assert.equal(userMaskSource?.td, 1);
  const userMaskedAsset = assetFor(native, userMasked);
  const outsideUserTarget = userMaskedAsset.layers.find((item) => item.tt === 2);
  assert.ok(outsideUserTarget, "the aligned outside stroke keeps its local matte inside the user-masked composition");
  assert.ok(userMaskedAsset.layers.some((item) => item.ind === outsideUserTarget.tp && item.td === 1),
    "the aligned outside matte remains inside the luminance-masked graphic composition");
  assert.ok(allCompositions.length >= 5, "recursive inspection reached nested group and matte compositions");
});

test("aligned text mattes remain per-letter with native stroke weight and stagger timing", async () => {
  const text = layer("text", "per-letter-caption", {
    name: "Per-letter caption",
    x: 24, y: 24, width: 140, height: 54,
    text: "AB",
    fontFamily: "Inter",
    fontSize: 28,
    fontWeight: 400,
    lineHeight: 1.2,
    fill: "#183858",
    stroke: linear("#ff3300e0", "#0066ff90", 0),
    strokeWidth: 4,
    strokeAlign: "inside",
    opacity: 0.8,
    animations: [animation(
      "per-letter-draw",
      "Letter draw",
      { opacity: 0, strokeWidth: 0 },
      { opacity: 0.8, strokeWidth: 4 },
      { kind: "in", unit: "letters", stagger: 0.25 },
    )],
  });
  const scene = createScene({
    id: "per-letter-matte-scene",
    name: "Per-letter matte",
    width: 220,
    height: 100,
    duration: 1,
    background: "#ffffff",
    layers: [text],
  });
  const document = documentFor(scene);
  const native = JSON.parse((await exportScene(document.scenes[0], { format: "lottie", fps: 4, duration: 1 })).buffer.toString("utf8"));
  const all = assertAllMatteLinksAreLocal(native);
  const letters = native.layers
    .filter((item) => item.nm.startsWith("Per-letter caption ") && item.ty === 0)
    .sort((left, right) => Number(left.nm.match(/ (\d+)$/)?.[1]) - Number(right.nm.match(/ (\d+)$/)?.[1]));
  assert.equal(letters.length, 2, "text creates one vector composition for each grapheme unit");
  assert.equal(native.layers.some((item) => item.ty === 5), false, "portable output contains outlines rather than live font layers");

  const firstOpacity = letters[0].ks.o;
  const secondOpacity = letters[1].ks.o;
  assert.equal(firstOpacity.a, 1);
  assert.equal(secondOpacity.a, 1);
  const atQuarter = (property) => property.k.find((key) => key.t === 1)?.s?.[0];
  assert.ok(atQuarter(firstOpacity) > atQuarter(secondOpacity), "the second letter retains its later stagger time");

  const expectedFinalWidths = [8, 6];
  for (const [index, letter] of letters.entries()) {
    const asset = assetFor(native, letter);
    const pairs = asset.layers.filter((item) => item.tt === 1);
    assert.ok(pairs.length > 0, `letter ${index + 1} has an inside-stroke matte pair`);
    const glyphShapes = asset.layers.flatMap((item) => item.shapes ?? []);
    assert.match(JSON.stringify(glyphShapes), /Glyph/, "the text unit keeps its glyph-specific vector group");
    assert.ok(asset.layers.some((item) => flattenItems(item.shapes).some((shape) => shape.ty === "sh")),
      "the text unit stores editable glyph outline paths");
    const stroke = pairs.flatMap(nativePaints).find((item) => item.ty === "gs");
    assert.ok(stroke, `letter ${index + 1} keeps its gradient stroke as native vector paint`);
    const widths = scalarSamples(stroke.w);
    assert.equal(widths.at(-1), expectedFinalWidths[index], "staggered glyph stroke width remains doubled and sampled per unit");
  }
  assert.ok(all.length >= 3, "recursive inspection includes text, glyph, and matte compositions");
});
