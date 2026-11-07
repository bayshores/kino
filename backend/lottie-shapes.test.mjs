import test from "node:test";
import assert from "node:assert/strict";
import { lottieShapeParts, lottieShapes, roundedBoxMask } from "./lottie-shapes.mjs";
import { interpolatePath, pathBounds, serializePath } from "../engine/vectorPath.js";

function property(values, dimension = 1) {
  const normalized = values.map((value) => Array.isArray(value) ? value.slice(0, dimension) : [value]);
  const same = normalized.every((value) => value.length === normalized[0].length && value.every((part, index) => Math.abs(Number(part) - Number(normalized[0][index])) < 1e-7));
  if (same) return { a: 0, k: dimension === 1 ? normalized[0][0] : normalized[0] };
  return {
    a: 1,
    k: normalized.map((value, index) => {
      const frame = { t: index, s: value };
      if (normalized[index + 1]) {
        frame.e = normalized[index + 1];
        frame.i = { x: 1, y: 1 };
        frame.o = { x: 0, y: 0 };
      } else frame.h = 1;
      return frame;
    }),
  };
}

function colorToRgba(value) {
  if (typeof value !== "string") return null;
  const hex = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(value);
  if (!hex) return null;
  return [
    Number.parseInt(hex[1].slice(0, 2), 16),
    Number.parseInt(hex[1].slice(2, 4), 16),
    Number.parseInt(hex[1].slice(4, 6), 16),
    hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1,
  ];
}

const helpers = { property, colorToRgba };
const layer = (type, values = {}) => ({
  id: "shape",
  name: "Shape",
  type,
  width: 200,
  height: 100,
  pathBounds: { width: 20, height: 10 },
  ...values,
});

test("path fill rules map to Lottie solid, gradient, and stroke-matte fills", () => {
  const shape = layer("path", {
    path: "M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z",
    fillRule: "evenodd",
  });
  const morph = "M1 1 H21 V21 H1 Z M6 6 H16 V16 H6 Z";
  const solid = lottieShapes(shape, [
    { ...shape, fillRule: "nonzero", path: shape.path, fill: "#335577" },
    { ...shape, fillRule: "nonzero", path: morph, fill: "#557799" },
  ], "Even-odd solid morph", helpers);
  assert.equal(solid.flatMap((group) => group.it).find((item) => item.ty === "fl").r, 2,
    "the base layer rule applies to every sampled morph path");

  const gradient = {
    type: "linear", angle: 90,
    stops: [{ offset: 0, color: "#335577" }, { offset: 1, color: "#7799bb" }],
  };
  const gradientGroups = lottieShapes(shape, [{ ...shape, fill: gradient }], "Even-odd gradient", helpers);
  assert.equal(gradientGroups.flatMap((group) => group.it).find((item) => item.ty === "gf").r, 2);

  const parts = lottieShapeParts(shape, [{ ...shape, fill: "#335577", stroke: "#112233", strokeWidth: 3, strokeAlign: "inside" }], "Even-odd stroked path", helpers);
  assert.equal(parts.matte.flatMap((group) => group.it).find((item) => item.ty === "fl").r, 2,
    "the alignment silhouette keeps the hole's fill rule");
});

function pathFromLottieShape(shape) {
  const segments = [];
  for (let index = 0; index < shape.v.length - 1; index += 1) {
    const from = shape.v[index];
    const to = shape.v[index + 1];
    segments.push({
      c1: [from[0] + shape.o[index][0], from[1] + shape.o[index][1]],
      c2: [to[0] + shape.i[index + 1][0], to[1] + shape.i[index + 1][1]],
      end: to,
    });
  }
  return serializePath([{ start: shape.v[0], segments, closed: shape.c }]);
}

function signedArea(shape) {
  return shape.v.reduce((area, point, index) => {
    const next = shape.v[(index + 1) % shape.v.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

test("paths without explicit sizing bounds retain their SVG coordinates", () => {
  const path = layer("path", {path: "M0 0 H20 V10 H0 Z", pathBounds: undefined});
  const groups = lottieShapes(path, [{...path, fill: "#ff0000"}], "Native path", helpers);
  assert.deepEqual(groups[0].it.at(-1).s, {a: 0, k: [100,100]});
});

test("rounded box masks keep the legacy four-vertex path when every corner is square", () => {
  const box = { width: 200, height: 100, radius: 0, cornerRadii: null };
  const mask = roundedBoxMask([box, { ...box, width: 300 }]);
  assert.equal(mask.mode, "a");
  assert.equal(mask.inv, false);
  assert.equal(mask.pt.a, 1);
  assert.deepEqual(mask.pt.k[0].s[0].v, [[0, 0], [200, 0], [200, 100], [0, 100]]);
  assert.deepEqual(mask.pt.k[0].e[0].v, [[0, 0], [300, 0], [300, 100], [0, 100]]);
  assert.equal(mask.pt.k[0].s[0].v.length, 4);
});

test("rounded box masks use cubic corners and resolve independent radii against the box", () => {
  const mask = roundedBoxMask([{ width: 100, height: 60, radius: 0, cornerRadii: [10, 20, 30, 40] }]);
  const shape = mask.pt.k;
  assert.equal(mask.pt.a, 0);
  assert.equal(shape.c, true);
  assert.equal(shape.v.length, 9);
  assert.deepEqual(shape.v, [[10, 0], [80, 0], [100, 20], [100, 30], [70, 60], [40, 60], [0, 20], [0, 10], [10, 0]]);
  assert.ok(shape.o.some(([x, y]) => x !== 0 || y !== 0), "rounded corners retain their cubic handles");
});

test("rounded box masks keep a stable path topology through square-to-rounded animation and compress repeats", () => {
  const box = { width: 100, height: 60, cornerRadii: null };
  const mask = roundedBoxMask([
    { ...box, radius: 0 },
    { ...box, radius: 0 },
    { ...box, radius: 12 },
    { ...box, radius: 12 },
    { ...box, radius: 0 },
  ]);
  assert.equal(mask.pt.a, 1);
  assert.deepEqual(mask.pt.k.map((frame) => frame.t), [0, 1, 3, 4]);
  for (const frame of mask.pt.k) {
    for (const shape of [...(frame.s ?? []), ...(frame.e ?? [])]) assert.equal(shape.v.length, 9);
  }
  assert.ok(mask.pt.k[1].s[0].o.some(([x, y]) => x !== 0 || y !== 0), "the rounded sample has cubic corner handles");
});

test("rounded box masks collapse negative overshoot dimensions to zero without changing topology", () => {
  const mask = roundedBoxMask([
    { width: 100, height: 60, radius: 20 },
    { width: -12, height: 60, radius: 20 },
  ]);
  assert.equal(mask.pt.a, 1);
  const collapsed = mask.pt.k[1].s[0];
  assert.equal(collapsed.v.length, 9);
  assert.ok(collapsed.v.every(([x]) => x === 0));
  assert.ok(collapsed.v.every(([, y]) => y >= 0 && y <= 60));
});

test("rounded box masks enforce the native path geometry budget", () => {
  const states = Array.from({ length: 27_779 }, (_, index) => ({
    width: 200 + index / 100,
    height: 100,
    radius: 8,
  }));
  assert.throws(() => roundedBoxMask(states), /too much changing rounded-box geometry/);
});

test("linear gradients use final layer coordinates and preserve per-stop alpha on a rounded, non-square rectangle", () => {
  const rectangle = layer("rectangle", { radius: 10 });
  const fill = {
    type: "linear",
    angle: 90,
    stops: [
      { offset: 0, color: "#ff000080" },
      { offset: 0.7, color: "#00ff00" },
      { offset: 1, color: "#0000ff20" },
    ],
  };
  const [strokeGroup, fillGroup] = lottieShapes(rectangle, [
    { ...rectangle, fill, stroke: "#00000080", strokeWidth: 2 },
  ], "Rounded box", helpers);
  const fillItems = fillGroup.it;
  const geometry = fillItems.find((item) => item.ty === "rc");
  const gradient = fillItems.find((item) => item.ty === "gf");
  const transform = fillItems.at(-1);
  assert.ok(geometry, "rounded rectangles retain native rectangle geometry");
  assert.deepEqual(geometry.p.k, [100, 50]);
  assert.deepEqual(geometry.s.k, [200, 100]);
  assert.equal(geometry.r.k, 10);
  assert.ok(Math.abs(gradient.s.k[0] - 100) < 1e-10);
  assert.ok(Math.abs(gradient.s.k[1]) < 1e-10);
  assert.ok(Math.abs(gradient.e.k[0] - 100) < 1e-10);
  assert.ok(Math.abs(gradient.e.k[1] - 100) < 1e-10);
  assert.equal(gradient.g.p, 3);
  const stops = gradient.g.k.k;
  assert.equal(stops.length, 3 * 4 + 3 * 2);
  assert.deepEqual(stops.slice(0, 4), [0, 1, 0, 0]);
  assert.deepEqual(stops.slice(12), [0, 128 / 255, 0.7, 1, 1, 32 / 255]);
  assert.deepEqual(transform.p.k, [0, 0]);
  assert.deepEqual(transform.s.k, [100, 100]);
  assert.ok(strokeGroup, "stroke uses its own original-coordinate group");
  const stroke = strokeGroup.it.find((item) => item.ty === "st");
  assert.ok(Math.abs(stroke.o.k - (128 / 255) * 100) < 1e-10);
  assert.equal(stroke.w.k, 2);
  assert.equal(stroke.lc, 1);
  assert.equal(stroke.lj, 1);
});

test("zero-radius gradient rectangles retain native rectangle geometry", () => {
  const rectangle = layer("rectangle", { radius: 0 });
  const [group] = lottieShapes(rectangle, [{
    ...rectangle,
    fill: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }],
    },
  }], "Square", helpers);
  const rectangleShape = group.it.find((item) => item.ty === "rc");
  assert.equal(rectangleShape.r.k, 0);
  assert.deepEqual(rectangleShape.p.k, [100, 50]);
  assert.deepEqual(rectangleShape.s.k, [200, 100]);
  assert.deepEqual(group.it.at(-1).s.k, [100, 100]);
});

test("radial gradients and strokes use each sampled path's final layer coordinates", () => {
  const base = layer("path", { path: "M0 0 L20 0 L20 10 L0 10 Z" });
  const fill = {
    type: "radial",
    angle: 0,
    stops: [
      { offset: 0, color: "#ffffff" },
      { offset: 1, color: "#112233" },
    ],
  };
  const nextPath = "M4 2 L24 2 L24 12 L4 12 Z";
  const groups = lottieShapes(base, [
    { ...base, path: base.path, fill, stroke: "#ff000080", strokeWidth: 3 },
    { ...base, path: nextPath, fill, stroke: "#ff000080", strokeWidth: 3 },
  ], "Morphing path", helpers);
  const fillGradient = groups[1].it.find((item) => item.ty === "gf");
  assert.equal(fillGradient.t, 2);
  assert.deepEqual(fillGradient.s.k[0].s, [100, 50]);
  assert.deepEqual(fillGradient.e.k[0].s, [100, -50]);
  assert.deepEqual(fillGradient.s.k[1].s, [140, 70]);
  assert.deepEqual(fillGradient.e.k[1].s, [140, -30]);
  const fillTransform = groups[1].it.at(-1);
  assert.deepEqual(fillTransform.p.k, [0, 0]);
  assert.deepEqual(fillTransform.s.k, [100, 100]);
  const strokeGeometry = groups[0].it.find((item) => item.ty === "sh");
  assert.equal(strokeGeometry.ks.a, 1);
  assert.deepEqual(strokeGeometry.ks.k[0].s[0].v[0], [0, 0]);
  assert.deepEqual(strokeGeometry.ks.k[1].s[0].v[0], [40, 20]);
  assert.deepEqual(groups[0].it.at(-1).s.k, [100, 100]);
  assert.equal(groups[0].it.find((item) => item.ty === "st").w.k, 3);
  assert.ok(Math.abs(groups[0].it.find((item) => item.ty === "st").o.k - (128 / 255) * 100) < 1e-10);
});

test("native gradient strokes retain gs width and stop alpha on the shared original layer domain", () => {
  const rectangle = layer("rectangle", { width: 200, height: 100, radius: 0 });
  const state = {
    ...rectangle,
    fill: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }],
    },
    stroke: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff40" }],
    },
    strokeWidth: 6,
  };
  const [strokeGroup, fillGroup] = lottieShapes(rectangle, [state], "Gradient stroke", helpers);
  const gradientStroke = strokeGroup.it.find((item) => item.ty === "gs");
  const fillGradient = fillGroup.it.find((item) => item.ty === "gf");
  assert.ok(gradientStroke, "a center-aligned gradient stroke remains a native Lottie gs item");
  assert.equal(gradientStroke.w.k, 6);
  assert.equal(gradientStroke.g.p, 2);
  assert.deepEqual(gradientStroke.g.k.k.slice(8), [0, 128 / 255, 1, 64 / 255]);
  assert.deepEqual(gradientStroke.s.k, [0, 50]);
  assert.deepEqual(gradientStroke.e.k, [200, 50]);
  assert.deepEqual(fillGradient.s.k, gradientStroke.s.k);
  assert.deepEqual(fillGradient.e.k, gradientStroke.e.k, "fill and stroke use the same original layer-space gradient domain");
  assert.deepEqual(strokeGroup.it.at(-1).s.k, [100, 100]);
});

test("lottieShapes requires the layer-level helper for positive aligned strokes", () => {
  const rectangle = layer("rectangle", { width: 200, height: 100, radius: 0 });
  const state = {
    ...rectangle,
    fill: "#ffffff",
    stroke: "#ff0000",
    strokeWidth: 4,
    strokeAlign: "outside",
  };
  assert.throws(
    () => lottieShapes(rectangle, [state], "Outside stroke", helpers),
    /use lottieShapeParts/,
  );
});

test("aligned gradient strokes use native doubled strokes, opaque silhouettes, and the original gradient domain", () => {
  const rectangle = layer("rectangle", { width: 200, height: 100, radius: 0 });
  const paint = {
    type: "linear",
    angle: 0,
    stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff40" }],
  };
  const state = {
    ...rectangle,
    fill: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }],
    },
    stroke: paint,
    strokeWidth: 8,
    strokeAlign: "outside",
  };
  const parts = lottieShapeParts(rectangle, [state], "Outside gradient stroke", helpers);
  const contentGradient = parts.content[0].it.find((item) => item.ty === "gf");
  const strokeGroup = parts.stroke[0];
  const strokeGradient = strokeGroup.it.find((item) => item.ty === "gs");
  const matteGroup = parts.matte[0];
  const matteFill = matteGroup.it.find((item) => item.ty === "fl");
  assert.equal(parts.matteType, 2, "outside alignment is clipped by the layer's opaque silhouette");
  assert.equal(parts.content.length, 1);
  assert.equal(parts.stroke.length, 2, "native paint is followed by a matte bounds rectangle");
  assert.equal(parts.matte.length, 1);
  assert.ok(strokeGradient, "the alignment helper retains a native gradient stroke");
  assert.equal(strokeGradient.w.k, 16, "the centered stroke doubles the requested outside weight before matte clipping");
  assert.deepEqual(strokeGradient.g.k.k.slice(8), [0, 128 / 255, 1, 64 / 255]);
  assert.deepEqual(strokeGradient.s.k, [0, 50]);
  assert.deepEqual(strokeGradient.e.k, [200, 50]);
  assert.deepEqual(contentGradient.s.k, strokeGradient.s.k);
  assert.deepEqual(contentGradient.e.k, strokeGradient.e.k, "stroke and content retain the original layer gradient domain");
  for (const group of [parts.content[0], strokeGroup, matteGroup]) {
    const geometry = group.it.find((item) => item.ty === "rc");
    assert.deepEqual(geometry.p.k, [100, 50]);
    assert.deepEqual(geometry.s.k, [200, 100], "matte clipping keeps source geometry instead of a generated stroke outline");
    assert.deepEqual(group.it.at(-1).s.k, [100, 100]);
  }
  assert.ok(matteFill, "the outside matte has an opaque native silhouette fill");
  assert.deepEqual(matteFill.c.k, [1, 1, 1]);
  assert.equal(matteFill.o.k, 100);
  const boundsGroup = parts.stroke[1];
  const boundsRectangle = boundsGroup.it.find((item) => item.ty === "rc");
  const transparentFill = boundsGroup.it.find((item) => item.ty === "fl");
  assert.equal(boundsGroup.nm, "Stroke matte bounds");
  assert.equal(boundsGroup.hd, false, "the invisible bounds group remains present in the player");
  assert.equal(boundsRectangle.hd, false);
  assert.deepEqual(boundsRectangle.p.k, [100, 50]);
  assert.deepEqual(boundsRectangle.s.k, [360, 260], "the bounds expand by ten times the entered stroke weight on each side");
  assert.deepEqual(transparentFill.c.k, [0, 0, 0]);
  assert.equal(transparentFill.o.k, 0);
  assert.equal(transparentFill.hd, false);
  assert.deepEqual(boundsGroup.it.at(-1).s.k, [100, 100]);
});

test("aligned stroke width remains in pixels when source geometry is resized", () => {
  const makeParts = (width, height) => {
    const rectangle = layer("rectangle", { width, height, radius: 0 });
    return lottieShapeParts(rectangle, [{
      ...rectangle,
      fill: "#336699",
      stroke: "#cc225580",
      strokeWidth: 3.5,
      strokeAlign: "inside",
    }], "Resized inside stroke", helpers);
  };
  const small = makeParts(100, 50);
  const large = makeParts(400, 200);
  for (const [parts, size] of [[small, [100, 50]], [large, [400, 200]]]) {
    const stroke = parts.stroke[0].it.find((item) => item.ty === "st");
    const silhouette = parts.matte[0].it.find((item) => item.ty === "fl");
    const sourceGeometry = parts.content[0].it.find((item) => item.ty === "rc");
    assert.equal(stroke.w.k, 7, "the centered native stroke stays at twice the requested pixel width");
    assert.deepEqual(sourceGeometry.s.k, size);
    assert.deepEqual(parts.stroke[0].it.at(-1).s.k, [100, 100]);
    assert.deepEqual(parts.matte[0].it.at(-1).s.k, [100, 100]);
    assert.deepEqual(silhouette.c.k, [1, 1, 1]);
    assert.equal(silhouette.o.k, 100);
  }
  assert.equal(small.matteType, 1);
  assert.equal(large.matteType, 1);
});

test("layer-level stroke parts keep compound holes and their opposite winding", () => {
  const compound = layer("path", {
    path: "M0 0 L200 0 L200 200 L0 200 Z M50 50 L50 150 L150 150 L150 50 Z",
    pathBounds: { x: 0, y: 0, width: 200, height: 200 },
    width: 200,
    height: 200,
  });
  const state = {
    ...compound,
    fill: "#44aa88",
    stroke: "#11223380",
    strokeWidth: 6,
    strokeAlign: "inside",
  };
  const parts = lottieShapeParts(compound, [state], "Compound inside stroke", helpers);
  assert.equal(parts.matteType, 1);
  for (const group of [parts.content[0], parts.stroke[0], parts.matte[0]]) {
    const contours = group.it.filter((item) => item.ty === "sh").map((item) => item.ks.k);
    assert.equal(contours.length, 2);
    assert.ok(signedArea(contours[0]) > 0);
    assert.ok(signedArea(contours[1]) < 0, "the inner contour stays reversed so the silhouette retains its hole");
    assert.equal(group.it.at(-1).s.k[0], 100);
  }
  const stroke = parts.stroke[0].it.find((item) => item.ty === "st");
  assert.equal(stroke.w.k, 12);
  assert.ok(Math.abs(stroke.o.k - (128 / 255) * 100) < 1e-10);
  const silhouette = parts.matte[0].it.find((item) => item.ty === "fl");
  assert.deepEqual(silhouette.c.k, [1, 1, 1]);
  assert.equal(silhouette.o.k, 100);
});

test("animated stroke bounds follow resized negative-bearing ink, weight, and not the gradient box", () => {
  const base = layer("path", {
    path: "M-20 -10 L30 -10 L30 40 L-20 40 Z",
    pathBounds: { x: -20, y: -10, width: 50, height: 50 },
    width: 100,
    height: 100,
  });
  const stroke = {
    type: "linear",
    angle: 90,
    stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff40" }],
  };
  const states = [
    {
      ...base,
      width: 100,
      height: 100,
      gradientBounds: { x: 2, y: 3, width: 7, height: 9 },
      fill: "#336699",
      stroke,
      strokeWidth: 2,
      strokeAlign: "outside",
    },
    {
      ...base,
      width: 200,
      height: 150,
      gradientBounds: { x: 20, y: 30, width: 11, height: 13 },
      fill: "#336699",
      stroke,
      strokeWidth: 4,
      strokeAlign: "outside",
    },
  ];
  const parts = lottieShapeParts(base, states, "Animated outside path stroke", helpers);
  assert.equal(parts.matteType, 2);
  const nativeStroke = parts.stroke[0].it.find((item) => item.ty === "gs");
  assert.equal(nativeStroke.w.a, 1);
  assert.deepEqual(nativeStroke.w.k.map((frame) => frame.s[0]), [4, 8], "entered stroke weights double independently of layer resizing");
  assert.deepEqual(nativeStroke.s.k.map((frame) => frame.s), [[11, 6], [102, 90]], "stroke gradients retain their requested gradient boxes");
  assert.deepEqual(nativeStroke.e.k.map((frame) => frame.s), [[11, 24], [102, 129]]);

  const boundsGroup = parts.stroke[1];
  const boundsRectangle = boundsGroup.it.find((item) => item.ty === "rc");
  const shape = parts.stroke[0].it.find((item) => item.ty === "sh");
  assert.equal(boundsGroup.hd, false);
  assert.equal(boundsRectangle.hd, false);
  assert.equal(boundsRectangle.p.a, 1);
  assert.deepEqual(boundsRectangle.p.k.map((frame) => frame.s), [[10, 30], [20, 45]]);
  assert.equal(boundsRectangle.s.a, 1);
  assert.deepEqual(boundsRectangle.s.k.map((frame) => frame.s), [[140, 140], [280, 230]]);
  assert.deepEqual(shape.ks.k[0].s[0].v[0], [-40, -20]);
  assert.deepEqual(shape.ks.k[1].s[0].v[0], [-80, -30]);
  assert.deepEqual(boundsGroup.it.at(-1).s.k, [100, 100]);
  const transparentFill = boundsGroup.it.find((item) => item.ty === "fl");
  assert.equal(transparentFill.o.k, 0);
  assert.equal(transparentFill.hd, false);
});

test("layer-level aligned stroke validation is constant and the centered helper returns content only", () => {
  const rectangle = layer("rectangle", { width: 200, height: 100, radius: 0 });
  const states = [
    { ...rectangle, fill: "#ffffff", stroke: "#000000", strokeWidth: 4, strokeAlign: "inside" },
    { ...rectangle, fill: "#ffffff", stroke: "#000000", strokeWidth: 4, strokeAlign: "outside" },
  ];
  assert.throws(
    () => lottieShapeParts(rectangle, states, "Changing alignment", helpers),
    /changes stroke position during the animation/,
  );
  const centered = lottieShapeParts(rectangle, [{ ...states[0], strokeAlign: "center" }], "Centered stroke", helpers);
  assert.deepEqual(Object.keys(centered), ["content"]);
  assert.equal(centered.content[0].it.find((item) => item.ty === "st").w.k, 4);
});

test("SVG arcs and compound nonzero-winding contours preserve cubic handles in a sampled Bezier morph", () => {
  const shape = layer("path", { path: "M0 0 A10 5 0 0 1 20 0 Z M5 5 A5 2 0 0 0 15 5 Z" });
  const to = "M2 1 C5 -2 9 -2 12 0 C16 2 19 -1 22 1 Z M7 4 C8 2 10 2 11 4 C13 6 14 7 15 4 Z";
  const fills = ["#cc2255", "#3355cc"];
  const groups = lottieShapes(shape, [
    { ...shape, path: shape.path, fill: fills[0], stroke: "#ffffff80", strokeWidth: 1 },
    { ...shape, path: to, fill: fills[1], stroke: "#ffffff80", strokeWidth: 1 },
  ], "Compound morph", helpers);
  const pathItems = groups[0].it.filter((item) => item.ty === "sh");
  assert.equal(pathItems.length, 2, "both compound contours are serialized before the shared fill");
  assert.equal(pathItems[0].ks.a, 1);
  assert.equal(pathItems[0].ks.k[0].s[0].c, true);
  const start = pathItems[0].ks.k[0].s[0];
  assert.ok(start.o.some(([x, y]) => x !== 0 || y !== 0), "arc conversion retains outgoing cubic tangents");
  assert.equal(groups[0].it.find((item) => item.ty === "fl").r, 1, "compound contours use the nonzero fill rule");
  const fill = groups[0].it.find((item) => item.ty === "fl");
  assert.equal(fill.c.a, 1);
  assert.deepEqual(fill.c.k[0].s, [204 / 255, 34 / 255, 85 / 255]);
  assert.equal(fill.c.k[1].s[2], 0.8);
  assert.ok(Math.abs(groups[0].it.find((item) => item.ty === "st").o.k - (128 / 255) * 100) < 1e-10);
  assert.ok(groups[0].it.findIndex((item) => item.ty === "st") < groups[0].it.findIndex((item) => item.ty === "fl"));
});

test("path morphs with different segment counts share vertices while keeping endpoint bounds", () => {
  const from = "M0 0 L10 0 L20 0 L20 10 L0 10 Z";
  const to = "M0 0 C5 0 15 0 20 0 L0 10 Z";
  const middle = interpolatePath(from, to, 0.5);
  const path = layer("path", { path: from, pathBounds: undefined });
  const groups = lottieShapes(path, [
    { ...path, path: from, fill: "#336699" },
    { ...path, path: middle, fill: "#336699" },
    { ...path, path: to, fill: "#336699" },
  ], "Line-to-curve morph", helpers);
  const geometry = groups[0].it.find((item) => item.ty === "sh");
  assert.equal(geometry.ks.a, 1);
  const sampledShapes = geometry.ks.k.map((frame) => frame.s[0]);
  assert.deepEqual(sampledShapes.map((shape) => shape.v.length), [5, 5, 5]);
  assert.deepEqual(sampledShapes.map((shape) => shape.i.length), [5, 5, 5]);
  assert.deepEqual(sampledShapes.map((shape) => shape.o.length), [5, 5, 5]);
  assert.deepEqual(pathBounds(pathFromLottieShape(sampledShapes[0])), pathBounds(from));
  assert.deepEqual(pathBounds(pathFromLottieShape(sampledShapes.at(-1))), pathBounds(to));
});

test("a solid to gradient paint change exports as one gradient whose solid frame has one color", () => {
  const rectangle = layer("rectangle");
  const groups = lottieShapes(rectangle, [
    { ...rectangle, fill: "#ffffff" },
    { ...rectangle, fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] } },
  ], "Changing paint", helpers);
  const fills = groups.flatMap((group) => group.it).filter((item) => item.ty === "gf");
  assert.equal(fills.length, 1);
  assert.equal(fills[0].g.p, 2);
  assert.deepEqual(fills[0].g.k.k[0].s, [0, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(fills[0].g.k.k[1].s, [0, 0, 0, 0, 1, 1, 1, 1]);
});

test("path topology changes fail with a specific explanation", () => {
  const path = layer("path", { path: "M0 0 L20 0" });
  assert.throws(() => lottieShapes(path, [
    { ...path, fill: "#ffffff" },
    { ...path, path: "M0 0 L20 0 Z", fill: "#ffffff" },
  ], "Changed closure", helpers), /contour 1 must be open in both paths or closed/);

  const oneContour = layer("path", { path: "M0 0 L20 0 Z" });
  assert.throws(() => lottieShapes(oneContour, [
    { ...oneContour, fill: "#ffffff" },
    { ...oneContour, path: "M0 0 L20 0 Z M4 4 L8 4 Z", fill: "#ffffff" },
  ], "Changed contour count", helpers), /same number of corresponding contours/);
});

test("trim paths and dashes export as a Lottie tm modifier and d list that read back to the same values", () => {
  const shape = layer("ellipse", { stroke: "#112233", strokeWidth: 6, fill: "#ffcc00", dash: [12, 6], dashOffset: 3 });
  const states = [0, 0.25, 0.5].map((offset, index) => ({ ...shape, strokeStart: 0.1, strokeEnd: 0.1 + index * 0.4, strokeOffset: offset }));
  const groups = lottieShapes(shape, states, "Trimmed", helpers);
  // The stroke has its own trimmed group, drawn over the whole fill.
  const [stroke, fill] = groups;
  assert.ok(stroke.it.some((item) => item.ty === "st") && !stroke.it.some((item) => item.ty === "fl"));
  assert.ok(fill.it.some((item) => item.ty === "fl") && !fill.it.some((item) => item.ty === "tm"));
  const order = stroke.it.map((item) => item.ty);
  assert.ok(order.indexOf("sh") < order.indexOf("tm") && order.indexOf("tm") < order.indexOf("st"), order.join(" "));
  const trim = stroke.it.find((item) => item.ty === "tm");
  const frames = (property) => property.k.map((frame) => frame.s[0]);
  assert.equal(trim.m, 1);
  // Read back: percent and degrees to kino's fractions and turns.
  assert.deepEqual(trim.s, { a: 0, k: 10 });
  assert.deepEqual(frames(trim.e).map((value) => Math.round(value) / 100), [0.1, 0.5, 0.9]);
  assert.deepEqual(frames(trim.o).map((value) => value / 360), [0, 0.25, 0.5]);
  const dash = stroke.it.find((item) => item.ty === "st").d;
  assert.deepEqual(dash.map((item) => [item.n, item.v.k]), [["d", 12], ["g", 6], ["o", 3]]);
  assert.throws(() => lottieShapes(shape, [states[0], { ...states[1], dash: [4, 2, 1, 2] }], "Dash count", helpers), /one dash pattern/);
});

