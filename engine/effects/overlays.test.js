// Speed lines, impact lines, film burn, invert and lightning: each draws what it says on the layer's pixels,
// the same for the same seed and time, and amount or opacity 0 leaves the layer alone.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { effectDefaults, effectDefinition } from "./catalog.js";
import { linePaths } from "./overlays.js";
import { lightningAt } from "./lightning.js";
import { seenNames } from "../../backend/agent/seen-names.mjs";

const W = 96, H = 54;
const GRAY = `<rect width="${W}" height="${H}" fill="#404040"/>`;

function draw(key, parameters = {}, time = 0, content = GRAY) {
  let sequence = 0;
  const defs = [];
  const output = effectDefinition(key).render({ content, bounds: { x: 0, y: 0, width: W, height: H }, parameters: { ...effectDefaults(key), ...parameters },
    time, progress: 1, helpers: { id: (kind) => `t-${kind}-${++sequence}`, defs, raster: true, transform: [1, 0, 0, 1, 0, 0] } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { output, pixels: new Resvg(svg).render().pixels };
}
const luma = (pixels, x, y) => (pixels[(y * W + x) * 4] + pixels[(y * W + x) * 4 + 1] + pixels[(y * W + x) * 4 + 2]) / 3;
const lit = (pixels, test) => { let count = 0; for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (test(x, y) && luma(pixels, x, y) > 120) count += 1; return count; };

test("speed-lines: white streaks over the layer that slide with time, count and seed change them", () => {
  const still = draw("speed-lines", { thickness: 30 });
  assert.ok(lit(still.pixels, () => true) > 100, "streaks show");
  assert.notDeepEqual(draw("speed-lines", { thickness: 30 }, 0.2).pixels, still.pixels, "they move");
  assert.equal(linePaths("speed-lines", { bounds: { x: 0, y: 0, width: W, height: H }, parameters: { count: 12 }, time: 0 }).length, 12);
  assert.notDeepEqual(draw("speed-lines", { seed: 3 }).output, draw("speed-lines").output);
  assert.equal(draw("speed-lines", { opacity: 0 }).output, GRAY);
});

test("speed-lines fade: each line clears toward its tail, along its travel", () => {
  const solid = { thickness: 40, taper: 0, variation: 0, speed: 0, count: 6, angle: 90 };
  const even = draw("speed-lines", solid), faded = draw("speed-lines", { ...solid, fade: 1 });
  assert.match(faded.output, /fill="url\(#t-line-fade-1\)"/);
  assert.ok(lit(faded.pixels, () => true) < lit(even.pixels, () => true) * 0.8, "faded lines light less of the layer");
  assert.equal("fade" in effectDefaults("speed-lines"), false, "saved lines draw as before");
});

test("impact-lines: wedges from the edges leave the middle clear around the focus", () => {
  const { pixels } = draw("impact-lines", { thickness: 60, count: 40 });
  const middle = (x, y) => Math.hypot(x - W / 2, y - H / 2) < 8;
  assert.equal(lit(pixels, middle), 0, "the middle stays clear");
  assert.ok(lit(pixels, (x, y) => x < 6 || x > W - 7) > 40, "lines at the edges");
  assert.notDeepEqual(draw("impact-lines", {}, 0.1).output, draw("impact-lines", {}, 0).output, "rate 12 redraws them");
});

test("film-burn: hot at its edge, untouched far from it, laid over with screen", () => {
  const { pixels } = draw("film-burn", { reach: 0.6 });
  const left = lit(pixels, (x) => x < 12), right = lit(pixels, (x) => x > W - 12);
  assert.ok(left > 100 && right === 0, `left ${left}, right ${right}`);
  assert.equal(draw("film-burn", { amount: 0 }).output, GRAY);
});

test("invert flips light and dark; keepHue keeps a red red", () => {
  const red = `<rect width="${W}" height="${H}" fill="#C83020"/>`;
  const flipped = draw("invert", {}, 0, red).pixels, kept = draw("invert", { keepHue: true }, 0, red).pixels;
  assert.deepEqual([...flipped.subarray(0, 3)].map((value) => Math.round(value / 8)), [7, 26, 28].map((value) => Math.round(value * 8 / 8)));
  assert.ok(kept[0] > kept[2], "red stays the strongest channel");
  assert.equal(draw("invert", { amount: 0 }, 0, red).output, red);
});

test("lightning: jagged bolts from the middle out with branches, re-drawn at rate, flash only when asked", () => {
  const at = (time, parameters = {}) => lightningAt({ bounds: { x: 0, y: 0, width: 960, height: 540 }, parameters, time });
  const first = at(0);
  assert.equal(first.lines.length, 3 + 3 * 3, "3 bolts, 3 branches each");
  const bolt = first.lines[0].points;
  assert.ok(bolt.length > 30, "cut into many jagged points");
  const [ax, ay] = bolt[0], [bx, by] = bolt.at(-1);
  assert.ok(ax > 280 && ax < 680 && ay > 160 && ay < 380, "starts near the middle");
  assert.ok(bx < 0 || bx > 960 || by < 0 || by > 540, "ends past an edge");
  assert.deepEqual(at(0.05).lines[0].points, bolt, "the same drawing within one re-draw");
  assert.notDeepEqual(at(0.09).lines[0].points, bolt, "rate 12 draws a new bolt");
  assert.notDeepEqual(at(0, { seed: 4 }).lines[0].points, bolt);
  const pinned = at(0, { startX: 0.1, startY: 0, endX: 0.9, endY: 1, branches: 0 }).lines;
  assert.ok(pinned.every((line) => line.points[0][0] === 96 && line.points.at(-1)[1] === 540), "fixed ends: every strand between them");
  assert.equal(first.flash, 0, "no flash unless set");
  assert.equal(at(0, { flash: 0.8 }).flash, 0.8);
  assert.equal(at(0.1, { flash: 0.8 }).flash, 0, "the flash lasts one re-draw");
  const { pixels } = draw("lightning", { thickness: 40 });
  assert.ok(lit(pixels, () => true) > 60, "bright lines show over the layer");
  assert.equal(draw("lightning", { opacity: 0 }).output, GRAY);
});

test("search finds them by the words a person uses", () => {
  for (const [words, name] of [["lightning", "lightning"], ["electric arc", "lightning"], ["bolt", "lightning"], ["thunder", "lightning"], ["speed lines", "speed-lines"], ["focus lines", "impact-lines"], ["film burn", "film-burn"], ["negative", "invert"], ["punch in", "punch-in"], ["camera shake", "shake"]])
    assert.ok(seenNames(words)[0]?.startsWith(name), `${words}: ${seenNames(words)[0]}`);
  // Common words inside a longer query lead nowhere: subtitles are not a burn, a pyramid is not an invert.
  for (const [words, name] of [["burn in subtitles", "film-burn"], ["slow zoom in", "punch-in"], ["inverted pyramid", "invert"], ["negative space", "invert"]])
    assert.ok(!seenNames(words).some((line) => line.startsWith(name)), `${words}: ${seenNames(words)}`);
});
