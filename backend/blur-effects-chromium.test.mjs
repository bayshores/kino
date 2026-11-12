// The blur and edge effects drawn by the export's Chromium worker, checked pixel by pixel.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { createChromiumRasterizer } from "./chromium-raster.mjs";
import { CPU_RASTER } from "../tests/golden/raster.mjs";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-blur-chromium-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// A test card: eight full-height bars, a white dot and `parts` small turned rectangles, all in one
// group that carries the effects. With many parts that reach past the frame, Chromium dropped most
// plain <use> copies of the group (see copySource and its home rectangle in engine/effects/svg.js).
// `spread` places the parts from half a frame before the frame to well past it instead.
function card({ width = 640, height = 360, parts = 0, effects = [], spread = false }) {
  const group = createLayer("group", { id: "card", name: "Card", x: 0, y: 0, width, height });
  const layers = [group];
  ["#BFBFBF", "#BFBF00", "#00BFBF", "#00BF00", "#BF00BF", "#BF0000", "#0000BF", "#202020"].forEach((fill, index) =>
    layers.push(createLayer("rectangle", { id: `bar-${index}`, name: `Bar ${index}`, parentId: "card", x: index * width / 8, y: 0,
      width: width / 8, height, fill, radius: 0, strokeWidth: 0 })));
  layers.push(createLayer("ellipse", { id: "dot", name: "Dot", parentId: "card", x: width * 0.1, y: height * 0.1,
    width: height * 0.3, height: height * 0.3, fill: "#FFFFFF", strokeWidth: 0 }));
  for (let index = 0; index < parts; index += 1) {
    layers.push(createLayer("rectangle", { id: `part-${index}`, name: `Part ${index}`, parentId: "card",
      ...(spread ? { x: (index % 10) * width * 0.2 - width * 0.5, y: Math.floor(index / 10) * height * 0.3 - height * 0.5, width: width / 6, height: height / 5 }
        : { x: (index % 10) * width / 10 + 10, y: Math.floor(index / 10) * height / 8 + 10, width: width / 14, height: height / 12 }),
      fill: index % 2 ? "#FFFFFF" : "#00FF88", radius: 0, strokeWidth: 0, rotation: index * 7 }));
  }
  group.animations = effects.map(([effect, to], index) => ({ id: `effect-${index}`, name: effect, kind: "effect", effect,
    start: 0, duration: 2, easing: "linear", from: to, to, ...(["edge-fill", "mirror", "kaleidoscope"].includes(effect) ? { keepStill: "both" } : {}) }));
  return parseDocument(createDocument({ id: "card", name: "Card",
    scenes: [createScene({ id: "main", name: "Main", width, height, duration: 2, background: "#000000", layers })] })).scenes[0];
}

async function decode(png, width, height) {
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(await loadImage(png), 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let sum = 0;
  for (let index = 0; index < data.length; index += 4) sum += data[index] + data[index + 1] + data[index + 2];
  return { data, mean: sum / (data.length / 4) / 3, red: (x, y) => data[(y * width + x) * 4] };
}

async function drawChromium(scene) {
  return decode((await chromium.render(renderSceneSvg(scene, 0.5, {}), scene.width, scene.height)).buffer, scene.width, scene.height);
}

// The frame as an export draws it at `scale` times the scene's size (backend/export.mjs frameSvg),
// or as a check or look frame does with `draft`.
async function drawScaled(scene, scale, draft = false) {
  const width = scene.width * scale, height = scene.height * scale;
  const svg = renderSceneSvg(scene, 0.5, { rasterScale: { x: scale, y: scale }, draft })
    .replace(/^(<svg[^>]*?) width="[^"]+" height="[^"]+"/, `$1 width="${width}" height="${height}" preserveAspectRatio="none"`);
  return decode((await chromium.render(svg, width, height, { draft })).buffer, width, height);
}

async function drawResvg(scene, scale = 1) {
  const width = scene.width * scale, height = scene.height * scale;
  const svg = renderSceneSvg(scene, 0.5, { raster: true, rasterScale: { x: scale, y: scale } })
    .replace(/^(<svg[^>]*?) width="[^"]+" height="[^"]+"/, `$1 width="${width}" height="${height}" preserveAspectRatio="none"`);
  return decode(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng(), width, height);
}

function meanDifference(first, second) {
  let sum = 0;
  for (let index = 0; index < first.data.length; index += 4)
    for (let channel = 0; channel < 3; channel += 1) sum += Math.abs(first.data[index + channel] - second.data[index + channel]);
  return sum / (first.data.length / 4) / 3;
}

// A tilted layer is drawn once into a bitmap that its triangles share (desktop/raster-page.cjs,
// flattenTilts); before, every triangle copied the whole drawing (a tilted page of code: 42 s a
// frame). The picture must stay what resvg draws from the vector triangles.
test("a tilted group with many parts draws as the vector reference does", async () => {
  const scene = card({ parts: 60 });
  const group = scene.layers.find((layer) => layer.id === "card");
  Object.assign(group, { rotateX: 24, rotateY: -16, perspective: 1600 });
  assert.match(renderSceneSvg(scene, 0.5, {}), /data-kino-flatten="/);
  const [browser, reference] = [await drawChromium(scene), await drawResvg(scene)];
  assert.ok(meanDifference(browser, reference) < 1.5, `mean difference ${meanDifference(browser, reference).toFixed(2)}`);
  // A check frame (draft: a coarser grid, a smaller shared bitmap) shows nearly the same picture.
  // Its grid may be off by 0.3 output pixels, as an export's is by 0.3 scene pixels: on this busy
  // 120 x 68 card that moved edges by 2.6 levels on average.
  const [draft, exported] = [await drawScaled(scene, 0.25, true), await drawScaled(scene, 0.25)];
  assert.ok(meanDifference(draft, exported) < 4, `draft mean difference ${meanDifference(draft, exported).toFixed(2)}`);
  // A small export keeps the bitmap's oversampling: the export's size is counted once. Thin
  // stripes at a quarter size were 22.8 levels off resvg when it was counted twice (a bitmap at
  // the output's own pixels), 15.4 now.
  const stripes = card({ parts: 0 });
  stripes.layers = [stripes.layers[0], ...Array.from({ length: 40 }, (_, index) => createLayer("rectangle", { id: `stripe-${index}`, name: `Stripe ${index}`,
    parentId: "card", x: index * 16, y: 0, width: 8, height: 360, fill: "#FFFFFF", radius: 0, strokeWidth: 0 }))];
  Object.assign(stripes.layers[0], { rotateX: 24, rotateY: -16, perspective: 1600 });
  const small = meanDifference(await drawScaled(stripes, 0.25), await drawResvg(stripes, 0.25));
  assert.ok(small < 19, `quarter-size stripes mean difference ${small.toFixed(2)}`);
});

test("a spin blur of a group with many parts keeps its brightness in Chromium", async () => {
  // Edge fill first, so every turned copy still covers the frame and the average keeps the
  // picture's brightness. With <use> copies this came out at 52 of 134.
  const filled = await drawChromium(card({ parts: 60, effects: [["edge-fill", { mode: "mirror", extend: 0.5 }]] }));
  const spun = await drawChromium(card({ parts: 60, effects: [["edge-fill", { mode: "mirror", extend: 0.5 }], ["spin-blur", { angle: 30 }]] }));
  assert.ok(Math.abs(spun.mean - filled.mean) < 3, `spin ${spun.mean.toFixed(1)}, picture ${filled.mean.toFixed(1)}`);
  assert.ok(meanDifference(spun, filled) > 10, "the spin blur changes the picture");
});

test("a zoom blur in Chromium matches the reference average of its copies", async () => {
  // Every zoomed copy covers the frame, so resvg's simpler average is exact here.
  const scene = card({ parts: 60, effects: [["zoom-blur", { amount: 0.4 }]] });
  const [browser, reference] = [await drawChromium(scene), await drawResvg(scene)];
  assert.ok(meanDifference(browser, reference) < 1.5, `mean difference ${meanDifference(browser, reference).toFixed(2)}`);
});

// A spin of a twentieth of a degree moves the farthest corner of a 1080p frame exported at 4K by
// about 2 pixels: the picture must stay as sharp as the layer. The frame is larger than Chromium's
// largest pattern tile (2048 × 2048 pixels): copies that repeated one pattern tile of the layer
// were drawn from a smaller, blurred tile (0.60 levels off on the GPU, 0.82 on the CPU; now 0.05
// and 0.29 with <use> copies and a home rectangle, see copySource in engine/effects/svg.js).
test("a very small spin blur of a frame larger than a pattern tile keeps it sharp", async () => {
  const plain = await drawScaled(card({ width: 1920, height: 1080, parts: 60, spread: true }), 2);
  const spun = await drawScaled(card({ width: 1920, height: 1080, parts: 60, spread: true, effects: [["spin-blur", { angle: 0.05 }]] }), 2);
  assert.ok(meanDifference(spun, plain) < (CPU_RASTER ? 0.45 : 0.2), `mean difference ${meanDifference(spun, plain).toFixed(3)}`);
});

// Over a filter the spin copies were plain <use> copies (16 of them), and Chromium left many of
// them out above 1080p: drawn at 4K the picture came out at a level of 62.5 instead of 152. A 20 px
// directional blur hardly changes the level, so the spin over it must look like the spin alone.
// Chromium drawing on the CPU (Linux CI) runs the filter again for every tile of every copy and
// takes about 50 s for this frame, so the test runs only where Chromium draws with the GPU.
test("a spin blur over a directional blur of a group with many parts keeps its copies",
  { skip: CPU_RASTER && "about 50 s with Chromium drawing on the CPU" }, async () => {
  const scene = (effects) => card({ width: 1920, height: 1080, parts: 60, spread: true, effects });
  const spun = await drawScaled(scene([["spin-blur", { angle: 30 }]]), 2);
  const both = await drawScaled(scene([["directional-blur", { length: 20 }], ["spin-blur", { angle: 30 }]]), 2);
  assert.ok(Math.abs(both.mean - spun.mean) < 2, `over the blur ${both.mean.toFixed(1)}, alone ${spun.mean.toFixed(1)}`);
});

test("a directional blur smears a small shape evenly on both sides, with no steps", async () => {
  const width = 320, height = 120;
  const square = createLayer("rectangle", { id: "square", name: "Square", x: 150, y: 30, width: 20, height: 60, fill: "#FFFFFF", radius: 0, strokeWidth: 0 });
  square.animations = [{ id: "smear", name: "smear", kind: "effect", effect: "directional-blur", start: 0, duration: 2, easing: "linear",
    from: { length: 100, angle: 0 }, to: { length: 100, angle: 0 } }];
  const scene = parseDocument(createDocument({ id: "smear", name: "Smear",
    scenes: [createScene({ id: "main", name: "Main", width, height, duration: 2, background: "#000000", layers: [square] })] })).scenes[0];
  const { red } = await drawChromium(scene);
  const row = Array.from({ length: 160 }, (_, index) => red(80 + index, 60));
  // A 20 px square smeared 100 px: from x=100 a ramp 20 px long, a plateau of 20 % white to x=200, a ramp down to x=220.
  assert.ok(Math.abs(red(160, 60) - 51) <= 3, `middle ${red(160, 60)}`);
  assert.ok(red(98, 60) <= 2 && red(222, 60) <= 2, `ends ${red(98, 60)} ${red(222, 60)}`);
  assert.ok(Math.abs(red(115, 60) - red(205, 60)) <= 6, `ramps ${red(115, 60)} ${red(205, 60)}`);
  for (let index = 1; index < row.length; index += 1)
    assert.ok(Math.abs(row[index] - row[index - 1]) <= 4, `no step at x=${80 + index}: ${row.join(" ")}`);
});

// The look (Chromium) and the reference renderer draw a twirl and an edges-only RGB split alike;
// the twirl turns the middle and leaves the corners where they were.
test("twirl and an edges-only rgb-shift match the reference renderer", async () => {
  const plain = await drawResvg(card({ parts: 20 }));
  for (const effects of [[["twirl", { angle: 180 }]], [["rgb-shift", { where: "edges", colors: "green-magenta" }]]]) {
    const scene = card({ parts: 20, effects });
    const [browser, reference] = [await drawChromium(scene), await drawResvg(scene)];
    assert.ok(meanDifference(browser, reference) < 1.5, `${effects[0][0]}: mean difference ${meanDifference(browser, reference).toFixed(2)}`);
    assert.ok(meanDifference(reference, plain) > 1, `${effects[0][0]} changes the picture`);
    if (effects[0][0] === "twirl") assert.equal(reference.red(3, 3), plain.red(3, 3), "the corner stays");
  }
});

// Dark type on a light card: an edges-only split on the type layer alone fringes in color and
// keeps the letters solid in the look (Chromium) as in the reference renderer.
test("an edges-only rgb-shift on a dark shape over transparency keeps it solid and matches the reference renderer", async () => {
  const mark = createLayer("rectangle", { id: "mark", name: "Mark", x: 220, y: 120, width: 200, height: 120, fill: "#0A0A0A", radius: 0, strokeWidth: 0 });
  mark.animations = [{ id: "fx", name: "rgb-shift", kind: "effect", effect: "rgb-shift", start: 0, duration: 2, easing: "linear",
    from: { amount: 0.5, where: "edges" }, to: { amount: 0.5, where: "edges" } }];
  const scene = parseDocument(createDocument({ id: "mark", name: "Mark",
    scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration: 2, background: "#DCDCDC", layers: [mark] })] })).scenes[0];
  const [browser, reference] = [await drawChromium(scene), await drawResvg(scene)];
  assert.ok(meanDifference(browser, reference) < 1.5, `mean difference ${meanDifference(browser, reference).toFixed(2)}`);
  for (const image of [browser, reference]) assert.ok(image.red(320, 180) < 30, `the middle stays dark: ${image.red(320, 180)}`);
});

test("edge fill and kaleidoscope on a group with many parts match the reference renderer", async () => {
  for (const effects of [[["edge-fill", { mode: "tile", extend: 3 }]], [["kaleidoscope", { segments: 32, angle: 0, centerX: 0.5, centerY: 0.5 }]]]) {
    const scene = card({ parts: 60, effects });
    if (effects[0][0] === "edge-fill") scene.layers[0].scaleX = scene.layers[0].scaleY = 0.3;
    const [browser, reference] = [await drawChromium(scene), await drawResvg(scene)];
    // The CPU anti-aliases the 32 wedge edges more coarsely (1.30 on Linux CI; tests/golden/raster.mjs).
    const allowed = CPU_RASTER ? 1.5 : 1;
    assert.ok(meanDifference(browser, reference) < allowed, `${effects[0][0]}: mean difference ${meanDifference(browser, reference).toFixed(2)}`);
    assert.ok(Math.abs(browser.mean - reference.mean) < 1);
  }
});
