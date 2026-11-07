import test from "node:test";
import assert from "node:assert/strict";
import { exportScene } from "./export.mjs";
import { renderSceneSvg } from "../engine/render.js";
import { Resvg } from "@resvg/resvg-js";

function rectangle(id, values = {}) {
  return {id, name: id, type: "rectangle", parentId: null, x: 0, y: 0, width: 20, height: 10,
    scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, fill: "#ff0000", stroke: "none", strokeWidth: 0,
    visible: true, animations: [], fillEnabled: values.type !== "group", ...values};
}

test("clipped nested groups export native compositions with correct local clocks, opacity and bounds", async () => {
  const scene = {id: "scene", name: "Clip verification", width: 100, height: 80, background: "transparent", duration: 1,
    layers: [
      rectangle("outer", {type: "group", x: 15, y: 12, width: 40, height: 30, opacity: .6, clipContent: true,
        animations: [{id: "size", start: 0, duration: 1, easing: "linear", from: {width: 40}, to: {width: 60}}]}),
      rectangle("inner", {type: "group", parentId: "outer", x: 3, y: 4, width: 12, height: 8, opacity: .5, clipContent: true}),
      rectangle("content", {parentId: "inner", x: -10, y: -5, width: 50, height: 40}),
    ]};
  const result = JSON.parse((await exportScene(scene, {format: "lottie", fps: 4})).buffer.toString());
  const outer = result.layers.find((item) => item.nm === "outer");
  assert.equal(outer.ty, 0);
  assert.equal(outer.hasMask, true);
  assert.equal(outer.w, 60);
  assert.equal(outer.h, 30);
  assert.equal(outer.ks.o.k, 60);
  assert.equal(outer.ks.a.a, 1);
  assert.deepEqual(outer.ks.a.k[0].s, [20,15,0]);
  assert.equal(outer.masksProperties[0].pt.a, 1);
  assert.deepEqual(outer.masksProperties[0].pt.k[0].s[0].v, [[0,0],[40,0],[40,30],[0,30]]);
  assert.deepEqual(outer.masksProperties[0].pt.k.at(-1).s[0].v, [[0,0],[60,0],[60,30],[0,30]]);
  const outerAsset = result.assets.find((item) => item.id === outer.refId);
  const inner = outerAsset.layers.find((item) => item.nm === "inner");
  assert.deepEqual(inner.ks.p.k, [9,8,0]);
  assert.deepEqual(inner.ks.a, {a: 0, k: [6,4,0]});
  assert.equal(inner.ks.o.k, 50);
  assert.equal(inner.masksProperties[0].pt.a, 0);
  const innerAsset = result.assets.find((item) => item.id === inner.refId);
  assert.deepEqual(innerAsset.layers[0].ks.p.k, [15,15,0]);
  assert.equal(innerAsset.layers[0].ks.o.k, 100);
  assert.equal(result.op, 4);
});

test("luminance masks retain their paint and reference only the following visible sibling", async () => {
  const scene = {id: "scene", name: "Mask verification", width: 100, height: 80, background: "transparent", duration: 1,
    layers: [
      rectangle("mask", {type: "ellipse", isMask: true, fill: "#ffffff80", x: 10, y: 10}),
      rectangle("hidden", {visible: false}),
      rectangle("masked", {type: "group"}),
      rectangle("content-a", {parentId: "masked"}),
      rectangle("content-b", {parentId: "masked", x: 15}),
      rectangle("unmasked", {x: 70}),
    ]};
  const data = JSON.parse((await exportScene(scene, {format: "lottie", fps: 4})).buffer.toString());
  const maskedIndex = data.layers.findIndex((item) => item.nm === "masked");
  const masked = data.layers[maskedIndex];
  const mask = data.layers[maskedIndex - 1];
  assert.equal(mask.nm, "mask");
  assert.equal(mask.td, 1);
  assert.equal(masked.tt, 3);
  assert.equal(masked.tp, mask.ind);
  assert.equal(masked.ty, 0);
  assert.equal(data.assets.find((item) => item.id === masked.refId).layers.length, 2);
  assert.equal(Object.hasOwn(data.layers.find((item) => item.nm === "unmasked"), "tt"), false);
  assert.ok(Math.abs(mask.shapes[0].it.find((item) => item.ty === "fl").o.k - 128/255*100) < 1e-10);
  await assert.rejects(exportScene({...scene, layers: [scene.layers[0]]}, {format:"lottie"}), /needs a following visible layer/);
});

test("moving a masked layer preserves the mask's parent coordinate space in actual pixels", () => {
  const scene = {width: 80, height: 50, duration: 1, background: "transparent", layers: [
    rectangle("mask", {x: 10, y: 10, width: 20, height: 10, fill: "#ffffff", isMask: true}),
    rectangle("target", {x: 5, y: 5, width: 50, height: 40, fill: "#ff0000"}),
  ]};
  const pixels = new Resvg(renderSceneSvg(scene, 0)).render().pixels;
  const pixel = (x,y) => [...pixels.subarray((y*80+x)*4,(y*80+x)*4+4)];
  assert.deepEqual(pixel(12,12), [255,0,0,255]);
  assert.deepEqual(pixel(27,17), [255,0,0,255]);
  assert.equal(pixel(8,8)[3], 0);
  assert.equal(pixel(32,12)[3], 0);
  assert.equal(pixel(12,23)[3], 0);
});

test("unclipped compositions preserve negative content, group opacity and nonuniform skew", async () => {
  const scene = {id: "scene", name: "Group verification", width: 100, height: 80, duration: 1, background: "transparent", layers: [
    rectangle("group", {type: "group", x: 10, y: 5, width: 40, height: 20, scaleX: 2, skewX: 45, opacity: .5}),
    rectangle("left", {parentId: "group", x: -20, width: 30, height: 20}),
    rectangle("right", {parentId: "group", x: 20, width: 30, height: 20}),
    rectangle("collapsed", {x: 70, scaleX: 0}),
  ]};
  const data = JSON.parse((await exportScene(scene, {format:"lottie", fps:4})).buffer.toString());
  const group = data.layers.find((item) => item.nm === "group");
  assert.equal(group.ty, 0);
  assert.equal(group.ks.o.k, 50);
  assert.deepEqual(group.ks.a.k, [0,0,0]);
  assert.ok(Math.abs(group.ks.p.k[0] + 70) < 1e-10);
  assert.equal(group.ks.p.k[1], 5);
  assert.deepEqual(group.ks.s.k, [200,100,100]);
  assert.ok(Math.abs(group.ks.sk.k + Math.atan(2)*180/Math.PI) < 1e-10);
  assert.equal(group.w, 70);
  assert.equal(group.h, 20);
  const content = data.assets.find((item) => item.id === group.refId);
  assert.ok(content.layers.every((item) => item.ks.o.k === 100), "opacity is applied once to the composition");
  assert.deepEqual(content.layers.find((item) => item.nm === "left").ks.p.k, [15,10,0]);
  assert.equal(data.layers.find((item) => item.nm === "collapsed").ks.s.k[0], 0);
});
