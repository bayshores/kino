import test from "node:test";
import assert from "node:assert/strict";
import { lottieShapeParts, lottieShapes } from "./lottie-shapes.mjs";
import { pathBounds, serializePath } from "../engine/vectorPath.js";
import { shapeContours } from "../engine/shapes.js";

function property(values, dimension = 1) {
  const normalized = values.map((value) => Array.isArray(value) ? value.slice(0, dimension) : [value]);
  const same = normalized.every((value) => value.length === normalized[0].length &&
    value.every((part, index) => Math.abs(Number(part) - Number(normalized[0][index])) < 1e-7));
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
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(value);
  if (!match) return null;
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
    match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
  ];
}

const helpers = { property, colorToRgba };
const layer = (type, values = {}) => ({
  id: "shape",
  name: "Shape",
  type,
  width: 200,
  height: 100,
  ...values,
});

function shapeItems(group) {
  return group.it.filter((item) => item.ty === "sh");
}

function signedArea(shape) {
  return shape.v.reduce((area, point, index) => {
    const next = shape.v[(index + 1) % shape.v.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function pathFromShape(shape) {
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

function assertSameBounds(actualPath, expectedPath) {
  const actual = pathBounds(actualPath);
  const expected = pathBounds(expectedPath);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${key} stays exact after cubic subdivision`);
  }
}

function assertHeldShapeProperty(propertyValue, expectedTimes) {
  assert.equal(propertyValue.a, 1);
  assert.deepEqual(propertyValue.k.map((frame) => frame.t), expectedTimes);
  propertyValue.k.forEach((frame, index) => {
    if (index > 0) assert.ok(frame.t > propertyValue.k[index - 1].t, "source sample indices remain ordered");
    assert.equal(frame.h, 1, "parametric geometry changes are held at sampled frames");
    assert.deepEqual(frame.s.length, 1);
    assert.equal("e" in frame, false, "held geometry does not request a false vertex interpolation");
    assert.equal("i" in frame, false);
    assert.equal("o" in frame, false);
  });
}

test("independent rectangle corners use layer-space geometry for gradients and original-coordinate strokes", () => {
  const rectangle = layer("rectangle", { width: 100, height: 80 });
  const state = {
    ...rectangle,
    cornerRadii: [10, 20, 30, 40],
    fill: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }],
    },
    stroke: "#ff000080",
    strokeWidth: 4,
  };
  const [strokeGroup, fillGroup] = lottieShapes(rectangle, [state], "Cornered rectangle", helpers);
  const strokePath = shapeItems(strokeGroup)[0].ks.k;
  const gradientPath = shapeItems(fillGroup)[0].ks.k;
  assert.equal(strokePath.c, true);
  assert.equal(strokePath.v.length, 9);
  assert.deepEqual(strokePath.v[0], [10, 0]);
  assert.deepEqual(strokePath.v[1], [80, 0]);
  assert.deepEqual(strokePath.v[2], [100, 20]);
  assert.deepEqual(strokePath.v[4], [70, 80]);
  assert.deepEqual(gradientPath.v[0], [10, 0]);
  assert.deepEqual(gradientPath.v[1], [80, 0]);
  assert.deepEqual(gradientPath.v[2], [100, 20]);
  assert.deepEqual(fillGroup.it.find((item) => item.ty === "gf").s.k, [0, 40]);
  assert.deepEqual(fillGroup.it.find((item) => item.ty === "gf").e.k, [100, 40]);
  assert.deepEqual(fillGroup.it.at(-1).s.k, [100, 100]);
  assert.deepEqual(strokeGroup.it.at(-1).s.k, [100, 100]);
  assert.ok(strokeGroup.it.some((item) => item.ty === "st"));
  assert.ok(fillGroup.it.some((item) => item.ty === "gf"));
});

test("full ellipse annuli keep opposite contour winding for a real nonzero-fill hole", () => {
  const ellipse = layer("ellipse", { width: 120, height: 80, donut: 0.25, sweep: 1, startAngle: 30 });
  const [group] = lottieShapes(ellipse, [{ ...ellipse, fill: "#446688" }], "Donut", helpers);
  const [outer, inner] = shapeItems(group).map((item) => item.ks.k);
  assert.equal(shapeItems(group).length, 2);
  assert.equal(outer.c, true);
  assert.equal(inner.c, true);
  assert.ok(signedArea(outer) > 0, "the outer contour winds clockwise in screen coordinates");
  assert.ok(signedArea(inner) < 0, "the inner contour winds the opposite way so nonzero fill leaves a hole");
  assert.equal(group.it.find((item) => item.ty === "fl").r, 1);
});

test("partial ellipse bands and empty endpoints keep a stable set of held contour slots", () => {
  const ellipse = layer("ellipse", { width: 200, height: 100 });
  const states = [
    { ...ellipse, donut: 0.25, sweep: 0, startAngle: 0, fill: "#336699" },
    { ...ellipse, donut: 0.25, sweep: 0.5, startAngle: 30, fill: "#336699" },
    { ...ellipse, donut: 0.25, sweep: 1, startAngle: 30, fill: "#336699" },
    { ...ellipse, donut: 0, sweep: 1, startAngle: 90, fill: "#336699" },
  ];
  const [group] = lottieShapes(ellipse, states, "Animated ellipse", helpers);
  const paths = shapeItems(group);
  assert.equal(paths.length, 2, "the maximum full-annulus contour count is allocated for every sample");
  assertHeldShapeProperty(paths[0].ks, [0, 1, 2, 3]);
  assertHeldShapeProperty(paths[1].ks, [0, 2, 3]);
  assert.deepEqual(paths[0].ks.k.map((frame) => frame.s[0].v.length), [7, 7, 7, 7]);
  assert.deepEqual(paths[1].ks.k.map((frame) => frame.s[0].v.length), [5, 5, 5]);
  assert.ok(paths[0].ks.k[0].s[0].v.every(([x, y]) => x === 0 && y === 0), "the first empty sweep is padded to the later fixed contour size");
  assert.ok(paths[1].ks.k[0].s[0].v.every(([x, y]) => x === 0 && y === 0), "an initially unused hole slot has the same fixed vertex count");
  assertSameBounds(
    pathFromShape(paths[0].ks.k[1].s[0]),
    serializePath([shapeContours("ellipse", states[1])[0]]),
  );
  assertSameBounds(
    pathFromShape(paths[0].ks.k[2].s[0]),
    serializePath([shapeContours("ellipse", states[2])[0]]),
  );
  assert.equal(signedArea(paths[1].ks.k[0].s[0]), 0, "the initial empty inner contour has zero area");
  assertSameBounds(
    pathFromShape(paths[1].ks.k[1].s[0]),
    serializePath([shapeContours("ellipse", states[2])[1]]),
  );
  assert.ok(signedArea(paths[1].ks.k[1].s[0]) < 0, "the inner annulus contour keeps opposite winding after subdivision");
});

test("ellipse gradients use the full nominal box and strokes keep source coordinates", () => {
  const ellipse = layer("ellipse", { width: 240, height: 120, donut: 0.3, sweep: 0.4, startAngle: 45 });
  const state = {
    ...ellipse,
    fill: {
      type: "radial",
      angle: 0,
      stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }],
    },
    stroke: "#ff0000",
    strokeWidth: 3,
  };
  const [strokeGroup, fillGroup] = lottieShapes(ellipse, [state], "Partial ellipse", helpers);
  const strokePath = shapeItems(strokeGroup)[0].ks.k;
  const gradientPath = shapeItems(fillGroup)[0].ks.k;
  assert.ok(Math.abs(strokePath.v[0][0] - 204.8528137423857) < 1e-9);
  assert.ok(Math.abs(strokePath.v[0][1] - 102.42640687119285) < 1e-9);
  assert.deepEqual(gradientPath.v[0], strokePath.v[0]);
  assert.deepEqual(fillGroup.it.find((item) => item.ty === "gf").s.k, [120, 60]);
  assert.deepEqual(fillGroup.it.find((item) => item.ty === "gf").e.k, [120, -60]);
  assert.deepEqual(fillGroup.it.at(-1).s.k, [100, 100]);
  assert.deepEqual(strokeGroup.it.at(-1).s.k, [100, 100]);
  assert.equal(fillGroup.it.find((item) => item.ty === "gf").t, 2);
});

test("stars are native vector paths and spike-count changes hold every sampled topology", () => {
  const star = layer("star", { width: 100, height: 60 });
  const states = [
    { ...star, spikes: 0, starThickness: 0.382, fill: "#f0a020" },
    { ...star, spikes: 5, starThickness: 0.382, fill: "#f0a020" },
    { ...star, spikes: 6, starThickness: 0.4, fill: "#f0a020" },
    { ...star, spikes: 6, starThickness: 0.4, fill: "#f0a020" },
    { ...star, spikes: 0, starThickness: 0.4, fill: "#f0a020" },
  ];
  const [group] = lottieShapes(star, states, "Star", helpers);
  const [path] = shapeItems(group);
  assertHeldShapeProperty(path.ks, [0, 1, 2, 4]);
  assert.deepEqual(path.ks.k.map((frame) => frame.s[0].v.length), [13, 13, 13, 13]);
  assert.ok(path.ks.k[0].s[0].v.every(([x, y]) => x === 0 && y === 0), "a zero-spike star is padded to the largest sampled point count");
  assert.ok(path.ks.k.at(-1).s[0].v.every(([x, y]) => x === 0 && y === 0), "a final empty star keeps the same topology");
  assertSameBounds(
    pathFromShape(path.ks.k[1].s[0]),
    serializePath(shapeContours("star", states[1])),
  );
  assertSameBounds(
    pathFromShape(path.ks.k[2].s[0]),
    serializePath(shapeContours("star", states[2])),
  );
  assert.equal(group.it.findIndex((item) => item.ty === "st"), -1);
  assert.equal(group.it.find((item) => item.ty === "fl").c.k[0], 0.9411764705882353);
});

test("aligned parametric strokes keep one native topology across zero-width and empty star samples", () => {
  const star = layer("star", { width: 100, height: 60 });
  const states = [
    { ...star, width: 0, spikes: 5, starThickness: 0.382, fill: "#336699", stroke: "#ff000080", strokeWidth: 0, strokeAlign: "inside" },
    { ...star, width: 100, spikes: 6, starThickness: 0.4, fill: "#336699", stroke: "#ff000080", strokeWidth: 4, strokeAlign: "inside" },
    { ...star, width: 100, spikes: 0, starThickness: 0.4, fill: "#336699", stroke: "#ff000080", strokeWidth: 0, strokeAlign: "inside" },
  ];
  const parts = lottieShapeParts(star, states, "Aligned animated star", helpers);
  assert.equal(parts.matteType, 1);
  for (const group of [parts.content[0], parts.stroke[0], parts.matte[0]]) {
    const [shape] = shapeItems(group);
    assertHeldShapeProperty(shape.ks, [0, 1, 2]);
    assert.deepEqual(shape.ks.k.map((frame) => frame.s[0].v.length), [13, 13, 13]);
    assert.ok(shape.ks.k[0].s[0].v.every(([x]) => x === 0), "zero-width input keeps real, collapsed horizontal geometry");
    assert.ok(shape.ks.k[2].s[0].v.every(([x, y]) => x === 0 && y === 0), "an empty star uses the same fixed vertex count");
    assert.deepEqual(group.it.at(-1).s.k, [100, 100]);
  }
  const stroke = parts.stroke[0].it.find((item) => item.ty === "st");
  assert.deepEqual(stroke.w.k.map((frame) => frame.s[0]), [0, 8, 0]);
  assert.deepEqual(stroke.o.k.map((frame) => frame.s[0]), [0, (128 / 255) * 100, 0]);
  const silhouette = parts.matte[0].it.find((item) => item.ty === "fl");
  assert.deepEqual(silhouette.c.k, [1, 1, 1]);
  assert.equal(silhouette.o.k, 100);
});

test("uniform rectangles and complete ellipses retain the compact native Lottie primitives", () => {
  const rectangle = layer("rectangle", { radius: 12 });
  const ellipse = layer("ellipse");
  const [rectangleGroup] = lottieShapes(rectangle, [{ ...rectangle, fill: "#112233" }], "Rectangle", helpers);
  const [ellipseGroup] = lottieShapes(ellipse, [{ ...ellipse, fill: "#112233" }], "Ellipse", helpers);
  assert.equal(rectangleGroup.it.find((item) => item.ty === "rc").r.k, 12);
  assert.ok(ellipseGroup.it.some((item) => item.ty === "el"));
  assert.equal(shapeItems(ellipseGroup).length, 0);
});

test("static 1000-spike stars share one geometry across a 7200-frame export", () => {
  const star = layer("star", { width: 100, height: 100 });
  const state = { ...star, spikes: 1000, starThickness: 0.382, fill: "#336699" };
  const [group] = lottieShapes(star, Array.from({ length: 7200 }, () => state), "Long static star", helpers);
  const [path] = shapeItems(group);
  assert.equal(path.ks.a, 0);
  assert.equal(path.ks.k.v.length, 2001);
});

test("a four-second parametric transition stops writing geometry after its final 0.8-second change", () => {
  const star = layer("star", { width: 100, height: 100 });
  const states = Array.from({ length: 240 }, (_, index) => ({
    ...star,
    spikes: 5,
    starThickness: index <= 48 ? 0.2 + index * 0.001 : 0.248,
    fill: "#336699",
  }));
  const [group] = lottieShapes(star, states, "Short transition", helpers);
  const [path] = shapeItems(group);
  assert.equal(path.ks.a, 1);
  assert.equal(path.ks.k.length, 49);
  assert.equal(path.ks.k[0].t, 0);
  assert.equal(path.ks.k.at(-1).t, 48, "the last geometry change is held for the rest of the four-second scene");
  assert.equal(path.ks.k.some((frame) => frame.t === 239), false);
});

test("a short change to a high-spike star stays within the serialized geometry budget across 7200 frames", () => {
  const star = layer("star", { width: 100, height: 100 });
  const states = Array.from({ length: 7200 }, (_, index) => ({
    ...star,
    spikes: index === 0 ? 999 : 1000,
    starThickness: 0.382,
    fill: "#336699",
  }));
  const [group] = lottieShapes(star, states, "Held high-spike star", helpers);
  const [path] = shapeItems(group);
  assertHeldShapeProperty(path.ks, [0, 1]);
  assert.deepEqual(path.ks.k.map((frame) => frame.t), [0, 1]);
  assert.deepEqual(path.ks.k.map((frame) => frame.s[0].v.length), [2001, 2001]);
});

test("large changing parametric geometry fails clearly before building an oversized Lottie path", () => {
  const star = layer("star", { width: 100, height: 100 });
  const states = Array.from({ length: 300 }, (_, index) => ({
    ...star,
    spikes: 1000,
    starThickness: index / 300,
    fill: "#336699",
  }));
  assert.throws(
    () => lottieShapes(star, states, "Oversized animation", helpers),
    /too much per-frame parametric geometry.*limit 500,000 shape vertices/,
  );
});

test("aligned parametric output rejects aggregate changing geometry above the native limit", () => {
  const star = layer("star", { width: 100, height: 100 });
  const states = Array.from({ length: 84 }, (_, index) => ({
    ...star,
    spikes: 1000,
    starThickness: index / 84,
    fill: "#336699",
    stroke: "#ff0000",
    strokeWidth: 4,
    strokeAlign: "outside",
  }));
  assert.throws(
    () => lottieShapeParts(star, states, "Large aligned star", helpers),
    /too much changing stroke geometry.*limit 500,000 shape vertices/,
  );
});
