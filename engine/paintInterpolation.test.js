// Every pair of paints mixed by a Color (fill) or Stroke animation, at the start, middle and end.
import test from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  contrastingColor,
  contrastingPaint,
  interpolatePaint,
  isGradientPaint,
  isSolidPaint,
  mixHexColor,
  parseHexColor,
  resampleGradient,
  solidAsGradient,
  unionOffsets,
} from "./paintInterpolation.js";

const linear = (angle, ...stops) => ({ type: "linear", angle, stops: stops.map(([offset, color]) => ({ offset, color })) });
const radial = (...stops) => ({ type: "radial", angle: 0, stops: stops.map(([offset, color]) => ({ offset, color })) });

const RED_TO_BLUE = linear(0, [0, "#ff0000"], [1, "#0000ff"]);
const WHITE_TO_BLACK = radial([0, "#ffffff"], [1, "#000000"]);

test("solid to solid mixes red, green, blue and alpha in a straight line", () => {
  assert.equal(interpolatePaint("#000000", "#ffffff", 0), "#000000");
  assert.equal(interpolatePaint("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(interpolatePaint("#000000", "#ffffff", 1), "#ffffff");
  // Alpha is written when either color has it; channels are not premultiplied.
  assert.equal(interpolatePaint("#ff000080", "#0000ff", 0), "#ff000080");
  assert.equal(interpolatePaint("#ff000080", "#0000ff", 0.5), "#800080c0");
  assert.equal(interpolatePaint("#ff000080", "#0000ff", 1), "#0000ffff");
  // Short hex forms are expanded first.
  assert.equal(interpolatePaint("#000", "#fff", 0.5), "#808080");
});

test("solid to linear gradient: the solid acts as a gradient of the other paint's geometry", () => {
  assert.equal(interpolatePaint("#00ff00", RED_TO_BLUE, 0), "#00ff00");
  assert.deepEqual(interpolatePaint("#00ff00", RED_TO_BLUE, 0.5), linear(0, [0, "#808000"], [1, "#008080"]));
  assert.deepEqual(interpolatePaint("#00ff00", RED_TO_BLUE, 1), RED_TO_BLUE);
  assert.notEqual(interpolatePaint("#00ff00", RED_TO_BLUE, 1), RED_TO_BLUE, "the end is a copy, not the stored object");
});

test("linear gradient to solid mixes every stop toward the solid", () => {
  assert.deepEqual(interpolatePaint(RED_TO_BLUE, "#00ff00", 0), RED_TO_BLUE);
  assert.deepEqual(interpolatePaint(RED_TO_BLUE, "#00ff00", 0.5), linear(0, [0, "#808000"], [1, "#008080"]));
  assert.equal(interpolatePaint(RED_TO_BLUE, "#00ff00", 1), "#00ff00");
});

test("solid to radial gradient and back", () => {
  assert.equal(interpolatePaint("#000000", WHITE_TO_BLACK, 0), "#000000");
  assert.deepEqual(interpolatePaint("#000000", WHITE_TO_BLACK, 0.5), radial([0, "#808080"], [1, "#000000"]));
  assert.deepEqual(interpolatePaint("#000000", WHITE_TO_BLACK, 1), WHITE_TO_BLACK);
  assert.deepEqual(interpolatePaint(WHITE_TO_BLACK, "#000000", 0), WHITE_TO_BLACK);
  assert.deepEqual(interpolatePaint(WHITE_TO_BLACK, "#000000", 0.5), radial([0, "#808080"], [1, "#000000"]));
  assert.equal(interpolatePaint(WHITE_TO_BLACK, "#000000", 1), "#000000");
});

test("two gradients of one type with the same stop count mix stop by stop, with their angle", () => {
  const from = linear(0, [0, "#000000"], [0.25, "#ff0000"], [1, "#ffffff"]);
  const to = linear(90, [0, "#000000"], [0.75, "#00ff00"], [1, "#ffffff"]);
  assert.deepEqual(interpolatePaint(from, to, 0), from);
  assert.deepEqual(interpolatePaint(from, to, 0.5), linear(45, [0, "#000000"], [0.5, "#808000"], [1, "#ffffff"]));
  assert.deepEqual(interpolatePaint(from, to, 1), to);
});

test("linear to radial mixes the stops and switches type halfway, keeping the linear angle", () => {
  const from = linear(45, [0, "#ff0000"], [1, "#0000ff"]);
  assert.deepEqual(interpolatePaint(from, WHITE_TO_BLACK, 0), from);
  assert.equal(interpolatePaint(from, WHITE_TO_BLACK, 0.49).type, "linear");
  assert.deepEqual(interpolatePaint(from, WHITE_TO_BLACK, 0.5), { type: "radial", angle: 45, stops: [{ offset: 0, color: "#ff8080" }, { offset: 1, color: "#000080" }] });
  assert.deepEqual(interpolatePaint(from, WHITE_TO_BLACK, 1), WHITE_TO_BLACK);

  assert.deepEqual(interpolatePaint(WHITE_TO_BLACK, from, 0), WHITE_TO_BLACK);
  assert.equal(interpolatePaint(WHITE_TO_BLACK, from, 0.49).type, "radial");
  assert.deepEqual(interpolatePaint(WHITE_TO_BLACK, from, 0.5), { type: "linear", angle: 45, stops: [{ offset: 0, color: "#ff8080" }, { offset: 1, color: "#000080" }] });
  assert.deepEqual(interpolatePaint(WHITE_TO_BLACK, from, 1), from);
});

test("gradients with different stop counts are resampled at the union of their offsets", () => {
  const from = linear(0, [0, "#000000"], [1, "#ffffff"]);
  const to = linear(90, [0, "#ff0000"], [0.5, "#00ff00"], [1, "#0000ff"]);
  assert.deepEqual(interpolatePaint(from, to, 0), from);
  // `from` read at 0.5 is the gray 127.5; the middle stop mixes that with green.
  assert.deepEqual(interpolatePaint(from, to, 0.5), linear(45, [0, "#800000"], [0.5, "#40bf40"], [1, "#8080ff"]));
  assert.deepEqual(interpolatePaint(from, to, 1), to);
  // Just after the start it already has three stops and still looks like `from` (its middle stop
  // is the gray 127.5, written as 7f or 80 by rounding).
  const start = interpolatePaint(from, to, 1e-9).stops;
  assert.deepEqual(start.map(({ offset }) => offset), [0, 0.5, 1]);
  assert.deepEqual([start[0].color, start[2].color], ["#000000", "#ffffff"]);
  assert.match(start[1].color, /^#(?:7f|80){3}$/);
});

test("different stop counts keep a hard edge (two stops at one offset) a hard edge", () => {
  const edge = linear(0, [0, "#ff0000"], [0.5, "#ff0000"], [0.5, "#0000ff"], [1, "#0000ff"]);
  const smooth = linear(0, [0, "#000000"], [1, "#ffffff"]);
  const middle = interpolatePaint(edge, smooth, 0.5);
  assert.deepEqual(middle.stops.map(({ offset, color }) => [offset, color]), [
    [0, "#800000"], [0.5, "#bf4040"], [0.5, "#4040bf"], [1, "#8080ff"],
  ]);
  assert.deepEqual(interpolatePaint(edge, smooth, 0), edge);
  assert.deepEqual(interpolatePaint(edge, smooth, 1), smooth);
});

test("gradient stop alpha mixes with the same straight line", () => {
  const faded = linear(0, [0, "#ff000080"], [1, "#0000ff"]);
  assert.deepEqual(interpolatePaint(faded, "#00000000", 0.5), linear(0, [0, "#80000040"], [1, "#00008080"]));
  assert.deepEqual(interpolatePaint("#00000000", faded, 0), "#00000000");
  assert.deepEqual(interpolatePaint("#00000000", faded, 1), faded);
});

test("overshooting easings clamp colors to 0..255 and keep stop offsets in 0..1 and in order", () => {
  assert.equal(interpolatePaint("#000000", "#808080", 1.5), "#c0c0c0");
  assert.equal(interpolatePaint("#ffffff", "#000000", -0.5), "#ffffff");
  const from = linear(0, [0, "#000000"], [0.2, "#808080"], [1, "#ffffff"]);
  const to = linear(0, [0, "#000000"], [0.8, "#808080"], [1, "#ffffff"]);
  assert.deepEqual(interpolatePaint(from, to, 1.5).stops.map((stop) => stop.offset), [0, 1, 1]);
  assert.deepEqual(interpolatePaint(from, to, -0.5).stops.map((stop) => stop.offset), [0, 0, 1]);
});

test("values that are not paints do not mix: the From value stays until the end", () => {
  assert.equal(interpolatePaint("none", "#ff0000", 0.5), "none");
  assert.equal(interpolatePaint("none", "#ff0000", 1), "#ff0000");
  const broken = { type: "conic", stops: [] };
  assert.deepEqual(interpolatePaint(RED_TO_BLUE, broken, 0.5), RED_TO_BLUE);
  assert.deepEqual(interpolatePaint(RED_TO_BLUE, broken, 1), broken);
});

test("paint helpers: kinds, union offsets, resampling and solid gradients", () => {
  assert.equal(isSolidPaint("#abc"), true);
  assert.equal(isSolidPaint("red"), false);
  assert.equal(isGradientPaint(RED_TO_BLUE), true);
  assert.equal(isGradientPaint(linear(0, [0, "#000000"])), false, "one stop is not a gradient");
  assert.equal(mixHexColor("#000000", "nope", 0.5), null);
  assert.deepEqual(unionOffsets([0, 0.5, 0.5, 1], [0, 0.25, 1]), [0, 0.25, 0.5, 0.5, 1]);
  assert.deepEqual(resampleGradient(RED_TO_BLUE, [0, 0.5, 1]), linear(0, [0, "#ff0000"], [0.5, "#800080"], [1, "#0000ff"]));
  assert.deepEqual(resampleGradient(linear(0, [0.25, "#ff0000"], [0.75, "#0000ff"]), [0, 1]), linear(0, [0, "#ff0000"], [1, "#0000ff"]),
    "before the first and after the last stop the color is that stop's");
  assert.deepEqual(solidAsGradient("#123456", WHITE_TO_BLACK), radial([0, "#123456"], [1, "#123456"]));
});

test("contrastingColor turns a colorful hue around and moves a gray's lightness, keeping alpha", () => {
  assert.equal(contrastingColor("#ff0000"), "#00ffff");
  assert.equal(contrastingColor("#ff000080"), "#00ffff80");
  assert.equal(contrastingColor("#000000"), "#595959");
  assert.equal(contrastingColor("#ffffff"), "#a6a6a6");
  assert.equal(contrastingColor("not a color"), "#ff6b3d");
  assert.deepEqual(contrastingPaint(RED_TO_BLUE), linear(0, [0, "#00ffff"], [1, "#ffff00"]));
  assert.equal(contrastingPaint(undefined), "#595959", "a missing fill counts as black");
});

// "Visibly different": the brightness differs (a WCAG contrast ratio of at least 1.5) or the hue
// turned enough that some channel moved at least half its range.
function assertVisiblyDifferent(from, to) {
  const a = parseHexColor(from).rgba;
  const b = parseHexColor(to).rgba;
  const channelMove = Math.max(...[0, 1, 2].map((index) => Math.abs(a[index] - b[index])));
  assert.ok(contrastRatio(from, to) >= 1.5 || channelMove >= 128,
    `${from} -> ${to}: contrast ${contrastRatio(from, to).toFixed(2)}, largest channel move ${channelMove}`);
  assert.ok(b[3] >= 64, `${from} -> ${to}: the To color can be seen (alpha ${b[3]})`);
}

test("contrastRatio is the WCAG brightness ratio of two colors", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000"), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert.equal(contrastRatio("#ff000000", "#ff0000"), 1, "alpha is not part of brightness");
  assert.equal(contrastRatio("red", "#000000"), null);
});

test("contrastingColor is visibly different for dark, light and tinted colors too", () => {
  // Nearly gray colors whose HSL saturation is high: a turned hue alone looked the same.
  assert.equal(contrastingColor("#0d1117"), "#666a70", "a dark tinted color gets lighter and keeps its tint");
  assert.equal(contrastingColor("#f8f8ff"), "#9f9fa6", "a light tinted color gets darker and keeps its tint");
  // Dim colors: the hue turns and, because that alone is subtle, the lightness moves as well.
  assert.equal(contrastingColor("#400000"), "#599999");
  // Colorful colors only turn their hue, even when the brightness happens to match.
  assert.equal(contrastingColor("#4ba5e1"), "#e1874b");
  // A (nearly) transparent color turns opaque, so the change can be seen; other alpha is kept.
  assert.equal(contrastingColor("#ff000000"), "#00ffff");
  assert.equal(contrastingColor("#0000"), "#595959");
  assert.equal(contrastingColor("#ff00003f"), "#00ffff");
  assert.equal(contrastingColor("#ff000040"), "#00ffff40");
  assert.equal(contrastingColor("#ff0000ff"), "#00ffffff", "written alpha stays written");
  for (const color of ["#0d1117", "#111827", "#0f172a", "#f8f8ff", "#1a0000", "#400000", "#330000", "#ffccdd", "#ff7000",
    "#4ba5e1", "#808080", "#7f7f7f", "#ff000000", "#00000000", "#ffffff00"])
    assertVisiblyDifferent(color, contrastingColor(color));
  const hex = (value) => value.toString(16).padStart(2, "0");
  for (let red = 0; red < 256; red += 17)
    for (let green = 0; green < 256; green += 17)
      for (let blue = 0; blue < 256; blue += 17) {
        const color = `#${hex(red)}${hex(green)}${hex(blue)}`;
        assertVisiblyDifferent(color, contrastingColor(color));
      }
  // A gradient's stops each follow the same rule.
  assert.deepEqual(contrastingPaint(linear(0, [0, "#0d1117"], [1, "#ff000000"])), linear(0, [0, "#666a70"], [1, "#00ffff"]));
});
