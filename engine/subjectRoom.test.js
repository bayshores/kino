import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { coveredShare, letterBoxes, placeAroundSubject, subjectRoom } from "./subjectRoom.js";

// A 1920×1080 frame, the subject box in the center (a head and shoulders), the safe area inside.
const SUBJECT = { x0: 760, y0: 200, x1: 1160, y1: 1080 };
const BOUNDS = { x0: 96, y0: 54, x1: 1824, y1: 1026 };
const word = (text, fontSize) => createLayer("text", { id: "word", name: "word", text, fontFamily: "Inter", fontWeight: 700, fontSize, textResize: "width-height", textAlign: "center", x: 560, y: 420, width: 800, height: 200 });
const sceneOf = (...layers) => createScene({ id: "s", width: 1920, height: 1080, duration: 2, layers });
const copyOf = (scene) => (layer) => {
  const copy = { ...structuredClone(layer), id: `${layer.id}-2`, name: `${layer.name} 2` };
  scene.layers.splice(scene.layers.indexOf(layer) + 1, 0, copy);
  return copy;
};

test("subjectRoom gives the free room on each side of the subject, none where it reaches the edge", () => {
  const room = subjectRoom(BOUNDS, SUBJECT, 24);
  assert.deepEqual(room.left, { x0: 96, y0: 54, x1: 736, y1: 1026 });
  assert.deepEqual(room.right, { x0: 1184, y0: 54, x1: 1824, y1: 1026 });
  assert.deepEqual(room.above, { x0: 96, y0: 54, x1: 1824, y1: 176 });
  assert.equal(room.below, null);
});

test("place around a subject: a word moves beside it with no letter inside; a line too wide for a side splits at its word gap", () => {
  const one = sceneOf(word("KILL", 200));
  const placed = placeAroundSubject(one, [one.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(one) });
  assert.ok(placed.before > 0.4, `the word started inside the subject (${placed.before})`);
  assert.ok(["left", "right"].includes(placed.side));
  assert.equal(placed.after, 0);
  assert.equal(placed.scale, 1, "it fits beside the subject at its size");

  // Two words at 260 px are wider than either side's 640 px: split keeps them larger than one shrunk line.
  const two = sceneOf(word("KILL YOU", 260));
  const split = placeAroundSubject(two, [two.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(two) });
  assert.equal(split.side, "split");
  assert.deepEqual(two.layers.map((layer) => layer.text), ["KILL", "YOU"]);
  assert.equal(split.after, 0);
  const [left, right] = two.layers.map((layer) => letterBoxes(layer, two.layers));
  assert.ok(Math.max(...left.map((box) => box.x1)) <= SUBJECT.x0 && Math.min(...right.map((box) => box.x0)) >= SUBJECT.x1, "one part on each side");
  assert.equal(two.layers[0].y, two.layers[1].y, "on one baseline");
  assert.equal(coveredShare([...left, ...right], SUBJECT), 0);
});
