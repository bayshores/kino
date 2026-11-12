// A text layer's material (engine/typeMaterial.js) drawn by the export renderer: worn edges,
// a texture inside the letters and a second print, with a bundled face (Inter).
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene, parseDocument, createDocument } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";

const fonts = await loadBundledFonts();

function scene(properties = {}, extra = {}) {
  const word = createLayer("text", { id: "word", name: "word", text: "TRUST", fontFamily: "Inter", fontWeight: 700,
    x: 40, y: 150, width: 880, height: 240, fontSize: 200, textAlign: "center", fill: "#FFFFFF", ...properties });
  return createScene({ id: "s", name: "s", width: 960, height: 540, duration: 1, background: "#000000", layers: [word], ...extra });
}

// The frame's lit pixels (any channel over 128) as a bit list.
async function lit(input) {
  const [frame] = await renderSceneFrames(input, [0.5], { fonts, width: 960 });
  const bits = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < bits.length; i += 1) bits[i] = Math.max(frame.pixels[i * 4], frame.pixels[i * 4 + 1], frame.pixels[i * 4 + 2]) > 128 ? 1 : 0;
  return { bits, frame };
}
const count = (bits) => bits.reduce((sum, bit) => sum + bit, 0);

test("a material is checked: text layers only, known parts and kinds, amount 0 draws exactly no material", () => {
  const document = (layer) => createDocument({ scenes: [createScene({ id: "a", name: "a", layers: [layer] })] });
  assert.throws(() => parseDocument(document(createLayer("rectangle", { material: { wear: { amount: 0.5 } } }))), /only text layers take a material/);
  assert.throws(() => parseDocument(document(createLayer("text", { material: { texture: { kind: "plaid" } } }))), /material\.texture\.kind: must be grain, brush, crackle, halftone/);
  assert.throws(() => parseDocument(document(createLayer("text", { material: { wear: { depth: 3 } } }))), /material\.wear\.depth: is not a field of wear/);
  const plain = renderSceneSvg(scene(), 0.5, { fonts });
  const zero = renderSceneSvg(scene({ material: { wear: { amount: 0, seed: 3 }, texture: { kind: "grain", amount: 0 }, print: { x: 8, y: 8, opacity: 0 } } }), 0.5, { fonts });
  assert.equal(zero, plain);
});

test("edge wear at amount 0.5 removes 8% to 40% of the letters' pixels, and the seed moves the pattern", async () => {
  const plain = count((await lit(scene())).bits);
  const worn = (await lit(scene({ material: { wear: { amount: 0.5, seed: 1 } } }))).bits;
  const removed = 1 - count(worn) / plain;
  assert.ok(removed > 0.08 && removed < 0.4, `removed ${removed}`);
  const reseeded = (await lit(scene({ material: { wear: { amount: 0.5, seed: 2 } } }))).bits;
  let differ = 0;
  for (let i = 0; i < worn.length; i += 1) differ += worn[i] !== reseeded[i];
  assert.ok(differ > plain * 0.03, `seed 1 and 2 differ in ${differ} of ${plain} pixels`);
});

test("texture stays inside the letters and the print sits under them at its offset", async () => {
  const plain = (await lit(scene())).bits;
  const textured = await lit(scene({ material: { texture: { kind: "halftone", amount: 1, seed: 4, color: "#000000" } } }));
  // Nothing lit outside the plain letters, and the dots darken some of the inside.
  let outside = 0;
  for (let i = 0; i < plain.length; i += 1) outside += textured.bits[i] && !plain[i];
  assert.equal(outside, 0);
  assert.ok(count(textured.bits) < count(plain) * 0.95);
  const printed = await lit(scene({ fill: "#000000", strokes: [{ color: "#FFFFFF", width: 4, align: "outside" }], material: { print: { x: 30, y: 0, color: "#FF0000", opacity: 1 } } }));
  // Red shows right of the letters (the print), and the white outline stays on the letters.
  const { pixels } = printed.frame;
  let red = 0;
  for (let i = 0; i < pixels.length; i += 4) red += pixels[i] > 200 && pixels[i + 1] < 60 ? 1 : 0;
  assert.ok(red > 1000, `red ${red}`);
});

test("fill and stroke scale as one: the outline's center follows the fill's under a 2.5x scale", async () => {
  const center = async (properties, color) => {
    const { frame } = await lit(scene({ ...properties, scaleX: 2.5, scaleY: 2.5, text: "O" }));
    let x = 0, y = 0, n = 0;
    for (let i = 0; i < frame.pixels.length; i += 4) if (color(frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2])) { x += (i / 4) % frame.width; y += Math.floor(i / 4 / frame.width); n += 1; }
    return { x: x / n, y: y / n, n };
  };
  const style = { fill: "#FFFFFF", strokes: [{ color: "#FF0000", width: 12, align: "outside" }], material: { print: { x: 20, y: 20, color: "#0000FF" } } };
  const fill = await center(style, (r, g, b) => r > 200 && g > 200 && b > 200);
  const ring = await center(style, (r, g) => r > 200 && g < 60);
  assert.ok(fill.n > 1000 && ring.n > 1000);
  assert.ok(Math.abs(fill.x - ring.x) < 3 && Math.abs(fill.y - ring.y) < 3, JSON.stringify({ fill, ring }));
});
