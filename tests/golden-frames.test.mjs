// Golden-frame regression test: renders every fixture in tests/golden/scenes.mjs through the real
// PNG export and compares it, pixel by pixel, with the stored PNG in tests/golden/frames/.
// When a change is meant to alter how frames look, run `npm run golden:update`, look at the new
// PNGs, and commit them together with the change.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scenes } from "./golden/scenes.mjs";
import { MAX_MISMATCH_RATIO, comparePixels, decodePng, encodePng } from "./golden/compare.mjs";
import { frameFileName, goldenPath, renderFrame } from "./golden/render.mjs";
import { hasMediaTools } from "./golden/media.mjs";

// One temp folder per test run, made only when a frame fails, holding the failed renders.
let failureDirectory = null;
async function saveFailure(fileName, actualPng, diffPng) {
  failureDirectory ??= process.env.KINO_GOLDEN_FAILURES
    ? await mkdir(process.env.KINO_GOLDEN_FAILURES, { recursive: true }).then(() => process.env.KINO_GOLDEN_FAILURES)
    : await mkdtemp(path.join(os.tmpdir(), "kino-golden-"));
  const base = fileName.replace(/\.png$/, "");
  await writeFile(path.join(failureDirectory, `${base}.actual.png`), actualPng);
  if (diffPng) await writeFile(path.join(failureDirectory, `${base}.diff.png`), diffPng);
  return failureDirectory;
}

for (const fixture of scenes) {
  for (const time of fixture.times) {
    const fileName = frameFileName(fixture, time);
    // The clip speed fixtures play footage that FFmpeg makes, so they need FFmpeg.
    const skip = fixture.media && !hasMediaTools ? "FFmpeg and ffprobe are required to make the golden media (tests/golden/media.mjs)" : false;
    test(`golden frame ${fileName}`, { skip }, async () => {
      const golden = goldenPath(fileName);
      if (!existsSync(golden)) {
        assert.fail(`Missing golden frame tests/golden/frames/${fileName}. Run \`npm run golden:update\`, check the new PNG, and commit it.`);
      }
      const actualPng = await renderFrame(fixture, time);
      const expected = await decodePng(await readFile(golden));
      const actual = await decodePng(actualPng);

      if (expected.width !== actual.width || expected.height !== actual.height) {
        const folder = await saveFailure(fileName, actualPng, null);
        assert.fail(`${fileName}: rendered ${actual.width}x${actual.height}, golden is ${expected.width}x${expected.height}. Actual frame saved in ${folder}`);
      }

      const { mismatched, diff } = comparePixels(expected, actual);
      const ratio = mismatched / (expected.width * expected.height);
      if (ratio > MAX_MISMATCH_RATIO) {
        const folder = await saveFailure(fileName, actualPng, await encodePng(expected.width, expected.height, diff));
        assert.fail(
          `${fileName}: ${(ratio * 100).toFixed(2)}% of pixels differ from ${path.relative(process.cwd(), golden)} (allowed ${MAX_MISMATCH_RATIO * 100}%). `
          + `Actual and diff (red = different) PNGs saved in ${folder}. `
          + "If the change is intended, run `npm run golden:update` and commit the new frames.",
        );
      }
    });
  }
}
