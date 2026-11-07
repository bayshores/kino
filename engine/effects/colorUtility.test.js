import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { renderColorGrade, renderColorRemover } from "./colorUtility.js";

function renderPixels(render, parameters, content, width, height) {
  const defs = [];
  let sequence = 0;
  const frame = {
    content,
    bounds: { x: 0, y: 0, width, height },
    parameters,
    time: 0,
    progress: 0,
    helpers: { id: (kind) => `${kind}-${++sequence}`, defs },
  };
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { svg, pixels: new Resvg(svg).render().pixels };
}

function pixel(pixels, width, x, y = 0) {
  const offset = (y * width + x) * 4;
  return [...pixels.subarray(offset, offset + 4)];
}

test("Color Grade identity is exact, default contrast changes real pixels, and alpha is preserved", () => {
  const content = [
    '<rect x="0" width="1" height="1" fill="#404040"/>',
    '<rect x="1" width="1" height="1" fill="#FF0000"/>',
    '<rect x="2" width="1" height="1" fill="#00FF00" fill-opacity="0.5"/>',
  ].join("");
  const width = 3, height = 1;
  const source = renderPixels((_frame) => content, {}, content, width, height).pixels;
  const identity = renderPixels(renderColorGrade,
    { exposure: 1, brightness: 1, contrast: 1, saturation: 1 }, content, width, height);
  assert.equal(identity.svg.includes("<filter"), false, "the identity grade returns the original paint directly");
  assert.deepEqual(identity.pixels, source);

  const graded = renderPixels(renderColorGrade, {}, content, width, height).pixels;
  assert.ok(pixel(graded, width, 0)[0] < pixel(source, width, 0)[0], "default 1.5 contrast darkens a below-midpoint gray");
  assert.deepEqual(pixel(graded, width, 2).slice(3), pixel(source, width, 2).slice(3), "half alpha stays half alpha");
});

test("Color Grade saturation, zero exposure, and extreme multipliers have bounded pixel results", () => {
  const content = '<rect width="1" height="1" fill="#FF0000"/><rect x="1" width="1" height="1" fill="#404040" fill-opacity="0.5"/>';
  const saturated = renderPixels(renderColorGrade,
    { exposure: 1, brightness: 1, contrast: 1, saturation: 0 }, content, 2, 1).pixels;
  const gray = pixel(saturated, 2, 0);
  assert.ok(Math.max(...gray.slice(0, 3)) - Math.min(...gray.slice(0, 3)) <= 1, "zero saturation maps red to neutral luma");

  const dark = renderPixels(renderColorGrade,
    { exposure: 0, brightness: 1, contrast: 1, saturation: 1 }, content, 2, 1).pixels;
  assert.deepEqual(pixel(dark, 2, 0), [0, 0, 0, 255]);
  assert.equal(pixel(dark, 2, 1)[3], 128, "zero exposure leaves translucent alpha unchanged");

  const extreme = renderPixels(renderColorGrade,
    { exposure: 100, brightness: 100, contrast: 100, saturation: 100 }, content, 2, 1);
  assert.equal(extreme.pixels.length, 8);
  for (const value of extreme.pixels) assert.ok(Number.isInteger(value) && value >= 0 && value <= 255);
  assert.equal(pixel(extreme.pixels, 2, 1)[3], 128, "clamped extreme multipliers still preserve alpha");
});

test("Color Remover applies normalized RGB distance to opaque, semitransparent, and antialiased pixels", () => {
  const content = [
    '<rect x="0" y="0" width="2" height="2" fill="#00FF00"/>',
    '<rect x="2" y="0" width="2" height="2" fill="#33FF00"/>',
    '<rect x="4" y="0" width="2" height="2" fill="#80FF00"/>',
    '<rect x="6" y="0" width="2" height="2" fill="#0000FF"/>',
    '<rect x="8" y="0" width="2" height="2" fill="#00FF00" fill-opacity="0.5"/>',
    '<rect x="10" y="0" width="2" height="2" fill="#80FF00" fill-opacity="0.5"/>',
    '<rect x="12.5" y="0" width="1.5" height="2" fill="#00FF00"/>',
  ].join("");
  const width = 14, height = 2;
  const source = renderPixels((_frame) => content, {}, content, width, height).pixels;
  const sourceEdge = pixel(source, width, 12);
  assert.ok(sourceEdge[3] > 0 && sourceEdge[3] < 255, "the fixture has a partially covered green edge pixel");

  const output = renderPixels(renderColorRemover, {}, content, width, height).pixels;
  assert.equal(pixel(output, width, 0)[3], 0, "an exact target-color pixel is removed");
  assert.equal(pixel(output, width, 2)[3], 0, "a near-green pixel inside Range is removed");
  const softEdge = pixel(output, width, 4)[3];
  assert.ok(softEdge > 0 && softEdge < 255, `Softness keeps a partial edge alpha (${softEdge})`);
  assert.deepEqual(pixel(output, width, 6), pixel(source, width, 6), "a color outside Range plus Softness stays intact");
  assert.equal(pixel(output, width, 8)[3], 0, "semi-transparent source color is compared as straight RGB");
  const semiTransparentSoftEdge = pixel(output, width, 10)[3];
  assert.ok(semiTransparentSoftEdge > 0 && semiTransparentSoftEdge < 128, "the removal ramp multiplies, rather than replaces, source alpha");
  assert.ok(Math.abs(semiTransparentSoftEdge * 2 - softEdge) <= 2, "softness alpha scales proportionally with source alpha");
  assert.equal(pixel(output, width, 12)[3], 0, "antialiased target-color coverage is removed without a green fringe");
});

test("Color Remover custom target and hard threshold behave deterministically", () => {
  const content = '<rect x="0" width="1" height="1" fill="#FF0000"/><rect x="1" width="1" height="1" fill="#FE0000"/><rect x="2" width="1" height="1" fill="#00FF00"/>';
  const parameters = { targetColor: "#FF0000", range: 0, softness: 0 };
  const first = renderPixels(renderColorRemover, parameters, content, 3, 1);
  const second = renderPixels(renderColorRemover, parameters, content, 3, 1);
  assert.equal(first.svg, second.svg);
  assert.deepEqual(first.pixels, second.pixels);
  assert.equal(pixel(first.pixels, 3, 0)[3], 0, "the exact custom target is cleared");
  assert.equal(pixel(first.pixels, 3, 1)[3], 255, "a one-channel step from the target remains opaque");
  assert.deepEqual(pixel(first.pixels, 3, 2), [0, 255, 0, 255], "colors outside the exact key remain unchanged");

  const fullRange = renderPixels(renderColorRemover,
    { targetColor: "#000000", range: 1, softness: 0 }, content, 3, 1).pixels;
  assert.deepEqual([0, 1, 2].map((x) => pixel(fullRange, 3, x)[3]), [0, 0, 0], "Range 1 removes the full normalized RGB distance");
});
