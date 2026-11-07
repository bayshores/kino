import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import {
  BLUR_EFFECTS,
  MAX_BLUR_COPIES,
  MAX_FILTERED_COPIES,
  averageCopies,
  copyBudget,
  renderDirectionalBlur,
  renderSpinBlur,
  renderZoomBlur,
  sampleCount,
  smearLength,
} from "./motionBlurs.js";

const WIDTH = 160;
const HEIGHT = 120;

// A frame as render.js hands it to an effect. `raster` asks for the resvg-friendly average.
function makeFrame(parameters, { content, bounds = { x: 40, y: 30, width: 80, height: 60 }, drawnBounds, transform, raster = true } = {}) {
  let sequence = 0;
  const defs = [], included = [];
  return {
    frame: {
      content: content ?? `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="#ffffff"/>`,
      bounds, ...(drawnBounds ? { drawnBounds } : {}), parameters, time: 0, progress: 0.5,
      helpers: { id: (kind) => `blur-${kind}-${++sequence}`, defs, includeBounds: (box) => included.push(box),
        ...(transform ? { transform } : {}), ...(raster ? { raster: true } : {}) },
    },
    defs, included,
  };
}

function draw(render, parameters, options) {
  const { frame, defs, included } = makeFrame(parameters, options);
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#000000"/><defs>${defs.join("")}</defs>${output}</svg>`;
  const pixels = new Resvg(svg).render().pixels;
  return { output, defs, included, red: (x, y) => pixels[(y * WIDTH + x) * 4] };
}

test("the Blur group has three value effects that are off at 0", () => {
  assert.deepEqual(BLUR_EFFECTS.map(({ key, group, kind }) => `${key}:${group}:${kind}`),
    ["directional-blur:Blur:value", "zoom-blur:Blur:value", "spin-blur:Blur:value"]);
  assert.deepEqual(BLUR_EFFECTS.map(({ parameters }) => Object.keys(parameters)),
    [["length", "angle"], ["amount", "centerX", "centerY"], ["angle", "centerX", "centerY"]]);
  for (const [render, parameters] of [[renderDirectionalBlur, { length: 0 }], [renderZoomBlur, { amount: 0 }], [renderSpinBlur, { angle: 0 }]]) {
    const { frame, defs } = makeFrame(parameters);
    assert.equal(render(frame), frame.content, `${render.name} at 0 draws the layer as it is`);
    assert.equal(defs.length, 0);
  }
  assert.throws(() => renderDirectionalBlur(makeFrame({ length: 4001 }).frame), /directional-blur.length must be a number from 0 to 4000/);
  assert.throws(() => renderZoomBlur(makeFrame({ amount: -0.1 }).frame), /zoom-blur.amount/);
  assert.throws(() => renderSpinBlur(makeFrame({ angle: 361 }).frame), /spin-blur.angle/);
});

test("the number of copies follows the distance the farthest pixel travels, as a power of two", () => {
  assert.deepEqual([0, 1, 1.5, 3, 100, 129, 5000].map((travel) => sampleCount(travel, 256)), [2, 2, 2, 4, 128, 256, 256]);
  assert.equal(sampleCount(5000, 16), 16);
  // Spin by 20° about the middle of an 80 × 60 box: its corners (50 px out) travel about 17 px.
  const small = makeFrame({ angle: 20 }).frame;
  assert.match(renderSpinBlur(small), /data-blur-copies="32"/);
  // The same layer drawn at twice the size on the scene travels twice as far, so it gets twice the copies.
  const large = makeFrame({ angle: 20 }, { transform: [2, 0, 0, 2, 0, 0] }).frame;
  assert.match(renderSpinBlur(large), /data-blur-copies="64"/);
  // Directional blur doubles its copies with each filter step: 40 px is 6 steps (64 copies).
  const { frame, defs } = makeFrame({ length: 40, angle: 0 });
  renderDirectionalBlur(frame);
  assert.equal(defs[0].match(/<feOffset /g).length, 7, "one move back to centre and six doubling steps");
});

test("the smear the checker counts is the line's length or how far the farthest corner travels", () => {
  const [directional, zoom, spin] = BLUR_EFFECTS;
  const size = { width: 80, height: 60 }; // the corners are 50 px from the middle
  assert.equal(smearLength([{ effect: directional, parameters: { length: 300, angle: 45 } }], size), 300);
  assert.equal(smearLength([{ effect: zoom, parameters: { amount: 0.5, centerX: 0.5, centerY: 0.5 } }], size), 25);
  assert.equal(smearLength([{ effect: zoom, parameters: { amount: 0.5, centerX: 0, centerY: 0 } }], size), 50, "from a corner, the far corner is 100 px away");
  assert.ok(Math.abs(smearLength([{ effect: spin, parameters: { angle: 180, centerX: 0.5, centerY: 0.5 } }], size) - 50 * Math.PI) < 1e-9);
  assert.equal(smearLength([{ effect: { key: "glow" }, parameters: { radius: 40 } }], size), 0, "other effects are not a smear");
});

test("zoom and spin copies share one budget of copies with the blurs and filters inside them", () => {
  assert.deepEqual(copyBudget("<rect/>"), { limit: MAX_BLUR_COPIES, inside: 1 });
  assert.deepEqual(copyBudget('<g data-blur-copies="64"></g>'), { limit: 4, inside: 64 });
  assert.deepEqual(copyBudget('<g data-blur-copies="256"></g><g data-blur-copies="8"></g>'), { limit: 2, inside: 256 });
  assert.deepEqual(copyBudget('<g filter="url(#glow)"></g>'), { limit: MAX_FILTERED_COPIES, inside: 1 });
  assert.deepEqual(copyBudget('<g filter="url(#glow)"><g data-blur-copies="64"></g></g>'), { limit: 4, inside: 64 });

  // A spin over a zoom: 128 zoom copies leave room for 2 spin copies, 256 in all.
  const zoom = makeFrame({ amount: 1 }, { bounds: { x: 0, y: 0, width: 160, height: 120 } });
  const zoomed = renderZoomBlur(zoom.frame);
  assert.match(zoomed, /data-blur-copies="128"/);
  const spin = makeFrame({ angle: 90 }, { content: zoomed, bounds: { x: 0, y: 0, width: 160, height: 120 } });
  assert.match(renderSpinBlur(spin.frame), /data-blur-copies="256"/);
  // Over a filter there are at most 16 copies.
  const directional = makeFrame({ length: 30 });
  const filtered = makeFrame({ angle: 90 }, { content: renderDirectionalBlur(directional.frame) });
  const output = renderSpinBlur(filtered.frame);
  assert.match(output, /data-blur-copies="16"/);
  assert.equal(output.match(/<use /g).length, 16);
});

test("each zoom or spin copy is a <use> copy of one definition that starts with a home rectangle", () => {
  const home = (box) => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="transparent" stroke="none" aria-hidden="true" pointer-events="none"/>`;
  // Raster markup (resvg) needs no home rectangle.
  const raster = makeFrame({ angle: 90 });
  renderSpinBlur(raster.frame);
  assert.equal(raster.defs.length, 1);
  assert.doesNotMatch(raster.defs[0], /fill="transparent"/);
  // Chromium (the preview and every export): the home rectangle covers the layer's paint, or
  // everything the layer drew when an earlier effect kept its paint inside a box.
  const { frame, defs, included } = makeFrame({ angle: 90 }, { raster: false });
  const output = renderSpinBlur(frame);
  assert.equal(defs.length, 1);
  assert.ok(defs[0].startsWith(`<g id="blur-copy-source-1">${home({ x: 40, y: 30, width: 80, height: 60 })}`), defs[0]);
  assert.equal(output.match(/<use href="#blur-copy-source-1"/g).length, 128);
  const drawnBounds = { x: -200, y: -100, width: 600, height: 400 };
  const drawn = makeFrame({ amount: 0.5 }, { raster: false, drawnBounds });
  renderZoomBlur(drawn.frame);
  assert.ok(drawn.defs[0].startsWith(`<g id="blur-copy-source-1">${home(drawnBounds)}`), drawn.defs[0]);
  // The copies' area grows to hold every turned copy, up to ±45° about (80, 60): the corners are
  // 50 px from the centre, so it reaches 50 px left and right and about 49.5 px up and down.
  assert.equal(included.length, 1);
  const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => included[0][key]);
  assert.ok(Math.abs(x - 30) < 0.5 && Math.abs(width - 100) < 1 && Math.abs(y - 10.5) < 0.5 && Math.abs(height - 99) < 1, JSON.stringify(included[0]));
  // The copies are decorative; the layer keeps one invisible copy for its name and focus.
  assert.match(output, /aria-hidden="true"/);
  // Over a filter on parts drawn on their own (at most 16 copies), the home rectangle is repeated
  // inside the filter.
  const content = '<g filter="url(#f)"><g transform="translate(1 1)"><rect width="9" height="9"/></g></g>';
  const filtered = makeFrame({ angle: 90 }, { raster: false, content });
  const spun = renderSpinBlur(filtered.frame);
  assert.equal(spun.match(/<use href="#blur-copy-source-1"/g).length, 16);
  assert.ok(filtered.defs[0].includes(`<g filter="url(#f)">${home({ x: 40, y: 30, width: 80, height: 60 })}<g transform`), filtered.defs[0]);
});

test("copies are averaged two at a time, so each counts exactly once", () => {
  const items = ["<a/>", "<b/>", "<c/>", "<d/>"];
  const chromium = averageCopies(items);
  assert.equal(chromium.match(/mix-blend-mode:plus-lighter/g).length, 3);
  assert.equal(chromium.match(/opacity="0.5"/g).length, 6);
  const raster = averageCopies(items, { raster: true });
  assert.ok(!raster.includes("plus-lighter"));
  assert.equal(raster, '<g><g><g><g><a/></g><g opacity="0.5"><b/></g></g></g><g opacity="0.5"><g><g><c/></g><g opacity="0.5"><d/></g></g></g></g>');
});

test("a directional blur is an even smear: a white square becomes a straight ramp with no steps", () => {
  // A 20 px white square smeared 40 px sideways: a plateau of half white, with straight ramps on both sides.
  const square = { x: 70, y: 40, width: 20, height: 40 };
  const { red, defs } = draw(renderDirectionalBlur, { length: 40, angle: 0 }, { bounds: square });
  assert.match(defs[0], /<filter /);
  assert.ok(Math.abs(red(80, 60) - 128) <= 3, `middle ${red(80, 60)}`);
  const row = Array.from({ length: 80 }, (_, index) => red(40 + index, 60));
  for (let index = 1; index < row.length; index += 1)
    assert.ok(Math.abs(row[index] - row[index - 1]) <= 8, `no step between x=${39 + index} and ${40 + index}: ${row.join(" ")}`);
  assert.ok(red(45, 60) <= 2 && red(115, 60) <= 2, "the smear stops 20 px past each side of the square");
  // The smear stays centred on the square (within a pixel: resvg moves the picture by whole pixels).
  assert.ok(Math.abs(red(62, 60) - red(98, 60)) <= 10, `${red(62, 60)} and ${red(98, 60)}`);
  // At angle 90 the smear runs down and up instead.
  const vertical = draw(renderDirectionalBlur, { length: 40, angle: 90 }, { bounds: square });
  assert.ok(vertical.red(80, 30) > 40 && vertical.red(95, 60) <= 2);
});

test("a spin blur of a disc turning about its own centre leaves it as it was; a zoom blur smears outward", () => {
  const disc = '<circle cx="80" cy="60" r="30" fill="#ffffff"/>';
  const bounds = { x: 50, y: 30, width: 60, height: 60 };
  const spun = draw(renderSpinBlur, { angle: 120 }, { content: disc, bounds });
  for (const [x, y] of [[80, 60], [80, 40], [100, 60], [60, 70]]) assert.ok(spun.red(x, y) >= 250, `inside (${x}, ${y}) ${spun.red(x, y)}`);
  for (const [x, y] of [[80, 25], [115, 60], [45, 45]]) assert.ok(spun.red(x, y) <= 4, `outside (${x}, ${y}) ${spun.red(x, y)}`);

  const zoomed = draw(renderZoomBlur, { amount: 0.5 }, { content: disc, bounds });
  assert.ok(zoomed.red(80, 60) >= 250, "the centre does not move");
  // The rim at 30 px is smeared out to 45 px: brightness falls steadily from 30 px to 45 px.
  const profile = Array.from({ length: 18 }, (_, index) => zoomed.red(80 + 29 + index, 60));
  assert.ok(profile[0] > 200 && profile.at(-1) <= 4, profile.join(" "));
  for (let index = 1; index < profile.length; index += 1) assert.ok(profile[index] <= profile[index - 1] + 2, profile.join(" "));
});

test("previewBlur smears a layer that moves fast while the shutter is open, along its path, and leaves slow ones sharp", async () => {
  const { createLayer, createScene } = await import("../model.js");
  const { renderSceneSvg } = await import("../render.js");
  const box = (id, x, to, y) => createLayer("rectangle", { id, x, y, width: 40, height: 40, fill: "#ffffff",
    animations: [{ id: `${id}-move`, kind: "custom", start: 0, duration: 1, easing: "linear", from: { x }, to: { x: to } }] });
  // 1,200 px/s smears 20 px in the default 1/60 s shutter; 60 px/s is 1 px, under the threshold.
  const scene = createScene({ width: 320, height: 120, background: "#000000", layers: [box("fast", 0, 1200, 10), box("slow", 100, 160, 70)] });
  const sharp = renderSceneSvg(scene, 0.1, { raster: true });
  assert.doesNotMatch(sharp, /data-preview-blur/, "off unless asked (final renders keep their own motion blur)");
  const svg = renderSceneSvg(scene, 0.1, { raster: true, previewBlur: true });
  assert.equal([...svg.matchAll(/data-preview-blur="(\d+)"/g)].map((match) => Number(match[1])).join(), "20");
  const pixels = new Resvg(svg).render().pixels, red = (x, y) => pixels[(y * 320 + x) * 4];
  // The fast square (x 120 to 160 at 0.1 s) has ramps 10 px past each side; the slow one has hard edges.
  assert.ok(red(115, 30) > 40 && red(115, 30) < 220 && red(165, 30) > 40 && red(165, 30) < 220, `${red(115, 30)} ${red(165, 30)}`);
  assert.ok(red(140, 30) > 250);
  assert.equal(red(105, 90), 0);
  assert.ok(red(108, 90) > 250);
  assert.doesNotMatch(renderSceneSvg(scene, 0.1, { raster: true, previewBlur: true, design: true }), /data-preview-blur/);
});

test("a whip preset is a fast slide that fades at its far end and smears along its path in every drawing", async () => {
  const { createLayer, createScene } = await import("../model.js");
  const { presetAnimation } = await import("../animation.js");
  const { renderSceneSvg } = await import("../render.js");
  const card = createLayer("rectangle", { id: "card", x: 100, y: 100, width: 200, height: 100, fill: "#ffffff" });
  const out = presetAnimation("whip-out", card, 0.5, undefined, { parameters: { direction: "down" } });
  // Direction names the move into place, so a whip out with direction down leaves upward.
  assert.deepEqual([out.kind, out.duration, out.easing, out.from, out.to],
    ["out", 0.35, "ease-in", { y: 100, opacity: 1 }, { y: -20, opacity: 0 }]);
  const into = presetAnimation("whip-in", card, 0.85, undefined, { parameters: { direction: "up" } });
  assert.deepEqual([into.easing, into.from, into.to], ["expo-out", { y: 220, opacity: 0 }, { y: 100, opacity: 1 }]);
  const scene = createScene({ width: 400, height: 300, background: "#000000", layers: [{ ...card, animations: [out] }] });
  // Late in the exit it moves fast: smeared without previewBlur; before it starts, sharp.
  const late = renderSceneSvg(scene, 0.8, { raster: true });
  assert.ok(Number(/data-preview-blur="(\d+)"/.exec(late)?.[1]) > 20, late.slice(0, 400));
  assert.doesNotMatch(renderSceneSvg(scene, 0.2, { raster: true }), /data-preview-blur/);
});

test("a final render without motionSamples draws as many shutter samples as its fastest move needs", async () => {
  const { createLayer } = await import("../model.js");
  const { presetAnimation } = await import("../animation.js");
  const { shutterSampleCount } = await import("../previewBlur.js");
  const card = createLayer("rectangle", { id: "card", x: 100, y: 100, width: 600, height: 300 });
  // A card sliding in 600 px over 0.8 s (expo-out): copies 8 px apart at 1/60 s, fewer as it slows.
  const slide = { ...card, animations: [{ id: "a", kind: "in", start: 0, duration: 0.8, easing: "expo-out", from: { x: -500 }, to: { x: 100 } }] };
  const shutter = 0.5 / 30;
  const early = shutterSampleCount([slide], 0.05, shutter);
  assert.ok(early > 2 && early <= 16, String(early));
  assert.ok(shutterSampleCount([slide], 0.6, shutter) < early);
  assert.ok(shutterSampleCount([slide], 0.05, shutter, { scale: 0.25 }) < early, "a smaller output needs fewer");
  assert.equal(shutterSampleCount([card], 0.05, shutter), 2, "nothing moves");
  // A whip smears itself, so it adds no samples.
  const whip = { ...card, animations: [presetAnimation("whip-in", card, 0, undefined, { parameters: { direction: "up" } })] };
  assert.equal(shutterSampleCount([whip], 0.05, shutter), 2);
});

test("focus-band keeps a band sharp and blurs more and more outside it, smoothly, in the layer's own coordinates", async () => {
  const { renderFocusBand, slabBox } = await import("./focusBand.js");
  // Upright stripes 4 px wide over the whole 160 × 120 box (opaque: resvg stacks the copies, which
  // is exact for opaque layers only): a row's contrast shows how sharp it is.
  let stripes = `<rect width="${WIDTH}" height="${HEIGHT}" fill="#000000"/>`;
  for (let x = 0; x < WIDTH; x += 8) stripes += `<rect x="${x}" y="0" width="4" height="${HEIGHT}" fill="#ffffff"/>`;
  const box = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const contrast = (red, y) => { const row = Array.from({ length: 40 }, (_, i) => red(60 + i, y)); return Math.max(...row) - Math.min(...row); };
  const band = draw(renderFocusBand, { centerY: 0.5, width: 0.2, falloff: 0.3, maxBlur: 12 }, { content: stripes, bounds: box });
  assert.match(band.output, /data-focus-band="3"/, "three copies: sharp, 6 px and 12 px");
  const rows = [60, 50, 44, 38, 30, 20, 6].map((y) => contrast(band.red, y));
  assert.ok(rows[0] > 240 && rows[1] > 240, `sharp in the band: ${rows}`);
  assert.ok(rows.at(-1) < 40, `blurred far from it: ${rows}`);
  for (let index = 1; index < rows.length; index += 1) assert.ok(rows[index] <= rows[index - 1] + 4, `the blur only rises away from the band: ${rows}`);
  assert.ok(!band.defs.join("").includes("<clipPath"), "the masks are gradients, not cuts");
  // A rect band: sharp inside, blurred beside it at the same height.
  const rect = draw(renderFocusBand, { shape: "rect", centerX: 0.25, centerY: 0.5, width: 0.3, height: 0.3, falloff: 0.2 }, { content: stripes, bounds: box });
  const across = (x) => { const row = Array.from({ length: 12 }, (_, i) => rect.red(x + i, 60)); return Math.max(...row) - Math.min(...row); };
  assert.ok(across(34) > 240 && across(130) < 60, `rect: ${across(34)} inside, ${across(130)} beside`);
  // Off at 0, and a band over the whole layer draws it as it is (no copies).
  for (const parameters of [{ maxBlur: 0 }, { width: 2 }]) {
    const { frame } = makeFrame(parameters, { content: stripes, bounds: box });
    assert.equal(renderFocusBand(frame), frame.content, JSON.stringify(parameters));
  }
  // slabBox: the part of a box within reach of a turned line.
  assert.deepEqual(slabBox({ cx: 50, cy: 50, nx: 0, ny: 1 }, 10, { x: 0, y: 0, width: 100, height: 100 }), { x: 0, y: 40, width: 100, height: 20 });
  assert.equal(slabBox({ cx: 50, cy: 500, nx: 0, ny: 1 }, 10, { x: 0, y: 0, width: 100, height: 100 }), null);
});

test("focus-band racks focus as a value effect, and on a tilted plane its masks are drawn inside the tilt", async () => {
  const { createLayer, createScene } = await import("../model.js");
  const { renderSceneSvg } = await import("../render.js");
  const band = (id, start, duration, to, from) => ({ id, name: "Focus", kind: "effect", effect: "focus-band", start, duration, easing: "linear", ...(from ? { from } : {}), to });
  const plane = createLayer("rectangle", { id: "plane", x: 100, y: 50, width: 400, height: 300, fill: "#808080", rotateX: 30, rotateY: -20,
    animations: [band("a", 0, 0.1, { centerY: 0.2 }, { centerY: 0.2 }), band("b", 1, 1, { centerY: 0.8 })] });
  const scene = createScene({ width: 600, height: 400, background: "#000000", layers: [plane] });
  // The gradient across the band runs through its middle: y 60 (0.2 of 300) before the rack, 240 after, 150 half way.
  const middle = (t) => { const [, y1, y2] = /<linearGradient[^>]*y1="([-\d.]+)"[^>]*y2="([-\d.]+)"/.exec(renderSceneSvg(scene, t, { raster: true })); return (Number(y1) + Number(y2)) / 2; };
  assert.deepEqual([0.5, 1.5, 2.5].map(middle), [60, 150, 240]);
  const svg = renderSceneSvg(scene, 0.5, { raster: true });
  assert.ok(svg.indexOf("data-tilt-layer-id") >= 0 && svg.indexOf("data-focus-band") > svg.indexOf("data-tilt-layer-id"), "the band is part of the tilted drawing");
});
