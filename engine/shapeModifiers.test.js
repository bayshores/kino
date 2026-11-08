import test from "node:test";
import assert from "node:assert/strict";
import { renderSceneSvg } from "./render.js";
import { createLayer, createScene, parseDocument, createDocument } from "./model.js";
import { modifyContours } from "./shapeModifiers.js";
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
  const zero = layers.map((layer) => ({ ...layer, zigzagSize: 0, zigzagCount: 9, offsetAmount: 0, offsetJoin: "round" }));
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
