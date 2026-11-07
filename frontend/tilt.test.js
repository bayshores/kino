// 2.5D tilt (tilt.js): the projection math, the triangle grid, the drawing and the limits.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { TILT_TOLERANCE, tiltDepthProjector, tiltGrid, tiltProjector, tiltTriangles, tiltVisiblePart } from "../engine/tilt.js";
import { tiltFan } from "./liveTilt.js";

test("a tilted plane's corner lands where the perspective math puts it", () => {
  // rotateX 30 alone: the top corner (-500, -300) goes back by 300·sin 30 = 150 px, so with the
  // eye 1600 px away it shrinks by 1600 / 1750 and rises by 300·cos 30 before that.
  const project = tiltProjector({ rotateX: 30, perspective: 1600 });
  const [x, y] = project(-500, -300);
  const w = 1600 / (1600 + 300 * Math.sin(Math.PI / 6));
  assert.ok(Math.abs(x - -500 * w) < 1e-9 && Math.abs(y - -300 * Math.cos(Math.PI / 6) * w) < 1e-9);
  // rotateY -20 brings the right edge toward the eye, so it is drawn taller than the left.
  const turned = tiltProjector({ rotateY: -20 });
  assert.ok(turned(500, 300)[1] > -turned(-500, -300)[1]);
  // Every triangle's affine map hits the projected corners exactly, and the grid keeps the
  // middle of each cell within the tolerance.
  const box = { x: -500, y: -300, width: 1000, height: 600 };
  const { triangles, corners } = tiltTriangles({ rotateX: 30, rotateY: -20 }, box);
  const [a, b, c, d, e, f] = triangles[0].matrix;
  const [px, py] = tiltProjector({ rotateX: 30, rotateY: -20 })(box.x, box.y);
  assert.ok(Math.abs(a * box.x + c * box.y + e - px) < 1e-6 && Math.abs(b * box.x + d * box.y + f - py) < 1e-6);
  assert.deepEqual(corners[0], [px, py]);
  assert.ok(tiltGrid(tiltProjector({ rotateX: 30, rotateY: -20 }), box).error <= TILT_TOLERANCE + 1e-9);
});

test("no tilt draws exactly as before; a tilt draws the layer once per grid triangle", () => {
  const layers = [createLayer("rectangle", { id: "card", x: 100, y: 100, width: 400, height: 240, fill: "#5e6ad2" })];
  const scene = (values) => createScene({ id: "s", width: 640, height: 360, layers: layers.map((layer) => ({ ...layer, ...values })) });
  const flat = renderSceneSvg(scene({}), 0);
  assert.equal(renderSceneSvg(scene({ rotateX: 0, rotateY: 0, perspective: 900 }), 0), flat);
  const tilted = renderSceneSvg(scene({ rotateX: 30, rotateY: -20 }), 0);
  const patterns = tilted.match(/<pattern /g).length;
  assert.ok(patterns >= 2 && tilted.includes('data-tilt-layer-id="card"'));
  assert.equal(tilted.match(/fill="url\(#[^"]*tilt-cell/g).length, patterns, "one filled triangle per pattern");
  // A draft (check and look frames) leaves out the triangles wholly off screen (this card hangs off
  // the right edge) and, at an eighth of the size, allows the grid's error in output pixels; a
  // full-size draft of a card wholly on screen keeps every triangle.
  const steep = scene({ rotateX: 60, rotateY: -50, x: 400 });
  const full = renderSceneSvg(steep, 0).match(/<pattern /g).length;
  const onScreen = renderSceneSvg(steep, 0, { draft: true }).match(/<pattern /g).length;
  const small = renderSceneSvg(steep, 0, { draft: true, rasterScale: { x: 1 / 8, y: 1 / 8 } }).match(/<pattern /g)?.length ?? 0;
  assert.ok(onScreen < full && small > 0 && small < full / 4, `${full}, ${onScreen} on screen, ${small} at 1/8`);
  // A parent's blur can bring off-screen paint back into view: then every triangle stays.
  const blurred = createScene({ id: "s", width: 640, height: 360, layers: [createLayer("group", { id: "g", width: 640, height: 360, blur: 40 }),
    { ...steep.layers[0], parentId: "g" }] });
  assert.equal(renderSceneSvg(blurred, 0, { draft: true }).match(/<pattern /g).length, renderSceneSvg(blurred, 0).match(/<pattern /g).length);
  assert.equal(renderSceneSvg(scene({ rotateX: 30, rotateY: -20 }), 0, { draft: true }), tilted);
});

test("the live picture draws a tilt as one GPU quad of its visible part", () => {
  // The visible part's corners are the projector's, and a plane far larger than the screen is cut to it.
  const state = { rotateX: 52, rotateY: -10, perspective: 1500 };
  const screen = [[-960, -540], [960, -540], [960, 540], [-960, 540]];
  const small = tiltVisiblePart(state, { x: -400, y: -200, width: 800, height: 400 }, screen);
  small.plane.forEach(([u, v], index) => tiltDepthProjector(state)(u, v).slice(0, 3)
    .forEach((value, axis) => assert.ok(Math.abs(value - small.points[index][axis]) < 1e-9)));
  const huge = tiltVisiblePart(state, { x: -6000, y: -6000, width: 12000, height: 12000 }, screen);
  assert.deepEqual(huge.points.map(([x, y]) => [Math.round(x), Math.round(y)]), screen);
  assert.ok(huge.points.every(([, , h]) => h > 0.02), "only the part in front of the eye");
  // Canvas mode (the app's live picture) marks one canvas instead of a triangle per pattern; a
  // linked picture, which an SVG picture cannot load, keeps the triangles.
  const scene = (layer) => createScene({ id: "s", width: 640, height: 360, layers: [createLayer(layer.type, { id: "card", x: 100, y: 100, width: 400, height: 240, rotateX: 30, rotateY: -20, ...layer })] });
  const live = renderSceneSvg(scene({ type: "rectangle", fill: "#5e6ad2" }), 0, { canvas: true });
  assert.equal(live.match(/data-kino-tilt="/g).length, 1);
  assert.ok(!live.includes("<pattern"));
  assert.ok(renderSceneSvg(scene({ type: "image", src: "/api/media/a.png" }), 0, { canvas: true, embedMedia: new Map([["card", "/api/media/a.png"]]) }).includes("<pattern"));
  // The GPU gets a fan of triangles: x y in clip space, the depth, and the bitmap position.
  const fan = tiltFan("0 0 1 10 20 100 0 1 30 20 100 50 0.5 30 40 0 50 0.5 10 40", 100, 50, [10, 20, 20, 20]);
  assert.deepEqual(fan.slice(0, 5), [-1, 1, 1, 0, 0]);
  assert.deepEqual(fan.slice(10, 15), [1, -1, 0.5, 1, 1]);
  assert.equal(fan.length, 2 * 3 * 5);
});

test("tilt values out of range are refused with the reason", () => {
  const save = (values) => parseDocument(JSON.stringify(createDocument({ scenes: [createScene({ id: "s",
    layers: [createLayer("group", { id: "g", ...values })] })] })));
  assert.equal(save({ rotateX: 45, rotateY: -30, perspective: 1200 }).scenes[0].layers[0].rotateX, 45);
  assert.throws(() => save({ rotateX: 90 }), /rotateX: must be a number of degrees from -89 to 89/);
  assert.throws(() => save({ perspective: 10 }), /perspective: must be the eye's distance in px, from 100/);
});

test("Lottie export refuses a tilted layer instead of dropping the tilt", async () => {
  const { exportScene } = await import("../backend/export.mjs");
  const card = createLayer("rectangle", { id: "card", name: "Card", x: 0, y: 0, width: 32, height: 32,
    animations: [{ id: "t", name: "Tilt", kind: "custom", start: 0, duration: 1, from: { rotateX: 0 }, to: { rotateX: 30 } }] });
  const scene = createScene({ id: "s", width: 32, height: 32, duration: 1, layers: [card] });
  await assert.rejects(exportScene(scene, { format: "lottie", fps: 10 }), /Lottie export cannot yet render the 3D tilt \(rotateX, rotateY\) on layer “Card”/);
});
