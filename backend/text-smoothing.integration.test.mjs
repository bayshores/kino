import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

test("the agent's edit stores text-unit smoothing through HTTP and rejects invalid operation batches atomically", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const projectId = "text-smoothing-project";
  const created = await server.api("/api/projects", {
    method: "POST",
    body: {
      document: createDocument({
        id: projectId,
        name: "Text smoothing",
        scenes: [createScene({
          id: "scene",
          name: "Scene",
          width: 120,
          height: 80,
          duration: 4,
          layers: [createLayer("text", { id: "title", name: "Title", text: "AB" })],
        })],
      }),
    },
  });
  assert.equal(created.status, 201, await created.clone().text());

  // The agent's edit tool, as the MCP server and the kino command call it.
  const edit = async (ops) => (await server.api("/api/agent/edit", { method: "POST", body: { project: projectId, ops } })).json();
  const read = async () => {
    const response = await server.api(`/api/projects/${projectId}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const added = await edit([{
    op: "add_animation",
    layer: "Title",
    animation: {
      id: "letters",
      name: "Letter Fade",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      intensity: 88,
      unit: "letters",
      stagger: 0.2,
      order: "forward",
      from: { opacity: 0 },
      to: { opacity: 1 },
      smoothing: "linear",
      smoothingIntensity: 4,
    },
    smoothing: "Slow down",
    smoothingIntensity: 73,
  }]);
  assert.equal(added.isError, undefined, added.text);

  const record = await read();
  const animation = record.document.scenes[0].layers[0].animations[0];
  assert.deepEqual([animation.smoothing, animation.smoothingIntensity, animation.intensity], ["ease-out", 73, 88]);
  assert.equal(animation.unit, "letters");

  const rejected = await edit([
    { op: "update_animation", layer: "Title", animation: "letters", properties: { name: "Would be partial" } },
    { op: "update_animation", layer: "Title", animation: "letters", properties: { smoothing: "bounce" } },
  ]);
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /smoothing/i);

  const after = await read();
  assert.equal(after.revision, record.revision, "a rejected batch does not advance the file revision");
  assert.deepEqual(after.document, record.document, "the valid first edit is not saved when the later smoothing value is invalid");
});
