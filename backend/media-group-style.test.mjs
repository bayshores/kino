import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { exportScene } from "./export.mjs";
import { createLayer, createScene, createDocument, parseDocument } from "../engine/model.js";

const imageBytes = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path fill="blue" d="M0 0H20V10H0Z"/></svg>').render().asPng();
const source = `data:image/png;base64,${imageBytes.toString("base64")}`;
const gradient = { type: "linear", angle: 45, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#00ff00" }] };
const layer = (type, values = {}) => createLayer(type, { id: type, name: type, x: 20, y: 20, width: 60, height: 60, ...values });
const scene = (layers) => createScene({ id: "scene", width: 120, height: 100, duration: 1, backgroundEnabled: false, layers });
const output = async (value) => JSON.parse((await exportScene(value, { format: "lottie", fps: 4, imageDPIRatio: "original" })).buffer);
const allLayers = (data) => [...data.layers, ...data.assets.flatMap((asset) => asset.layers ?? [])];
const allShapes = (data) => {
  const found = [];
  const visit = (shape) => { found.push(shape); shape.it?.forEach(visit); };
  allLayers(data).forEach((item) => item.shapes?.forEach(visit));
  return found;
};

test("rounded images keep native bitmap fit and all three native border alignments", async () => {
  for (const strokeAlign of ["inside", "center", "outside"]) {
    const data = await output(scene([layer("image", { src: source, cornerRadii: [20, 0, 8, 16], stroke: gradient, strokeWidth: 6, strokeAlign, opacity: 0.5 })]));
    const root = data.layers.find((item) => item.nm === "image");
    assert.equal(root.ks.o.k, 50);
    assert.deepEqual(root.ks.p.k, [50, 50, 0]);
    const content = allLayers(data).find((item) => item.nm === "image content");
    assert.ok(content.hasMask);
    assert.ok(content.masksProperties[0].pt.k.v.length >= 8);
    assert.ok(content.masksProperties[0].pt.k.i.some((tangent) => tangent.some((number) => number !== 0)));
    const bitmap = allLayers(data).find((item) => item.ty === 2);
    assert.deepEqual(bitmap.ks.p.k, [-30, 0, 0]);
    assert.equal(bitmap.ks.o.k, 100);
    const stroke = allShapes(data).find((item) => item.ty === "gs");
    assert.ok(stroke, "native gradient stroke, not a rasterized substitute");
    assert.equal(stroke.w.k, strokeAlign === "center" ? 6 : 12);
    if (strokeAlign !== "center") assert.ok(allLayers(data).some((item) => item.tt === (strokeAlign === "inside" ? 1 : 2)));
    if (strokeAlign === "outside") {
      assert.equal(root.w, 72);
      assert.deepEqual(root.ks.a.k, [36, 36, 0]);
    }
  }
});

test("styled clipped groups compose background, rounded children, and outside border in order", async () => {
  const data = await output(scene([
    layer("group", { fill: gradient, fillEnabled: true, stroke: "#ff000080", strokeWidth: 5, strokeAlign: "outside", radius: 16, clipContent: true, opacity: 0.6 }),
    layer("rectangle", { parentId: "group", x: -15, y: -10, fill: "#0000ff", opacity: 0.5 }),
  ]));
  const root = data.layers.find((item) => item.nm === "group");
  assert.equal(root.ks.o.k, 60);
  const painted = data.assets.find((asset) => asset.id === root.refId).layers;
  assert.deepEqual(painted.map((item) => item.nm), ["group border", "group content", "group background"]);
  assert.ok(painted[1].hasMask);
  assert.equal(painted[1].ks.o.k, 100);
  const child = allLayers(data).find((item) => item.nm === "rectangle");
  assert.equal(child.ks.o.k, 50, "parent opacity belongs only to the outer group");
  assert.ok(allShapes(data).some((item) => item.ty === "gf"));
});

test("unclipped group styles and negative children fit nested parent compositions", async () => {
  const data = await output(scene([
    layer("group", { id: "outer", name: "outer", width: 10, height: 10 }),
    layer("group", { parentId: "outer", x: -40, y: -20, fillEnabled: true, strokeWidth: 7, strokeAlign: "outside", fill: "#00ff00" }),
    layer("rectangle", { parentId: "group", x: -30, y: 0, width: 20, height: 20 }),
  ]));
  const outer = data.layers.find((item) => item.nm === "outer");
  assert.ok(outer.w >= 100);
  const styled = allLayers(data).find((item) => item.nm === "group");
  assert.ok(styled.w >= 97);
  assert.equal(allLayers(data).some((item) => item.hasMask && item.nm === "group content"), false);
});

test("new media corner and border animations produce native animated paths and paint", async () => {
  const data = await output(scene([layer("image", { src: source, animations: [{ id: "round", name: "Round", kind: "custom", start: 0, duration: 1, easing: "linear", from: { radius: 0, strokeWidth: 0 }, to: { radius: 24, strokeWidth: 8 } }] })]));
  const content = allLayers(data).find((item) => item.nm === "image content");
  assert.equal(content.masksProperties[0].pt.a, 1);
  const paths = content.masksProperties[0].pt.k.map((key) => key.s[0]);
  assert.ok(paths.every((path) => path.v.length === paths[0].v.length));
  assert.ok(allShapes(data).some((item) => item.ty === "st" && item.w.a === 1));
});

test("legacy box styles remain inactive in native Lottie exports", async () => {
  const old = parseDocument({ ...createDocument({ scenes: [scene([
    layer("group", { fillEnabled: true, radius: 25, strokeWidth: 6, clipContent: true }),
    layer("image", { parentId: "group", x: 0, y: 0, src: source, radius: 20, strokeWidth: 5 }),
  ])] }), version: 3 });
  const data = await output(old.scenes[0]);
  assert.equal(allShapes(data).some((item) => ["st", "gs", "fl", "gf"].includes(item.ty)), false);
  for (const item of allLayers(data).filter((item) => item.hasMask))
    assert.equal(item.masksProperties[0].pt.k.v.length, 4);
});
