// The entry point other apps import (integration.mjs) keeps its names, and a document built
// with it the way an outside screen recorder builds one is a valid kino document.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as kino from "./integration.mjs";

test("the integration entry point exports its fixed names and builds a valid document", () => {
  assert.deepEqual(Object.keys(kino).sort(), ["DOCUMENT_VERSION", "INTEGRATION_VERSION", "MAX_UPLOAD_BYTES",
    "connectAgentClient", "createDocument", "createLayer", "createScene", "parseDocument"]);
  assert.equal(kino.INTEGRATION_VERSION, 1);
  assert.equal(typeof kino.connectAgentClient, "function");
  assert.ok(kino.MAX_UPLOAD_BYTES > 0);
  const clip = kino.createLayer("video", { id: "screen-1", name: "Screen", src: "/api/media/screen", x: 0, y: 0,
    width: 1280, height: 720, mediaStart: 0, mediaOffset: 2, mediaDuration: 4, mediaSourceDuration: 10, mediaSpeed: 1.5 });
  const scene = kino.createScene({ id: "scene-1", name: "Part 1", width: 1280, height: 720, duration: 4, layers: [clip] });
  const document = kino.parseDocument(kino.createDocument({ name: "Recording", scenes: [scene] }));
  assert.equal(document.version, kino.DOCUMENT_VERSION);
  const layer = document.scenes[0].layers[0];
  assert.deepEqual([layer.type, layer.src, layer.mediaOffset, layer.mediaSpeed], ["video", "/api/media/screen", 2, 1.5]);
});
