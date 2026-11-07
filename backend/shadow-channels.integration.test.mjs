import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { startTestServer } from "./media.test.support.mjs";

test("the agent's edit changes independent Shadow channels, persists them, and rejects invalid batches atomically", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const shadow = { color: "#ff000080", x: 0, y: 10, blur: 4 };
  const created = await server.api("/api/projects", { method: "POST", body: {
    document: createDocument({ id: "shadow-channels", name: "Independent Shadows", scenes: [createScene({
      id: "main", width: 160, height: 120, duration: 4,
      layers: [createLayer("rectangle", { id: "card", name: "Card", shadow })],
    })] }),
  } });
  assert.equal(created.status, 201);
  const read = async () => (await server.api("/api/projects/shadow-channels")).json();
  // The agent's edit tool, as the MCP server and the kino command call it.
  const edit = async (ops) => (await server.api("/api/agent/edit", { method: "POST", body: { project: "shadow-channels", ops } })).json();
  let saved;
  const apply = async (ops) => {
    const result = await edit(ops);
    assert.equal(result.isError, undefined, result.text);
    saved = await read();
  };
  await apply([{ op: "add_animation", layer: "Card", preset: "shadow", shadowChannels: ["blur"], easing: "linear", duration: 2 }]);
  const first = saved.document.scenes[0].layers[0].animations[0];
  assert.deepEqual(first.shadowChannels, ["blur"]);
  const update = (properties) => ({ op: "update_animation", layer: "Card", animation: first.id, properties });
  await apply([update({ to: { shadow: { color: "#00000000", x: 999, y: 999, blur: 20 } } }),
    { op: "add_animation", layer: "Card", animation: {
      id: "x", name: "Offset X", kind: "custom", start: 0.5, duration: 1, easing: "linear",
      shadowChannels: ["x"], from: { shadow }, to: { shadow: { ...shadow, x: 40, blur: 99 } },
    } }]);
  const readback = saved;
  assert.deepEqual(evaluateLayer(readback.document.scenes[0].layers[0], 1).shadow,
    { color: "#ff000080", x: 20, y: 10, blur: 12 });

  for (const invalid of [[], ["spread"], ["blur", "blur"], "blur", [1]]) {
    const result = await edit([update({ name: "Must not persist" }), update({ shadowChannels: invalid })]);
    assert.equal(result.isError, true, JSON.stringify(invalid));
    assert.match(result.text, /shadowChannels/);
    const unchanged = await read();
    assert.equal(unchanged.revision, readback.revision);
    assert.deepEqual(unchanged.document, readback.document, "the valid edit before the invalid selector also rolls back");
  }
  await apply([update({ shadowChannels: null })]);
  assert.ok(!Object.hasOwn(saved.document.scenes[0].layers[0].animations[0], "shadowChannels"));
});
