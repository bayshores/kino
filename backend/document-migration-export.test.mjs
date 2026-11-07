import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { DOCUMENT_VERSION } from "../engine/schema.js";
import { startTestServer } from "./media.test.support.mjs";
import { parseExportDocument } from "./export-document.mjs";

test("scene-only requests retain v3 background fields and explicit versions without changing current letter spacing", () => {
  const background = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const backgroundAnimations = [{ id: "bg-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ffffff" }, to: { fill: background } }];
  const scene = createScene({ background, backgroundEnabled: false, backgroundAnimations,
    layers: [createLayer("text", { text: "HH", fontSize: 40, letterSpacing: 10 })] });
  for (const input of [{ scene }, { scene, version: 3 }, { document: createDocument({ scenes: [scene] }) }]) {
    const result = parseExportDocument(input);
    assert.equal(result.version, DOCUMENT_VERSION);
    assert.equal(result.scenes[0].backgroundEnabled, false);
    assert.deepEqual(result.scenes[0].background, background);
    assert.equal(result.scenes[0].backgroundAnimations.length, 1);
    assert.equal(result.scenes[0].layers[0].letterSpacing, 10);
  }
  const legacy = structuredClone(scene);
  delete legacy.backgroundEnabled;
  delete legacy.backgroundAnimations;
  legacy.background = "#ffffff00";
  legacy.layers[0].letterSpacing = 4;
  const migrated = parseExportDocument({ scene: legacy }).scenes[0];
  assert.equal(migrated.layers[0].letterSpacing, 10);
  assert.equal(migrated.backgroundEnabled, false);
  assert.equal(migrated.background, "#ffffff");
  assert.throws(() => parseExportDocument({ scene, version: 999 }), /version/);
});

test("scene-only exports preserve legacy pixel spacing and accept an explicit document version", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const scene = createScene({ width: 300, height: 140, duration: 1, layers: [
    createLayer("text", { text: "HH", x: 30, y: 40, fontSize: 40, letterSpacing: 4 }),
  ] });
  delete scene.backgroundEnabled;
  delete scene.backgroundAnimations;
  const document = { ...createDocument({ scenes: [scene] }), version: 1 };
  const png = async (input) => {
    const response = await server.api("/api/export", {
      method: "POST", body: { ...input, options: { format: "png", time: 0 } },
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const expected = await png({ document });
  assert.deepEqual(await png({ scene }), expected, "unversioned scene callers retain 4 px spacing");
  const currentScene = structuredClone(scene);
  currentScene.layers[0].letterSpacing = 10;
  assert.deepEqual(await png({ scene: currentScene, version: DOCUMENT_VERSION }), expected,
    "current scene callers can explicitly send the equivalent 10 percent spacing");
  const invalid = await server.api("/api/export", {
    method: "POST", body: { scene, version: 999, options: { format: "png" } },
  });
  assert.equal(invalid.status, 400);
});
