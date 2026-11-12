// A text layer's material (engine/typeMaterial.js) drawn by the export renderer: worn edges,
// a texture inside the letters and a second print, with a bundled face (Inter).
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene, parseDocument, createDocument } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { renderSceneFrames } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { materialWords, normalizeMaterial } from "../engine/typeMaterial.js";

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
  // Shorthands, and a print given only a color takes an offset that follows the size (a starting guess, printed).
  const short = normalizeMaterial({ wear: 0.6, texture: "crackle", print: "#ff3fa4" });
  assert.deepEqual(short, { wear: { amount: 0.6, seed: 1 }, texture: { amount: 0.5, seed: 1, kind: "crackle" }, print: { color: "#FF3FA4", opacity: 1 } });
  // A texture color left out follows the fill (white on dark letters, black on light ones), printed with its source.
  assert.match(materialWords(short, 240, "#141414"), /; crackle #FFFFFF \(follows the #141414 fill, dark: a starting guess\) at 0\.5/);
  assert.match(materialWords(short, 240, "#fff"), /; crackle #000000 \(follows the #fff fill, light: a starting guess\)/);
  assert.equal(materialWords({ print: short.print }, 240), "print #FF3FA4 offset 12,7 px (a starting guess: 0.05,0.03 of the size) at 1");
  assert.match(materialWords(short, 240), /^wear 0\.6 seed 1, 12 px deep \(a starting guess: 0\.05 of the 240 px size\); crackle/);
  assert.notEqual(renderSceneSvg(scene({ material: normalizeMaterial({ print: "#FF0000" }) }), 0.5, { fonts }), plain);
  assert.equal(renderSceneSvg(scene({ material: { print: { x: 0, y: 0, color: "#FF0000" } } }), 0.5, { fonts }), plain);
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
  // Dark letters with a texture of no color: the texture lights some of the inside (it follows the fill).
  const dark = await lit(scene({ fill: "#141414", material: { texture: { kind: "crackle", amount: 0.5 } } }));
  assert.ok(count(dark.bits) > count(plain) * 0.01, `lit ${count(dark.bits)} of ${count(plain)}`);
  const printed = await lit(scene({ fill: "#000000", strokes: [{ color: "#FFFFFF", width: 4, align: "outside" }], material: { print: { x: 30, y: 0, color: "#FF0000", opacity: 1 } } }));
  // Red shows right of the letters (the print), and the white outline stays on the letters.
  const { pixels } = printed.frame;
  let red = 0;
  for (let i = 0; i < pixels.length; i += 4) red += pixels[i] > 200 && pixels[i + 1] < 60 ? 1 : 0;
  assert.ok(red > 1000, `red ${red}`);
});

test("letters animated one by one with outside strokes wear and print like the whole word, and a blur keeps the print", async () => {
  const colors = async (properties) => {
    const { frame } = await lit(scene({ strokes: [{ color: "#FF0000", width: 10, align: "outside" }],
      material: { wear: { amount: 0.6, seed: 4 }, print: { x: 24, y: 90, color: "#0000FF" } }, ...properties }));
    let red = 0, blue = 0;
    for (let i = 0; i < frame.pixels.length; i += 4) {
      const [r, g, b] = frame.pixels.subarray(i, i + 3);
      red += r > 200 && g < 60 ? 1 : 0;
      blue += b > 150 && r < 90 ? 1 : 0;
    }
    return { red, blue };
  };
  const whole = await colors({});
  // Finished by 0.5 s: the outside strokes are drawn in a pass of their own under the letters.
  const letters = await colors({ animations: [{ id: "in", kind: "custom", unit: "letters", stagger: 0.02, order: "forward", start: 0, duration: 0.1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } }] });
  assert.ok(Math.abs(letters.red - whole.red) < whole.red * 0.05 && Math.abs(letters.blue - whole.blue) < whole.blue * 0.05, JSON.stringify({ whole, letters }));
  const blurred = await colors({ blur: 2 });
  // The blur softens the print's edges (about 0.89 of the pixels stay); a clipped print kept about 0.3.
  assert.ok(blurred.blue > whole.blue * 0.8, JSON.stringify({ whole, blurred }));
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
