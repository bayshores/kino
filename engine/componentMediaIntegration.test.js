import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyBulkCreate, planBulkCreate } from "./bulkCreate.js";
import { createComponentInstance, detachComponent, expandComponents } from "./linkedComponents.js";
import { applyOperations } from "./operations.js";

function baseDocument(duration = 1.25) {
  const base = createScene({ id: "base", isComponent: true, layers: [
    createLayer("image", { id: "gif", name: "GIF", src: "/api/media/aaa.gif", mediaSourceDuration: duration, mediaDuration: 0 }),
  ] });
  return parseDocument(createDocument({ scenes: [base] }));
}

function variant(document, src, sources = new Map()) {
  const plan = planBulkCreate(document, "base", ["id", "GIF"], [["variant", src]], []);
  return parseDocument(applyBulkCreate(document, plan, sources));
}

function detachedImage(document, sceneId, instanceId) {
  return parseDocument(detachComponent(document, sceneId, instanceId)).scenes.find((scene) => scene.id === sceneId).layers.find((layer) => layer.type === "image");
}

test("an unmeasured saved GIF replacement clears the base duration", () => {
  const document = variant(baseDocument(), "/api/media/bbb.gif");
  const scene = document.scenes[1];
  assert.deepEqual(scene.layers[0].componentOverrides.gif, { src: "/api/media/bbb.gif", mediaSourceDuration: 0 });
  assert.equal(detachedImage(document, scene.id, scene.layers[0].id).mediaSourceDuration, 0);
});

test("only the same replacement URL can retain its previous measurement on reimport", () => {
  const first = variant(baseDocument(), "/api/media/bbb.gif", new Map([["/api/media/bbb.gif", { src: "/api/media/bbb.gif", duration: 3 }]]));
  const again = variant(first, "/api/media/bbb.gif");
  assert.equal(again.scenes[1].layers[0].componentOverrides.gif.mediaSourceDuration, 3);
  const changed = variant(again, "/api/media/ccc.gif");
  const scene = changed.scenes[1];
  const image = detachedImage(changed, scene.id, scene.layers[0].id);
  assert.equal(image.mediaSourceDuration, 0);
});

for (const duration of [2, 0]) {
  test(`set_component_overrides retains the replacement's explicit ${duration}s duration across later base edits`, () => {
    const before = baseDocument(duration);
    before.scenes.push(createScene({ id: "page", layers: [createComponentInstance(before.scenes[0], { id: "instance" })] }));
    const document = applyOperations(before, [{ type: "set_component_overrides", sceneId: "page", layerId: "instance",
      overrides: { gif: { src: "/api/media/bbb.gif", mediaSourceDuration: duration } } }]);
    assert.deepEqual(document.scenes[1].layers[0].componentOverrides.gif, { src: "/api/media/bbb.gif", mediaSourceDuration: duration });
    const edited = applyOperations(document, [{ type: "update_layer", sceneId: "base", layerId: "gif", properties: { src: "/api/media/ccc.gif", mediaSourceDuration: 3 } }]);
    const expanded = expandComponents(parseDocument(JSON.parse(JSON.stringify(edited))), "page").layers.find((layer) => layer.type === "image");
    assert.equal(expanded.src, "/api/media/bbb.gif");
    assert.equal(expanded.mediaSourceDuration, duration);
  });

  test(`Bulk Create retains a replacement's explicit ${duration}s duration when it initially equals the base`, () => {
    const first = variant(baseDocument(duration), "/api/media/bbb.gif", new Map([["/api/media/bbb.gif", { src: "/api/media/bbb.gif", duration }]]));
    const edited = applyOperations(first, [{ type: "update_layer", sceneId: "base", layerId: "gif", properties: { src: "/api/media/ccc.gif", mediaSourceDuration: 3 } }]);
    const scene = edited.scenes[1];
    const image = detachedImage(edited, scene.id, scene.layers[0].id);
    assert.equal(image.src, "/api/media/bbb.gif");
    assert.equal(image.mediaSourceDuration, duration);
  });
}
