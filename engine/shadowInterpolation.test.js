// The pure rules of a Shadow animation: mixing two drop shadows, "no shadow" ends, the opacity
// helpers behind the Inspector's fields, and the preset's From and To.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHADOW,
  SHADOW_LIMITS,
  copyShadow,
  interpolateShadow,
  shadowPresetValues,
  transparentShadow,
} from "./shadowInterpolation.js";

const RED = { color: "#ff0000", x: 0, y: 4, blur: 10 };
const BLUE = { color: "#0000ff80", x: 20, y: -8, blur: 30 };

test("two shadows mix color, alpha, x, y and blur in a straight line", () => {
  assert.deepEqual(interpolateShadow(RED, BLUE, 0.5), { color: "#800080c0", x: 10, y: -2, blur: 20 });
  assert.deepEqual(interpolateShadow(RED, BLUE, 0.25), { color: "#bf0040df", x: 5, y: 1, blur: 15 });
  assert.deepEqual(interpolateShadow(RED, { ...RED, color: "#00ff00" }, 0.5).color, "#808000", "no alpha stays #rrggbb");
});

test("the ends are exact copies of From and To", () => {
  const start = interpolateShadow(RED, BLUE, 0);
  assert.deepEqual(start, RED);
  assert.notEqual(start, RED, "a copy, so evaluation never shares the stored object");
  assert.deepEqual(interpolateShadow(RED, BLUE, 1), BLUE);
  assert.deepEqual(interpolateShadow({ ...RED, extra: 1 }, BLUE, 0), RED, "only the four parts are kept");
});

test("no shadow at one end is the other shadow with zero alpha, so it fades in place", () => {
  assert.equal(interpolateShadow(null, RED, 0), null, "exactly no shadow before it starts");
  assert.deepEqual(interpolateShadow(null, RED, 0.5), { color: "#ff000080", x: 0, y: 4, blur: 10 });
  assert.deepEqual(interpolateShadow(null, RED, 1), RED);
  assert.deepEqual(interpolateShadow(BLUE, null, 0.5), { color: "#0000ff40", x: 20, y: -8, blur: 30 });
  assert.equal(interpolateShadow(BLUE, null, 1), null, "exactly no shadow at the end");
  assert.deepEqual(transparentShadow(RED), { color: "#ff000000", x: 0, y: 4, blur: 10 });
  assert.deepEqual(transparentShadow(BLUE), { color: "#0000ff00", x: 20, y: -8, blur: 30 });
});

test("no shadow at both ends draws no shadow at any time", () => {
  for (const progress of [0, 0.3, 1, 1.2]) assert.equal(interpolateShadow(null, null, progress), null);
  assert.equal(interpolateShadow(undefined, "not a shadow", 0.5), null);
});

test("overshooting easings extrapolate the offsets but keep blur and color in range", () => {
  const past = interpolateShadow({ color: "#000000", x: 0, y: 0, blur: 0 }, { color: "#ffffff", x: 10, y: 10, blur: 4 }, 1.25);
  assert.deepEqual(past, { color: "#ffffff", x: 12.5, y: 12.5, blur: 5 });
  const before = interpolateShadow({ color: "#000000", x: 0, y: 0, blur: 0 }, { color: "#ffffff", x: 10, y: 10, blur: 4 }, -0.25);
  assert.deepEqual(before, { color: "#000000", x: -2.5, y: -2.5, blur: 0 });
});

test("a color that is not hex is kept until the end instead of mixing", () => {
  const older = { color: "rgba(0, 0, 0, 0.5)", x: 0, y: 2, blur: 4 };
  assert.equal(interpolateShadow(older, RED, 0.5).color, "rgba(0, 0, 0, 0.5)");
  assert.equal(interpolateShadow(older, RED, 0.5).y, 3, "the numbers still move");
  assert.deepEqual(transparentShadow(older).color, "#00000000");
});

test("copyShadow reads only shadows and never returns a negative blur", () => {
  assert.equal(copyShadow(null), null);
  assert.equal(copyShadow([1, 2]), null);
  assert.equal(copyShadow({ x: 1 }), null);
  assert.deepEqual(copyShadow({ color: "#000", x: "3", y: Number.NaN, blur: -2 }), { color: "#000", x: 0, y: 0, blur: 0 });
});

test("the preset starts at the layer's shadow and lifts it", () => {
  assert.deepEqual(shadowPresetValues(null), { from: null, to: DEFAULT_SHADOW });
  assert.notEqual(shadowPresetValues(null).to, DEFAULT_SHADOW, "a copy of the default");
  assert.deepEqual(shadowPresetValues(BLUE), { from: BLUE, to: { color: "#0000ff80", x: 40, y: -16, blur: 60 } });
  assert.deepEqual(shadowPresetValues({ color: "#ff0000", x: 0, y: 0, blur: 0 }), {
    from: { color: "#ff0000", x: 0, y: 0, blur: 0 },
    to: { color: "#ff0000", x: 0, y: 4, blur: 12 },
  });
});

test("the preset's doubled offset and blur stop at the limits a document can store", () => {
  assert.deepEqual(SHADOW_LIMITS, { offset: 1_000_000, blur: 10_000 });
  assert.deepEqual(shadowPresetValues({ color: "#000000", x: 0, y: 4, blur: 6000 }).to, { color: "#000000", x: 0, y: 8, blur: 10_000 });
  assert.deepEqual(shadowPresetValues({ color: "#000000", x: 500_001, y: -999_999, blur: 5000 }).to, {
    color: "#000000",
    x: 1_000_000,
    y: -1_000_000,
    blur: 10_000,
  });
  assert.deepEqual(shadowPresetValues({ color: "#000000", x: 1_000_000, y: 0, blur: 10_000 }).to, {
    color: "#000000",
    x: 1_000_000,
    y: 0,
    blur: 10_000,
  });
});
