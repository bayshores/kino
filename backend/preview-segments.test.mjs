import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLayer } from "../engine/model.js";
import { createPreviewCache, previewSegmentKeys, previewSize, renderPreviewSegment } from "./preview-segments.mjs";

// A 5 s scene: "always" shows throughout; "late" has no opacity until it fades in at 4.2 s.
function scene() {
  return {
    id: "s1", name: "Scene", width: 160, height: 90, duration: 5, background: "#101010",
    layers: [
      createLayer("rectangle", { id: "always", x: 10, y: 10, width: 40, height: 30, fill: "#ff0000" }),
      createLayer("rectangle", { id: "late", x: 80, y: 40, width: 40, height: 30, fill: "#00ff00", opacity: 0,
        animations: [{ id: "a1", start: 4.2, duration: 0.5, from: {}, to: { opacity: 1 }, easing: "linear" }] }),
    ],
  };
}

test("a segment's key changes only when a layer that shows in it changes", async () => {
  const keys = async (value) => (await previewSegmentKeys(value)).map((segment) => segment.key);
  const before = await keys(scene());
  assert.deepEqual((await previewSegmentKeys(scene())).map(({ start, end }) => [start, end]), [[0, 2], [2, 4], [4, 5]]);
  const lateEdit = scene();
  lateEdit.layers[1].fill = "#0000ff";
  const afterLate = await keys(lateEdit);
  assert.deepEqual(afterLate.slice(0, 2), before.slice(0, 2), "hidden in 0 to 4 s: those keys stay");
  assert.notEqual(afterLate[2], before[2]);
  // A top-level mask over "always" does not tie "late" to every segment.
  const masked = (fill) => { const value = scene(); value.layers[1].fill = fill;
    value.layers.unshift(createLayer("rectangle", { id: "mask", isMask: true, x: 0, y: 0, width: 80, height: 60 })); return value; };
  const [maskBefore, maskAfter] = [await keys(masked("#00ff00")), await keys(masked("#0000ff"))];
  assert.deepEqual(maskAfter.slice(0, 2), maskBefore.slice(0, 2));
  assert.notEqual(maskAfter[2], maskBefore[2]);
  const alwaysEdit = scene();
  alwaysEdit.layers[0].x = 20;
  (await keys(alwaysEdit)).forEach((key, index) => assert.notEqual(key, before[index]));
  assert.deepEqual(previewSize({ width: 1920, height: 1080 }), { width: 960, height: 540 });
  assert.deepEqual(previewSize({ width: 1080, height: 1920 }), { width: 540, height: 960 });
});

test("a 2 s segment renders to a silent H.264 file in the preview cache, once", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "kino-test-times-preview-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const cache = createPreviewCache({ dataDirectory: data, maxBytes: 16 * 1024 * 1024 });
  t.after(() => cache.close());
  const value = scene();
  const size = { width: 64, height: 36 };
  const [segment] = await previewSegmentKeys(value, { size });
  const first = await renderPreviewSegment(value, segment, { cache, size });
  assert.equal(first.cached, false);
  assert.match(first.path, /[/\\]preview-cache[/\\]/);
  assert.equal((await readFile(first.path)).subarray(4, 8).toString(), "ftyp");
  const probe = execFileSync(process.env.KINO_FFPROBE ?? "ffprobe", ["-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames", "-of", "csv=p=0", first.path]).toString().trim();
  assert.equal(probe, "h264,video,64,36,60");
  const again = await renderPreviewSegment(value, segment, { cache, size });
  assert.deepEqual([again.cached, again.path, again.bytes], [true, first.path, first.bytes]);
});
