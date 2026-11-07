// The cut-out's edge clean-up (cutout/edges.mjs) on small synthetic frames: a steady shot's empty
// background (the plate) is found and a moving one is not; near the edge, pixels that match the
// plate leave the matte, and see-through edge pixels take the subject's colour.
import assert from "node:assert/strict";
import test from "node:test";
import { createEdgeRefiner, createPlateBuilder } from "./cutout/edges.mjs";

const W = 64, H = 48, SIZE = W * H;

// A planar YUV 4:4:4 frame: background `bg(x, y)` with a square subject of `fg` at `at`.
function frame({ bg = () => [200, 128, 128], fg = [60, 90, 170], at = [20, 14], side = 16 } = {}) {
  const yuv = new Uint8Array(SIZE * 3), matte = new Uint8Array(SIZE);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = y * W + x;
    const inside = x >= at[0] && x < at[0] + side && y >= at[1] && y < at[1] + side;
    const color = inside ? fg : bg(x, y);
    yuv[i] = color[0]; yuv[SIZE + i] = color[1]; yuv[2 * SIZE + i] = color[2];
    if (inside) matte[i] = 255;
  }
  return { yuv, matte };
}

const wall = (x, y) => [180 + ((x * 7 + y * 3) % 20), 128, 126];

test("a still shot's empty background is found from the frames the subject leaves; a moving one is not a plate", () => {
  const steady = createPlateBuilder({ width: W, height: H });
  for (let n = 0; n < 8; n += 1) {
    const { yuv, matte } = frame({ bg: wall, at: [4 + n * 6, 14] });
    steady.add(yuv, matte);
  }
  const plate = steady.finish();
  assert.equal(plate.steady, true);
  // Every pixel of the wall was seen empty in most frames: the plate is the wall itself.
  const i = 20 * W + 30;
  assert.equal(plate.known[i], 1);
  assert.deepEqual([plate.plate[i], plate.plate[SIZE + i], plate.plate[2 * SIZE + i]], wall(30, 20));
  // A pan: a striped wall slides every frame, so its pixels do not hold still and there is no plate.
  const pan = createPlateBuilder({ width: W, height: H });
  for (let n = 0; n < 8; n += 1) {
    const { yuv, matte } = frame({ bg: (x) => [((x + n * 5) >> 2) % 2 ? 70 : 200, 128, 128], at: [4 + n * 6, 14] });
    pan.add(yuv, matte);
  }
  assert.equal(pan.finish().steady, false);
});

test("near the edge, wall pixels inside a generous matte leave it; see-through edge pixels take the subject's colour", () => {
  const plateFrames = createPlateBuilder({ width: W, height: H });
  for (let n = 0; n < 8; n += 1) {
    const { yuv, matte } = frame({ bg: wall, at: [4 + n * 6, 14] });
    plateFrames.add(yuv, matte);
  }
  const plate = plateFrames.finish();
  // The subject at [24, 14], 16 px, with a matte 3 px too big (it holds wall) and a soft rim.
  const { yuv } = frame({ bg: wall, at: [24, 14] });
  const matte = new Uint8Array(SIZE);
  for (let y = 11; y < 33; y += 1) for (let x = 21; x < 43; x += 1) matte[y * W + x] = 255;
  for (let x = 21; x < 43; x += 1) matte[10 * W + x] = 120;
  const refiner = createEdgeRefiner({ width: W, height: H, plate, band: 6 });
  refiner.refine(yuv, matte);
  // The wall the matte held is gone; the subject is kept.
  assert.equal(matte[12 * W + 22], 0, "a wall pixel inside the generous matte");
  assert.equal(matte[20 * W + 30], 255, "the subject's middle");
  assert.equal(matte[14 * W + 24], 255, "the subject's own corner");
  // Without a plate, a see-through edge pixel takes the solid subject's colour, not the wall's.
  const plain = frame({ bg: wall, at: [24, 14] });
  const soft = Uint8Array.from(plain.matte);
  for (let x = 24; x < 40; x += 1) soft[13 * W + x] = 128;
  createEdgeRefiner({ width: W, height: H, plate: null, band: 6 }).refine(plain.yuv, soft);
  const i = 13 * W + 30;
  assert.equal(soft[i], 128, "no plate: the matte is left as it is");
  assert.deepEqual([plain.yuv[i], plain.yuv[SIZE + i], plain.yuv[2 * SIZE + i]], [60, 90, 170]);
  // A solid pixel is never recoloured.
  assert.deepEqual([plain.yuv[20 * W + 30], plain.yuv[SIZE + 20 * W + 30]], [60, 90]);
});
