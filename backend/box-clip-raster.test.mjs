import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { run } from "./media.test.support.mjs";

const source = `data:image/png;base64,${new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>').render().asPng().toString("base64")}`;
const image = (values = {}) => createLayer("image", { id: "image", x: 0, y: 0, width: 40, height: 40, src: source, radius: 10, ...values });
const scene = (layers) => createScene({ width: 100, height: 100, backgroundEnabled: false, layers });

// A native panic must be an ordinary failed assertion, not an abort of the whole test file.
async function renderInChild(scenes) {
  const renderer = new URL("../engine/render.js", import.meta.url).href;
  const script = `import { Resvg } from '@resvg/resvg-js'; import { renderSceneSvg } from ${JSON.stringify(renderer)};
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const output=JSON.parse(input).map((scene,index)=>{console.error('raster fixture '+index);const image=new Resvg(renderSceneSvg(scene)).render();
      return Buffer.from(image.pixels).toString('base64')}); console.log(JSON.stringify(output));`;
  const output = await run(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify(scenes) });
  return JSON.parse(output.toString()).map((value) => Buffer.from(value, "base64"));
}

test("clipped offscreen media and nested clips rasterize without a native abort or visible registration pixels", async () => {
  const fixtures = [
    scene([image({ x: 120, y: 120 })]),
    scene([image({ x: -80, stroke: "#ff0000", strokeWidth: 6, strokeAlign: "inside" })]),
    scene([image({ x: 120, stroke: "#ff0000", strokeWidth: 6, strokeAlign: "outside" })]),
    scene([createLayer("group", { id: "g", x: 120, y: 120, width: 40, height: 40, clipContent: true, radius: 10 }), image({ parentId: "g" })]),
    scene([createLayer("group", { id: "g", x: 0, y: 0, width: 40, height: 40, clipContent: true, radius: 10 }), image({ parentId: "g", x: 60, y: 60 })]),
    scene([image({ x: 120, scaleX: 0 })]),
    scene([createLayer("group", { id: "g", x: 1e5, y: 1e5, width: 40, height: 40, scaleX: 1000, scaleY: 1000 }), image({ parentId: "g", x: 1e5, scaleX: 1000, scaleY: 1000 })]),
  ];
  const results = await renderInChild(fixtures);
  for (const [index, data] of results.entries())
    assert.equal(data.some((value, position) => position % 4 === 3 && value !== 0), false, `offscreen fixture ${index} has no visible pixels`);
});

test("offscreen rounded media still casts a visible shadow, including an ancestor shadow", async () => {
  const shadow = { x: -35, y: 0, blur: 0, color: "#000000" };
  const results = await renderInChild([
    scene([image({ x: 110, y: 30, shadow })]),
    scene([createLayer("group", { id: "g", x: 110, y: 30, width: 40, height: 40, shadow }), image({ parentId: "g" })]),
  ]);
  for (const data of results) {
    const pixel = (x, y) => [...data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
    assert.deepEqual(pixel(90, 50), [0, 0, 0, 255]);
    assert.equal(pixel(75, 30)[3], 0, "the shadow keeps the rounded corner");
    assert.equal(pixel(50, 50)[3], 0, "the transparent registration pixel contributes no shadow");
  }
});
