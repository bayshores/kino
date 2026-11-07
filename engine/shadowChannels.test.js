import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SHADOW, interpolateShadow } from "./shadowInterpolation.js";
import { SHADOW_CHANNELS, interpolateShadowChannels, normalizeShadowChannels } from "./shadowChannels.js";

const RED = { color: "#ff000080", x: 10, y: 20, blur: 30 };
const BLUE = { color: "#0000ff40", x: 50, y: 60, blur: 70 };

test("shadow channel masks normalize to the canonical order and reject malformed values", () => {
  assert.deepEqual(SHADOW_CHANNELS, ["color", "opacity", "x", "y", "blur"]);
  assert.ok(Object.isFrozen(SHADOW_CHANNELS));
  assert.equal(normalizeShadowChannels(undefined), null);
  assert.equal(normalizeShadowChannels(null), null);
  assert.deepEqual(normalizeShadowChannels(["blur", "x", "color"]), ["color", "x", "blur"]);
  for (const invalid of ["x", 4, {}, [], ["x", "x"], ["unknown"], ["opacity", null]])
    assert.throws(() => normalizeShadowChannels(invalid));
});

test("partial tracks compose independent geometry and color channels without mutating inputs", () => {
  const current = { color: "#33669980", x: 1, y: 2, blur: 3, ignored: true };
  const before = structuredClone(current);
  const result = interpolateShadowChannels(current, RED, BLUE, 0.5, ["x", "color"]);
  assert.deepEqual(result, { color: "#80008080", x: 30, y: 2, blur: 3 });
  assert.deepEqual(current, before);
  assert.deepEqual(RED, { color: "#ff000080", x: 10, y: 20, blur: 30 });
  assert.deepEqual(BLUE, { color: "#0000ff40", x: 50, y: 60, blur: 70 });
});

test("RGB and opacity can be animated separately", () => {
  const current = { color: "#11223340", x: 7, y: 8, blur: 9 };
  const colorOnly = interpolateShadowChannels(current, RED, BLUE, 0.5, ["color"]);
  assert.deepEqual(colorOnly, { color: "#80008040", x: 7, y: 8, blur: 9 }, "RGB changes while current alpha remains");

  const opacityOnly = interpolateShadowChannels(current,
    { ...RED, color: "#ff000000" }, { ...BLUE, color: "#0000ffcc" }, 0.5, ["opacity"]);
  assert.deepEqual(opacityOnly, { color: "#11223366", x: 7, y: 8, blur: 9 }, "alpha changes while current RGB remains");
});

test("one null endpoint supplies transparent geometry and RGB at its endpoint", () => {
  const current = { color: "#123456cc", x: 1, y: 2, blur: 3 };
  const appearing = interpolateShadowChannels(current, null, RED, 0, ["x", "opacity"]);
  assert.deepEqual(appearing, { color: "#12345600", x: RED.x, y: 2, blur: 3 });
  const halfway = interpolateShadowChannels(current, null, RED, 0.5, ["x", "opacity"]);
  assert.deepEqual(halfway, { color: "#12345640", x: RED.x, y: 2, blur: 3 });
  const disappearing = interpolateShadowChannels(current, BLUE, null, 1, ["y", "opacity"]);
  assert.deepEqual(disappearing, { color: "#12345600", x: 1, y: BLUE.y, blur: 3 });
});

test("two null endpoints preserve unselected values and keep absent opacity tracks transparent", () => {
  const current = { color: "#abcdef80", x: 3, y: 4, blur: 5 };
  assert.deepEqual(interpolateShadowChannels(current, null, null, 0.6, ["x", "blur"]), current);
  assert.deepEqual(interpolateShadowChannels(null, null, null, 0.6, ["x", "blur"]), null);
  assert.deepEqual(interpolateShadowChannels(current, null, null, 0.6, ["opacity"]), {
    color: "#abcdef00", x: 3, y: 4, blur: 5,
  });
  assert.equal(interpolateShadowChannels(null, null, null, 0.6, ["opacity"]), null);
  assert.equal(interpolateShadowChannels(null, null, null, 0.6, ["color", "opacity"]), null);
});

test("transparent geometry survives a geometry track for a later opacity track", () => {
  const geometry = interpolateShadowChannels(null, null, { ...RED, x: 24, y: 32, blur: 18 }, 0.5, ["x"]);
  assert.deepEqual(geometry, { color: "#00000000", x: 24, y: DEFAULT_SHADOW.y, blur: DEFAULT_SHADOW.blur });

  const opacity = interpolateShadowChannels(geometry, null, RED, 0.5, ["opacity"]);
  assert.deepEqual(opacity, { color: "#00000040", x: 24, y: DEFAULT_SHADOW.y, blur: DEFAULT_SHADOW.blur });
});

test("omitted and full channel masks exactly preserve legacy whole-shadow interpolation", () => {
  const cases = [
    [RED, BLUE],
    [null, RED],
    [BLUE, null],
    [null, null],
  ];
  for (const [from, to] of cases) {
    for (const progress of [0, 0.25, 1, 1.2]) {
      const expected = interpolateShadow(from, to, progress);
      assert.deepEqual(interpolateShadowChannels({ color: "#12345678", x: 2, y: 3, blur: 4 }, from, to, progress), expected);
      assert.deepEqual(interpolateShadowChannels(null, from, to, progress, [...SHADOW_CHANNELS].reverse()), expected);
    }
  }
});

test("partial channels preserve overshoot in geometry while shadow color stays clamped", () => {
  const current = { color: "#12345680", x: 0, y: 3, blur: 2 };
  const result = interpolateShadowChannels(current,
    { color: "#00000000", x: 0, y: 0, blur: 1 },
    { color: "#ffffff80", x: 10, y: 10, blur: 0 },
    1.5,
    ["x", "blur", "opacity"]);
  assert.deepEqual(result, { color: "#123456c0", x: 15, y: 3, blur: 0 });
});
