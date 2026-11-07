import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";

test("cancellation at the final PNG write stays handled while temporary media is cleaned up", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-write-cancel-"));
  const controller = new AbortController();
  const fonts = await loadBundledFonts();
  try {
    const result = exportScene(createScene({ width: 32, height: 32, layers: [createLayer("rectangle", { x: 0, y: 0, width: 32, height: 32 })] }),
      { format: "png" }, { fonts, outputPath: path.join(directory, "frame.png"), signal: controller.signal,
        onProgress(event) { if (event.stage === "render" && event.completed === 1) controller.abort(); } });
    await assert.rejects(result, (error) => error.name === "AbortError");
    // An unhandled inner write rejection would fail the test independently of the handled
    // outer export promise, as it did when the real batch service was canceled in CI.
    await new Promise((resolve) => setImmediate(resolve));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
