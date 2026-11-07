import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { FontRegistry } from "../engine/fonts.js";
import { layoutText } from "../engine/textLayout.js";
import { startTestServer } from "./media.test.support.mjs";

async function json(response, expected = 200) {
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : null;
}
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${message}: ${actual} versus ${expected}`);

test("text preset operations use linked text line height, preserve Mode, and reject invalid edits atomically", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);

  const projectId = "preset-catalog-project";
  const alias = "CatalogFace";
  const initialLayers = [
    createLayer("text", {
      id: "text-up",
      name: "Auto-sized title",
      text: "A measured title",
      textResize: "width-height",
      width: 1,
      height: 1,
      x: 80,
      y: 90,
      textAlign: "center",
      verticalAlign: "middle",
      fontFamily: alias,
      fontSize: 32,
    }),
    createLayer("text", {
      id: "text-right",
      name: "Auto-sized two-line label",
      text: "First line\nSecond line",
      textResize: "width-height",
      width: 1,
      height: 1,
      x: 240,
      y: 150,
      textAlign: "right",
      verticalAlign: "bottom",
      fontFamily: alias,
      fontSize: 28,
    }),
  ];
  const created = await json(await server.api("/api/projects", {
    method: "POST",
    body: {
      document: createDocument({
        id: projectId,
        name: "Preset geometry",
        scenes: [createScene({ id: "main", width: 640, height: 360, duration: 8, layers: initialLayers })],
      }),
    },
  }), 201);

  const fontBytes = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const upload = await json(await server.api(`/api/media?project=${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "font/ttf", "X-File-Name": `${alias}.ttf` },
    body: fontBytes,
  }), 201);

  const attachedDocument = structuredClone(created.document);
  for (const layer of attachedDocument.scenes[0].layers) layer.fontSource = upload.src;
  let saved = await json(await server.api(`/api/projects/${projectId}`, {
    method: "PUT",
    body: { document: attachedDocument, revision: created.revision },
  }));

  // The upload's filename is the actual family alias registered by the server.
  // Measure the same font bytes locally so endpoint checks use exact integer geometry.
  const fonts = new FontRegistry();
  fonts.register(fontBytes, { id: upload.id, family: alias, weight: 400, style: "normal", src: upload.src });
  const geometry = new Map(saved.document.scenes[0].layers.map((layer) => [
    layer.id,
    layoutText(layer, fonts),
  ]));
  const layerById = (document, id) => document.scenes[0].layers.find((layer) => layer.id === id);
  const animationById = (document, layerId, animationId) => layerById(document, layerId).animations.find((animation) => animation.id === animationId);

  async function apply(operations) {
    saved = await json(await server.api(`/api/projects/${projectId}/operations`, {
      method: "POST",
      body: { revision: saved.revision, operations },
    }));
    return saved;
  }

  await apply([
    { type: "add_animation", sceneId: "main", layerId: "text-up", preset: "slide-up", start: 0.25, duration: 1.5, parameters: { distance: 50 } },
    { type: "add_animation", sceneId: "main", layerId: "text-right", preset: "slide-right", start: 0.5, duration: 1.25, parameters: { distance: 40 } },
  ]);
  const firstUp = layerById(saved.document, "text-up").animations[0];
  const firstRight = layerById(saved.document, "text-right").animations[0];
  const upLayer = layerById(saved.document, "text-up");
  const rightLayer = layerById(saved.document, "text-right");
  const upLine = geometry.get("text-up").lineHeight;
  const rightLine = geometry.get("text-right").lineHeight;
  assert.notEqual(rightLine, geometry.get("text-right").width, "horizontal text travel uses a line, not the text box width");
  assert.equal(firstUp.from.y, upLayer.y + upLine * 0.5, "Slide Up uses the linked text line height");
  assert.equal(firstUp.to.y, upLayer.y);
  close(firstRight.from.x, rightLayer.x - rightLine * 0.4, "Slide Right uses the linked text line height");
  assert.equal(firstRight.to.x, rightLayer.x);

  await apply([{
    type: "update_animation",
    sceneId: "main",
    layerId: "text-up",
    animationId: firstUp.id,
    properties: { preset: { parameters: { distance: 25 } } },
  }]);
  assert.equal(animationById(saved.document, "text-up", firstUp.id).from.y, upLayer.y + upLine * 0.25,
    "a single parameter edit regenerates against line height");

  await apply([{
    type: "update_animations",
    sceneId: "main",
    animationIds: [firstUp.id, firstRight.id],
    properties: { preset: { parameters: { distance: 80 } } },
  }]);
  close(animationById(saved.document, "text-up", firstUp.id).from.y, upLayer.y + upLine * 0.8,
    "multi-update regenerates the vertical preset against line height");
  close(animationById(saved.document, "text-right", firstRight.id).from.x, rightLayer.x - rightLine * 0.8,
    "multi-update regenerates the horizontal preset against line height");

  await apply([{
    type: "update_animation",
    sceneId: "main",
    layerId: "text-up",
    animationId: firstUp.id,
    properties: { preset: { mode: "out" } },
  }]);
  const modeOut = animationById(saved.document, "text-up", firstUp.id);
  assert.equal(modeOut.kind, "out");
  assert.equal(modeOut.from.y, upLayer.y, "Mode Out starts at the unanimated position");
  close(modeOut.to.y, upLayer.y + upLine * 0.8, "Mode Out ends at the measured effect position");

  const readback = await json(await server.api(`/api/projects/${projectId}`));
  assert.equal(readback.revision, saved.revision);
  assert.deepEqual(animationById(readback.document, "text-up", firstUp.id), modeOut,
    "the Mode Out preset and regenerated endpoints are persisted by the HTTP operation");
  assert.deepEqual(animationById(readback.document, "text-right", firstRight.id),
    animationById(saved.document, "text-right", firstRight.id));

  const rejected = await json(await server.api(`/api/projects/${projectId}/operations`, {
    method: "POST",
    body: {
      revision: readback.revision,
      operations: [{
        type: "update_animation",
        sceneId: "main",
        layerId: "text-up",
        animationId: firstUp.id,
        properties: { preset: { parameters: { distance: "80" } } },
      }],
    },
  }), 400);
  assert.match(rejected.error, /distance/);
  const unchanged = await json(await server.api(`/api/projects/${projectId}`));
  assert.equal(unchanged.revision, readback.revision, "invalid parameters do not advance project revision");
  assert.deepEqual(animationById(unchanged.document, "text-up", firstUp.id), modeOut,
    "invalid parameters leave the persisted preset unchanged");
});
