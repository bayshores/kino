import test from "node:test";
import assert from "node:assert/strict";
import { renderSceneSvg } from "./render.js";
import { createLayer, createScene, parseDocument, createDocument } from "./model.js";
import { OUTLINE_LIMIT, modifierReach, modifyContours } from "./shapeModifiers.js";
import { shapeContours } from "./shapes.js";
import { parsePath, pathBounds } from "./vectorPath.js";

const scene = (layers) => createScene({ id: "s", width: 400, height: 400, background: "#000000", layers });
const square = (more = {}) => ({ type: "rectangle", width: 100, height: 100, ...more });
const vertices = (contours) => contours.reduce((sum, contour) => sum + contour.segments.length, 0);

test("old shapes draw the same markup; zero amounts are no modifier", () => {
  const layers = [
    createLayer("rectangle", { id: "r", x: 10, y: 20, width: 80, height: 40, radius: 8, stroke: "#ffffff", strokeWidth: 4 }),
    createLayer("ellipse", { id: "e", x: 120, y: 20, width: 60, height: 60 }),
    createLayer("star", { id: "t", x: 200, y: 20, width: 60, height: 60 }),
    createLayer("path", { id: "p", x: 10, y: 200, width: 100, height: 100, path: "M0 0L100 0L50 100Z" }),
  ];
  const before = renderSceneSvg(scene(layers), 0);
  const zero = layers.map((layer) => ({ ...layer, zigzagSize: 0, zigzagCount: 9, offsetAmount: 0, offsetJoin: "round",
    roundCorners: 0, bloatAmount: 0, twistAngle: 0, twistX: 30, twistY: -10 }));
  assert.equal(renderSceneSvg(scene(zero), 0), before);
});

test("a zig zag adds two points per tooth on each side", () => {
  const contours = shapeContours("rectangle", square());
  for (const count of [1, 3, 7]) {
    const zig = modifyContours(contours, square({ zigzagSize: 5, zigzagCount: count }));
    assert.equal(vertices(zig), 4 * count * 2, `count ${count}`);
  }
  // A star's 10 edges.
  const star = { type: "star", width: 100, height: 100 };
  assert.equal(vertices(modifyContours(shapeContours("star", star), { ...star, zigzagSize: 4, zigzagCount: 2 })), 10 * 4);
  // Peaks sit on the corners, pushed outward; smooth points make curves through the same points.
  const box = pathBounds(renderPath(square({ zigzagSize: 10, zigzagCount: 2 })));
  assert.ok(box.x < -5 && box.width > 110, JSON.stringify(box));
  const smooth = modifyContours(contours, square({ zigzagSize: 10, zigzagCount: 2, zigzagPoints: "smooth" }));
  assert.equal(vertices(smooth), 16);
  assert.ok(smooth[0].segments.some((s) => Math.abs(s.c1[0] - s.end[0]) > 1 && Math.abs(s.c1[1] - s.end[1]) > 1));
});

function renderPath(state) {
  return modifyContours(shapeContours(state.type, state), state).map((c) => [c.start, ...c.segments.map((s) => s.end)]
    .map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("") + "Z").join("");
}

test("an offset grows a rectangle's box by the amount; a negative one shrinks it", () => {
  for (const join of ["miter", "round", "bevel"]) {
    const box = pathBounds(renderPath(square({ offsetAmount: 12, offsetJoin: join })));
    for (const [key, value] of Object.entries({ x: -12, y: -12, width: 124, height: 124 }))
      assert.ok(Math.abs(box[key] - value) < 1e-6, `${join} ${key} ${box[key]}`);
  }
  // Miter keeps 4 corners, bevel cuts each in two, round adds arc points.
  const count = (join) => vertices(modifyContours(shapeContours("rectangle", square()), square({ offsetAmount: 12, offsetJoin: join })));
  assert.equal(count("miter"), 4);
  assert.equal(count("bevel"), 8);
  assert.ok(count("round") > 8);
  const shrunk = pathBounds(renderPath(square({ offsetAmount: -10 })));
  assert.ok(Math.abs(shrunk.x - 10) < 1e-6 && Math.abs(shrunk.width - 80) < 1e-6);
  assert.equal(modifyContours(shapeContours("rectangle", square()), square({ offsetAmount: -60 })).length, 0, "shrunk past its middle: gone");
  // A circle grows evenly.
  const circle = { type: "ellipse", width: 100, height: 100, offsetAmount: 10 };
  const round = pathBounds(renderPath(circle));
  assert.ok(Math.abs(round.width - 120) < 0.5, round.width);
});

test("the render draws the modified outline, and the document keeps and checks the fields", () => {
  const layer = createLayer("rectangle", { id: "r", x: 100, y: 100, width: 100, height: 100, fill: "#ffffff",
    zigzagSize: 6, zigzagCount: 4, zigzagPoints: "smooth", offsetAmount: 3, offsetJoin: "bevel" });
  const svg = renderSceneSvg(scene([layer]), 0);
  assert.doesNotMatch(svg, /<rect x="0" y="0" width="100"/);
  const d = svg.match(/<path d="(M[^"]+)"[^>]*fill="#ffffff"/)?.[1];
  assert.ok(d && parsePath(d)[0].segments.length > 16, "a path with the teeth");
  const doc = createDocument({ scenes: [scene([layer])] });
  const parsed = parseDocument(JSON.stringify(doc));
  assert.equal(parsed.scenes[0].layers[0].offsetJoin, "bevel");
  assert.throws(() => parseDocument(JSON.stringify(createDocument({ scenes: [scene([{ ...layer, offsetJoin: "sharp" }])] }))), /offsetJoin/);
  assert.throws(() => parseDocument(JSON.stringify(createDocument({ scenes: [scene([createLayer("text", { id: "t", zigzagSize: 3 })])] }))), /zigzagSize/);
});

const anchorsOf = (contours) => contours.flatMap((c) => [c.start, ...c.segments.map((s) => s.end)]);
const curveBox = (contours) => pathBounds(contours.map((c) => `M${c.start}` + c.segments.map((s) => `C${s.c1} ${s.c2} ${s.end}`).join("") + "Z").join(""));

test("round corners add one curve per sharp corner, meet the sides smoothly and stay inside", () => {
  const star = { type: "star", width: 100, height: 100, roundCorners: 8 };
  const rounded = modifyContours(shapeContours("star", star), star);
  assert.equal(vertices(rounded), 20, "10 sides and 10 corners");
  const segments = rounded[0].segments;
  segments.forEach((segment, i) => {
    const next = segments[(i + 1) % segments.length];
    const into = [segment.end[0] - segment.c2[0], segment.end[1] - segment.c2[1]], out = [next.c1[0] - segment.end[0], next.c1[1] - segment.end[1]];
    assert.ok(Math.abs(into[0] * out[1] - into[1] * out[0]) / (Math.hypot(...into) * Math.hypot(...out)) < 1e-6, `join ${i} is smooth`);
  });
  const triangle = { type: "path", width: 100, height: 100, path: "M0 100L50 0L100 100Z", roundCorners: 20 };
  const box = curveBox(modifyContours(parsePath(triangle.path), triangle));
  assert.ok(box.y > 1 && box.x > 1 && box.x + box.width < 99 && Math.abs(box.y + box.height - 100) < 1e-6, JSON.stringify(box));
  // Already round corners are left alone.
  const pill = square({ radius: 20, roundCorners: 40 });
  assert.deepEqual(curveBox(modifyContours(shapeContours("rectangle", pill), pill)), { x: 0, y: 0, width: 100, height: 100 });
});

test("a bloat pulls points in and pushes sides out; a pucker does the reverse", () => {
  const bloat = modifyContours(shapeContours("rectangle", square()), square({ bloatAmount: 0.5 }));
  assert.deepEqual(anchorsOf(bloat).map(([x, y]) => [Math.round(x), Math.round(y)]).slice(0, 4), [[25, 25], [75, 25], [75, 75], [25, 75]]);
  const box = curveBox(bloat);
  assert.ok(Math.abs(box.y + 12.5) < 1e-6 && Math.abs(box.height - 125) < 1e-6, JSON.stringify(box));
  const pucker = modifyContours(shapeContours("rectangle", square()), square({ bloatAmount: -0.5 }));
  assert.deepEqual(curveBox(pucker), { x: -25, y: -25, width: 150, height: 150 });
});

test("a twist keeps each point's distance from its center and turns the farthest the whole angle", () => {
  for (const [twistX, twistY] of [[0, 0], [20, -10]]) {
    const state = square({ twistAngle: 90, twistX, twistY });
    const center = [50 + twistX, 50 + twistY];
    const base = shapeContours("rectangle", square());
    const twisted = modifyContours(base, state);
    const far = Math.max(...anchorsOf(twisted).map(([x, y]) => Math.hypot(x - center[0], y - center[1])));
    const baseFar = Math.max(...[[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => Math.hypot(x - center[0], y - center[1])));
    assert.ok(Math.abs(far - baseFar) < 1e-6);
    assert.ok(vertices(twisted) > 100, "fine pieces");
  }
  // The corner (0, 0) turns 90 degrees around the middle to (100, 0).
  const twisted = modifyContours(shapeContours("rectangle", square()), square({ twistAngle: 90 }));
  assert.ok(anchorsOf(twisted).some(([x, y]) => Math.hypot(x - 100, y) < 1e-6));
});

test("every modifier stays inside the box grown by its reach", () => {
  const cases = [square({ bloatAmount: 1 }), square({ bloatAmount: -1 }), square({ twistAngle: 270, twistX: 60, twistY: -40 }),
    { type: "star", width: 160, height: 90, roundCorners: 30, bloatAmount: 0.6, twistAngle: -120, zigzagSize: 6, offsetAmount: 8 }];
  for (const state of cases) {
    const reach = modifierReach(state), box = curveBox(modifyContours(shapeContours(state.type, state), state));
    assert.ok(box.x >= -reach - 1e-6 && box.y >= -reach - 1e-6 && box.x + box.width <= state.width + reach + 1e-6 &&
      box.y + box.height <= state.height + reach + 1e-6, JSON.stringify({ state, reach, box }));
  }
  assert.throws(() => parseDocument(JSON.stringify(createDocument({ scenes: [scene([createLayer("star", { id: "s", bloatAmount: 1.5 })])] }))), /bloatAmount/);
  assert.throws(() => parseDocument(JSON.stringify(createDocument({ scenes: [scene([createLayer("text", { id: "t", twistAngle: 30 })])] }))), /twistAngle/);
});

test("a zig zag after a twist keeps its teeth per side, and big outlines stay drawable", () => {
  const state = square({ width: 400, height: 400, zigzagSize: 4, zigzagCount: 10, twistAngle: 45 });
  assert.equal(vertices(modifyContours(shapeContours("rectangle", state), state)), 4 * 10 * 2);
  const layers = [createLayer("rectangle", { id: "r", width: 400, height: 400, zigzagSize: 4, zigzagCount: 10, twistAngle: 45 }),
    createLayer("star", { id: "s", width: 600, height: 600, spikes: 1000, zigzagSize: 5, zigzagCount: 100, twistAngle: 3600, offsetAmount: 6, offsetJoin: "round" }),
    createLayer("star", { id: "t", width: 1600, height: 1600, spikes: 1000, starThickness: 0.5, roundCorners: 3, offsetAmount: 6, offsetJoin: "round" })];
  assert.match(renderSceneSvg(scene(layers), 0), /<path d="M/);
  for (const layer of layers) assert.ok(vertices(modifyContours(shapeContours(layer.type, layer), layer)) <= OUTLINE_LIMIT, layer.id);
});

test("an offset of a cusp or a tight twist stays inside its reach", () => {
  const cases = [square({ width: 400, height: 400, bloatAmount: -1, offsetAmount: -5 }), square({ width: 160, bloatAmount: -1, offsetAmount: -5 }),
    square({ width: 160, twistAngle: 720, offsetAmount: 15 }), square({ width: 160, zigzagSize: 10, twistAngle: 180, offsetAmount: 15, roundCorners: 20 }),
    square({ width: 300, twistAngle: 150, offsetAmount: -8, offsetJoin: "round" }), { type: "star", width: 200, height: 200, bloatAmount: -1, offsetAmount: 10, offsetJoin: "bevel" }];
  for (const state of cases) {
    const contours = modifyContours(shapeContours(state.type, state), state), reach = modifierReach(state);
    assert.ok(contours.length, JSON.stringify(state));
    const box = curveBox(contours);
    assert.ok(box.x >= -reach - 1e-6 && box.y >= -reach - 1e-6 && box.x + box.width <= state.width + reach + 1e-6 &&
      box.y + box.height <= state.height + reach + 1e-6, JSON.stringify({ state, reach, box }));
  }
});
