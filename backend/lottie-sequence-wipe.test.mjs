import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { defaultFonts } from "../engine/fonts.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";

// A sequence's straight wipe exports to Lottie; a shaped one is refused, as the docs say.
test("Lottie export takes a straight sequence wipe and refuses a shaped one", async () => {
  const scenes = [1, 2].map((n) => createScene({ id: `p${n}`, name: `Part ${n}`, width: 320, height: 180, duration: 1,
    layers: [{ ...createLayer("rectangle"), id: `r${n}`, name: `r${n}`, width: 100, height: 60, fill: "#ffffff" }] }));
  const sequence = (transition) => {
    const document = applyOperations(createDocument({ scenes }), [{ type: "add_sequence", properties: { id: "seq", name: "Film" }, scenes: ["p1", "p2"], transition }], { fonts: defaultFonts, reports: new Map() });
    return expandComponents(document, "seq", { fonts: defaultFonts });
  };
  assert.ok((await exportScene(sequence("wipe"), { format: "lottie", fps: 4 })).buffer.length > 0);
  await assert.rejects(exportScene(sequence({ type: "wipe", shape: "iris" }), { format: "lottie", fps: 4 }), /draws only straight wipes/);
  const docs = readFileSync(new URL("./agent/operations.md", import.meta.url), "utf8");
  assert.match(docs, /Lottie export refuses a sequence that uses any of them/);
});
