import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { EDGE_EFFECTS, renderEdgeFill, renderKaleidoscope, renderMirror } from "./edges.js";

const WIDTH = 160;
const HEIGHT = 120;
const BOX = { x: 60, y: 45, width: 40, height: 30 };
// A layer whose left half is red and right half is blue, with a green stripe along its top.
const HALVES = '<rect x="60" y="45" width="20" height="30" fill="#ff0000"/><rect x="80" y="45" width="20" height="30" fill="#0000ff"/><rect x="60" y="45" width="40" height="5" fill="#00ff00"/>';

function draw(render, parameters, { content = HALVES, bounds = BOX, paintBounds } = {}) {
  let sequence = 0;
  const defs = [], included = [];
  const frame = { content, bounds, ...(paintBounds ? { paintBounds } : {}), parameters, time: 0, progress: 0.5,
    helpers: { id: (kind) => `edge-${kind}-${++sequence}`, defs, includeBounds: (box) => included.push(box) } };
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#000000"/><defs>${defs.join("")}</defs>${output}</svg>`;
  const pixels = new Resvg(svg).render().pixels;
  const pixel = (x, y) => [...pixels.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
  return { frame, output, defs, included, pixel };
}

const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${label}: ${actual} is not about ${expected}`);
const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 255, 0], BLACK = [0, 0, 0];

test("edge fill, mirror and kaleidoscope are ranged Distortion effects with checked controls", () => {
  assert.deepEqual(EDGE_EFFECTS.map(({ key, group, kind }) => `${key}:${group}:${kind}`),
    ["edge-fill:Distortion:ranged", "mirror:Distortion:ranged", "kaleidoscope:Distortion:ranged"]);
  const frame = { content: HALVES, bounds: BOX, parameters: { extend: 0 }, helpers: { id: () => "x", defs: [] } };
  assert.equal(renderEdgeFill(frame), HALVES, "edge fill with extend 0 draws the layer as it is");
  assert.equal(frame.helpers.defs.length, 0);
  assert.throws(() => draw(renderEdgeFill, { mode: "wrap" }), /edge-fill.mode must be mirror or tile/);
  assert.throws(() => draw(renderEdgeFill, { extend: 3.5 }), /edge-fill.extend must be a number from 0 to 3/);
  assert.throws(() => draw(renderKaleidoscope, { segments: 6.5 }), /kaleidoscope.segments must be an integer/);
  assert.throws(() => draw(renderMirror, { centerX: 3 }), /mirror.centerX/);
});

test("edge fill in mirror mode continues the picture across each edge; tile mode repeats it", () => {
  const mirrored = draw(renderEdgeFill, { mode: "mirror", extend: 1 });
  // Just past the right edge the picture is flipped, so blue continues; past the left edge, red.
  near(mirrored.pixel(102, 60), BLUE, "right of the layer");
  near(mirrored.pixel(58, 60), RED, "left of the layer");
  // Below the layer the next cell is flipped upside down, so its green stripe sits at the far side.
  near(mirrored.pixel(70, 77), RED, "just below");
  near(mirrored.pixel(70, 102), GREEN, "the flipped stripe at the bottom of the cell below");
  // The fill reaches one layer size past each edge and no further.
  // The top-left cell is flipped both ways: its bottom-right corner touches the layer's top-left.
  near(mirrored.pixel(21, 16), BLUE, "top-left corner cell, far from the layer");
  near(mirrored.pixel(56, 41), GREEN, "top-left corner cell, near the layer's corner");
  near(mirrored.pixel(18, 60), BLACK, "outside the filled area");
  assert.deepEqual(mirrored.included, [{ x: 20, y: 15, width: 120, height: 90 }]);

  const tiled = draw(renderEdgeFill, { mode: "tile", extend: 1 });
  near(tiled.pixel(102, 60), RED, "the next tile starts with red");
  near(tiled.pixel(58, 60), BLUE, "the tile before ends with blue");
  near(tiled.pixel(70, 77), GREEN, "the tile below starts with the stripe");
});

test("edge fill joins its cells with no dark seam", () => {
  // A plain orange layer filled out by mirror and by tile cells, at a size that puts the joints
  // between pixels: every pixel of the filled area is the layer's colour.
  const content = '<rect x="60.3" y="45.6" width="40.2" height="30.7" fill="#ff8800"/>';
  const bounds = { x: 60.3, y: 45.6, width: 40.2, height: 30.7 };
  for (const mode of ["mirror", "tile"]) {
    const { pixel } = draw(renderEdgeFill, { mode, extend: 1 }, { content, bounds });
    for (let y = 18; y < 104; y += 1) for (let x = 22; x < 139; x += 1) near(pixel(x, y), [255, 136, 0], `${mode} pixel (${x}, ${y})`, 2);
  }
});

test("paint past the layer box is cut at each cell's edge", () => {
  // The picture's stroke reaches 4 px past its box; the cells are the box, so the stroke is not repeated.
  const content = '<rect x="60" y="45" width="40" height="30" fill="#ff0000" stroke="#ffffff" stroke-width="8"/>';
  const { pixel, defs } = draw(renderEdgeFill, { mode: "tile", extend: 1 }, { content, paintBounds: { x: 56, y: 41, width: 48, height: 38 } });
  assert.ok(defs.some((def) => def.includes("edge-cell")), "a cell clip");
  near(pixel(80, 60), RED, "the layer");
  near(pixel(130, 60), RED, "inside the next tile");
  near(pixel(98, 60), [255, 255, 255], "the layer's stroke inside its box");
  near(pixel(101, 60), [255, 255, 255], "the next tile's stroke inside its box");
  near(pixel(106, 60), RED, "the next tile, past its stroke");
});

test("mirror keeps one side of a line and reflects it onto the other", () => {
  near(draw(renderMirror, { angle: 0 }).pixel(95, 60), RED, "angle 0 keeps the left half");
  near(draw(renderMirror, { angle: 180 }).pixel(65, 60), BLUE, "angle 180 keeps the right half");
  const top = draw(renderMirror, { angle: 90 });
  near(top.pixel(70, 72), GREEN, "angle 90 keeps the top half and reflects the stripe to the bottom");
  near(top.pixel(70, 60), RED, "the middle row is still red");
  // The joint along the line has no dark seam.
  const left = draw(renderMirror, { angle: 0, centerX: 0.5 });
  for (let y = 52; y < 74; y += 1) near(left.pixel(80, y), RED, `on the line at y=${y}`);
  // The result stays inside the layer's painted area.
  near(left.pixel(102, 60), BLACK, "outside the layer");
});

test("a kaleidoscope repeats one wedge around its centre, every other wedge mirrored", () => {
  // A centred disc with a coloured quarter: with 4 segments the result looks the same after a quarter turn.
  const content = '<circle cx="80" cy="60" r="28" fill="#ffffff"/><path d="M80 60h28v28z" fill="#ff0000"/><path d="M80 60v-28h-28z" fill="#0000ff"/>';
  const bounds = { x: 52, y: 32, width: 56, height: 56 };
  const { pixel, defs } = draw(renderKaleidoscope, { segments: 4, angle: 10 }, { content, bounds });
  assert.equal(defs.filter((def) => def.includes("kaleidoscope-wedge")).length, 1);
  // The pixel 20 px from the centre in a direction (degrees, clockwise from the right). Directions
  // are chosen at least 5° from every wedge edge and every colour edge.
  const at = (degrees) => pixel(Math.floor(80 + 20 * Math.cos(degrees * Math.PI / 180)), Math.floor(60 + 20 * Math.sin(degrees * Math.PI / 180)));
  for (const degrees of [20, 30, 50, 60, 80, 115, 205, 260, 300]) near(at(degrees + 90), at(degrees), `${degrees}° and a quarter turn on`, 6);
  // The wedge from 10° to 55° is the picture as it was: red up to the red triangle's edge at 45°, white after.
  near(at(30), RED, "30°");
  near(at(50), [255, 255, 255], "50°");
  // The wedge beside it is its mirror image about 55°: white to 65°, red after.
  near(at(60), [255, 255, 255], "60°");
  near(at(80), RED, "80°");
});
