import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { startTestServer, readImage } from "./media.test.support.mjs";

// A whole scene as a native-size still PNG at `time`, as the /api/export route takes it.
const scenePngRequest = (document, sceneId, time) => ({ document, sceneId, options: { format: "png", size: "native", time } });

test("the scene PNG HTTP path preserves a 3000 by 3000 playhead render and enforces native bounds", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const document = parseDocument(createDocument({ id: "native-scene-png", scenes: [createScene({
    id: "scene", width: 3000, height: 3000, duration: 2, background: "#123456", layers: [
      createLayer("rectangle", { id: "bar", x: 0, y: 0, width: 8, height: 8, fill: "#ff0000", animations: [
        { id: "move", name: "Move", kind: "custom", start: 0, duration: 2, easing: "linear", from: { x: 0 }, to: { x: 32 } },
      ] }),
    ],
  })] }));
  const created = await service.api("/api/projects", { method: "POST", body: { document } });
  assert.equal(created.status, 201);
  const record = await created.json();
  const response = await service.api("/api/export", { method: "POST", body: scenePngRequest(document, "scene", 1) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const image = await readImage(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([image.width, image.height], [3000, 3000]);
  assert.deepEqual(image.pixel(2999, 2999), [18, 52, 86, 255]);
  assert.deepEqual(image.pixel(18, 4), [255, 0, 0, 255], "animation is sampled at the playhead");
  const oversized = structuredClone(document);
  Object.assign(oversized.scenes[0], { width: 6000, height: 6000 });
  const refused = await service.api("/api/export", { method: "POST", body: {
    document: oversized, sceneId: "scene", options: { format: "png", size: "native", time: 0 },
  } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /33,554,432/);
  const current = await (await service.api(`/api/projects/${document.id}`)).json();
  assert.equal(current.revision, record.revision, "successful and refused exports leave the file unchanged");
});
