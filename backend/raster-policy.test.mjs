import assert from "node:assert/strict";
import test from "node:test";
import { sceneNeedsChromium } from "./raster-policy.mjs";

const scene = layer => ({ layers: [{ id: "shape", type: "rectangle", animations: [], ...layer }] });

test("ordinary documents and disabled effects retain the established raster path", () => {
  assert.equal(sceneNeedsChromium(scene({})), false);
  assert.equal(sceneNeedsChromium(scene({ glass: { enabled: false }, animations: [
    { id: "disabled", kind: "effect", effect: "bulge", enabled: false },
    { id: "group", kind: "composed", enabled: false, animations: [
      { id: "nested", kind: "effect", effect: "ripple" },
    ] },
  ] })), false);
});

test("effect operations, effect presets and animated backdrop styles select the editor renderer", () => {
  for (const layer of [
    { animations: [{ id: "effect", kind: "effect", effect: "bulge" }] },
    { animations: [{ id: "preset", kind: "in", to: { effectPreset: { id: "dissolve" } } }] },
    { backgroundBlur: { enabled: true } },
    { glass: { enabled: true } },
    { animations: [{ id: "style", kind: "custom", from: { glass: { enabled: true } }, to: { glass: { enabled: false } } }] },
  ]) assert.equal(sceneNeedsChromium(scene(layer)), true);
});

test("an invisible ancestor excludes its affected descendants", () => {
  assert.equal(sceneNeedsChromium({ layers: [
    { id: "parent", type: "group", visible: false, animations: [] },
    { id: "child", parentId: "parent", type: "rectangle", glass: { enabled: true }, animations: [] },
  ] }), false);
});
