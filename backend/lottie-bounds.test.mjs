import test from "node:test";
import assert from "node:assert/strict";
import { compositionBounds } from "./lottie-bounds.mjs";
import { pathBounds } from "../engine/vectorPath.js";
import { evaluateLayer } from "../engine/animation.js";
import { renderSceneSvg } from "../engine/render.js";
import { Resvg } from "@resvg/resvg-js";

function layer(type, values = {}) {
  return {
    id: values.id ?? type,
    name: values.id ?? type,
    type,
    fillEnabled: type !== "group",
    visible: true,
    x: 0,
    y: 0,
    width: 20,
    height: 10,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    strokeWidth: 0,
    ...values,
  };
}

function localMatrix(value, state) {
  const width = Number(state.width ?? 0);
  const height = Number(state.height ?? 0);
  const rotation = (Number(state.rotation ?? 0) * Math.PI) / 180;
  const sx = Number(state.scaleX ?? 1);
  const sy = Number(state.scaleY ?? 1);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const cx = width / 2;
  const cy = height / 2;
  return [
    a,
    b,
    c,
    d,
    Number(state.x ?? 0) + cx - a * cx - c * cy,
    Number(state.y ?? 0) + cy - b * cx - d * cy,
  ];
}

function multiplyMatrix(parent, child) {
  const [a, b, c, d, e, f] = parent;
  const [g, h, i, j, k, l] = child;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function helpers(stateFor = (value) => value) {
  return {
    sampleLayer: (value, times) => times.map((time) => stateFor(value, time)),
    localMatrix,
    multiplyMatrix,
  };
}

function node(value, children = []) {
  return { layer: value, children };
}

function alphaBounds(pixels, width, height) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function assertRasterFitsBounds(raster, bounds, label) {
  const tolerance = 1;
  assert.ok(raster.x >= bounds.x - tolerance, `${label} raster left ${raster.x} is inside measured bound ${bounds.x}`);
  assert.ok(raster.y >= bounds.y - tolerance, `${label} raster top ${raster.y} is inside measured bound ${bounds.y}`);
  assert.ok(raster.x + raster.width <= bounds.x + bounds.width + tolerance, `${label} raster right fits measured bounds`);
  assert.ok(raster.y + raster.height <= bounds.y + bounds.height + tolerance, `${label} raster bottom fits measured bounds`);
}

test("bounds include children with negative coordinates", () => {
  const result = compositionBounds(
    [node(layer("rectangle", { x: -25, y: -10, width: 40, height: 20 }))],
    [0],
    helpers(),
  );
  assert.deepEqual(result, { x: -25, y: -10, width: 40, height: 20 });
});

test("nested rotation and non-uniform scale are composed in local space", () => {
  const nested = node(
    layer("group", { id: "outer", x: 10, y: 20, width: 100, height: 50, rotation: 90, scaleX: 2, scaleY: 1 }),
    [node(
      layer("group", { id: "inner", x: 5, y: -3, width: 40, height: 30, scaleX: 0.5, scaleY: 2 }),
      [node(layer("rectangle", { id: "content", x: -4, y: 3, width: 10, height: 6 }))],
    )],
  );
  const result = compositionBounds([nested], [0], helpers());
  assert.deepEqual(result, { x: 85, y: -29, width: 12, height: 10 });
});

test("animated bounds include both sampled endpoints", () => {
  const moving = layer("rectangle", { id: "moving", y: 4, width: 10, height: 5 });
  const sampled = helpers((value, time) => ({
    ...value,
    x: time === 0 ? -20 : 50,
  }));
  const result = compositionBounds([node(moving)], [0, 1], sampled);
  assert.deepEqual(result, { x: -20, y: 4, width: 80, height: 5 });
});

test("path bounds use the exact cubic curve extrema and renderer size scaling", () => {
  const path = "M-50 0 C-50 100 50 100 50 0";
  const measured = pathBounds(path);
  assert.equal(measured.width, 100);
  assert.equal(measured.height, 75);
  const result = compositionBounds(
    [node(layer("path", {
      id: "curve",
      x: 10,
      y: -4,
      width: 200,
      height: 150,
      path,
      pathBounds: measured,
    }))],
    [0],
    helpers(),
  );
  assert.deepEqual(result, { x: -90, y: -4, width: 200, height: 150 });
});

test("clipped groups contribute only their animated clip rectangle", () => {
  const clipped = node(
    layer("group", { id: "clip", x: 10, y: 20, width: 20, height: 10, clipContent: true }),
    [node(layer("rectangle", { id: "outside", x: -100, y: -100, width: 500, height: 500 }))],
  );
  const result = compositionBounds([clipped], [0], helpers());
  assert.deepEqual(result, { x: 10, y: 20, width: 20, height: 10 });
});

test("composition bounds include actual rendered acute miters and keep inside stroke bounds exact", () => {
  const path = "M0 50 L100 50 L0 76 Z";
  const width = 500;
  const height = 500;
  const origin = { x: 160, y: 160 };
  const pathBoundsExpected = { x: origin.x, y: origin.y + 50, width: 100, height: 26 };
  const rasterBounds = {};
  for (const strokeAlign of ["center", "outside", "inside"]) {
    const value = layer("path", {
      id: `acute-${strokeAlign}`,
      x: origin.x,
      y: origin.y,
      width: 100,
      height: 26,
      path,
      fill: "none",
      stroke: "#111111",
      strokeWidth: 8,
      strokeAlign,
    });
    const composition = compositionBounds([node(value)], [0], helpers());
    const svg = renderSceneSvg({ width, height, background: "transparent", layers: [value] });
    const pixels = new Resvg(svg).render().pixels;
    const raster = alphaBounds(pixels, width, height);
    assert.ok(raster, `${strokeAlign} SVG paints real stroke pixels`);
    assertRasterFitsBounds(raster, composition, strokeAlign);
    rasterBounds[strokeAlign] = raster;
    if (strokeAlign === "inside") {
      assert.deepEqual(composition, pathBoundsExpected, "inside stroke does not expand the path's measured composition bounds");
      assertRasterFitsBounds(raster, pathBoundsExpected, "inside");
    }
  }
  assert.ok(rasterBounds.center.x < pathBoundsExpected.x || rasterBounds.center.y < pathBoundsExpected.y, "center stroke paints beyond at least one path edge");
  assert.ok(rasterBounds.outside.x < pathBoundsExpected.x || rasterBounds.outside.y < pathBoundsExpected.y, "outside stroke paints beyond at least one path edge");
  assert.ok(rasterBounds.outside.x < rasterBounds.center.x || rasterBounds.outside.y < rasterBounds.center.y, "outside stroke reaches farther than centered stroke on an acute miter");
});

test("text bounds include wrapped lines and glyphs wider than the layer box", () => {
  const text = layer("text", {
    id: "overflow",
    x: 2,
    y: 5,
    width: 10,
    height: 5,
    text: "WWWW",
    fontSize: 20,
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
  });
  const result = compositionBounds([node(text)], [0], helpers());
  assert.ok(result.width > text.width, `expected text bounds to exceed ${text.width}px, got ${result.width}px`);
  assert.ok(result.height > text.height, `expected wrapped text bounds to exceed ${text.height}px, got ${result.height}px`);
  assert.ok(result.x >= text.x, "real Inter W bearings do not need an estimated safety margin");
  assert.ok(result.y >= text.y, "the line box puts Inter's ink below its top edge");
  assert.ok(result.width < 30, "exact glyph metrics keep the composition close to actual text ink");
});

test("a hidden static subtree and empty input return a minimal finite composition", () => {
  const hidden = node(layer("group", { id: "hidden", visible: false }), [
    node(layer("rectangle", { id: "also-hidden", x: -100, y: -100, width: 300, height: 300 })),
  ]);
  assert.deepEqual(compositionBounds([hidden], [0], helpers()), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(compositionBounds([], [], helpers()), { x: 0, y: 0, width: 1, height: 1 });
});

test("unclipped text bounds include late units still at a staggered position", () => {
  const text = layer("text", {fontFamily: "Inter", fontSize: 20, fontWeight: 400, text: "AB", lineHeight: 1.2, textResize: "width-height", width: 30, height: 24,
    animations: [{id: "move", kind: "in", start: 0, duration: 1, easing: "linear", unit: "letters", stagger: 1, order: "forward", from: {x: -100}, to: {x: 0}}],
  });
  const helper = helpers();
  helper.sampleLayer = (value, times, unitIndex = 0, unitCount = 1, unit = "layer") => times.map((time) => ({...value, ...evaluateLayer(value, time, {unitIndex, unitCount, unit})}));
  const result = compositionBounds([node(text)], [1], helper);
  assert.ok(result.x <= -99, `the delayed B must fit while A has reached x=0: ${JSON.stringify(result)}`);
  assert.ok(result.x + result.width > 20, "the first unit's finished position must also fit");
});
