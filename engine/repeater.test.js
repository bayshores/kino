import test from "node:test";
import assert from "node:assert/strict";
import { renderSceneSvg } from "./render.js";
import { animationProblem, createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { repeaterOf } from "./repeater.js";

const scene = (layers) => createScene({ id: "s", width: 400, height: 400, background: "#000000", layers });
const copies = (svg) => (svg.match(/data-repeat-copy="/g) ?? []).length;
const matrices = (svg) => [...svg.matchAll(/data-repeat-copy="\d+" transform="matrix\(([^)]*)\)"/g)].map((match) => match[1].split(" ").map(Number));
const near = (actual, expected) => assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-3), `${actual} != ${expected}`);

test("no repeater fields draw the layer exactly as before", () => {
  const plain = createLayer("rectangle", { id: "r", x: 10, y: 20, width: 40, height: 40 });
  const one = { ...plain, repeatCopies: 1, repeatRotation: 30 };
  const svg = renderSceneSvg(scene([plain]), 0);
  assert.equal(copies(svg), 0);
  assert.equal(renderSceneSvg(scene([one]), 0).replace(/-\d+"/g, '"'), svg.replace(/-\d+"/g, '"'), "one copy is no repeater");
  assert.equal(repeaterOf({ ...plain, type: "image", repeatCopies: 4 }), null, "pictures have none");
});

test("a ring of 12 copies turns 30 degrees each around the anchor, opacity from start to end", () => {
  // A 20 px dot 100 px above the ring's center: the anchor is 100 px below the dot's center.
  const dot = createLayer("ellipse", { id: "d", x: 190, y: 90, width: 20, height: 20, fill: "#ffffff",
    repeatCopies: 12, repeatRotation: 30, repeatAnchorY: 100, repeatStartOpacity: 1, repeatEndOpacity: 0.12 });
  const svg = renderSceneSvg(scene([dot]), 0);
  assert.equal(copies(svg), 12);
  assert.equal((svg.match(/<use href="#[^"]*repeat-\d+"/g) ?? []).length, 11, "copies reuse the first one's drawing");
  const list = matrices(svg);
  // Copy 3 has turned 90 degrees around (10, 110) in the dot's own units.
  near(list[2], [0, 1, -1, 0, 120, 100]);
  assert.match(svg, /data-repeat-copy="11" transform="[^"]*" opacity="0.12"/);
  assert.match(svg, /data-repeat-copy="0"><g id=/, "the first copy keeps full opacity");
});

test("offset and scale compound per copy; a row of bars", () => {
  const bar = createLayer("rectangle", { id: "b", x: 0, y: 0, width: 10, height: 50, repeatCopies: 4, repeatX: 20, repeatScale: 0.5 });
  const list = matrices(renderSceneSvg(scene([bar]), 0));
  assert.equal(list.length, 3);
  // Scale 0.5 around the center (5, 25), moved 20 px; the next step is taken in that copy (gaps shrink too).
  near(list[0], [0.5, 0, 0, 0.5, 22.5, 12.5]);
  near(list[1], [0.25, 0, 0, 0.25, 33.75, 18.75]);
});

test("text and group layers repeat; the drawn bounds hold every copy", () => {
  const word = createLayer("text", { id: "t", x: 0, y: 0, width: 200, height: 60, text: "Go", repeatCopies: 3, repeatY: 70 });
  assert.equal(copies(renderSceneSvg(scene([word]), 0)), 3);
  const group = createLayer("group", { id: "g", x: 0, y: 0, width: 50, height: 50, repeatCopies: 5, repeatX: 60 });
  const child = createLayer("rectangle", { id: "c", parentId: "g", x: 0, y: 0, width: 50, height: 50 });
  const blurred = { ...group, blur: 4 };
  const svg = renderSceneSvg(scene([blurred, child]), 0);
  assert.equal(copies(svg), 5);
  // The blur's filter region spans all five copies (290 px wide), not the 50 px box.
  const region = svg.match(/<filter [^>]*width="([\d.]+)"/);
  assert.ok(region && Number(region[1]) >= 290, `filter width ${region?.[1]}`);
});

test("repeater fields animate; a fraction of a copy fades the last one in", () => {
  const ray = createLayer("rectangle", { id: "r", x: 195, y: 100, width: 10, height: 80, repeatCopies: 1, repeatRotation: 45, repeatAnchorY: 100 });
  ray.animations = [{ id: "a", name: "Burst", kind: "custom", start: 0, duration: 1, easing: "linear", from: { repeatCopies: 1 }, to: { repeatCopies: 8 } }];
  assert.equal(animationProblem(ray.animations[0], ray), null);
  const at = (time) => renderSceneSvg(scene([ray]), time);
  assert.equal(copies(at(0)), 0);
  assert.equal(copies(at(1)), 8);
  // At 0.5 s copies is 4.5: five copies, the fifth at half opacity.
  assert.equal(copies(at(0.5)), 5);
  assert.match(at(0.5), /data-repeat-copy="4" transform="[^"]*" opacity="0.5"/);
  // An animation may leave out from: it starts from the layer's own value or the rest.
  const turn = { id: "b", name: "Turn", kind: "custom", start: 0, duration: 1, easing: "linear", from: {}, to: { repeatRotation: 90 } };
  assert.equal(animationProblem(turn, ray), null);
  const picture = createLayer("image", { id: "i" });
  assert.match(animationProblem(turn, picture) ?? "", /no repeater/);
});

test("saved documents check repeater fields and their ranges", () => {
  const doc = (layer) => createDocument({ scenes: [scene([layer])] });
  const ok = parseDocument(doc(createLayer("star", { id: "s1", repeatCopies: 6, repeatRotation: 60 })));
  assert.equal(ok.scenes[0].layers[0].repeatCopies, 6);
  assert.throws(() => parseDocument(doc(createLayer("star", { id: "s2", repeatCopies: 65 }))), /repeatCopies/);
  assert.throws(() => parseDocument(doc(createLayer("video", { id: "v", repeatCopies: 3 }))), /repeater/);
});
