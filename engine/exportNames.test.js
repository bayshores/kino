import assert from "node:assert/strict";
import test from "node:test";
import { availableSequenceBase, exportBasename, imageSequenceBase } from "./exportNames.js";

test("export basenames keep useful Unicode in NFC and replace path-sensitive characters", () => {
  assert.equal(exportBasename("企画 / Cafe\u0301 🎬"), "企画-Café");
  assert.equal(exportBasename("A\\B\u0000C"), "A-B-C");
  assert.equal(imageSequenceBase("Cafe\u0301"), "Café");
});

test("empty, traversal-only, and reserved device names use a safe fallback", () => {
  for (const name of ["", ".", "..", "...", "CON", "nul", "COM1", "lpt9"])
    assert.equal(exportBasename(name), "Scene", name);
  assert.equal(exportBasename("CON name"), "CON-name", "valid descriptive names remain useful");
});

test("export basenames stay within both codepoint and UTF-8 byte bounds", () => {
  const base = exportBasename("界".repeat(300));
  assert.ok([...base].length <= 120);
  assert.ok(new TextEncoder().encode(base).length <= 200);
});

test("a sequence base is taken when any of its frames is in the folder, not only frame 0", async () => {
  const none = async () => false;
  assert.equal(await availableSequenceBase("Scene", none), "Scene");
  assert.equal(await availableSequenceBase("Scene", none, ["Scene.00002.png"]), "Scene_1");
  assert.equal(await availableSequenceBase("Scene", none, ["scene.00007.PNG", "Scene_1.00003.png"]), "Scene_2", "case is ignored, as on a Mac");
  assert.equal(await availableSequenceBase("Scene", none, ["Scene.png", "Scene.0001.png", "Scene.mp4"]), "Scene", "only NNNNN frames count");
  const frameZero = new Set(["Scene.00000.png"]);
  assert.equal(await availableSequenceBase("Scene", async (name) => frameZero.has(name), []), "Scene_1");
});
