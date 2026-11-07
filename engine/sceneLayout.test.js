import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { nextScenePosition } from "./sceneLayout.js";

import { duplicateSceneInDocument } from "./sceneDuplication.js";
import { applyOperations } from "./operations.js";
import { renderSceneSvg } from "./render.js";

function legacy() {
  return createDocument({ scenes: [createScene({ id: "a", width: 640, height: 360 }), createScene({ id: "b", width: 400, height: 200 })] });
}

test("new and duplicate scenes use the rightmost artboard, even when order differs", () => {
  const file = parseDocument(legacy());
  Object.assign(file.scenes[0], { canvasX: 2000, canvasY: -200 });
  assert.deepEqual(nextScenePosition(file.scenes), { canvasX: 2760, canvasY: -200 });
  const duplicated = duplicateSceneInDocument(file, "b");
  assert.equal(duplicated.document.scenes.at(-1).canvasX, 2760);
  const operated = applyOperations(file, [{ type: "duplicate_scene", sceneId: "b" }, { type: "add_scene", properties: { id: "new" } }]);
  assert.equal(operated.scenes.at(-1).canvasX, 3280);
});

test("scene positions are finite, bounded and do not affect the exported drawing", () => {
  const file = parseDocument(legacy());
  file.scenes[0].layers = [createLayer("rectangle", { x: 10, y: 20 })];
  const before = renderSceneSvg(file.scenes[0], 0);
  const changed = applyOperations(file, [{ type: "update_scene", sceneId: "a", properties: { canvasX: -1000, canvasY: 2000, aspectLocked: true } }]);
  assert.equal(renderSceneSvg(changed.scenes[0], 0), before);
  for (const value of [NaN, Infinity, "1", null, 100000001])
    assert.throws(() => applyOperations(file, [{ type: "update_scene", sceneId: "a", properties: { canvasX: value } }]));
  assert.throws(() => applyOperations(file, [{ type: "update_scene", sceneId: "a", properties: { aspectLocked: "true" } }]));
});
