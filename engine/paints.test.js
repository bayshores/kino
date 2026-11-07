import test from "node:test";
import assert from "node:assert/strict";
import { animationListProblem } from "./animationListCheck.js";
import {
  animatesFill,
  fillAnimationEditProblem,
  fillAnimationProblem,
  gradientCoordinates,
  isFillEnabled,
  pathGradientBounds,
  withVisibleFill,
} from "./paints.js";

test("collapsed path axes use the positive local layer box for linear and radial gradients", () => {
  const localBox = { x: 0, y: 0, width: 100, height: 20, rotation: 73, scaleX: 2, scaleY: 0.5 };
  const horizontal = { x: 0, y: 10, width: 100, height: 0 };
  const bounds = pathGradientBounds(horizontal, localBox);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 100, height: 20 });
  assert.deepEqual(horizontal, { x: 0, y: 10, width: 100, height: 0 }, "source bounds stay unchanged");
  const diagonal = gradientCoordinates({ type: "linear", angle: 45 }, bounds);
  assert.ok(Math.abs(diagonal.start[0] - 40) < 1e-12);
  assert.equal(diagonal.start[1], 0);
  assert.ok(Math.abs(diagonal.end[0] - 60) < 1e-12);
  assert.equal(diagonal.end[1], 20);
  const vertical = pathGradientBounds({ x: 10, y: 0, width: 0, height: 100 }, { width: 20, height: 100 });
  assert.deepEqual(vertical, { x: 0, y: 0, width: 20, height: 100 });
  assert.deepEqual(gradientCoordinates({ type: "radial" }, vertical), { start: [10, 50], end: [10, 40] });
});

test("path gradient fallback preserves non-collapsed origins and uses the current resized local box", () => {
  assert.deepEqual(pathGradientBounds({ x: -80, y: 20, width: 200, height: 0 }, { width: 200, height: 40 }),
    { x: -80, y: 0, width: 200, height: 40 });
  assert.deepEqual(pathGradientBounds({ x: 10, y: -30, width: 0, height: 120 }, { width: 40, height: 120 }),
    { x: 0, y: -30, width: 40, height: 120 });
  const nonCollapsed = { x: -20, y: 15, width: 70, height: 90 };
  assert.deepEqual(pathGradientBounds(nonCollapsed, { width: 100, height: 100 }), nonCollapsed);
});

test("linear gradient endpoints follow horizontal and vertical angle semantics", () => {
  const horizontal = gradientCoordinates(
    { type: "linear", angle: 0 },
    { x: 0, y: 0, width: 200, height: 100 },
  );
  assert.deepEqual(horizontal, { start: [0, 50], end: [200, 50] });

  const vertical = gradientCoordinates(
    { type: "linear", angle: 90 },
    { x: 0, y: 0, width: 200, height: 100 },
  );
  assert.ok(Math.abs(vertical.start[0] - 100) < 1e-12);
  assert.ok(Math.abs(vertical.end[0] - 100) < 1e-12);
  assert.ok(Math.abs(vertical.start[1]) < 1e-12);
  assert.ok(Math.abs(vertical.end[1] - 100) < 1e-12);
});

test("linear endpoints translate and resize with the final layer bounds", () => {
  const { start, end } = gradientCoordinates(
    { type: "linear", angle: 30 },
    { x: 15, y: 25, width: 80, height: 40 },
  );
  assert.ok(Math.abs(start[0] - (55 - 20 * Math.sqrt(3))) < 1e-12);
  assert.equal(start[1], 25);
  assert.ok(Math.abs(end[0] - (55 + 20 * Math.sqrt(3))) < 1e-12);
  assert.equal(end[1], 65);
});

test("radial gradient uses the bounds center and a circular radius based on half the width", () => {
  const coordinates = gradientCoordinates(
    { type: "radial" },
    { x: 10, y: 20, width: 200, height: 100 },
  );
  assert.deepEqual(coordinates, { start: [110, 70], end: [110, -30] });
  const radius = Math.hypot(
    coordinates.end[0] - coordinates.start[0],
    coordinates.end[1] - coordinates.start[1],
  );
  assert.equal(radius, 100);
});

test("non-finite inputs fall back to zero without mutating source values", () => {
  const paint = { type: "linear", angle: Number.NaN };
  const bounds = { x: Infinity, y: 12, width: Number.NaN, height: 20 };
  const beforePaint = { ...paint };
  const beforeBounds = { ...bounds };

  assert.deepEqual(gradientCoordinates(paint, bounds), {
    start: [0, 22],
    end: [0, 22],
  });
  assert.deepEqual(paint, beforePaint);
  assert.deepEqual(bounds, beforeBounds);
});

test("a layer's fill is on unless fillEnabled is false, including layers saved before the toggle", () => {
  assert.equal(isFillEnabled({ fill: "#ff0000" }), true, "an older layer without the flag keeps its fill");
  assert.equal(isFillEnabled({ fill: "#ff0000", fillEnabled: true }), true);
  assert.equal(isFillEnabled({ fill: "#ff0000", fillEnabled: false }), false);
  assert.equal(isFillEnabled(null), true);
});

test("a state with its fill turned off draws no fill, and the stored layer keeps its paint", () => {
  const gradient = { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff" }] };
  const on = { id: "on", fill: gradient, fillEnabled: true, stroke: "#00ff00", strokeWidth: 2 };
  assert.equal(withVisibleFill(on), on, "an enabled fill is drawn exactly as stored");

  const off = { ...on, fillEnabled: false };
  const drawn = withVisibleFill(off);
  assert.equal(drawn.fill, null, "a disabled fill exports as no fill");
  assert.equal(drawn.stroke, "#00ff00", "the stroke is not affected");
  assert.equal(drawn.strokeWidth, 2);
  assert.deepEqual(off.fill, gradient, "the layer itself keeps the gradient for turning the fill back on");
  assert.deepEqual(withVisibleFill({ ...off, fillEnabled: true }).fill, gradient, "turning it back on draws the same gradient and alpha");
});

test("group Fill supports Color animation while media Fill stays unsupported", () => {
  const group = { id: "g1", type: "group" };
  const image = { id: "photo", type: "image" };
  const video = { id: "clip", type: "video" };
  const box = { id: "b1", type: "rectangle" };
  const color = { id: "a1", from: { fill: "#ff0000" }, to: { fill: "#00ff00" } };
  const noFill = /A Color \(fill\) animation needs a rectangle, ellipse, star, path, text, group layer; (image|video) layer (photo|clip) has no Fill/;

  assert.equal(animatesFill(color), true);
  assert.equal(animatesFill({ from: { opacity: 0, fill: "#fff" }, to: { opacity: 1 } }), true, "one side is enough");
  assert.equal(animatesFill({ from: { opacity: 0 }, to: { opacity: 1 } }), false);
  assert.equal(animatesFill({ kind: "hide", start: 1 }), false, "a Hide has no values");
  assert.equal(animatesFill(null), false);

  assert.equal(fillAnimationProblem(group, color), null);
  assert.equal(fillAnimationProblem(box, color), null);
  assert.match(fillAnimationProblem(image, color), noFill);
  assert.match(fillAnimationProblem(video, color), noFill);
  assert.equal(fillAnimationProblem(group, { from: { opacity: 0 }, to: { opacity: 1 } }), null);

  // An edit: only a new or changed fill end is checked.
  assert.equal(fillAnimationEditProblem(group, undefined, color), null, "a new group animation");
  assert.equal(fillAnimationEditProblem(group, color, { ...color, start: 2, name: "Later" }), null, "timing and name");
  assert.equal(fillAnimationEditProblem(group, color, { ...color, to: { fill: "#0000ff" } }), null, "a changed group Fill end");
  assert.equal(fillAnimationEditProblem(group, color, { ...color, from: { opacity: 0 } }), null, "the group still has the old Fill end");
  assert.equal(fillAnimationEditProblem(group, color, { ...color, from: { opacity: 0 }, to: { opacity: 1 } }), null, "the fill is taken out");
  assert.equal(fillAnimationEditProblem(box, undefined, color), null);
  assert.match(fillAnimationEditProblem(image, undefined, color), noFill, "a new media animation");

  // A whole list (add_layer, update_layer): kept animations pass, new ones are checked.
  assert.equal(animationListProblem({ ...group, animations: [color] }, [color], 10), null);
  assert.equal(animationListProblem({ ...group, animations: [structuredClone(color)] }, [color], 10), null, "an equal copy");
  assert.equal(animationListProblem({ ...group, animations: [color] }, [], 10), null, "a new group layer");
  assert.equal(animationListProblem({ ...group, animations: [color, { ...color, id: "a2" }] }, [color], 10), null, "an added group animation");
  assert.equal(animationListProblem({ ...group, animations: [{ ...color, to: { fill: "#000000" } }] }, [color], 10), null);
  assert.match(animationListProblem({ ...image, animations: [color] }, [], 10), noFill, "a new image layer");
  assert.equal(animationListProblem({ ...group, animations: [] }, [color], 10), null, "deleting it");
  assert.equal(animationListProblem({ ...group, animations: "not a list" }, [color], 10), null, "parseDocument reports a bad list");
  assert.equal(animationListProblem({ ...group, animations: [null, 3] }, "not a list", 10), null);
});
