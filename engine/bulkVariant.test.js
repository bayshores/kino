import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createScene, parseDocument } from "./model.js";
import { duplicateSceneInDocument } from "./sceneDuplication.js";

function documentWith(scenes) {
  return parseDocument(createDocument({ scenes }));
}

function variant(id, baseSceneId, key, instanceId = "instance-1") {
  return createScene({
    id,
    bulkVariant: { baseSceneId, key, instanceId },
  });
}

test("bulk variant identity is normalized and survives document parsing", () => {
  const document = documentWith([
    createScene({ id: "base" }),
    variant("variant-1", "base", "  spring  ", "instance-1"),
  ]);

  assert.deepEqual(document.scenes[1].bulkVariant, {
    baseSceneId: "base",
    key: "spring",
    instanceId: "instance-1",
  });
  assert.deepEqual(parseDocument(JSON.stringify(document)).scenes[1].bulkVariant, {
    baseSceneId: "base",
    key: "spring",
    instanceId: "instance-1",
  });
});

test("bulk variant metadata rejects malformed objects, IDs, and keys", () => {
  const invalidValues = [
    null,
    "variant",
    [],
    { baseSceneId: "bad id", key: "spring", instanceId: "instance-1" },
    { baseSceneId: "base", key: "spring", instanceId: "bad id" },
    { baseSceneId: "base", key: 1, instanceId: "instance-1" },
    { baseSceneId: "base", key: "   ", instanceId: "instance-1" },
    { baseSceneId: "base", key: `x${" ".repeat(1)}${"x".repeat(128)}`, instanceId: "instance-1" },
  ];

  for (const bulkVariant of invalidValues) {
    assert.throws(
      () => documentWith([createScene({ id: "base" }), createScene({ id: "variant", bulkVariant })]),
      /bulkVariant/,
      `expected ${JSON.stringify(bulkVariant)} to be rejected`,
    );
  }
});

test("validation drops missing, self-referential, and later duplicate identities", () => {
  const document = documentWith([
    createScene({ id: "base" }),
    variant("missing-base", "absent", "key-a"),
    variant("self-base", "self-base", "key-b"),
    variant("first", "base", "same"),
    variant("second", "base", "  same  "),
  ]);

  assert.equal(Object.hasOwn(document.scenes[1], "bulkVariant"), false);
  assert.equal(Object.hasOwn(document.scenes[2], "bulkVariant"), false);
  assert.deepEqual(document.scenes[3].bulkVariant, {
    baseSceneId: "base",
    key: "same",
    instanceId: "instance-1",
  });
  assert.equal(Object.hasOwn(document.scenes[4], "bulkVariant"), false);
});

test("duplicating a scene does not copy its bulk variant identity", () => {
  const document = documentWith([
    createScene({ id: "base" }),
    variant("variant", "base", "spring"),
  ]);

  const result = duplicateSceneInDocument(document, "variant");
  const copy = result.document.scenes.find((scene) => scene.id === result.sceneId);

  assert.equal(Object.hasOwn(copy, "bulkVariant"), false);
});
