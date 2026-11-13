import assert from "node:assert/strict";
import { test } from "node:test";
import { LATE_SECONDS, isLate, previewRatio, scriptLayersToDraw, scriptRequest, shouldSend } from "./scriptFrames.js";

const layer = {
  id: "bars", type: "script", name: "Bars", x: 0, y: 0, width: 400, height: 200, opacity: 1, rotation: 0,
  script: "export default function setup(layer) { return function draw(frame) {}; }",
  inputs: [{ key: "reveal", type: "number", min: 0, max: 1 }, { key: "logo", type: "image" }],
  values: { reveal: 0.5, logo: "/api/media/logo.png" },
  animations: [],
};

test("only script layers with a module need a frame", () => {
  const layers = [layer, { ...layer, id: "empty", script: "  " }, { id: "box", type: "rectangle" }];
  assert.deepEqual(scriptLayersToDraw(layers).map((item) => item.id), ["bars"]);
});

test("a request: the mount key changes with the script, size, ratio and images, not with the time", () => {
  const first = scriptRequest(layer, 1, { sceneDuration: 4 });
  const later = scriptRequest(layer, 2, { sceneDuration: 4 });
  assert.equal(first.mountKey, later.mountKey);
  assert.notEqual(first.key, later.key);
  assert.deepEqual(first.mount.images, { logo: "/api/media/logo.png" });
  assert.equal(first.frame.progress, 0.25);
  assert.notEqual(scriptRequest({ ...layer, script: `${layer.script}\n` }, 1).mountKey, first.mountKey);
  assert.notEqual(scriptRequest({ ...layer, width: 401 }, 1).mountKey, first.mountKey);
  assert.notEqual(scriptRequest(layer, 1, { pixelRatio: 2 }).mountKey, first.mountKey);
  assert.notEqual(scriptRequest({ ...layer, values: { ...layer.values, logo: "" } }, 1).mountKey, first.mountKey);
  assert.equal(scriptRequest({ ...layer, values: { ...layer.values, reveal: 0.6 } }, 1).mountKey, first.mountKey, "a new value draws again without a new mount");
  assert.equal(previewRatio(960, 1920), 0.5);
  assert.equal(previewRatio(5000, 1920), 2);
});

test("when to ask again: once mounted, one request in flight, not for the picture already shown, never after a failure", () => {
  const wanted = scriptRequest(layer, 1, { sceneDuration: 4 });
  assert.equal(shouldSend({ mounted: null }, wanted), false, "not before the module is mounted");
  assert.equal(shouldSend({ mounted: wanted.mountKey }, wanted), true);
  assert.equal(shouldSend({ mounted: wanted.mountKey, pending: scriptRequest(layer, 0.5) }, wanted), false, "one request at a time");
  assert.equal(shouldSend({ mounted: wanted.mountKey, shownKey: wanted.key }, wanted), false, "already on screen");
  assert.equal(shouldSend({ mounted: wanted.mountKey, failedKey: wanted.mountKey }, wanted), false, "a failed module stays off");
});

test("a picture that comes back after the playhead left its time is dropped", () => {
  const at = (time) => scriptRequest(layer, time, { sceneDuration: 4 });
  assert.equal(isLate(at(1), at(1)), false);
  assert.equal(isLate(at(1), at(1 + LATE_SECONDS / 2)), false, "a frame or two behind while playing still shows");
  assert.equal(isLate(at(1), at(3)), true, "the playhead jumped away");
  assert.equal(isLate(at(1), scriptRequest({ ...layer, width: 300 }, 1, { sceneDuration: 4 })), true, "another size");
});
