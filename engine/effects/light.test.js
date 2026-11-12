// The Light effects (glow.js, lightRays.js, lensFlare.js): their maths, and the pixels Chromium
// draws from their SVG, which is what every preview and export of an effect shows
// (backend/raster-policy.mjs).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import { effectDefaults } from "./catalog.js";
import { glowRadii, glowWeights, renderGlow, thresholdTable } from "./glow.js";
import { MAX_RAY_COPIES_PER_STAGE, MAX_RAY_STAGES, rayFade, rayStages, renderLightRays, sceneBoxInLayer } from "./lightRays.js";
import { flareVisibility, renderLensFlare } from "./lensFlare.js";
import { calmLightAnimations } from "./light.js";
import { lobeTable, renderRimLight, rimWidth } from "./rimLight.js";
import { createLayer, createScene } from "../model.js";
import { renderSceneSvg } from "../render.js";
import { CPU_RASTER } from "../../tests/golden/raster.mjs";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-light-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/**
 * Draws `render` with `parameters` over `content` (a width × height layer at `layer` in a scene
 * of the same size, unless `scene` says otherwise) and returns a pixel reader.
 */
async function draw(render, parameters, { width, height, content, under = "", layer = { x: 0, y: 0 }, scene = { width, height }, layerType, cutout }) {
  const defs = [];
  let sequence = 0;
  const output = render({ content, bounds: { x: 0, y: 0, width, height }, parameters: { ...parameters }, time: 0, progress: 1,
    helpers: { id: (kind) => `${kind}-${++sequence}`, defs, includeBounds: () => {}, layerType, cutout,
      scene: { ...scene, matrix: [1, 0, 0, 1, layer.x, layer.y] } } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}"><defs>${defs.join("")}</defs>${under}<g transform="translate(${layer.x} ${layer.y})">${output}</g></svg>`;
  const image = await loadImage((await chromium.render(svg, scene.width, scene.height)).buffer);
  const canvas = createCanvas(scene.width, scene.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, scene.width, scene.height).data;
  return { output, pixel: (x, y) => [...data.subarray((y * scene.width + x) * 4, (y * scene.width + x) * 4 + 4)] };
}

// erf, Abramowitz and Stegun 7.1.26 (error under 1.5e-7).
function erf(x) {
  const sign = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
/** A Gaussian blur (standard deviation sigma) of the span [from, to), sampled at the pixel centre x + 0.5. */
const blurredSpan = (x, from, to, sigma) => (erf((x + 0.5 - from) / (sigma * Math.SQRT2)) - erf((x + 0.5 - to) / (sigma * Math.SQRT2))) / 2;

const BLACK = (width, height) => `<rect width="${width}" height="${height}" fill="#000"/>`;
const SQUARE = (fill) => `<rect x="50" y="50" width="20" height="20" fill="${fill}"/>`;

test("glow: the threshold ramp, the pass radii and their shares of the light", () => {
  const table = thresholdTable(0.7, 0.2);
  assert.equal(table.length, 65);
  assert.equal(table[Math.floor(0.7 * 64)], 0, "nothing at the threshold");
  assert.equal(table[Math.ceil(0.9 * 64)], 1, "all of it at threshold + softness");
  assert.ok(table.every((value, index) => index === 0 || value >= table[index - 1]), "the ramp only rises");
  assert.ok(thresholdTable(0, 0).every((value) => value === 1), "threshold 0, softness 0 lets everything through");
  assert.deepEqual(glowRadii(10, 4), [10, 20, 40, 80]);
  assert.ok(Math.abs(glowWeights(5).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
});

test("glow: a white square on black glows as a Gaussian blur of radius/2 times strength, a grey one under the threshold does not", async () => {
  const size = 120;
  // The GPU's blur is within 1 level of the maths; the CPU's (Linux CI) reads up to 11 brighter
  // near the square (178 for 167.3 at strength 2.5, 3 px out). See tests/golden/raster.mjs.
  const tolerance = CPU_RASTER ? 12 : 5;
  for (const strength of [1, 2.5]) {
    const glow = await draw(renderGlow, { ...effectDefaults("glow"), strength, radius: 8 }, { width: size, height: size, content: BLACK(size, size) + SQUARE("#FFF") });
    for (const distance of [1, 3, 6, 10]) {
      const x = 70 + distance - 1;
      const expected = Math.min(255, 255 * strength * blurredSpan(x, 50, 70, 4) * blurredSpan(60, 50, 70, 4));
      const [r, g, b] = glow.pixel(x, 60);
      assert.ok(Math.abs(r - expected) <= tolerance && r === g && g === b, `strength ${strength}, ${distance} px out: ${r}, expected ${expected.toFixed(1)}`);
    }
  }
  const grey = await draw(renderGlow, effectDefaults("glow"), { width: size, height: size, content: BLACK(size, size) + SQUARE("#808080") });
  for (const [x, y] of [[60, 60], [72, 60], [80, 60]]) assert.deepEqual(grey.pixel(x, y).slice(0, 3), x < 70 ? [128, 128, 128] : [0, 0, 0], "under the threshold nothing glows");
});

test("glow: color tints the glow, deep passes reach further, and on a transparent layer the glow has its own alpha", async () => {
  const size = 120;
  const tinted = await draw(renderGlow, { ...effectDefaults("glow"), radius: 8, color: "#FF0000", colorMix: 1 }, { width: size, height: size, content: BLACK(size, size) + SQUARE("#FFF") });
  const [r, g, b] = tinted.pixel(73, 60);
  assert.ok(r > 40 && g === 0 && b === 0, `the glow is all red: ${[r, g, b]}`);
  const one = await draw(renderGlow, { ...effectDefaults("glow"), radius: 4, passes: 1 }, { width: size, height: size, content: BLACK(size, size) + SQUARE("#FFF") });
  const deep = await draw(renderGlow, { ...effectDefaults("glow"), radius: 4, passes: 4 }, { width: size, height: size, content: BLACK(size, size) + SQUARE("#FFF") });
  assert.ok(deep.pixel(80, 60)[0] > one.pixel(80, 60)[0] + 6, `four passes reach 10 px out, one does not: ${deep.pixel(80, 60)} against ${one.pixel(80, 60)}`);
  const alone = await draw(renderGlow, { ...effectDefaults("glow"), radius: 8 }, { width: size, height: size, content: SQUARE("#FFF") });
  const [, , , alpha] = alone.pixel(73, 60);
  assert.ok(alpha > 40 && alpha < 255, `the glow is see-through over nothing: alpha ${alpha}`);
});

test("glow mode behind: an orange square keeps its orange and gets an orange halo", async () => {
  const size = 120;
  const behind = await draw(renderGlow, { ...effectDefaults("glow"), radius: 8, mode: "behind" }, { width: size, height: size, under: BLACK(size, size), content: SQUARE("#FF8000") });
  assert.deepEqual(behind.pixel(60, 60).slice(0, 3), [255, 128, 0], "the fill keeps its color");
  const [r, g, b] = behind.pixel(73, 60);
  assert.ok(r > 40 && g > 10 && g < r * 0.7 && b === 0, `the halo is orange: ${[r, g, b]}`);
  const added = await draw(renderGlow, { ...effectDefaults("glow"), radius: 8, threshold: 0 }, { width: size, height: size, content: BLACK(size, size) + SQUARE("#FF8000") });
  assert.ok(added.pixel(60, 60)[1] > 150, `add mode lifts the fill toward yellow: ${added.pixel(60, 60)}`);
});

test("rim light: a band on the lit side, a ring alone outside, and no rim along the frame border", async () => {
  const size = 120;
  const rim = (parameters, content = SQUARE("#404040")) => draw(renderRimLight,
    { ...effectDefaults("rim-light"), spread: 0, haze: 0, ...parameters }, { width: size, height: size, content });
  const right = await rim({ angle: 90, color: "#00FF00" });
  assert.ok(right.pixel(68, 60)[1] > 150, `inside the right edge it is lit: ${right.pixel(68, 60)}`);
  assert.deepEqual(right.pixel(52, 60).slice(0, 3), [64, 64, 64], "the left edge stays as it was");
  const ring = await rim({ edge: "outside", color: "#00FF00", lightOnly: true });
  assert.equal(ring.pixel(60, 60)[3], 0, "the ring leaves the inside empty");
  assert.ok(ring.pixel(73, 60)[1] > 100 && ring.pixel(46, 60)[1] > 100, `the ring sits outside on both sides: ${ring.pixel(73, 60)} ${ring.pixel(46, 60)}`);
  // A shape that runs off the bottom of the frame: its bottom edge is the frame border, not an edge.
  const offFrame = `<rect x="50" y="50" width="20" height="70" fill="#404040"/>`;
  const open = await rim({ color: "#00FF00", width: 4 }, offFrame);
  assert.ok(open.pixel(51, 90)[1] > 100, `the side edge is lit: ${open.pixel(51, 90)}`);
  assert.deepEqual(open.pixel(60, 118).slice(0, 3), [64, 64, 64], "no rim along the frame border");
  const auto = await rim({ width: 4, angle: "auto", color: "auto" }, `<rect x="50" y="50" width="20" height="20" fill="#C0F040"/>`);
  const [r, g, b] = auto.pixel(51, 60);
  assert.ok(g >= 240 && b < g * 0.6 && r > b, `auto color takes the layer's own hue, brighter: ${[r, g, b]}`);
});

test("rim light on a video matte: stair steps are smoothed, the frame border stays dark", async () => {
  const size = 120;
  // A staircase that runs off the left and bottom of the frame, 20 px steps.
  const stairs = `<path d="M0 120 V30 H30 V50 H50 V70 H70 V90 H90 V120 Z" fill="#404040"/>`;
  const ring = (layerType) => draw(renderRimLight, { ...effectDefaults("rim-light"), edge: "outside", color: "#00FF00", width: 6, spread: 0, haze: 0, core: 0, lightOnly: true },
    { width: size, height: size, content: stairs, layerType });
  const drawn = await ring("text"), matte = await ring("video");
  assert.ok(drawn.pixel(32, 48)[3] > 100, `a drawn layer's ring follows the step into its corner: ${drawn.pixel(32, 48)}`);
  assert.ok(matte.pixel(32, 48)[3] < 60, `a matte's corner is rounded off: ${matte.pixel(32, 48)}`);
  assert.ok(matte.pixel(40, 46)[1] > 100, `the ring still runs along the step: ${matte.pixel(40, 46)}`);
  for (const [x, y] of [[100, 2], [118, 60], [60, 118], [2, 60]]) assert.equal(matte.pixel(x, y)[3], 0, `no ring along the frame border at ${x},${y}`);
});

test("rim light: haze reaches far by default, auto color lifts a dark subject, lobes leave dark gaps", async () => {
  const size = 200;
  const dark = `<rect x="80" y="80" width="40" height="40" fill="#120A22"/>`;
  const ring = (parameters) => draw(renderRimLight, { ...effectDefaults("rim-light"), edge: "outside", spread: 0, lightOnly: true, ...parameters }, { width: size, height: size, content: dark });
  const hazy = await ring({}), bare = await ring({ haze: 0 });
  assert.ok(hazy.pixel(165, 100)[3] > 3, `haze 45 px out: ${hazy.pixel(165, 100)}`);
  assert.equal(bare.pixel(165, 100)[3], 0, "haze 0 keeps only the line");
  const [r, g, b] = hazy.pixel(124, 100);
  assert.ok(Math.max(r, g, b) > 150 && b > g, `a dark violet subject gets a bright violet rim: ${[r, g, b]}`);
  const table = lobeTable();
  assert.equal(table[0], 0, "low noise is a dark gap");
  assert.equal(table.at(-1), 1);
  const width = (parameters) => rimWidth({ parameters: { ...effectDefaults("rim-light"), ...parameters } }, parameters.style ?? "even");
  assert.deepEqual([width({}), width({ style: "lobes" }), width({ style: "lobes", width: 8 })], [8, 4, 8], "auto width: 4 for lobes, a saved 8 stays 8");
});

test("glow and shadows on a cut-out stay off the faded strip along its source picture's border", async () => {
  // A bust cut by the bottom of its 200 px box, in a taller scene: below the box is open picture.
  const bust = `<rect x="60" y="100" width="80" height="100" fill="#FFFFFF"/>`;
  const glow = (cutout) => draw(renderGlow, { ...effectDefaults("glow"), radius: 16, threshold: 0 },
    { width: 200, height: 200, content: bust, under: BLACK(200, 260), scene: { width: 200, height: 260 }, cutout });
  const plain = await glow(false), cut = await glow(true);
  assert.ok(plain.pixel(100, 206)[0] > 20, `a plain layer glows past its box: ${plain.pixel(100, 206)}`);
  assert.ok(cut.pixel(100, 206)[0] < 4, `a cut-out does not trace its box border: ${cut.pixel(100, 206)}`);
  assert.ok(cut.pixel(52, 140)[0] > 20, `its real edge still glows: ${cut.pixel(52, 140)}`);
  const shadowed = (extra) => renderSceneSvg(createScene({ id: "s", width: 200, height: 200, duration: 1, layers: [
    createLayer("rectangle", { id: "bust", x: 0, y: 0, width: 200, height: 200, shadows: [{ color: "#00FF00", x: 0, y: 0, blur: 10, opacity: 1 }], ...extra })] }), 0);
  assert.match(shadowed({ cutoutOf: "source" }), /shadow-border/);
  assert.doesNotMatch(shadowed({}), /shadow-border/);
});

test("light rays: the copy plan, the fade along a streak and the scene box", () => {
  for (const [farthest, length] of [[50, 0.2], [400, 0.5], [2200, 0.9]]) {
    const stages = rayStages(farthest, length);
    assert.ok(stages.length >= 1 && stages.length <= MAX_RAY_STAGES && stages.every((count) => count >= 2 && count <= MAX_RAY_COPIES_PER_STAGE));
    const total = stages.reduce((product, count) => product * count, 1);
    // Neighbouring copies are at most 1.5 px apart at the far end, unless the plan is full.
    const gap = farthest / (1 - length) * (1 - (1 - length) ** (1 / (total - 1)));
    assert.ok(gap <= 1.5 + 1e-9 || total === MAX_RAY_COPIES_PER_STAGE ** MAX_RAY_STAGES, `${farthest}, ${length}: ${stages} leaves ${gap} px`);
  }
  assert.deepEqual(rayStages(100, 0), []);
  assert.equal(rayFade(0), 1);
  assert.equal(rayFade(1), 6);
  assert.deepEqual(sceneBoxInLayer({ helpers: { scene: { width: 100, height: 50, matrix: [2, 0, 0, 2, 10, 20] } } }), { x: -5, y: -10, width: 50, height: 25 });
  assert.equal(sceneBoxInLayer({ helpers: {} }), null);
});

test("light rays: a bright spot streaks away from the centre, not towards it, and no further than length allows", async () => {
  const width = 200, height = 120;
  // The centre is at (100, 60); the spot sits 40 px to its right.
  const content = BLACK(width, height) + `<rect x="138" y="58" width="4" height="4" fill="#FFF"/>`;
  const rays = await draw(renderLightRays, { ...effectDefaults("light-rays"), length: 0.5, decay: 0, strength: 2 }, { width, height, content });
  assert.ok(rays.pixel(155, 60)[0] > 30, `lit outward: ${rays.pixel(155, 60)}`);
  assert.ok(rays.pixel(125, 60)[0] < 3, `dark towards the centre: ${rays.pixel(125, 60)}`);
  // length 0.5 doubles distances: the streak ends at 2 × 42 = 84 px from the centre.
  assert.ok(rays.pixel(192, 60)[0] < 3, `nothing past the end: ${rays.pixel(192, 60)}`);
  assert.ok(rays.pixel(155, 75)[0] < 3, "the streak is thin, pointing away from the centre");
});

test("light rays: a light behind a shape shines round it and never onto it, and a layer far outside the scene draws no rays", async () => {
  const width = 200, height = 120;
  const disc = `<circle cx="100" cy="60" r="20" fill="#202020"/>`;
  const behind = await draw(renderLightRays, { ...effectDefaults("light-rays"), source: "behind", lightSize: 0.3, length: 0.5 }, { width, height, content: disc, under: BLACK(width, height) });
  assert.deepEqual(behind.pixel(100, 60).slice(0, 3), [32, 32, 32], "the shape in front stays as it is");
  assert.ok(behind.pixel(100, 60 - 26)[0] > 40, `light round the shape: ${behind.pixel(100, 34)}`);
  // A layer so far outside the scene that even its rays cannot reach it draws no rays at all.
  const outside = await draw(renderLightRays, effectDefaults("light-rays"), { width: 50, height: 50, content: BLACK(50, 50), layer: { x: 400, y: 0 }, scene: { width: 100, height: 50 } });
  assert.equal(outside.output, BLACK(50, 50));
});

test("lens flare: it fades out as the light leaves the scene, and its core sits on the light", async () => {
  const scene = { width: 300, height: 200 };
  const diagonal = Math.hypot(300, 200);
  assert.equal(flareVisibility({ x: 150, y: 100 }, scene), 1);
  assert.equal(flareVisibility({ x: 300 + 0.12 * diagonal, y: 100 }, scene), 0);
  const halfway = flareVisibility({ x: 300 + 0.06 * diagonal, y: 100 }, scene);
  assert.ok(Math.abs(halfway - 0.5) < 1e-9);

  const content = BLACK(300, 200);
  const flare = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), x: 0.25, y: 0.3 }, { width: 300, height: 200, content });
  const core = flare.pixel(75, 60), off = flare.pixel(75, 160);
  assert.ok(core[0] > 230 && core[1] > 200, `the core is bright: ${core}`);
  assert.ok(off[0] < 40, `far from the light it is dim: ${off}`);
  const gone = renderLensFlare({ content, bounds: { x: 0, y: 0, width: 300, height: 200 }, parameters: { ...effectDefaults("lens-flare"), x: 1.3 },
    helpers: { id: () => "x", defs: [], scene: { ...scene, matrix: [1, 0, 0, 1, 0, 0] } } });
  assert.equal(gone, content, "a light well past the edge draws nothing");
  assert.equal(renderLensFlare({ content, bounds: { x: 0, y: 0, width: 300, height: 200 }, parameters: { ...effectDefaults("lens-flare"), strength: 0 }, helpers: {} }), content);
});

test("lens flare: on a small layer it follows the layer; anamorphic is a streak along angle; ghosts tint a light picture", async () => {
  const scene = { width: 300, height: 200 };
  const sun = `<circle cx="10" cy="10" r="10" fill="#FFF4DA"/>`;
  const sky = BLACK(300, 200);
  const at = (layer) => draw(renderLensFlare, { ...effectDefaults("lens-flare"), x: 0.5, y: 0.5 }, { width: 20, height: 20, content: sun, under: sky, layer, scene });
  const left = await at({ x: 40, y: 40 }), right = await at({ x: 220, y: 120 });
  // 25 px beside the sun's centre: lit where the sun is, dark where it is not.
  assert.ok(left.pixel(75, 50)[0] > right.pixel(75, 50)[0] + 40);
  assert.ok(right.pixel(255, 130)[0] > left.pixel(255, 130)[0] + 40);

  const streak = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "anamorphic", x: 0.5, y: 0.5 }, { width: 300, height: 200, content: sky });
  assert.ok(streak.pixel(80, 100)[0] > streak.pixel(150, 30)[0] + 30, "horizontal by default");
  const turned = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "anamorphic", x: 0.5, y: 0.5, angle: 90 }, { width: 300, height: 200, content: sky });
  assert.ok(turned.pixel(150, 30)[0] > turned.pixel(80, 100)[0] + 30, "vertical at angle 90");

  const pale = `<rect width="300" height="200" fill="#DCE6F0"/>`;
  const plain = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), strength: 0 }, { width: 300, height: 200, content: pale });
  const rings = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "rings", x: 0.2, y: 0.2 }, { width: 300, height: 200, content: pale });
  // Somewhere along the line from the light through the middle, a ghost visibly changes the colour.
  let largest = 0;
  for (let t = 0.3; t <= 2; t += 0.02) {
    const x = Math.round(60 + t * 90), y = Math.round(40 + t * 60);
    if (x >= 300 || y >= 200) break;
    largest = Math.max(largest, ...rings.pixel(x, y).slice(0, 3).map((value, channel) => Math.abs(value - plain.pixel(x, y)[channel])));
  }
  assert.ok(largest > 12, `ghosts show on a light picture: ${largest}`);
  const quiet = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "rings", x: 0.2, y: 0.2, ghosts: 0 }, { width: 300, height: 200, content: pale });
  let residue = 0;
  for (let t = 0.6; t <= 2; t += 0.02) {
    const x = Math.round(60 + t * 90), y = Math.round(40 + t * 60);
    if (x >= 300 || y >= 200) break;
    residue = Math.max(residue, ...quiet.pixel(x, y).slice(0, 3).map((value, channel) => Math.abs(value - plain.pixel(x, y)[channel])));
  }
  assert.ok(residue < largest / 3, `ghosts 0 turns the reflections off: ${residue} vs ${largest}`);
});

test("lens flare streak: one soft line across the whole picture, no ghosts, its halo about 5% of the height", async () => {
  const sky = BLACK(300, 200);
  const line = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "streak", x: 0.3, y: 0.5 }, { width: 300, height: 200, content: sky });
  assert.ok(line.pixel(5, 100)[0] > 20 && line.pixel(295, 100)[0] > 20, "it reaches both edges");
  const column = Array.from({ length: 200 }, (_, y) => line.pixel(150, y)[0]);
  const lit = column.filter((value) => value > column[100] / 4).length;
  assert.ok(lit >= 4 && lit <= 20, `halo ${lit} px of 200 tall`);
  const hard = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "streak", x: 0.3, y: 0.5, softness: 0 }, { width: 300, height: 200, content: sky });
  const steepest = (pixel) => Math.max(...Array.from({ length: 20 }, (_, step) => Math.abs(pixel(150, 103 + step)[0] - pixel(150, 104 + step)[0])));
  assert.ok(steepest(line.pixel) < steepest(hard.pixel), "softness fades the halo's edge");
  assert.ok(line.pixel(60, 100)[0] > line.pixel(240, 100)[0], "brightest near the light");
  // The core takes the flare color; only a strength above 1 heats its middle toward white.
  const green = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "streak", x: 0.5, y: 0.5, color: "#20FF40" }, { width: 300, height: 200, content: sky });
  const hot = await draw(renderLensFlare, { ...effectDefaults("lens-flare"), style: "streak", x: 0.5, y: 0.5, color: "#20FF40", strength: 2 }, { width: 300, height: 200, content: sky });
  assert.ok(green.pixel(150, 100)[0] < 90 && green.pixel(150, 100)[1] > 150, `green core: ${green.pixel(150, 100)}`);
  assert.ok(hot.pixel(150, 100)[0] > green.pixel(150, 100)[0] + 60, `whiter core at strength 2: ${hot.pixel(150, 100)}`);
});

test("reduced motion: the calm preview leaves out short Light bursts and holds short one-sided changes still; exports draw them", () => {
  const glow = (id, extra) => ({ id, kind: "effect", effect: "glow", start: 1, duration: 0.4, easing: "ease-out", to: { strength: 0, radius: 16 }, from: { strength: 4 }, ...extra });
  const animations = [glow("burst", { keepStill: "off" }), glow("before", { keepStill: "start" }), glow("after", { keepStill: "end" }),
    glow("both", { keepStill: "both" }), glow("long", { keepStill: "off", duration: 1 }), { ...glow("blur", { keepStill: "off" }), effect: "blur" }];
  const calm = calmLightAnimations(animations);
  assert.deepEqual(calm.map((animation) => animation.id), ["before", "after", "both", "long", "blur"]);
  assert.deepEqual([calm[0].from, calm[0].to], [undefined, { strength: 4, radius: 16 }], "held at its start values until it ends");
  assert.deepEqual([calm[1].from, calm[1].to], [undefined, { strength: 0, radius: 16 }], "its end values from its start");
  assert.equal(calm[2], animations[3]);
  const quiet = [glow("both", { keepStill: "both" })];
  assert.equal(calmLightAnimations(quiet), quiet, "nothing to calm: the same array");
  // A burst inside a group (group_animations) is calmed too; the group and its other members stay.
  const move = { id: "move", kind: "custom", start: 0, duration: 1, easing: "ease-out", to: { y: 20 }, from: { y: 60 } };
  const grouped = [{ id: "group", kind: "composed", start: 1, animations: [move, { ...glow("burst", { keepStill: "off" }), start: 0 }] }];
  const calmGroup = calmLightAnimations(grouped);
  assert.notEqual(calmGroup, grouped);
  assert.deepEqual(calmGroup[0].animations.map((animation) => animation.id), ["move"]);
  const groupedQuiet = [{ id: "group", kind: "composed", start: 1, animations: [move] }];
  assert.equal(calmLightAnimations(groupedQuiet), groupedQuiet, "a group with nothing to calm: the same array");

  // Through the renderer: in the middle of the burst the calm picture is the picture without it.
  const scene = (layerAnimations) => createScene({ id: "calm", width: 200, height: 100, duration: 3, layers: [
    createLayer("text", { id: "title", text: "LIGHT", x: 20, y: 20, width: 160, height: 60, animations: layerAnimations })] });
  const flashing = scene([glow("burst", { keepStill: "off" })]);
  assert.notEqual(renderSceneSvg(flashing, 1.2), renderSceneSvg(scene([]), 1.2), "exports draw the flash");
  assert.equal(renderSceneSvg(flashing, 1.2, { calmLight: true }), renderSceneSvg(scene([]), 1.2, { calmLight: true }));
  const flashingInGroup = scene([{ id: "group", kind: "composed", start: 1, animations: [{ ...glow("burst", { keepStill: "off" }), start: 0 }] }]);
  assert.notEqual(renderSceneSvg(flashingInGroup, 1.2), renderSceneSvg(scene([]), 1.2), "exports draw the grouped flash");
  assert.equal(renderSceneSvg(flashingInGroup, 1.2, { calmLight: true }), renderSceneSvg(scene([]), 1.2, { calmLight: true }), "the calm preview leaves out the grouped flash");
});
