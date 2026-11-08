// push-through-type on each kind of subject: plain words (its fields), a text layer, a picture
// logo (its alpha grid), a path, a shape and a group.
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { evaluateLayer } from "./animation.js";

const frame = { width: 1920, height: 1080 };
const move = MOVES["push-through-type"];
const shot = () => createLayer("image", { id: "shot", x: 0, y: 0, width: 1920, height: 1080, src: "/api/media/shot.png" });

function run(layers, raw, extra = {}) {
  const scene = createScene({ id: "s", name: "S", ...frame, duration: 6, layers: [shot(), ...layers] });
  return runMove(move, { id: "p", input: readMoveInput(move, raw), scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.2, dur: 2.6, media: () => null, ...extra });
}
const on = (made, layerId) => made.animations.filter((entry) => entry.layerId === layerId).map((entry) => entry.animation);
const named = (list, suffix) => list.find((animation) => animation.id.endsWith(suffix));
// Where a local point of the layer lands on screen at the end of the push (scale about its center).
const landsAt = (layer, push, point) => ({
  x: push.to.x + layer.width / 2 + (point.x - layer.width / 2) * push.to.scaleX,
  y: push.to.y + layer.height / 2 + (point.y - layer.height / 2) * push.to.scaleY,
});

test("words: fill, sheenColor, typeIn, push, spacing and split change the word; text or layer, not both", () => {
  const plain = run([], { text: "oak.", next: "shot" });
  const word = plain.added.find((entry) => entry.layer.move.part === "word").layer;
  assert.equal(word.fill.type, "linear", "chrome by default");
  const tuned = run([], { text: "oak.", next: "shot", fill: "#FF0000", typeIn: 0.3, push: 1.2, spacing: 1.5, split: 0, size: 0.3 });
  const tunedWord = tuned.added.find((entry) => entry.layer.move.part === "word").layer;
  assert.equal(tunedWord.fill, "#FF0000");
  assert.ok(tunedWord.fontSize < word.fontSize * 0.7, "size makes it smaller");
  const anims = tunedWord.animations;
  assert.equal(named(anims, ".in").duration, 0.3);
  assert.equal(named(anims, ".in").from.letterSpacing, tunedWord.letterSpacing * 1.5);
  assert.equal(named(anims, ".split"), undefined, "split 0: no color split");
  assert.equal(named(anims, ".sheen"), undefined, "a solid color has no sheen");
  assert.ok(Math.abs(named(anims, ".push").duration - 1.2) < 0.01);
  const sheened = run([], { text: "oak.", sheenColor: "#00FF00" }).added[0].layer;
  assert.notEqual(sheened.fill.stops[2].color, word.fill.stops[2].color, "the sheen band mixes in the sheen color");
  assert.equal(sheened.fill.stops[0].color, word.fill.stops[0].color);
  assert.throws(() => run([createLayer("text", { id: "t", text: "A" })], { text: "a", layer: "t" }), /exactly one of text or layer/);
});

test("a text layer keeps its font, size, color and place; the push lands in one of its letters", () => {
  const title = createLayer("text", { id: "title", x: 300, y: 400, width: 1200, height: 200, text: "BOLD", fontSize: 160, fontFamily: "Inter", fontWeight: 700, fill: "#22AAFF", textResize: "fixed" });
  const made = run([title], { layer: "title", next: "shot" });
  assert.equal(made.added.find((entry) => entry.layer.move.part === "word"), undefined, "no word of its own");
  const anims = on(made, "title");
  const push = named(anims, "layer-push");
  assert.deepEqual([push.from.x > 0, named(anims, "layer-creep").from.x], [true, 300], "starts where it is");
  assert.equal(named(anims, "layer-sheen"), undefined, "its own color: no sheen");
  const window = made.added.find((entry) => entry.layer.move.part === "window").layer;
  assert.deepEqual([window.isMask, window.fill, window.fontSize, window.text], [true, "#FFFFFF", 160, "BOLD"]);
  assert.ok(push.to.scaleX > 5, "it pushes deep into a letter");
  assert.throws(() => run([title], { layer: "title", size: 0.4 }), /for words only/);
  // A layer on screen before the move has no entrance.
  const early = run([title], { layer: "title" }, { start: 1 });
  assert.equal(named(on(early, "title"), "layer-in")?.from.opacity, undefined);
  // Nor do its letters jump open before the move and close up at it.
  const shownTitle = { ...title, animations: on(early, "title") };
  for (const t of [0, 0.5, 0.99, 1.02, 1.3]) assert.equal(evaluateLayer(shownTitle, t).letterSpacing ?? 0, 0, `letter spacing at ${t} s`);
  const earlyWindow = run([title], { layer: "title", next: "shot" }, { start: 1 }).added.find((entry) => entry.layer.move.part === "window").layer;
  assert.equal(earlyWindow.animations.some((animation) => animation.from?.letterSpacing !== undefined), false);
  // From the scene start it still sharpens in with its letters closing up.
  assert.ok(named(on(run([title], { layer: "title" }, { start: 0 }), "title"), "layer-in").from.letterSpacing > 0);
});

test("a picture logo: the push aims at its solid part from its alpha grid, never its see-through middle", () => {
  // A ring: solid on a band near the edge, see-through in the middle.
  const columns = 32;
  const solid = new Uint8Array(columns * columns);
  for (let row = 0; row < columns; row += 1) for (let column = 0; column < columns; column += 1) {
    const distance = Math.hypot(column + 0.5 - 16, row + 0.5 - 16);
    solid[row * columns + column] = distance > 9 && distance < 15 ? 1 : 0;
  }
  const logo = createLayer("image", { id: "logo", x: 810, y: 390, width: 300, height: 300, src: "/api/media/logo.png" });
  const made = run([logo], { layer: "logo", next: "shot" }, { alpha: (src) => (src === "/api/media/logo.png" ? { columns, rows: columns, solid } : null) });
  const push = named(on(made, "logo"), "layer-push");
  // The frame's middle at the end lands on a point of the ring.
  const local = { x: logo.width / 2 + (960 - push.to.x - logo.width / 2) / push.to.scaleX, y: logo.height / 2 + (540 - push.to.y - logo.height / 2) / push.to.scaleY };
  const distance = Math.hypot(local.x / logo.width * 32 - 16, local.y / logo.height * 32 - 16);
  assert.ok(distance > 9 && distance < 15, `aims at the ring (${distance.toFixed(1)} cells from the middle)`);
  const window = made.added.find((entry) => entry.layer.move.part === "window").layer;
  assert.equal(window.type, "image");
  assert.equal(window.animations[0].effect, "hue-saturation", "the mask is the picture whitened");
  assert.throws(() => run([logo], { layer: "logo", point: [50, 50] }, { alpha: () => ({ columns, rows: columns, solid }) }), /not on what logo draws; try/);
  assert.throws(() => run([logo], { layer: "logo", fill: "chrome" }), /chrome or a color is for words/);
  // Unknown alpha: its box stands in, with a note.
  assert.ok(run([logo], { layer: "logo" }).notes.some((note) => note.includes("not measured")));
});

test("a filled path: the push lands inside its outline", () => {
  const blob = createLayer("path", { id: "blob", x: 660, y: 340, width: 600, height: 400, path: "M0 0 L600 0 L600 400 L0 400 Z", fill: "#FF7D3D" });
  const made = run([blob], { layer: "blob", next: "shot", point: [25, 50] });
  const push = named(on(made, "blob"), "layer-push");
  const hit = landsAt(blob, push, { x: 150, y: 200 });
  assert.ok(Math.abs(hit.x - 960) < 1 && Math.abs(hit.y - 540) < 1, "the point asked for ends in the frame's middle");
  assert.equal(made.added.find((entry) => entry.layer.move.part === "window").layer.fill, "#FFFFFF");
  const chrome = run([blob], { layer: "blob", fill: "chrome", sheenColor: "#112233" });
  assert.ok(JSON.stringify(named(on(chrome, "blob"), "layer-sheen").to.fill).includes("#"), "a path takes the chrome sheen");
});

test("a shape: an ellipse's push aims at its middle and covers the frame", () => {
  const dot = createLayer("ellipse", { id: "dot", x: 760, y: 340, width: 400, height: 400, fill: "#F4F2EE", scaleX: 0.5, scaleY: 0.5 });
  const push = named(on(run([dot], { layer: "dot", next: "shot" }), "dot"), "layer-push");
  const middle = landsAt(dot, push, { x: 200, y: 200 });
  assert.ok(Math.abs(middle.x - 960) < 30 && Math.abs(middle.y - 540) < 30, "near its middle");
  // The frame fits in the circle: its half diagonal is under the drawn radius.
  assert.ok(200 * push.to.scaleX > Math.hypot(960, 540), "the circle covers the frame at the end");
  assert.equal(push.from.scaleX, 0.5 * 1.3, "its own scale is kept and grows from there");
});

test("a group: the push lands in one of its parts, and its mask copies the parts", () => {
  const group = createLayer("group", { id: "mark", x: 560, y: 340, width: 800, height: 400 });
  const left = createLayer("rectangle", { id: "left", parentId: "mark", x: 0, y: 0, width: 300, height: 400, fill: "#FFFFFF" });
  const right = createLayer("ellipse", { id: "right", parentId: "mark", x: 500, y: 100, width: 200, height: 200, fill: "#FFFFFF" });
  const made = run([group, left, right], { layer: "mark", next: "shot" });
  const push = named(on(made, "mark"), "layer-push");
  const local = { x: group.width / 2 + (960 - push.to.x - group.width / 2) / push.to.scaleX, y: group.height / 2 + (540 - push.to.y - group.height / 2) / push.to.scaleY };
  assert.ok(local.x > 0 && local.x < 300 && local.y > 0 && local.y < 400, "inside the bigger part (the rectangle fills the frame sooner)");
  const window = made.added.find((entry) => entry.layer.move.part === "window").layer;
  assert.equal(window.type, "group");
  assert.equal(made.added.filter((entry) => entry.layer.parentId === window.id).length, 2);
  assert.throws(() => run([group, left, right], { layer: "left" }), /inside a group|give the group|group/);
});
