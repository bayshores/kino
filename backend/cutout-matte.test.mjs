// Matte clean-up for cut_out (backend/cutout/matte.mjs), on every computer: the temporal median
// that steadies edges, grow and shrink measured as true distances, feather widths, the bounding
// box shortcut in finishMatte, and bilinear scaling. Every number is checked against a disc whose
// edge is known exactly, not against output saved from an earlier run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleMatte } from "./cutout/cutout.mjs";
import { createSteadier, feather, finishMatte, grow, matteMeasure, radialEdgeErrors } from "./cutout/matte.mjs";

// A disc of radius r centred at (cx, cy), anti-aliased over one pixel like a real matte.
function disc(width, height, { cx, cy, r }) {
  const matte = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      matte[y * width + x] = Math.round(255 * Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy))));
  return matte;
}

// The radius at which the matte crosses half, averaged over 64 rays.
function measuredRadius(matte, width, height, centre) {
  const errors = radialEdgeErrors(matte, width, height, { ...centre, r: centre.r }, 64).map((ray) => ray.error);
  assert.ok(errors.every((error) => error !== null), "every ray finds the edge");
  return centre.r + errors.reduce((sum, error) => sum + error, 0) / errors.length;
}

test("the steadier keeps a still edge still and removes a one- or two-frame pop", () => {
  const width = 60, height = 40, centre = { cx: 30, cy: 20, r: 10 };
  const still = disc(width, height, centre);
  const popped = disc(width, height, { ...centre, r: 15 });
  const empty = new Uint8Array(width * height);
  // Frames 0–9 show the disc; frame 4 is too big for one frame, frames 7 and 8 lose it.
  const input = Array.from({ length: 10 }, (_, index) => (index === 4 ? popped : index === 7 || index === 8 ? empty : still));
  const steadier = createSteadier({ width, height, radius: 2 });
  const output = [];
  for (const frame of input) output.push(...steadier.push(frame));
  assert.equal(output.length, 8, "two frames wait for the frames after them");
  output.push(...steadier.finish());
  assert.equal(output.length, 10, "finish sends the rest: one frame out for each frame in");
  // With radius 2 a pop of at most two frames is outvoted by the three around it.
  for (const [index, frame] of output.entries())
    assert.deepEqual(frame, still, `frame ${index} is the steady disc`);
});

test("the steadier follows a subject that really moves, even a small fast one", () => {
  // A disc of radius r moving v pixels a frame. Slow: the median of five frames is the middle
  // frame's own disc. Fast (v near r or more): each pixel is covered in too few of the five
  // frames, so the median alone would drop the disc; the frame's own matte is kept instead.
  for (const [r, v, least] of [[10, 2, 1], [10, 6, 0.98], [10, 10, 1], [10, 20, 1], [30, 15, 0.99], [30, 45, 1]]) {
    const width = 2 * r + 20 + 12 * v, height = 2 * r + 20;
    const input = Array.from({ length: 12 }, (_, index) => disc(width, height, { cx: r + 10 + v * index, cy: height / 2, r }));
    const steadier = createSteadier({ width, height, radius: 2 });
    const output = [...input.flatMap((frame) => steadier.push(frame)), ...steadier.finish()];
    for (const [index, frame] of output.entries()) {
      const { iou } = matteMeasure(frame, { truth: input[index].map((value) => (value >= 128 ? 1 : 0)) });
      assert.ok(iou >= least, `r ${r}, ${v} px a frame: frame ${index} IoU ${iou.toFixed(4)}`);
    }
  }
  // Fast and found a little bigger or smaller in each frame (up to 4%, as Vision's mask of a blurred
  // subject is): a frame bigger than one frame beside it still keeps its own edge (0.84 before the
  // pop-up check compared with the larger neighbour rather than their mean).
  const sizes = [0, 1, -1, 0.5, 1, -0.5, 0, 1, -1, 1, 0, -1].map((step) => 40 * (1 + 0.04 * step));
  const width = 400, height = 120;
  const input = sizes.map((r, index) => disc(width, height, { cx: 60 + 25 * index, cy: 60, r }));
  const wobbly = createSteadier({ width, height, radius: 2 });
  const output = [...input.flatMap((frame) => wobbly.push(frame)), ...wobbly.finish()];
  for (const [index, frame] of output.entries()) {
    const { iou } = matteMeasure(frame, { truth: input[index].map((value) => (value >= 128 ? 1 : 0)) });
    assert.ok(iou >= 0.99, `size wobble: frame ${index} IoU ${iou.toFixed(4)}`);
  }
  const steadier = createSteadier({ width: 10, height: 10, radius: 2 });
  assert.throws(() => createSteadier({ width: 10, height: 10, radius: 3 }), /0, 1 or 2/);
  assert.throws(() => steadier.push(new Uint8Array(5)), /bytes/);
});

test("the steadier removes a blob that pops up for one frame, near or far from the subject", () => {
  const width = 200, height = 80, centre = { cx: 50, cy: 40, r: 20 };
  const still = disc(width, height, centre);
  const blob = disc(width, height, { cx: 150, cy: 40, r: 16 });
  const near = disc(width, height, { cx: 80, cy: 40, r: 14 });
  const withBlob = still.map((value, i) => Math.max(value, blob[i]));
  const withNear = still.map((value, i) => Math.max(value, near[i]));
  const input = [still, still, still, withBlob, still, still, withNear, still, still];
  const steadier = createSteadier({ width, height, radius: 2 });
  const output = [...input.flatMap((frame) => steadier.push(frame)), ...steadier.finish()];
  for (const [index, frame] of output.entries()) assert.deepEqual(frame, still, `frame ${index}`);
});

test("grow and shrink move the edge by true distances, so a disc stays a disc", () => {
  const width = 120, height = 120, centre = { cx: 60, cy: 60, r: 25 };
  const matte = disc(width, height, centre);
  assert.ok(Math.abs(measuredRadius(matte, width, height, centre) - 25) < 0.15, "the test disc's edge is where it should be");
  for (const pixels of [1, 4, 10.5, 20, -3, -8, -15]) {
    const moved = grow(matte, width, height, pixels);
    const radius = measuredRadius(moved, width, height, { ...centre, r: 25 + pixels });
    assert.ok(Math.abs(radius - (25 + pixels)) < 0.6, `grow ${pixels}: radius ${radius.toFixed(2)}, expected ${25 + pixels}`);
    // Round on every side: the rays agree within a pixel.
    const errors = radialEdgeErrors(moved, width, height, { ...centre, r: 25 + pixels }).map((ray) => ray.error);
    assert.ok(Math.max(...errors) - Math.min(...errors) < 1.2, `grow ${pixels} keeps the disc round (${Math.min(...errors).toFixed(2)} to ${Math.max(...errors).toFixed(2)})`);
  }
  // Shrinking past the subject leaves nothing; growing an empty matte leaves it empty.
  assert.equal(grow(matte, width, height, -40).every((value) => value === 0), true);
  assert.equal(grow(new Uint8Array(width * height), width, height, 10).every((value) => value === 0), true);
  assert.deepEqual(grow(matte, width, height, 0), matte, "grow 0 leaves the matte as it is");
});

test("feather spreads the edge over about the asked width, keeping it in place", () => {
  const width = 160, height = 160, centre = { cx: 80, cy: 80, r: 40 };
  const matte = disc(width, height, centre);
  for (const pixels of [4, 12, 24]) {
    const soft = feather(matte, width, height, pixels);
    // Along a row through the centre, from inside to outside: 90% to 10% takes about `pixels`.
    const row = Array.from({ length: width }, (_, x) => soft[80 * width + x] / 255);
    const crossing = (level) => {
      for (let x = 80; x < width - 1; x += 1) if (row[x] >= level && row[x + 1] < level) return x + (row[x] - level) / (row[x] - row[x + 1]);
      return null;
    };
    const ramp = crossing(0.1) - crossing(0.9);
    assert.ok(Math.abs(ramp - pixels) < 0.25 * pixels + 1, `feather ${pixels}: the edge ramps over ${ramp.toFixed(1)} px`);
    assert.ok(Math.abs(crossing(0.5) + 0.5 - 120) < 1.2, `feather ${pixels} keeps the half-way edge at the disc's edge`);
    // A blur moves matte around but keeps its amount (the disc is far from the borders).
    assert.ok(Math.abs(matteMeasure(soft).area - matteMeasure(matte).area) < 0.002);
  }
  // A subject touching the frame's edge stays solid there.
  const edge = disc(80, 80, { cx: 0, cy: 40, r: 30 });
  assert.equal(feather(edge, 80, 80, 10)[40 * 80], 255);
});

test("finishMatte works on the subject's box and gives what the whole frame would", () => {
  const width = 400, height = 240, centre = { cx: 300, cy: 70, r: 22 };
  const matte = disc(width, height, centre);
  for (const settings of [{ grow: 6 }, { feather: 10 }, { grow: 8, feather: 16 }, { grow: -5, feather: 3 }]) {
    let whole = matte;
    if (settings.grow) whole = grow(whole, width, height, settings.grow);
    if (settings.feather) whole = feather(whole, width, height, settings.feather);
    const boxed = finishMatte(matte, width, height, settings);
    let worst = 0;
    for (let i = 0; i < whole.length; i += 1) worst = Math.max(worst, Math.abs(whole[i] - boxed[i]));
    assert.ok(worst <= 1, `${JSON.stringify(settings)}: largest difference ${worst}`);
  }
  assert.equal(finishMatte(matte, width, height, {}), matte, "no settings: the matte itself");
  assert.equal(finishMatte(new Uint8Array(width * height), width, height, { grow: 5 }).some((value) => value), false);
});

test("scaleMatte scales a matte the way FFmpeg and browsers line up pixel centres", () => {
  const small = disc(64, 36, { cx: 32, cy: 18, r: 10 });
  const big = scaleMatte(small, 64, 36, 256, 144);
  assert.equal(big.length, 256 * 144);
  const radius = measuredRadius(big, 256, 144, { cx: 128, cy: 72, r: 40 });
  assert.ok(Math.abs(radius - 40) < 1, `the edge scales with the picture (radius ${radius.toFixed(2)})`);
  assert.equal(scaleMatte(small, 64, 36, 64, 36), small);
});
