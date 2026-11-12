import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { copyProjectDocument } from "./projectFiles.js";

test("file copies retain normalized content with independent nested data and a new identity", () => {
  const source = createDocument({ id: "original", name: "Motion", scenes: [createScene({ layers: [createLayer("rectangle")] })] });
  const original = structuredClone(source);
  const copy = copyProjectDocument(source, "copy");
  assert.deepEqual(copy, parseDocument({ ...source, id: "copy", name: "Motion [copy]" }));
  copy.scenes[0].layers[0].name = "Only in the copy";
  assert.deepEqual(source, original);
  assert.equal(copyProjectDocument({ ...source, name: "n".repeat(120) }, "long").name, `${"n".repeat(113)} [copy]`);
  assert.equal(copyProjectDocument(source, "named", " Motion v2 ").name, "Motion v2");
  assert.throws(() => copyProjectDocument({ ...source, scenes: null }, "invalid"));
});
