import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "./animation.js";
import { carryAnimations, shiftAnimation } from "./animationShift.js";
import { applyComponentOverride } from "./componentOverrides.js";
import { layerMatrix, multiply, point } from "./geometry.js";
import { rotationAbout } from "./multiTransform.js";
import { resizeGroup } from "./groupResize.js";
import { copyAnimation, duplicateLayers, pasteAnimations } from "./layerClipboard.js";
import { createComponentInstance, detachComponent, expandComponents } from "./linkedComponents.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { reparentLayer } from "./reparent.js";

const TIMES = [0.15, 0.4, 0.7, 0.9];

function move(id, from, to, motionPath, start = 0) {
  return { id, name: id, kind: "custom", start, duration: 1, easing: "linear", from, to, motionPath };
}

function pathLayer(overrides = {}) {
  const layer = createLayer("rectangle", {
    id: "box", x: 12, y: 15, width: 24, height: 14, rotation: 13, scaleX: -1.1, scaleY: 0.8,
    ...overrides,
  });
  layer.animations = [move("move", { x: 12, y: 15 }, { x: 72, y: 58 }, {
    points: [
      { x: 25, y: 80, in: { x: -6, y: 2 }, out: { x: 9, y: -12 } },
      { x: 58, y: 22, in: { x: -5, y: -7 }, out: { x: 4, y: 11 } },
    ],
    bezierControls: true,
    alignToPath: true,
    alignmentOffset: 17,
  })];
  return layer;
}

function close(actual, expected, message, epsilon = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`);
}

function matrixClose(actual, expected, message) {
  for (let index = 0; index < 6; index += 1) close(actual[index], expected[index], `${message} matrix[${index}]`);
}

function documentWith(layers) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "main", duration: 5, layers })] }));
}

test("duplicated layers keep independent path geometry and fresh animation IDs", () => {
  const document = documentWith([pathLayer()]);
  const result = duplicateLayers(document, "main", ["box"]);
  const original = result.document.scenes[0].layers.find((layer) => layer.id === "box");
  const copy = result.document.scenes[0].layers.find((layer) => layer.id !== "box");
  assert.notEqual(copy.animations[0].id, original.animations[0].id);
  assert.deepEqual(copy.animations[0].motionPath, original.animations[0].motionPath);
  for (const time of TIMES) matrixClose(layerMatrix(evaluateLayer(copy, time)), layerMatrix(evaluateLayer(original, time)), `duplicate at ${time}`);
  copy.animations[0].motionPath.points[0].x += 15;
  assert.equal(original.animations[0].motionPath.points[0].x, 25);
  assert.equal(document.scenes[0].layers.length, 1);
});

test("linked and detached component layers retain curved motion at the instance clock", () => {
  const moving = pathLayer();
  const source = createScene({ id: "source", name: "Path component", isComponent: true, layers: [moving] });
  const instance = createComponentInstance(source, { id: "instance", componentStart: 0.5 });
  const document = parseDocument(createDocument({ scenes: [source, createScene({ id: "main", layers: [instance] })] }));
  const expanded = expandComponents(document, "main").layers.find((layer) => layer.animations.some((animation) => animation.motionPath));
  const detached = detachComponent(document, "main", instance.id).scenes.find((scene) => scene.id === "main").layers.find((layer) => layer.animations.some((animation) => animation.motionPath));
  for (const layer of [expanded, detached]) {
    assert.deepEqual(layer.animations[0].motionPath, document.scenes[0].layers[0].animations[0].motionPath);
    assert.notEqual(layer.animations[0].id, moving.animations[0].id);
    for (const time of TIMES) {
      const before = evaluateLayer(moving, time), after = evaluateLayer(layer, time + 0.5);
      close(after.x, before.x, `component x at ${time}`);
      close(after.y, before.y, `component y at ${time}`);
      close(after.rotation, before.rotation, `component rotation at ${time}`);
    }
  }
});

test("reparenting maps aligned motion positions and rotations through translation, rotation, scale and reflection", () => {
  const layer = pathLayer();
  const before = structuredClone(layer);
  const transforms = [
    [1, 0, 0, 1, 20, -8],
    [0, 1, -1, 0, 100, 40],
    [1.75, 0, 0, 1.75, -12, 30],
    [-1, 0, 0, 1, 180, -4],
  ];

  for (const transform of transforms) {
    const after = { ...layer, ...reparentLayer(layer, transform) };
    const [a, b, c, d] = transform;
    const determinant = a * d - b * c;
    const reflected = determinant < 0 ? -1 : 1;
    const angle = Math.atan2(b, a) * 180 / Math.PI;
    const expectedOffset = reflected * (layer.animations[0].motionPath.alignmentOffset ?? 0) - angle;
    close(after.animations[0].motionPath.alignmentOffset ?? 0, expectedOffset, "alignment compensation");
    const originalPoint = layer.animations[0].motionPath.points[0];
    const expectedPoint = {
      x: a * (originalPoint.x + layer.width / 2) + c * (originalPoint.y + layer.height / 2) + transform[4] - layer.width / 2,
      y: b * (originalPoint.x + layer.width / 2) + d * (originalPoint.y + layer.height / 2) + transform[5] - layer.height / 2,
    };
    close(after.animations[0].motionPath.points[0].x, expectedPoint.x, "mapped node x");
    close(after.animations[0].motionPath.points[0].y, expectedPoint.y, "mapped node y");
    const expectedHandle = {
      x: a * originalPoint.out.x + c * originalPoint.out.y,
      y: b * originalPoint.out.x + d * originalPoint.out.y,
    };
    close(after.animations[0].motionPath.points[0].out.x, expectedHandle.x, "mapped handle x");
    close(after.animations[0].motionPath.points[0].out.y, expectedHandle.y, "mapped handle y");

    for (const time of TIMES) {
      const oldPose = evaluateLayer(layer, time);
      const newPose = evaluateLayer(after, time);
      matrixClose(layerMatrix(newPose), multiply(transform, layerMatrix(oldPose)), `time ${time}`);
    }
  }
  assert.deepEqual(layer, before, "reparenting leaves the source untouched");
});

// multi_transform moves, scales or turns a layer in its own parent space: the layer gets its new
// pose the way rotateSelection gives it, and carryAnimations takes the animations along, so the
// whole motion is drawn through the same transform at every moment.
test("carried animations follow a layer that is moved, scaled or turned, curved path and heading too", () => {
  const layer = pathLayer();
  const before = structuredClone(layer);
  const transforms = [
    [1, 0, 0, 1, 20, -8],
    [1.5, 0, 0, 1.5, -20, 10],
    rotationAbout({ x: 50, y: 40 }, 90),
    rotationAbout({ x: 50, y: 40 }, 30),
  ];
  for (const transform of transforms) {
    const pose = reparentLayer({ ...layer, animations: [] }, transform);
    const after = { ...layer, ...pose, animations: carryAnimations(layer.animations, layer, { ...layer, ...pose }, transform.slice(0, 4)) };
    for (const time of TIMES) {
      matrixClose(layerMatrix(evaluateLayer(after, time)), multiply(transform, layerMatrix(evaluateLayer(layer, time))), `${transform} at ${time}`);
    }
  }
  const slide = { id: "slide", kind: "in", start: 0, duration: 1, easing: "linear", from: { y: 55 }, to: { y: 15 } };
  const turned = carryAnimations([slide], layer, { ...layer, rotation: 103 }, [0, 1, -1, 0]);
  assert.deepEqual([turned[0].from, turned[0].to], [{ x: 12 - 40 }, { x: 12 }], "a slide up, turned a quarter, slides across and sets no y");
  assert.deepEqual(layer, before, "carrying leaves the source untouched");
});

test("a partial-axis Move materializes both motion endpoints when its parent turns", () => {
  const layer = pathLayer({ scaleX: 1, scaleY: 1 });
  layer.animations[0] = move("partial", { x: 12 }, { x: 72 }, {
    points: [{ x: 35, y: 42, in: { x: -3, y: 1 }, out: { x: 7, y: 4 } }],
    alignToPath: false,
  });
  const after = { ...layer, ...reparentLayer(layer, [0, 1, -1, 0, 120, -10]) };
  assert.deepEqual(Object.keys(after.animations[0].from).sort(), ["x", "y"]);
  assert.deepEqual(Object.keys(after.animations[0].to).sort(), ["x", "y"]);
  for (const time of TIMES) {
    const oldPose = evaluateLayer(layer, time);
    const newPose = evaluateLayer(after, time);
    matrixClose(layerMatrix(newPose), multiply([0, 1, -1, 0, 120, -10], layerMatrix(oldPose)), `time ${time}`);
  }
});

test("nonuniform reparenting maps unaligned curve geometry and refuses animated path alignment", () => {
  const layer = pathLayer({ scaleX: 1, scaleY: 1 });
  layer.animations[0].motionPath.alignToPath = false;
  const transform = [2, 0, 0, 0.75, 11, -6];
  const mapped = { ...layer, ...reparentLayer(layer, transform) };
  const original = layer.animations[0].motionPath.points[0];
  close(mapped.animations[0].motionPath.points[0].x, 2 * (original.x + layer.width / 2) + 11 - layer.width / 2, "nonuniform point x");
  close(mapped.animations[0].motionPath.points[0].y, 0.75 * (original.y + layer.height / 2) - 6 - layer.height / 2, "nonuniform point y");
  close(mapped.animations[0].motionPath.points[0].out.x, 2 * original.out.x, "nonuniform handle x");
  close(mapped.animations[0].motionPath.points[0].out.y, 0.75 * original.out.y, "nonuniform handle y");

  const aligned = pathLayer({ scaleX: 1, scaleY: 1 });
  assert.throws(() => reparentLayer(aligned, transform), /animates its rotation/);
});

test("group stretch and box-only movement carry motion paths with their layers without mutating inputs", () => {
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 100, height: 100 });
  const child = pathLayer({ id: "box", parentId: "g", x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 });
  child.animations[0] = move("move", { x: 10, y: 20 }, { x: 70, y: 60 }, {
    points: [{ x: 25, y: 80, in: { x: -4, y: 2 }, out: { x: 8, y: -6 } }], alignToPath: true,
  });
  const before = [group, child];
  const snapshot = structuredClone(before);
  const apply = (changes) => before.map((layer) => ({ ...layer, ...(changes.find((change) => change.id === layer.id) ?? {}) }));
  const worldAt = (layers, time) => {
    const parent = layers.find((layer) => layer.id === "g");
    const item = evaluateLayer(layers.find((layer) => layer.id === "box"), time);
    return {
      center: point(layerMatrix(parent), item.x + item.width / 2, item.y + item.height / 2),
      rotation: item.rotation,
    };
  };

  const stretched = apply(resizeGroup(before, "g", { x: 0, y: 0, width: 200, height: 200 }));
  for (const time of TIMES) {
    const oldPose = worldAt(before, time);
    const newPose = worldAt(stretched, time);
    close(newPose.center.x, oldPose.center.x * 2, `uniform stretch x at ${time}`);
    close(newPose.center.y, oldPose.center.y * 2, `uniform stretch y at ${time}`);
    close(newPose.rotation, oldPose.rotation, `uniform stretch rotation at ${time}`);
  }
  close(stretched[1].animations[0].motionPath.points[0].x, 50, "stretched node x");
  close(stretched[1].animations[0].motionPath.points[0].y, 160, "stretched node y");
  close(stretched[1].animations[0].motionPath.points[0].out.x, 16, "stretched handle x");
  close(stretched[1].animations[0].motionPath.points[0].out.y, -12, "stretched handle y");

  const moved = apply(resizeGroup(before, "g", { x: 15, y: -8, width: 100, height: 100 }, { scaleChildren: false }));
  for (const time of TIMES) {
    const oldPose = worldAt(before, time);
    const newPose = worldAt(moved, time);
    close(newPose.center.x, oldPose.center.x, `box-only x at ${time}`);
    close(newPose.center.y, oldPose.center.y, `box-only y at ${time}`);
    close(newPose.rotation, oldPose.rotation, `box-only rotation at ${time}`);
  }
  assert.deepEqual(before, snapshot, "group resize leaves both input layers untouched");
});

test("checked shifts move curve nodes while preserving handle vectors, including component overrides", () => {
  const animation = move("move", { x: 12, y: 15 }, { x: 72, y: 58 }, {
    points: [{ x: 30, y: 40, in: { x: -3, y: 4 }, out: { x: 5, y: -6 } }], alignToPath: true,
  });
  const original = structuredClone(animation);
  const shifted = shiftAnimation(animation, 20, -7, (value, delta) => Math.round((value + delta) * 1e6) / 1e6);
  assert.deepEqual(shifted.motionPath.points[0], { x: 50, y: 33, in: { x: -3, y: 4 }, out: { x: 5, y: -6 } });
  assert.deepEqual(animation, original);

  const layer = pathLayer({ scaleX: 1, scaleY: 1 });
  const overridden = applyComponentOverride(layer, { x: 35, y: 25 });
  assert.deepEqual(overridden.animations[0].motionPath.points.map(({ x, y, in: incoming, out }) => ({ x, y, in: incoming, out })), [
    { x: 48, y: 90, in: { x: -6, y: 2 }, out: { x: 9, y: -12 } },
    { x: 81, y: 32, in: { x: -5, y: -7 }, out: { x: 4, y: 11 } },
  ]);
  for (const time of TIMES) {
    const before = evaluateLayer(layer, time);
    const after = evaluateLayer(overridden, time);
    close(after.x, before.x + 23, `override x at ${time}`);
    close(after.y, before.y + 10, `override y at ${time}`);
  }
});

test("pasting a Move rebases curve points with the source and target resting positions", () => {
  const source = createLayer("rectangle", { id: "source", x: 10, y: 20, width: 24, height: 14 });
  source.animations = [move("move", { x: 10, y: 20 }, { x: 70, y: 60 }, {
    points: [{ x: 35, y: 42, in: { x: -3, y: 1 }, out: { x: 7, y: 4 } }], alignToPath: false,
  })];
  const target = createLayer("rectangle", { id: "target", x: 100, y: 200, width: 24, height: 14 });
  const document = documentWith([source, target]);
  const original = structuredClone(document);
  const result = pasteAnimations(document, "main", ["target"], copyAnimation(document, "main", "source", "move"), 0);
  const pasted = result.document.scenes[0].layers.find((layer) => layer.id === "target").animations[0];
  assert.deepEqual(pasted.from, { x: 100, y: 200 });
  assert.deepEqual(pasted.to, { x: 160, y: 240 });
  assert.deepEqual(pasted.motionPath.points[0], { x: 125, y: 222, in: { x: -3, y: 1 }, out: { x: 7, y: 4 } });
  for (const time of TIMES) {
    const before = evaluateLayer(source, time);
    const after = evaluateLayer({ ...target, animations: [pasted] }, time);
    close(after.x, before.x + 90, `pasted x at ${time}`);
    close(after.y, before.y + 180, `pasted y at ${time}`);
  }
  assert.deepEqual(document, original, "paste leaves the source document untouched");
});

test("pasting a motion path outside supported coordinates is refused without clamping", () => {
  const source = createLayer("rectangle", { id: "source", x: 0, y: 0 });
  source.animations = [move("move", { x: 0, y: 0 }, { x: 20, y: 10 }, {
    points: [{ x: 999_990, y: 5, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }],
  })];
  const target = createLayer("rectangle", { id: "target", x: 20, y: 0 });
  const document = documentWith([source, target]);
  const original = structuredClone(document);
  assert.throws(
    () => pasteAnimations(document, "main", ["target"], copyAnimation(document, "main", "source", "move"), 0),
    /outside the supported range/,
  );
  assert.deepEqual(document, original);
});

test("pasting refuses an out-of-range motion endpoint even when all curve nodes remain in range", () => {
  const source = createLayer("rectangle", { id: "source", x: 0, y: 0 });
  source.animations = [move("move", { x: 999_990, y: 0 }, { x: 20, y: 10 }, {
    points: [{ x: 100, y: 50, in: { x: -2, y: 1 }, out: { x: 3, y: -4 } }],
  })];
  const target = createLayer("rectangle", { id: "target", x: 20, y: 0 });
  const document = documentWith([source, target]);
  const original = structuredClone(document);
  assert.throws(
    () => pasteAnimations(document, "main", ["target"], copyAnimation(document, "main", "source", "move"), 0),
    /motion endpoint would be outside the supported range/,
  );
  const partialRest = copyAnimation(document, "main", "source", "move");
  if (partialRest.rest) delete partialRest.rest.y;
  for (const rest of partialRest.rests ?? []) delete rest.y;
  assert.throws(() => pasteAnimations(document, "main", ["target"], partialRest, 0),
    /motion endpoint would be outside the supported range/, "an incomplete clipboard rest cannot bypass the endpoint limit");
  assert.deepEqual(document, original);
});
