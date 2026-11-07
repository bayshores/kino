// Radial Repeat Blur drawn by the export's Chromium worker. With plain <use> copies, Chromium left
// out parts of many see-through copies of a layer with many parts reaching past the frame: each
// copy became about 37 GPU layers, the 512 MB of tile memory ran out and undrawn tiles showed the
// copy underneath. The copies' definition now starts with a home rectangle (copySource in
// engine/effects/svg.js), which keeps each copy one layer.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { captureLayerSvg, renderSceneSvg } from "../engine/render.js";
import { createChromiumRasterizer } from "./chromium-raster.mjs";
import { CPU_RASTER } from "../tests/golden/raster.mjs";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-utility-chromium-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// A test card: eight full-height bars, a white dot and 60 turned rectangles spread from half a
// frame before the frame to well past it, all in one group that carries the effect. `inner` puts
// the 60 rectangles in a group of their own with these settings; `part` adds settings to each.
function card({ width, height, effect, far = null, inner = null, part = {} }) {
  const group = createLayer("group", { id: "card", name: "Card", x: 0, y: 0, width, height });
  const layers = [group];
  ["#BFBFBF", "#BFBF00", "#00BFBF", "#00BF00", "#BF00BF", "#BF0000", "#0000BF", "#202020"].forEach((fill, index) =>
    layers.push(createLayer("rectangle", { id: `bar-${index}`, name: `Bar ${index}`, parentId: "card", x: index * width / 8, y: 0,
      width: width / 8, height, fill, radius: 0, strokeWidth: 0 })));
  layers.push(createLayer("ellipse", { id: "dot", name: "Dot", parentId: "card", x: width * 0.1, y: height * 0.1,
    width: height * 0.3, height: height * 0.3, fill: "#FFFFFF", strokeWidth: 0 }));
  if (inner) layers.push(createLayer("group", { id: "inner", name: "Inner", parentId: "card", x: 0, y: 0, width, height, ...inner }));
  for (let index = 0; index < 60; index += 1) {
    layers.push(createLayer("rectangle", { id: `part-${index}`, name: `Part ${index}`, parentId: inner ? "inner" : "card",
      x: (index % 10) * width * 0.2 - width * 0.5, y: Math.floor(index / 10) * height * 0.3 - height * 0.5,
      width: width / 6, height: height / 5, fill: index % 2 ? "#FFFFFF" : "#00FF88", radius: 0, strokeWidth: 0, rotation: index * 7, ...part }));
  }
  // A dot far off the frame makes the layer's drawing wider still.
  if (far !== null) layers.push(createLayer("ellipse", { id: "far", name: "Far", parentId: "card", x: far, y: height / 2, width: 60, height: 60,
    fill: "#FF3366", strokeWidth: 0 }));
  if (effect) {
    const [name, value] = effect;
    group.animations = [{ id: "effect", name, kind: "effect", effect: name, start: 0, duration: 2, easing: "linear", from: value, to: value }];
  }
  return parseDocument(createDocument({ id: "card", name: "Card",
    scenes: [createScene({ id: "main", name: "Main", width, height, duration: 2, background: "#000000", layers })] })).scenes[0];
}

// Blur amount 0: resvg leaves out the copies under the extra Gaussian blur, so it is no reference there.
const radial = (repeats) => ["radial-repeat-blur", { angle: 300, repeats, blurAmount: 0, edgeFalloff: 0.5, centerX: 1, centerY: 0 }];

async function decode(png, width, height) {
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(await loadImage(png), 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let sum = 0;
  for (let index = 0; index < data.length; index += 4) sum += data[index] + data[index + 1] + data[index + 2];
  return { data, mean: sum / (data.length / 4) / 3 };
}

// Mean and largest difference out of 255, over the colour channels.
function difference(first, second) {
  let sum = 0, max = 0;
  for (let index = 0; index < first.data.length; index += 4)
    for (let channel = 0; channel < 3; channel += 1) {
      const value = Math.abs(first.data[index + channel] - second.data[index + channel]);
      sum += value;
      if (value > max) max = value;
    }
  return { mean: sum / (first.data.length / 4) / 3, max };
}

const draw = async (rasterizer, svg, width, height) => decode((await rasterizer.render(svg, width, height)).buffer, width, height);
const drawScene = (scene) => draw(chromium, renderSceneSvg(scene, 0.5, {}), scene.width, scene.height);

// 64 and 40 copies at 1080p, and 64 at 4K, against resvg. With plain <use> copies the GPU was 12.8,
// 44.1 and 35.5 levels away (13.0, 51.5 and 29.9 on the CPU, as on Linux CI); now 0.11, 0.13 and
// 0.10 (0.77 on the CPU: 8-bit rounding of 64 stacked see-through copies).
test("Radial Repeat Blur keeps all its see-through copies of a group with many parts in Chromium", async () => {
  for (const [repeats, width, height] of [[64, 1920, 1080], [40, 1920, 1080], [64, 3840, 2160]]) {
    const scene = card({ width, height, effect: radial(repeats) });
    const browser = await drawScene(scene);
    const reference = await decode(new Resvg(renderSceneSvg(scene, 0.5, { raster: true }), { font: { loadSystemFonts: false } }).render().asPng(), width, height);
    const { mean } = difference(browser, reference);
    assert.ok(mean < (CPU_RASTER ? 1.5 : 1), `${repeats} copies at ${width}×${height}: mean difference ${mean.toFixed(2)}`);
    assert.ok(Math.abs(browser.mean - reference.mean) < 1, `${repeats} copies: Chromium ${browser.mean.toFixed(1)}, reference ${reference.mean.toFixed(1)}`);
  }
});

// resvg leaves out content of turned copies that hold a see-through group (resvg 2.6.2), so these
// compare with plain <use> copies (the markup without its home rectangles) drawn by a worker with
// 4 GB of tile memory instead of 512 MB, where they are all drawn. Plain copies were 43.8 (parts
// with a blur) and 8.9 (a group at 80%) levels away in the normal worker; now 0.05 and 0.15 (0.68
// and 0.77 on the CPU).
test("Radial Repeat Blur keeps its copies of blurred parts and of a see-through group inside the layer", async () => {
  const require = createRequire(import.meta.url);
  const electron = process.env.KINO_ELECTRON_EXECUTABLE ?? require("electron");
  const wrapper = join(directory, "electron-4gb.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${electron}" "$@" --force-gpu-mem-available-mb=4096\n`, { mode: 0o755 });
  await mkdir(join(directory, "roomy"));
  const roomy = await createChromiumRasterizer({ directory: join(directory, "roomy"), dependencies: { electronExecutable: wrapper } });
  try {
    const plain = (svg) => svg.replace(/<rect [^>]*fill="transparent" stroke="none" aria-hidden="true" pointer-events="none"\/>/g, "");
    for (const [label, options] of [["blurred parts", { part: { blur: 4 } }], ["a group at 80%", { inner: { opacity: 0.8 } }]]) {
      const scene = card({ width: 1920, height: 1080, effect: radial(64), ...options });
      const svg = renderSceneSvg(scene, 0.5, {});
      assert.match(svg, /fill="transparent" stroke="none"/);
      const browser = await draw(chromium, svg, 1920, 1080);
      const reference = await draw(roomy, plain(svg), 1920, 1080);
      const { mean } = difference(browser, reference);
      assert.ok(mean < (CPU_RASTER ? 1.5 : 0.5), `${label}: mean difference ${mean.toFixed(2)}`);
    }
  } finally {
    await roomy.close();
  }
});

// One copy is the layer itself, so it must draw exactly like the layer without the effect, at 1080p,
// at 4K, with a dot 100,000 px off the frame, and in a Lottie layer capture at 3× (3846 × 2016
// pixels). Copies that repeat one pattern tile of the layer would not: Chromium draws a tile larger
// than 2048 × 2048 pixels from a smaller, blurred one (0.47, 0.59 and 3.4 levels off).
test("one Radial Repeat Blur copy draws exactly like the layer, also when it is larger than a pattern tile", async () => {
  const one = { effect: radial(1) };
  for (const options of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1920, height: 1080, far: 100000 }]) {
    const [plain, copied] = [await drawScene(card(options)), await drawScene(card({ ...options, ...one }))];
    const { mean, max } = difference(copied, plain);
    assert.ok(mean === 0 && max === 0, `${JSON.stringify(options)}: mean difference ${mean.toFixed(3)}, largest ${max}`);
  }
  const capture = async (options) => {
    const layer = captureLayerSvg(card({ width: 640, height: 360, ...options }), "card", 0.5, { raster: false, rasterScale: { x: 3, y: 3 } });
    return { ...(await draw(chromium, layer.svg, layer.width, layer.height)), size: `${layer.width}x${layer.height}` };
  };
  const [plainLayer, copiedLayer] = [await capture({}), await capture(one)];
  assert.equal(copiedLayer.size, plainLayer.size);
  assert.equal(difference(copiedLayer, plainLayer).max, 0, "Lottie capture");
});
