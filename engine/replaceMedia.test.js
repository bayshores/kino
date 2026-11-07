import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { applyComponentOverride } from "./componentOverrides.js";

const old = { id: "11111111-1111-4111-8111-111111111111.png", src: "/api/media/11111111-1111-4111-8111-111111111111.png", name: "old.png", mime: "image/png", width: 80, height: 40, duration: 0 };
const video = { id: "22222222-2222-4222-8222-222222222222.mp4", src: "/api/media/22222222-2222-4222-8222-222222222222.mp4", name: "new.mp4", mime: "video/mp4", width: 20, height: 90, duration: 2, hasAudio: true };
const gif = { ...video, id: "33333333-3333-4333-8333-333333333333.gif", src: "/api/media/33333333-3333-4333-8333-333333333333.gif", name: "new.gif", mime: "image/gif", frameCount: 2, animated: true, hasAudio: false };
const audio = { ...video, id: "44444444-4444-4444-8444-444444444444.wav", src: "/api/media/44444444-4444-4444-8444-444444444444.wav", name: "new.wav", mime: "audio/wav", width: 0, height: 0 };

function documentFor(properties = {}, type = "image") {
  return parseDocument(createDocument({ scenes: [createScene({ id: "scene", duration: 8, layers: [createLayer(type, {
    id: "layer", name: old.name, src: old.src, x: 31, y: 42, width: 150, height: 60, rotation: 17, scaleX: -1, opacity: 0.7,
    blur: 2, shadow: { x: 1, y: 2, blur: 3, color: "#00000080" },
    animations: [{ id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 31 } }],
    ...properties,
  })] })] }));
}

function replace(document, media, previous = old) {
  return applyOperations(document, [{ type: "replace_media", sceneId: "scene", layerId: "layer", mediaId: media.id }],
    { mediaById: new Map([[previous.id, previous], [media.id, media]]) });
}

test("Replace Media retains identity, geometry, effects, names chosen by the user, and every animation", () => {
  const source = documentFor({ name: "Hero" });
  const before = structuredClone(source);
  const result = replace(source, video);
  const layer = result.scenes[0].layers[0];
  for (const key of ["id", "name", "parentId", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "opacity", "blur", "shadow", "animations"])
    assert.deepEqual(layer[key], before.scenes[0].layers[0][key], key);
  assert.equal(layer.type, "video");
  assert.equal(layer.src, video.src);
  assert.equal(layer.mediaSourceDuration, 2);
  assert.equal(layer.mediaDuration, 2, "still → video gets the normal imported Play range");
  assert.deepEqual(source, before, "input and any undo snapshot remain untouched");
  assert.deepEqual(parseDocument(result), result, "replacement survives normalization and persistence");
});

test("automatic filename follows the new file; a custom name is kept", () => {
  assert.equal(replace(documentFor(), video).scenes[0].layers[0].name, video.name);
  assert.equal(replace(documentFor({ name: "old" }), video).scenes[0].layers[0].name, "old");
});

test("image replacement uses the component override box rule", () => {
  const source = documentFor();
  const actual = replace(source, gif).scenes[0].layers[0];
  const override = applyComponentOverride(source.scenes[0].layers[0], { src: gif.src, mediaSourceDuration: gif.duration });
  for (const key of ["src", "x", "y", "width", "height", "rotation", "mediaSourceDuration"])
    assert.equal(actual[key], override[key], key);
});

for (const media of [video, gif, audio]) test(`${media.mime} replacement clamps trims and Play to the new source`, () => {
  const type = media.mime.startsWith("audio/") ? "audio" : "video";
  const previous = { ...video, id: old.id, src: old.src, name: old.name, duration: 20 };
  const layer = replace(documentFor({ mediaStart: 1, mediaOffset: 9, mediaDuration: 6, mediaSourceDuration: 20, volume: 0.4, mediaFreeze: "last" }, type), media, previous).scenes[0].layers[0];
  assert.equal(layer.mediaStart, 1);
  assert.equal(layer.mediaOffset, 1.99);
  assert.ok(Math.abs(layer.mediaDuration - 0.01) < 1e-6);
  assert.equal(layer.mediaSourceDuration, 2);
  assert.equal(layer.volume, 0.4);
  assert.equal(layer.mediaFreeze, "last");
});

test("timed → still removes Play in the same result and keeps unrelated animations", () => {
  const source = documentFor({ src: video.src, mediaStart: 1, mediaOffset: 0.4, mediaDuration: 1, mediaSourceDuration: 2 }, "video");
  const result = replace(source, old, video).scenes[0].layers[0];
  assert.equal(result.type, "image");
  for (const key of ["mediaStart", "mediaOffset", "mediaDuration", "mediaSourceDuration"]) assert.equal(result[key], 0, key);
  assert.deepEqual(result.animations, source.scenes[0].layers[0].animations);
});

test("a video with subject boxes becomes a still without them; another video keeps them, tied to the old file", () => {
  const subjectBoxes = { src: video.src, boxes: [{ at: 0.6, box: [17, 25, 38, 63], by: "agent" }] };
  const source = documentFor({ src: video.src, subjectBoxes }, "video");
  const still = replace(source, old, video).scenes[0].layers[0];
  assert.equal(still.type, "image");
  assert.equal("subjectBoxes" in still, false);
  const other = { ...video, id: "55555555-5555-4555-8555-555555555555.mp4", src: "/api/media/55555555-5555-4555-8555-555555555555.mp4" };
  const swapped = replace(source, other, video).scenes[0].layers[0];
  assert.deepEqual(swapped.subjectBoxes, subjectBoxes);
});

test("still → animated GIF uses imported timing; a single-frame GIF has no Play", () => {
  assert.equal(replace(documentFor(), gif).scenes[0].layers[0].mediaDuration, 2);
  const single = { ...gif, animated: false, frameCount: 1 };
  assert.equal(replace(documentFor(), single).scenes[0].layers[0].mediaDuration, 0);
});

test("invalid replacement refuses without mutating the source", () => {
  const source = documentFor();
  const before = structuredClone(source);
  assert.throws(() => replace(source, audio), /audio/i);
  assert.throws(() => replace(documentFor({}, "audio"), video), /audio/i);
  assert.throws(() => replace(documentFor({}, "rectangle"), video), /media layer/i);
  assert.throws(() => applyOperations(source, [{ type: "replace_media", sceneId: "scene", layerId: "layer", mediaId: video.id }]), /media.*not found|uploaded/i);
  assert.throws(() => applyOperations(source, [{ type: "replace_media", sceneId: "scene", layerId: "gone", mediaId: video.id }]), /Layer gone/);
  assert.throws(() => replace(source, { ...video, src: "https://elsewhere.test/file.mp4" }), /uploaded|local/i);
  assert.throws(() => replace(source, { ...video, measurementSucceeded: false }), /could not be decoded/i);
  assert.deepEqual(source, before);
});
