import assert from "node:assert/strict";
import test from "node:test";
import { easingAt, evaluateLayer } from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { DOCUMENT_VERSION } from "./schema.js";

const layerId = "path-layer";
const sceneId = "path-scene";

function move(overrides = {}) {
  return {
    id: "move",
    name: "Move",
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { x: 10 },
    to: { x: 90 },
    unit: "layer",
    stagger: 0,
    order: "forward",
    ...overrides,
  };
}

function documentWith(animations, { type = "rectangle", version = DOCUMENT_VERSION, layer = {} } = {}) {
  const text = type === "text" ? { text: "42" } : {};
  const movingLayer = createLayer(type, {
    id: layerId,
    name: "Path layer",
    x: 10,
    y: 20,
    width: 30,
    height: 16,
    fill: "#000000",
    ...text,
    ...layer,
    animations,
  });
  return createDocument({
    id: "path-document",
    name: "Motion path integration",
    version,
    scenes: [createScene({
      id: sceneId,
      name: "Motion scene",
      width: 180,
      height: 140,
      duration: 4,
      background: "#ffffff",
      layers: [movingLayer],
    })],
  });
}

function layerOf(document) {
  return document.scenes[0].layers.find((layer) => layer.id === layerId);
}

test("reading an older Move without motionPath preserves its animation shape and leaves the field absent", () => {
  const originalMove = move();
  const opened = parseDocument(documentWith([originalMove], { version: DOCUMENT_VERSION - 1 }));
  const storedMove = layerOf(opened).animations[0];
  assert.deepEqual(storedMove, originalMove);
  assert.equal(Object.hasOwn(storedMove, "motionPath"), false);
  assert.deepEqual(parseDocument(opened), opened, "opening the migrated file again is stable");
});

test("document validation normalizes motion-path defaults and accepts one- or two-axis Moves", () => {
  const withDefaults = parseDocument(documentWith([
    move({ motionPath: { points: [{ x: 40, y: 60 }] } }),
  ]));
  assert.deepEqual(layerOf(withDefaults).animations[0].motionPath, {
    points: [{ x: 40, y: 60, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }],
    bezierControls: true,
    alignToPath: false,
  });

  const twoAxis = parseDocument(documentWith([
    move({ from: { x: 10, y: 20 }, to: { x: 90, y: 80 }, motionPath: { points: [] } }),
  ]));
  assert.deepEqual(layerOf(twoAxis).animations[0].from, { x: 10, y: 20 });
  assert.deepEqual(layerOf(twoAxis).animations[0].to, { x: 90, y: 80 });

  const fullPointLimit = parseDocument(documentWith([
    move({ motionPath: { points: Array.from({ length: 64 }, (_, index) => ({ x: index, y: -index })) } }),
  ]));
  assert.equal(layerOf(fullPointLimit).animations[0].motionPath.points.length, 64);
});

test("document validation refuses malformed paths, excessive points, and mixed properties", () => {
  const rejectPath = (path) => {
    const document = documentWith([move({ motionPath: { points: [] } })]);
    layerOf(document).animations[0].motionPath = path;
    assert.throws(() => parseDocument(document));
  };
  rejectPath({ points: Array.from({ length: 65 }, (_, index) => ({ x: index, y: 0 })) });
  rejectPath({ points: [{ x: Number.NaN, y: 0 }] });
  rejectPath({ points: [{ x: Number.POSITIVE_INFINITY, y: 0 }] });
  rejectPath({ points: [{ x: 1_000_001, y: 0 }] });
  rejectPath({ points: [{ x: 0, y: 0, in: { x: 0, y: -1_000_001 } }] });
  rejectPath({ points: [{ x: 0, y: 0 }], unexpected: true });
  rejectPath({ points: [{ x: 0, y: 0 }], bezierControls: 1 });
  rejectPath({ points: [{ x: 0, y: 0 }], alignToPath: "yes" });
  rejectPath({ points: [{ x: 0, y: 0 }], alignmentOffset: 360_001 });

  assert.throws(() => parseDocument(documentWith([
    move({ from: { x: 0, opacity: 1 }, to: { x: 100 }, motionPath: { points: [] } }),
  ])), /only a custom Move/);
});

test("motionPath is refused on in/out, instant, Counter, and nested text effects", () => {
  for (const kind of ["in", "out"]) {
    assert.throws(() => parseDocument(documentWith([
      move({ kind, motionPath: { points: [{ x: 40, y: 20 }] } }),
    ])), /only a custom Move/);
  }

  assert.throws(() => parseDocument(documentWith([{
    id: "hide", name: "Hide", kind: "hide", start: 0, motionPath: { points: [] },
  }])), /instant.*motionPath/);

  assert.throws(() => parseDocument(documentWith([{
    id: "counter", name: "Counter", kind: "counter", start: 0, duration: 1,
    easing: "linear", from: 0, to: 4, step: 1, motionPath: { points: [] },
  }], { type: "text" })), /cannot have motionPath/);

  assert.throws(() => parseDocument(documentWith([{
    id: "change", name: "Change text", kind: "change-text", start: 0, text: "43",
    overlap: false, out: null, in: { preset: "fade-in", motionPath: { points: [] } },
  }], { type: "text" })), /not a text effect setting/);
});

test("add_animation and update_animation preset overrides save, normalize, and remove motionPath", () => {
  const original = parseDocument(documentWith([]));
  const firstPath = { points: [{ x: 50, y: 80 }] };
  const added = applyOperations(original, [{
    type: "add_animation", sceneId, layerId, preset: "move", start: 0.25, motionPath: firstPath,
  }]);
  const addedAnimation = layerOf(added).animations[0];
  assert.equal(addedAnimation.name, "Move");
  assert.deepEqual(addedAnimation.motionPath, {
    points: [{ x: 50, y: 80, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }],
    bezierControls: true,
    alignToPath: false,
  });

  const updatedPath = {
    points: [{ x: 70, y: 90, in: { x: -8, y: 2 }, out: { x: 9, y: -3 } }],
    bezierControls: false,
    alignToPath: true,
    alignmentOffset: 12,
  };
  const updated = applyOperations(added, [{
    type: "update_animation", sceneId, layerId, animationId: addedAnimation.id,
    properties: { motionPath: updatedPath },
  }]);
  assert.deepEqual(layerOf(updated).animations[0].motionPath, updatedPath);

  const removed = applyOperations(updated, [{
    type: "update_animation", sceneId, layerId, animationId: addedAnimation.id,
    properties: { motionPath: null },
  }]);
  assert.equal(Object.hasOwn(layerOf(removed).animations[0], "motionPath"), false);
});

test("evaluation follows an explicit two-segment polyline, uses design-axis fallbacks, and respects its clock", () => {
  const path = { points: [{ x: 50, y: 20 }], bezierControls: false };
  const layer = createLayer("rectangle", {
    id: layerId, x: 10, y: 20, width: 12, height: 10,
    animations: [move({ start: 0.5, duration: 1, from: { x: 10 }, to: { x: 90 }, motionPath: path })],
  });
  assert.deepEqual(
    [evaluateLayer(layer, 0.49).x, evaluateLayer(layer, 0.49).y],
    [10, 20],
  );
  assert.deepEqual(
    [evaluateLayer(layer, 0.5).x, evaluateLayer(layer, 0.5).y],
    [10, 20],
  );
  assert.deepEqual(
    [evaluateLayer(layer, 0.75).x, evaluateLayer(layer, 0.75).y],
    [30, 20],
  );
  assert.deepEqual(
    [evaluateLayer(layer, 1).x, evaluateLayer(layer, 1).y],
    [50, 20],
  );
  assert.deepEqual(
    [evaluateLayer(layer, 1.5).x, evaluateLayer(layer, 1.5).y],
    [90, 20],
  );
  assert.deepEqual(
    [evaluateLayer(layer, 2).x, evaluateLayer(layer, 2).y],
    [90, 20],
  );
  const disabled = { ...layer, animations: [{ ...layer.animations[0], enabled: false }] };
  assert.deepEqual([evaluateLayer(disabled, 1).x, evaluateLayer(disabled, 1).y], [10, 20]);

  const vertical = createLayer("rectangle", {
    id: "vertical", x: 30, y: 5, width: 10, height: 10,
    animations: [move({ from: { y: 5 }, to: { y: 85 }, motionPath: {
      points: [{ x: 80, y: 45 }], bezierControls: false,
    } })],
  });
  assert.deepEqual([evaluateLayer(vertical, 0).x, evaluateLayer(vertical, 0).y], [30, 5]);
  assert.deepEqual([evaluateLayer(vertical, 0.5).x, evaluateLayer(vertical, 0.5).y], [80, 45]);
  assert.deepEqual([evaluateLayer(vertical, 1).x, evaluateLayer(vertical, 1).y], [30, 85]);
});

test("a curved Move evaluates away from the direct line between its endpoints", () => {
  const straight = createLayer("rectangle", {
    id: "straight", x: 10, y: 20, width: 12, height: 10,
    animations: [move({ from: { x: 10 }, to: { x: 90 } })],
  });
  const curved = createLayer("rectangle", {
    id: "curved", x: 10, y: 20, width: 12, height: 10,
    animations: [move({ from: { x: 10 }, to: { x: 90 }, motionPath: {
      points: [{ x: 50, y: 80 }],
    } })],
  });
  const direct = evaluateLayer(straight, 0.5);
  const routed = evaluateLayer(curved, 0.5);
  assert.ok(Math.abs(direct.x - 50) < 1e-9 && Math.abs(direct.y - 20) < 1e-9);
  assert.ok(Math.abs(routed.x - 50) < 1e-9 && Math.abs(routed.y - 80) < 1e-9);
});

test("easing overshoot extrapolates past the path endpoint along its tangent", () => {
  const path = { points: [{ x: 0, y: 50 }], bezierControls: false };
  const layer = createLayer("rectangle", {
    id: layerId, x: 0, y: 0, width: 12, height: 10,
    animations: [move({ from: { x: 0, y: 0 }, to: { x: 0, y: 100 }, easing: "overshoot", intensity: 100, motionPath: path })],
  });
  const eased = easingAt("overshoot", 0.15, 100);
  assert.ok(eased > 1, `fixture needs a progress overshoot, got ${eased}`);
  const state = evaluateLayer(layer, 0.15);
  assert.ok(Math.abs(state.x) < 1e-8);
  assert.ok(state.y > 100);
  assert.ok(Math.abs(state.y - 100 * eased) < 1e-3, `endpoint tangent extension ${state.y} follows easing ${eased}`);
});

test("the latest aligned Move adds its tangent after ordinary rotation and remains aligned after it ends", () => {
  const firstPath = { points: [{ x: 30, y: 20 }], bezierControls: false, alignToPath: true };
  const latestPath = {
    points: [{ x: 60, y: 20 }],
    bezierControls: false,
    alignToPath: true,
    alignmentOffset: 5,
  };
  const layer = createLayer("rectangle", {
    id: layerId, x: 0, y: 20, width: 18, height: 14, rotation: 10,
    animations: [
      move({ id: "first", start: 0, duration: 0.5, from: { x: 0, y: 20 }, to: { x: 60, y: 20 }, motionPath: firstPath }),
      { id: "rotate", name: "Rotate", kind: "custom", start: 0, duration: 2, easing: "linear", from: { rotation: 10 }, to: { rotation: 30 } },
      move({ id: "latest", start: 0.5, duration: 0.5, from: { x: 0, y: 20 }, to: { x: 60, y: 80 }, motionPath: latestPath }),
    ],
  });
  const afterBothMoves = evaluateLayer(layer, 1.5);
  assert.equal(afterBothMoves.x, 60);
  assert.equal(afterBothMoves.y, 80);
  assert.ok(Math.abs(afterBothMoves.rotation - 120) < 1e-8,
    `ordinary rotation 25 + latest tangent 90 + offset 5, got ${afterBothMoves.rotation}`);
});

test("per-unit text Move paths apply the existing unit stagger independently", () => {
  const layer = createLayer("text", {
    id: "staggered-text", x: 0, y: 20, width: 120, height: 30,
    animations: [move({
      from: { x: 0 }, to: { x: 100 }, unit: "letters", stagger: 0.25,
      motionPath: { points: [{ x: 50, y: 20 }], bezierControls: false },
    })],
  });
  const xAt = (unitIndex) => evaluateLayer(layer, 0.5, { unit: "letters", unitIndex, unitCount: 3 }).x;
  const positions = [xAt(0), xAt(1), xAt(2)];
  assert.ok(Math.abs(positions[0] - 50) < 1e-9);
  assert.ok(Math.abs(positions[1] - 25) < 1e-9);
  assert.ok(Math.abs(positions[2]) < 1e-9);
});
