// The Color effects: the colour maths (colorMath.js) and the SVG filters that draw it
// (colorGrading.js). The filters are drawn by Chromium, which draws every effect in previews and
// exports (backend/raster-policy.mjs), and compared with the maths.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../../backend/chromium-raster.mjs";
import {
  IDENTITY_CURVE, KEEP_COLOR_FLOOR, colorWheelTables, cubeText, curveFunction, curvesTables, hueAngle, hueRotationMatrix,
  hueSaturationMatrix, applyMatrix, keepColor, keepColorMask, liftGammaGain, luma, lutIsSeparable, normalizeCurve, parseCubeLut,
  sampleLut, whiteBalanceGains, whiteBalanceTables,
} from "./colorMath.js";
import { renderColorWheels, renderCurves, renderHueSaturation, renderKeepColor, renderLut, renderWhiteBalance } from "./colorGrading.js";
import { effectDefaults } from "./catalog.js";

const LUT_SOURCE = "/api/media/00000000-0000-4000-8000-000000000001.cube";

// One Chromium worker for the whole file.
let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-color-grading-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function rasterize(svg, width, height = 1) {
  const image = await loadImage((await chromium.render(svg, width, height)).buffer);
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.getContext("2d").getImageData(0, 0, width, height).data;
}

// A row of 1×1 opaque pixels in the given colours (0..255 triples).
function swatches(colors) {
  return colors.map(([r, g, b], x) => `<rect x="${x}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`).join("");
}

// Draws `render` over a row of colours and returns the drawn [r, g, b, a] of each pixel.
async function draw(render, parameters, colors, luts) {
  const defs = [];
  let sequence = 0;
  const width = colors.length;
  const content = swatches(colors);
  const output = render({ content, bounds: { x: 0, y: 0, width, height: 1 }, parameters, time: 0, progress: 0,
    helpers: { id: (kind) => `${kind}-${++sequence}`, defs, luts } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1" viewBox="0 0 ${width} 1"><defs>${defs.join("")}</defs>${output}</svg>`;
  const pixels = await rasterize(svg, width);
  return { svg, output, content, pixels: colors.map((_, x) => [...pixels.subarray(x * 4, x * 4 + 4)]) };
}

// Every 8-bit level of each channel on its own, greys, and a spread of mixed colours.
function testColors() {
  const colors = [];
  for (let value = 0; value <= 255; value += 15) colors.push([value, 0, 0], [0, value, 0], [0, 0, value], [value, value, value]);
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 85) for (let b = 0; b <= 255; b += 85) colors.push([r, g, b]);
  colors.push([232, 183, 150], [198, 134, 66], [141, 85, 36], [106, 142, 194]);
  return colors;
}

function maxDifference(actual, expected) {
  let largest = 0;
  actual.forEach((pixel, index) => {
    for (let channel = 0; channel < 3; channel += 1) largest = Math.max(largest, Math.abs(pixel[channel] - expected[index][channel]));
  });
  return largest;
}

const toUnit = (rgb) => rgb.map((value) => value / 255);
const toByte = (rgb) => rgb.map((value) => Math.round(value * 255));

test("curves: an identity curve changes nothing, curves stay monotone and pass through their points", async () => {
  const colors = testColors();
  // Identity curves, also with extra points on the diagonal, are no filter at all.
  const identity = await draw(renderCurves, effectDefaults("curves"), colors);
  assert.equal(identity.output, identity.content);
  const straight = [[0, 0], [0.3, 0.3], [0.7, 0.7], [1, 1]];
  assert.equal((await draw(renderCurves, { ...effectDefaults("curves"), master: straight }, colors)).output, swatches(colors));
  // A curve that only just bends goes through the filter and stays within 1/255 of the maths.
  const points = [[0, 0.05], [0.2, 0.1], [0.5, 0.55], [0.8, 0.95], [1, 1]];
  const parameters = { ...effectDefaults("curves"), master: points, blue: [[0, 0], [0.5, 0.45], [1, 1]] };
  const drawn = await draw(renderCurves, parameters, colors);
  assert.ok(drawn.svg.includes("<filter"));
  const tables = curvesTables(parameters);
  const expected = colors.map((rgb) => rgb.map((value, channel) => Math.round(tables[channel][value] * 255)));
  assert.ok(maxDifference(drawn.pixels, expected) <= 1, `curves are off by ${maxDifference(drawn.pixels, expected)}/255`);

  const curve = curveFunction(points);
  for (const [input, output] of points) assert.ok(Math.abs(curve(input) - output) < 1e-9, `passes through ${input}`);
  let previous = -Infinity;
  for (let index = 0; index <= 1000; index += 1) {
    const value = curve(index / 1000);
    assert.ok(value >= previous - 1e-12 && value >= 0 && value <= 1, "monotone points give a monotone curve inside 0..1");
    previous = value;
  }
  // Strength 0.5 is halfway between the original and the curve.
  const [red] = curvesTables({ master: points, red: IDENTITY_CURVE }, 0.5);
  assert.ok(Math.abs(red[128] - (128 / 255 + curve(128 / 255)) / 2) < 1e-9);
  assert.throws(() => normalizeCurve([[0.5, 0], [0.5, 1]]), /increas/);
});

test("a .cube file is parsed by the Cube LUT 1.0 rules and refused with the line that is wrong", () => {
  const lut = parseCubeLut('# made in a test\nTITLE "Swap"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\nLUT_3D_SIZE 2\n' +
    "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  assert.deepEqual([lut.title, lut.type, lut.size, lut.table.length], ["Swap", "3d", 2, 24]);
  const oneD = parseCubeLut("LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n0.5 0.5 0.5\n1 1 1\n");
  assert.deepEqual([oneD.type, oneD.domainMax], ["1d", [2, 2, 2]]);
  assert.deepEqual(sampleLut(oneD, [1, 2, 0.5]).map((value) => Number(value.toFixed(6))), [0.5, 1, 0.25], "inputs are read through the domain");

  const refusals = [
    ["LUT_3D_SIZE 2\n0 0 0\n", /needs 8 table lines, but the file has 1/],
    ["LUT_3D_SIZE 66\n", /from 2 to 65/],
    ["LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n", /line 2 gives a second LUT size/],
    ["LUT_3D_SIZE 2\nGAMMA 2.2\n", /line 2 has the keyword GAMMA/],
    ["0 0 0\n", /line 1 has table numbers before/],
    ["LUT_1D_SIZE 2\n0 0 0\nTITLE \"late\"\n1 1 1\n", /line 3 has the keyword TITLE after the table started/],
    ["LUT_1D_SIZE 2\n0 0\n1 1 1\n", /line 2 .*three numbers/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 1\n1 1 1\n", /line 4 is one table line too many/],
    ["DOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 0 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n", /DOMAIN_MAX value must be larger/],
    ["LUT_1D_SIZE 2\n0 0 0\n1 1 1\0", /binary data/],
    ["TITLE unquoted\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n", /double quotes/],
    ["# only a comment\n", /no LUT_1D_SIZE or LUT_3D_SIZE/],
  ];
  for (const [text, message] of refusals) assert.throws(() => parseCubeLut(text), message, JSON.stringify(text));
});

test("lut: an identity LUT changes nothing within 1/255, and an inverting LUT inverts", async () => {
  const colors = testColors();
  for (const [type, size] of [["3d", 17], ["3d", 33], ["1d", 1024]]) {
    const identity = parseCubeLut(cubeText({ size, type, color: (r, g, b) => [r, g, b] }));
    assert.equal(lutIsSeparable(identity), true);
    const drawn = await draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, identity]]));
    assert.ok(maxDifference(drawn.pixels, colors) <= 1, `${type} identity of size ${size} moved a pixel by ${maxDifference(drawn.pixels, colors)}`);
  }
  const invert = parseCubeLut(cubeText({ size: 17, color: (r, g, b) => [1 - r, 1 - g, 1 - b] }));
  const inverted = await draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, invert]]));
  assert.ok(maxDifference(inverted.pixels, colors.map((rgb) => rgb.map((value) => 255 - value))) <= 1);
  // Strength 0 leaves the layer as it is; strength 0.5 is halfway.
  assert.equal((await draw(renderLut, { lut: LUT_SOURCE, strength: 0 }, colors, new Map([[LUT_SOURCE, invert]]))).output, swatches(colors));
  const half = await draw(renderLut, { lut: LUT_SOURCE, strength: 0.5 }, [[0, 0, 0], [255, 255, 255]], new Map([[LUT_SOURCE, invert]]));
  for (const pixel of half.pixels) for (const value of pixel.slice(0, 3)) assert.ok(Math.abs(value - 127.5) <= 1);
});

test("lut: a 3D LUT that swaps channels gives the expected pixels through the 3D construction", async () => {
  const colors = testColors();
  // Red out = green in, green out = blue in, blue out = red in: no channel depends on itself only.
  const swap = parseCubeLut(cubeText({ size: 17, color: (r, g, b) => [g, b, r] }));
  assert.equal(lutIsSeparable(swap), false);
  const drawn = await draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, swap]]));
  const expected = colors.map(([r, g, b]) => [g, b, r]);
  const difference = maxDifference(drawn.pixels, expected);
  assert.ok(difference <= 3, `swap LUT is off by ${difference}/255`);
  // A curved, cross-channel look matches exact trilinear interpolation of the file within 3/255
  // (the 3D construction adds 8-bit steps; about half a level on average).
  const look = parseCubeLut(cubeText({ size: 9, color: (r, g, b) => [0.8 * r + 0.2 * luma([r, g, b]), g ** 1.2, 0.7 * b + 0.2 * (1 - r)] }));
  const graded = await draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, look]]));
  const reference = colors.map((rgb) => toByte(sampleLut(look, toUnit(rgb))));
  assert.ok(maxDifference(graded.pixels, reference) <= 3, `look LUT is off by ${maxDifference(graded.pixels, reference)}/255`);
  for (const pixel of graded.pixels) assert.equal(pixel[3], 255);
});

test("lut: a LUT that is still loading leaves the layer alone; a missing or broken one is a clear error", async () => {
  const colors = [[10, 20, 30]];
  assert.equal((await draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, null]]))).output, swatches(colors));
  await assert.rejects(draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map()), /was not loaded/);
  await assert.rejects(draw(renderLut, { lut: LUT_SOURCE, strength: 1 }, colors, new Map([[LUT_SOURCE, { error: "broken file" }]])), /broken file/);
  await assert.rejects(draw(renderLut, { lut: null, strength: 1 }, colors, new Map()), /needs parameters\.lut/);
});

test("hue-saturation: 120° turns red into green, greys stay grey, and colorize tints by brightness", async () => {
  assert.deepEqual(applyMatrix(hueRotationMatrix(120), [1, 0, 0]).map((value) => Number(value.toFixed(12))), [0, 1, 0]);
  assert.deepEqual(applyMatrix(hueRotationMatrix(240), [1, 0, 0]).map((value) => Number(value.toFixed(12))), [0, 0, 1]);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128], [191, 0, 0]];
  const turned = await draw(renderHueSaturation, { ...effectDefaults("hue-saturation"), hue: 120 }, colors);
  assert.ok(maxDifference(turned.pixels, [[0, 255, 0], [0, 0, 255], [255, 0, 0], [128, 128, 128], [0, 191, 0]]) <= 1);
  // A full turn is the identity, so a hue cycle ends where it started.
  const full = await draw(renderHueSaturation, { ...effectDefaults("hue-saturation"), hue: 360 }, testColors());
  assert.ok(maxDifference(full.pixels, testColors()) <= 1);
  // Saturation 0 gives the Rec.709 luma grey.
  const grey = await draw(renderHueSaturation, { ...effectDefaults("hue-saturation"), saturation: 0 }, [[255, 0, 0]]);
  for (const value of grey.pixels[0].slice(0, 3)) assert.ok(Math.abs(value - 255 * 0.2126) <= 1);
  // Lightness +1 is white and -1 black.
  assert.deepEqual(applyMatrix(hueSaturationMatrix({ lightness: 1 }), [0.2, 0.4, 0.6]), [1, 1, 1]);
  assert.deepEqual(applyMatrix(hueSaturationMatrix({ lightness: -1 }), [0.2, 0.4, 0.6]), [0, 0, 0]);
  // Colorize: every colour takes the tint's hue; black stays black and white stays white.
  const tinted = await draw(renderHueSaturation, { ...effectDefaults("hue-saturation"), colorize: true, tint: "#3366CC" }, [[0, 0, 0], [255, 255, 255], [0, 255, 0]]);
  assert.ok(maxDifference([tinted.pixels[0], tinted.pixels[1]], [[0, 0, 0], [255, 255, 255]]) <= 1);
  assert.ok(Math.abs(hueAngle(toUnit(tinted.pixels[2])) - hueAngle([0.2, 0.4, 0.8])) < 4, "a green pixel takes the blue tint's hue");
});

test("white-balance: zero is no change, warmer raises red against blue, and grey keeps its brightness", async () => {
  assert.deepEqual(whiteBalanceGains(0, 0), [1, 1, 1]);
  const identity = await draw(renderWhiteBalance, effectDefaults("white-balance"), testColors());
  assert.equal(identity.output, identity.content);
  const [red, green, blue] = whiteBalanceGains(60, 0);
  assert.ok(red > 1 && blue < 1, "temperature + warms");
  assert.ok(Math.abs(0.2126 * red + 0.7152 * green + 0.0722 * blue - 1) < 1e-12, "linear-light luminance of grey is kept");
  const [, magenta] = whiteBalanceGains(0, 60);
  assert.ok(magenta < 1, "tint + lowers green (magenta)");
  const warm = (await draw(renderWhiteBalance, { temperature: 60, tint: 0 }, [[128, 128, 128]])).pixels[0];
  assert.ok(warm[0] > 128 && warm[2] < 128, `a warm grey is ${warm}`);
  const tables = whiteBalanceTables(60, 0);
  assert.ok(Math.abs(tables[0][128] * 255 - warm[0]) <= 1 && Math.abs(tables[2][128] * 255 - warm[2]) <= 1);
});

test("color-wheels: lift 0, gamma 1, gain 1 changes nothing; each wheel moves the part of the range it should", async () => {
  for (let index = 0; index <= 255; index += 1) assert.equal(liftGammaGain(index / 255), index / 255);
  const identity = await draw(renderColorWheels, effectDefaults("color-wheels"), testColors());
  assert.equal(identity.output, identity.content, "the identity wheels are no filter");
  const tables = colorWheelTables(effectDefaults("color-wheels"));
  for (const table of tables) table.forEach((value, index) => assert.ok(Math.abs(value - index / 255) < 1e-12));
  // Lift raises black and keeps white; gain scales white and keeps black; gamma keeps both ends.
  assert.equal(liftGammaGain(0, 0.1), 0.1);
  assert.equal(liftGammaGain(1, 0.1), 1);
  assert.equal(liftGammaGain(0, 0, 1, 0.8), 0);
  assert.equal(liftGammaGain(1, 0, 1, 0.8), 0.8);
  assert.equal(liftGammaGain(0, 0, 2), 0);
  assert.equal(liftGammaGain(1, 0, 2), 1);
  assert.ok(liftGammaGain(0.5, 0, 2) > 0.5, "gamma above 1 brightens the middle");
  // Blue lift: teal shadows, untouched whites.
  const teal = (await draw(renderColorWheels, { ...effectDefaults("color-wheels"), liftBlue: 0.1 }, [[0, 0, 0], [255, 255, 255]])).pixels;
  assert.ok(Math.abs(teal[0][2] - 25.5) <= 1 && teal[0][0] === 0, `teal black is ${teal[0]}`);
  assert.deepEqual(teal[1].slice(0, 3), [255, 255, 255]);
});

test("keep-color keeps the target hue and greys the others", async () => {
  const parameters = { ...effectDefaults("keep-color"), targetColor: "#FF0000", hueRange: 25, softness: 15, amount: 1 };
  const colors = [[255, 0, 0], [191, 20, 30], [0, 200, 0], [0, 0, 255], [0, 200, 200], [255, 255, 0], [128, 128, 128], [0, 0, 0], [255, 255, 255]];
  const drawn = await draw(renderKeepColor, parameters, colors);
  const expected = colors.map((rgb) => toByte(keepColor(toUnit(rgb), parameters)));
  assert.ok(maxDifference(drawn.pixels, expected) <= 3, `keep-color is off by ${maxDifference(drawn.pixels, expected)}/255`);
  assert.ok(maxDifference(drawn.pixels.slice(0, 2), colors.slice(0, 2)) <= 3, "reds are kept");
  for (const pixel of drawn.pixels.slice(2)) assert.ok(Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)) <= 3, `${pixel} is grey`);
  for (const [index, rgb] of colors.slice(2).entries()) {
    const grey = Math.round(luma(toUnit(rgb)) * 255);
    assert.ok(Math.abs(drawn.pixels[index + 2][1] - grey) <= 3, `${rgb} becomes its luma ${grey}`);
  }
  // The edge of the range is soft: an orange 30° away is partly kept, a yellow 60° away is not.
  assert.equal(keepColorMask([1, 0, 0], parameters), 1);
  assert.ok(Math.abs(hueAngle([1, 0.5, 0]) - 30) < 1e-9);
  const orange = keepColorMask([1, 0.5, 0], parameters);
  assert.ok(orange > 0 && orange < 1, `orange mask ${orange}`);
  assert.equal(keepColorMask([1, 1, 0], parameters), 0);
  assert.equal(keepColorMask([0.5, 0.5, 0.5], parameters), 0, "greys have no hue to keep");
  assert.ok(KEEP_COLOR_FLOOR > 0 && KEEP_COLOR_FLOOR < 0.05);
  // Amount 0 keeps everything.
  const none = await draw(renderKeepColor, { ...parameters, amount: 0 }, colors);
  assert.equal(none.output, none.content);
});

test("the Color filters keep transparency: half-transparent pixels stay half transparent", async () => {
  const content = '<rect width="2" height="1" fill="#C86432" fill-opacity="0.5"/>';
  const lut = parseCubeLut(cubeText({ size: 9, color: (r, g, b) => [g, b, r] }));
  const cases = [
    [renderCurves, { ...effectDefaults("curves"), master: [[0, 0.1], [1, 0.9]] }],
    [renderLut, { lut: LUT_SOURCE, strength: 1 }],
    [renderHueSaturation, { ...effectDefaults("hue-saturation"), hue: 90 }],
    [renderWhiteBalance, { temperature: 50, tint: 10 }],
    [renderColorWheels, { ...effectDefaults("color-wheels"), lift: 0.1 }],
    [renderKeepColor, effectDefaults("keep-color")],
  ];
  for (const [render, parameters] of cases) {
    const defs = [];
    let sequence = 0;
    const output = render({ content, bounds: { x: 0, y: 0, width: 2, height: 1 }, parameters, time: 0, progress: 0,
      helpers: { id: (kind) => `${kind}-${++sequence}`, defs, luts: new Map([[LUT_SOURCE, lut]]) } });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><defs>${defs.join("")}</defs>${output}</svg>`;
    const pixels = await rasterize(svg, 2);
    assert.ok(Math.abs(pixels[3] - 128) <= 1, `${render.name} alpha ${pixels[3]}`);
  }
});
