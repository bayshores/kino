import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

test("Lottie export refuses stacked strokes with a message", async () => {
  const card = { ...createLayer("rectangle"), id: "card", name: "card", width: 100, height: 60, stroke: "#ffffff", strokeWidth: 4 };
  const scene = (layer) => createScene({ id: "s", name: "s", width: 320, height: 180, duration: 1, background: "transparent", layers: [layer] });
  await assert.rejects(exportScene(scene({ ...card, strokes: [{ color: "#ff0000", width: 8 }] }), { format: "lottie", fps: 4 }),
    /cannot render stacked strokes \(strokes\) on layer “card”/);
});
