// A Shadow animation in Lottie: the Drop Shadow tracks (lottie-shadow.mjs) and the keyframes a
// real export writes.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "../engine/animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { parseHexColor } from "../engine/paintInterpolation.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { effectPadding } from "./lottie-effects.mjs";
import { lottieShadowTracks } from "./lottie-shadow.mjs";

// Reads a hex color the way export.mjs's colorToRgba does: red, green, blue 0..255 and alpha 0..1.
function hexToRgba(color) {
  const parsed = parseHexColor(color);
  return parsed ? [...parsed.rgba.slice(0, 3), parsed.rgba[3] / 255] : null;
}

const at = (x, y, extra = {}) => ({ color: "#000000", x, y, blur: 4, ...extra });

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: expected ${expected}, received ${actual}`);
}

test("no shadow on any frame writes no Drop Shadow", () => {
  assert.equal(lottieShadowTracks([null, undefined, null], hexToRgba), null);
});

test("a still shadow keeps the existing direction, distance, softness and opacity mapping", () => {
  const tracks = lottieShadowTracks([at(-12, 18, { color: "#3366ff59", blur: 14 })], hexToRgba);
  tracks.color[0].forEach((channel, index) => close(channel, [51 / 255, 102 / 255, 1][index], "shadow RGB"));
  assert.deepEqual(tracks.opacity, [89]);
  close(tracks.direction[0], (Math.atan2(18, -12) * 180) / Math.PI + 90 - 360, "direction");
  close(tracks.distance[0], Math.hypot(-12, 18), "distance");
  assert.deepEqual(tracks.softness, [28]);
  assert.deepEqual(lottieShadowTracks([at(0, 10)], hexToRgba).direction, [180], "straight down is 180");
  assert.deepEqual(lottieShadowTracks([at(10, 0)], hexToRgba).direction, [90], "to the right is 90");
});

test("a direction that passes straight down turns the short way", () => {
  const { direction } = lottieShadowTracks([at(-10, 10), at(0, 10), at(10, 10)], hexToRgba);
  direction.forEach((value, index) => close(value, [-135, -180, -225][index], `frame ${index}`));

  // A shadow that circles the layer once keeps turning in one direction: 90 degrees per frame.
  const circle = [at(10, 0), at(0, 10), at(-10, 0), at(0, -10), at(10, 0), at(0, 10)];
  const turned = lottieShadowTracks(circle, hexToRgba).direction;
  turned.forEach((value, index) => close(value, 90 + 90 * index, `circle frame ${index}`));
  for (let index = 1; index < turned.length; index += 1)
    assert.ok(Math.abs(turned[index] - turned[index - 1]) <= 180, "never more than half a turn between frames");
});

test("frames without a shadow are the nearest shadow with opacity 0", () => {
  const shadow = at(6, 8, { color: "#ff000080", blur: 5 });
  const tracks = lottieShadowTracks([null, null, shadow, null], hexToRgba);
  assert.deepEqual(tracks.opacity, [0, 0, 128, 0]);
  assert.deepEqual(tracks.color, Array(4).fill([1, 0, 0]), "the color does not change while it fades");
  assert.deepEqual(tracks.distance, [10, 10, 10, 10], "the shadow does not slide out from under the layer");
  assert.deepEqual(tracks.softness, [10, 10, 10, 10]);
  const between = lottieShadowTracks([at(0, 10, { blur: 0 }), null, at(10, 0, { blur: 8 })], hexToRgba);
  assert.deepEqual([between.distance[1], between.softness[1], between.opacity[1]], [10, 0, 0], "a tie takes the earlier frame");
});

test("a frame with no offset takes the nearest direction instead of jumping", () => {
  const tracks = lottieShadowTracks([at(0, 0), at(-5, 0), at(-10, 0)], hexToRgba);
  assert.deepEqual(tracks.direction, [-90, -90, -90]);
  assert.deepEqual(tracks.distance, [0, 5, 10]);
  assert.deepEqual(lottieShadowTracks([at(0, 0), at(0, 0)], hexToRgba).direction, [90, 90], "no offset at all stays at 90");
});

test("a shadow color Lottie cannot read is refused", () => {
  assert.throws(() => lottieShadowTracks([at(0, 4, { color: "url(#paint)" })], hexToRgba), /The shadow color cannot be exported to Lottie/);
});

// A real export of one rectangle with a Shadow animation, as the Lottie button writes it.
async function exportShadowAnimation(from, to) {
  const document = parseDocument(createDocument({
    scenes: [createScene({
      id: "main", width: 200, height: 200, duration: 1, background: "#00000000",
      layers: [createLayer("rectangle", {
        id: "card", name: "Card", x: 50, y: 50, width: 100, height: 100, fill: "#ffffff", strokeWidth: 0,
        animations: [{ id: "lift", name: "Shadow", kind: "custom", start: 0, duration: 1, easing: "linear", from: { shadow: from }, to: { shadow: to } }],
      })],
    })],
  }));
  const result = await exportScene(document.scenes[0], { format: "lottie", fps: 4, imageDPIRatio: "original" });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const card = animation.layers.find((layer) => layer.nm === "Card");
  const effect = card?.ef?.find((entry) => entry.ty === 25);
  assert.ok(effect, "the card has a native Drop Shadow effect");
  assert.deepEqual(effect.ef.map((parameter) => parameter.nm), ["Shadow Color", "Opacity", "Direction", "Distance", "Softness"]);
  return { effect, warnings: result.warnings ?? [], card };
}

const values = (property) => (property.a === 1 ? property.k.map((frame) => frame.s[0]) : null);

function channelTrack(id, start, duration, from, to, shadowChannels) {
  return {
    id,
    name: id,
    kind: "in",
    start,
    duration,
    easing: "linear",
    from: { shadow: from },
    to: { shadow: to },
    shadowChannels,
  };
}

function sceneWithIndependentShadowChannels() {
  const base = { color: "#ff000080", x: 4, y: 0, blur: 2 };
  const box = createLayer("rectangle", {
    id: "card",
    name: "Card",
    x: 25,
    y: 30,
    width: 20,
    height: 20,
    fill: "#ffffff",
    strokeWidth: 0,
    shadow: base,
    animations: [
      channelTrack("rgb", 0, 1, base, { ...base, color: "#0000ff80" }, ["color"]),
      channelTrack("opacity", 0.25, 0.75,
        { ...base, color: "#ff000000" }, { ...base, color: "#ff0000ff" }, ["opacity"]),
      channelTrack("xy", 0.25, 1,
        base, { ...base, x: 16, y: 8 }, ["x", "y"]),
      channelTrack("blur", 0.5, 0.5,
        base, { ...base, blur: 10 }, ["blur"]),
    ],
  });
  return parseDocument(createDocument({
    scenes: [createScene({ id: "channels", width: 100, height: 100, duration: 1, background: "#ffffff", layers: [box] })],
  })).scenes[0];
}

async function exportComposedShadowChannels() {
  const result = await exportScene(sceneWithIndependentShadowChannels(), {
    format: "lottie", fps: 4, imageDPIRatio: "original",
  });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const card = animation.layers.find((layer) => layer.nm === "Card");
  const effect = card?.ef?.find((entry) => entry.ty === 25);
  assert.ok(effect, "the card has a native Drop Shadow effect");
  return { animation, warnings: result.warnings ?? [], card, effect };
}

function sceneWithLargeShadow(opacityAnimation = true) {
  const invisible = { color: "#ff000000", x: 400_000, y: 300_000, blur: 10_000 };
  const visible = { ...invisible, color: "#ff0000ff" };
  const box = createLayer("rectangle", {
    id: "large-shadow",
    name: "Large shadow",
    x: 10,
    y: 15,
    width: 20,
    height: 20,
    fill: "#ffffff",
    strokeWidth: 0,
    shadow: invisible,
    animations: opacityAnimation
      ? [channelTrack("reveal-opacity", 0, 1, invisible, visible, ["opacity"])]
      : [],
  });
  return parseDocument(createDocument({
    scenes: [createScene({ id: "large-shadow", width: 60, height: 60, duration: 1, background: "#ffffff", layers: [box] })],
  })).scenes[0];
}

test("a real Lottie export keys a shadow that appears on every frame", async () => {
  const { effect, warnings, card } = await exportShadowAnimation(null, { color: "#3366ff80", x: 0, y: 24, blur: 10 });
  assert.deepEqual(warnings, []);
  const [color, opacity, direction, distance, softness] = effect.ef.map((parameter) => parameter.v);
  assert.deepEqual(values(opacity), [0, 32, 64, 96, 128], "the opacity fades in, one keyframe per frame");
  assert.equal(opacity.k.at(-1).h, 1, "the last keyframe holds");
  assert.deepEqual(color, { a: 0, k: [0.2, 0.4, 1] }, "the color stays the same while it fades");
  assert.deepEqual([direction, distance, softness], [{ a: 0, k: 180 }, { a: 0, k: 24 }, { a: 0, k: 20 }], "it fades in place");
  assert.ok(card.w >= 100 + 2 * (24 + 20), "the effect bounds leave room for the end shadow");
});

test("a real Lottie export turns an animated offset into direction and distance keys without a long spin", async () => {
  const { effect } = await exportShadowAnimation(
    { color: "#000000", x: -20, y: 20, blur: 0 },
    { color: "#ff0000", x: 20, y: 20, blur: 8 },
  );
  const [color, opacity, direction, distance, softness] = effect.ef.map((parameter) => parameter.v);
  const degrees = direction.k.map((frame) => frame.s[0]);
  degrees.forEach((value, index) => close(value, [-135, -153.43494882292202, -180, -206.56505117707798, -225][index], `direction ${index}`));
  distance.k.map((frame) => frame.s[0]).forEach((value, index) =>
    close(value, [Math.hypot(20, 20), Math.hypot(10, 20), 20, Math.hypot(10, 20), Math.hypot(20, 20)][index], `distance ${index}`));
  assert.deepEqual(values(softness), [0, 4, 8, 12, 16], "softness is twice the blur on every frame");
  assert.deepEqual(color.k.map((frame) => frame.s.map((channel) => Math.round(channel * 255))), [[0, 0, 0], [64, 0, 0], [128, 0, 0], [191, 0, 0], [255, 0, 0]]);
  assert.deepEqual(opacity, { a: 0, k: 255 });
});

test("a real Lottie export composes overlapping shadow channels into native effect tracks", async () => {
  const { warnings, card, effect } = await exportComposedShadowChannels();
  assert.deepEqual(warnings, []);
  const [color, opacity, direction, distance, softness] = effect.ef.map((parameter) => parameter.v);
  assert.deepEqual(color.k.map((frame) => frame.s.map((channel) => Math.round(channel * 255))), [
    [255, 0, 0], [191, 0, 64], [128, 0, 128], [64, 0, 191], [0, 0, 255],
  ], "RGB follows its own one-second track");
  assert.deepEqual(values(opacity), [0, 0, 85, 170, 255], "opacity starts later and keeps the RGB track");
  const directions = direction.k.map((frame) => frame.s[0]);
  [90, 90, 90 + Math.atan2(2, 7) * 180 / Math.PI,
    90 + Math.atan2(4, 10) * 180 / Math.PI,
    90 + Math.atan2(6, 13) * 180 / Math.PI]
    .forEach((expected, index) => close(directions[index], expected, `composed direction ${index}`));
  distance.k.map((frame) => frame.s[0]).forEach((value, index) =>
    close(value, [4, 4, Math.hypot(7, 2), Math.hypot(10, 4), Math.hypot(13, 6)][index], `composed distance ${index}`));
  assert.deepEqual(values(softness), [4, 4, 4, 12, 20], "blur follows its later half-second track");
  assert.ok(card.w >= 20 + 2 * (Math.hypot(13, 6) + 20), "visible composed geometry and blur fit inside the effect bounds");
});

test("invisible large shadow geometry stays internal until opacity reveals it", async () => {
  const scene = sceneWithLargeShadow();
  const layer = scene.layers[0];
  const invisible = evaluateLayer(layer, 0);
  assert.deepEqual(invisible.shadow, { color: "#ff000000", x: 400_000, y: 300_000, blur: 10_000 },
    "zero-alpha geometry remains available on the evaluated shadow");
  assert.equal(effectPadding(invisible), 0, "invisible geometry does not reserve filter bounds");
  assert.doesNotMatch(renderSceneSvg(scene, 0), /<filter\b/, "an invisible shadow does not create an SVG filter");

  const visible = evaluateLayer(layer, 1);
  assert.deepEqual(visible.shadow, { color: "#ff0000", x: 400_000, y: 300_000, blur: 10_000 },
    "opacity reveals the same stored offset and blur");
  assert.equal(effectPadding(visible), 520_000);
  assert.match(renderSceneSvg(scene, 1), /<filter\b/, "the revealed shadow creates its filter");

  const invisibleExport = await exportScene(sceneWithLargeShadow(false), { format: "lottie", fps: 2, imageDPIRatio: "original" });
  const invisibleAnimation = JSON.parse(invisibleExport.buffer.toString("utf8"));
  const invisibleCard = invisibleAnimation.layers.find((entry) => entry.nm === "Large shadow");
  assert.ok(invisibleCard, "the static layer is exported");
  assert.equal(invisibleCard.ty, 4, "an all-transparent shadow keeps the layer as a direct shape");
  assert.equal(invisibleCard.ef?.some((entry) => entry.ty === 25) ?? false, false,
    "all-transparent samples omit the native Drop Shadow effect");
  assert.deepEqual(invisibleAnimation.assets, [], "an all-transparent shadow does not create effect assets or a wrapper");

  const visibleExport = await exportScene(scene, { format: "lottie", fps: 2, imageDPIRatio: "original" });
  const animation = JSON.parse(visibleExport.buffer.toString("utf8"));
  const card = animation.layers.find((entry) => entry.nm === "Large shadow");
  assert.ok(card?.ef?.some((entry) => entry.ty === 25), "opacity later produces a native Drop Shadow effect");
  assert.ok(card.w >= 20 + 2 * 520_000, "the visible offset and blur are included in Lottie effect bounds");
  assert.ok(card.h >= 20 + 2 * 520_000, "vertical visible geometry is included in Lottie effect bounds");
});
