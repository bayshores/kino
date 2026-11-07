import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../model.js";
import { captureLayerSvg } from "../render.js";

const box = (id, properties = {}) => createLayer("rectangle", { id, x: 0, y: 0, width: 30, height: 20, fill: "#FF0000", ...properties });
const scene = (layers) => createScene({ width: 200, height: 150, background: "#00FF00", layers });
function raster(capture) {
  const image = new Resvg(capture.svg).render();
  return { pixels: image.pixels, width: image.width, height: image.height };
}
const pixel = (image, x, y) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test("layer capture removes its world transform and excludes unrelated paint and scene background", () => {
  const group = createLayer("group", { id: "parent", x: 80, y: 50, width: 100, height: 70, rotation: 25, scaleX: 1.8, scaleY: 0.7, opacity: 0.3 });
  const target = box("target", { parentId: "parent", x: 30, y: 25, rotation: -17, opacity: 0.5 });
  const capture = captureLayerSvg(scene([box("outside", { width: 200, height: 150, fill: "#0000FF" }), group, target]), "target");
  const image = raster(capture);
  assert.ok(capture.bounds.x < 1 && capture.bounds.width < 60, JSON.stringify(capture.bounds));
  const center = pixel(image, Math.round(15 - capture.bounds.x), Math.round(10 - capture.bounds.y));
  assert.ok(center[0] >= 126 && center[0] <= 129 && center[3] >= 126 && center[3] <= 129, center);
  assert.equal(pixel(image, 0, 0)[3], 0);
  assert.equal(capture.state.x, 30);
});

test("capture keeps the complete group subtree, clipping and its effect overflow in local bounds", () => {
  const group = createLayer("group", { id: "group", x: 90, y: 40, width: 40, height: 40, clipContent: true,
    radius: 8, shadow: { color: "#000000", x: 10, y: 3, blur: 4 } });
  const child = box("child", { parentId: "group", x: -10, y: -10, width: 80, height: 80 });
  const capture = captureLayerSvg(scene([group, child]), "group");
  const image = raster(capture);
  assert.ok(capture.bounds.width > 50 && capture.bounds.x < 0, JSON.stringify(capture.bounds));
  const middle = pixel(image, Math.round(20 - capture.bounds.x), Math.round(20 - capture.bounds.y));
  assert.deepEqual(middle, [255, 0, 0, 255]);
  assert.equal(pixel(image, 0, 0)[3], 0);
});

test("capture samples the real backdrop while keeping outside pixels transparent", () => {
  const left = box("left", { width: 100, height: 150 });
  const right = box("right", { x: 100, width: 100, height: 150, fill: "#0000FF" });
  const target = box("blur", { x: 80, y: 30, width: 40, height: 40, fill: "#FFFFFF",
    backgroundBlur: { enabled: true, radius: 5, blend: 20 } });
  const capture = captureLayerSvg(scene([left, right, target]), "blur");
  const image = raster(capture);
  const middle = pixel(image, 20 - capture.bounds.x, 20 - capture.bounds.y);
  assert.ok(middle[0] > 100 && middle[2] > 100 && middle[1] >= 50, middle);
  assert.equal(pixel(image, 0, 0)[3], 0);
});

test("a collapsed transform captures a transparent frame and does not allocate a huge image", () => {
  const target = box("collapsed", { x: 130, y: 90, scaleX: 0 });
  const capture = captureLayerSvg(scene([target]), target.id);
  assert.ok(capture.width <= 4 && capture.height <= 4);
  assert.ok(raster(capture).pixels.every((value) => value === 0));
});

test("a tightly cropped displacement capture normalizes native source size without an abort", () => {
  const source = `import {createLayer,createScene} from ${JSON.stringify(new URL("../model.js", import.meta.url).href)};
    import {captureLayerSvg,renderSceneSvg} from ${JSON.stringify(new URL("../render.js", import.meta.url).href)};
    import {createEffectAnimation} from ${JSON.stringify(new URL("./animation.js", import.meta.url).href)};
    import {Resvg} from '@resvg/resvg-js';
    const scene=createScene({width:64,height:48,layers:[createLayer('rectangle',{id:'target',x:10,y:10,width:40,height:30})]});
    scene.layers[0].animations=[createEffectAnimation('noise-warp',scene.layers[0],0,scene,'noise')];
    const capture=captureLayerSvg(scene,'target',0); const image=new Resvg(capture.svg).render();
    const pixels=image.pixels; let visible=0; for(let i=3;i<pixels.length;i+=4) if(pixels[i])visible++;
    console.log(JSON.stringify({visible,width:image.width,height:image.height,normalized:capture.svg.includes('kinoSourceGraphic'),browserChanged:renderSceneSvg(scene).includes('kinoSourceGraphic')}));`;
  const process = spawnSync(globalThis.process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 20_000 });
  assert.equal(process.status, 0, `${process.signal ?? ""} ${process.stderr}`);
  const result = JSON.parse(process.stdout.trim());
  assert.ok(result.visible > 100);
  assert.equal(result.normalized, true);
  assert.equal(result.browserChanged, false);
  assert.ok(result.width < 60 && result.height < 60);
});
