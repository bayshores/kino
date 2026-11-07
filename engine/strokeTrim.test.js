import test from "node:test";
import assert from "node:assert/strict";
import { contourLengths, trimDash } from "./strokeTrim.js";
import { renderSceneSvg } from "./render.js";
import { animationProblem, createLayer, createScene } from "./model.js";
import { evaluateLayer, presetAnimation } from "./animation.js";

const close = (actual, expected) => assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6), `${actual} != ${expected}`);

test("trim and dash math on a 100 by 50 box (300 px around)", () => {
  const [box] = contourLengths("M0 0 L100 0 L100 50 L0 50 Z");
  assert.ok(Math.abs(box.length - 300) < 1e-9, "the closing side counts");
  assert.equal(trimDash(300, {}), null, "a whole, solid stroke needs no dash");
  assert.deepEqual(trimDash(300, { strokeEnd: 0 }).array, [], "nothing kept draws nothing");
  // The first half: one dash of 150 px, then a gap past the end.
  close(trimDash(300, { strokeEnd: 0.5 }).array, [150, 451]);
  // 0.25 to 0.75 moved on by 0.5 wraps past the end: 0 to 75 and 225 to 300.
  close(trimDash(300, { strokeStart: 0.25, strokeEnd: 0.75, strokeOffset: 0.5 }).array, [75, 150, 75, 301]);
  // A dash without a trim keeps its own pattern; with one, only the dashes inside the trim.
  assert.deepEqual(trimDash(300, { dash: [10, 5], dashOffset: 3 }), { array: [10, 5], offset: 3 });
  close(trimDash(300, { strokeEnd: 0.2, dash: [20, 10] }).array, [20, 10, 20, 551]);
  // As in Lottie, the dashes start where the trim starts (165 px here), not at the contour's start.
  close(trimDash(300, { strokeStart: 0.55, strokeEnd: 0.75, dash: [20, 10] }).array, [0, 165, 20, 10, 20, 386]);
  // Each contour of a path is measured on its own and remembered.
  assert.deepEqual(contourLengths("M0 0 H10 M0 5 H30").map((contour) => contour.length), [10, 30]);
  assert.equal(contourLengths("M0 0 H10 M0 5 H30"), contourLengths("M0 0 H10 M0 5 H30"));
});

test("a trim preset holds no stroke until it starts; a trim animation may leave out from", () => {
  const layer = createLayer("rectangle", { stroke: "#000000", strokeWidth: 4 });
  layer.animations = [presetAnimation("trim", layer, 1)];
  const at = (time) => evaluateLayer(layer, time).strokeEnd;
  assert.deepEqual([at(0), at(0.5), at(2)], [0, 0, 1]);
  assert.ok(at(1.4) > 0 && at(1.4) < 1, "it draws on after its start");
  const leftOut = { id: "a", name: "Trim", kind: "custom", start: 0, duration: 1, easing: "linear", from: {}, to: { strokeEnd: 0.5, dashOffset: 20 } };
  assert.equal(animationProblem(leftOut, layer), null);
});

test("the renderer draws a trimmed stroke as one dashed path per contour, the fill whole", () => {
  const layer = createLayer("path", { id: "p", x: 0, y: 0, width: 100, height: 50, path: "M0 0 L100 0 M0 50 L100 50", pathBounds: { x: 0, y: 0, width: 100, height: 50 }, fill: "#ff0000", stroke: "#000000", strokeWidth: 4, strokeEnd: 0.5 });
  const svg = renderSceneSvg(createScene({ id: "s", width: 200, height: 100, layers: [layer] }), 0);
  assert.equal((svg.match(/stroke-dasharray="50 151"/g) ?? []).length, 2);
  assert.match(svg, /<path d="M0 0 L100 0 M0 50 L100 50" fill-rule="nonzero" fill="#ff0000" stroke="none"/);
});
