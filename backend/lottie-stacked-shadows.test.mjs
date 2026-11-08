import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

test("Lottie export refuses stacked shadows with a message and keeps one shadow", async () => {
  const card = { ...createLayer("rectangle"), id: "card", name: "card", width: 100, height: 60, shadow: { color: "#00000080", x: 0, y: 6, blur: 10 } };
  const scene = (layer) => createScene({ id: "s", name: "s", width: 320, height: 180, duration: 1, background: "transparent", layers: [layer] });
  await assert.rejects(exportScene(scene({ ...card, shadows: [{ color: "#ff0000", x: 4, y: 4, blur: 0 }] }), { format: "lottie", fps: 4 }),
    /cannot render stacked shadows \(shadows\) on layer “card”/);
  const result = await exportScene(scene(card), { format: "lottie", fps: 4 });
  assert.ok(JSON.parse(result.buffer.toString("utf8")).layers.length);
});
