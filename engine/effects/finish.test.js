// Grain and vignette: their settings, grain that is the same for the same seed and time and new
// each step when animated, and a vignette that darkens toward the corners of the layer's pixels.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { effectDefaults, effectDefinition, normalizeEffectParameters } from "./catalog.js";
import { grainPlacement, vignetteShade } from "./finish.js";
import { libraryCatalog } from "../../backend/agent/library-catalog.mjs";
import { createDocument, createLayer, createScene, parseDocument } from "../model.js";
import { renderSceneSvg } from "../render.js";
import { FINISH_START, letterboxBar, normalizeLetterbox, normalizeSceneFinish } from "../sceneFinishFields.js";
import { sceneFinishLayers, withSceneFinish } from "../sceneFinish.js";

const W = 64, H = 40;
// Dark, middle and light bands, with a see-through strip at the bottom.
const SOURCE = `<rect width="${W}" height="30" fill="#7090B0"/><rect width="20" height="30" fill="#141418"/><rect x="44" width="20" height="30" fill="#F0ECE4"/>`;

function draw(key, parameters, { time = 0, content = SOURCE } = {}) {
  let sequence = 0;
  const defs = [];
  const output = effectDefinition(key).render({ content, bounds: { x: 0, y: 0, width: W, height: H }, parameters: { ...effectDefaults(key), ...parameters },
    time, progress: 1, helpers: { id: (kind) => `t-${kind}-${++sequence}`, defs, raster: true, transform: [1, 0, 0, 1, 0, 0] } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { output, markup: defs.join("") + output, pixels: new Resvg(svg).render().pixels };
}
const at = (pixels, x, y) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const differs = (a, b) => a.some((value, index) => value !== b[index]);
const luma = (pixels, x, y) => { const [r, g, b] = at(pixels, x, y); return (r + g + b) / 3; };

test("grain and vignette settings: defaults, limits and the library entries", () => {
  assert.deepEqual(effectDefaults("grain"), { amount: 0.35, size: 1.5, seed: 0, monochrome: true, animated: true, rate: 30 });
  assert.deepEqual(effectDefaults("vignette"), { amount: 0.5, midpoint: 0.6, roundness: 0, feather: 0.6, color: "#000000" });
  for (const key of ["grain", "vignette"]) assert.equal(effectDefinition(key).parameters.mix.default, 1, `${key} has mix`);
  assert.throws(() => normalizeEffectParameters("grain", { size: 9 }), /from 0.5 to 8/);
  assert.throws(() => normalizeEffectParameters("grain", { rate: 2.5 }), /integer from 1 to 60/);
  assert.throws(() => normalizeEffectParameters("grain", { seed: -1 }), /integer from 0 to 1000000/);
  assert.throws(() => normalizeEffectParameters("vignette", { roundness: 1.5 }), /from -1 to 1/);
  assert.equal(normalizeEffectParameters("vignette", { color: "#fff" }).color, "#FFFFFF");
  const entries = libraryCatalog().entries;
  for (const key of ["grain", "vignette"])
    assert.deepEqual(entries.find((entry) => entry.id === `effect:${key}`)?.tags, [key], `${key} is tagged in the library`);
});

test("grain: the same seed and time draw the same grain; animated grain changes each step, still grain never", () => {
  const first = draw("grain", { seed: 7 }, { time: 0.2 });
  assert.equal(draw("grain", { seed: 7 }, { time: 0.2 }).markup, first.markup);
  assert.deepEqual(draw("grain", { seed: 7 }, { time: 0.2 }).pixels, first.pixels);
  // Rate 30: one step a frame at 30 fps, so every frame of a 30 fps video differs from the last.
  for (let frame = 0; frame < 4; frame += 1) {
    const now = draw("grain", { seed: 7 }, { time: frame / 30 }).pixels, next = draw("grain", { seed: 7 }, { time: (frame + 1) / 30 }).pixels;
    assert.ok(differs(now, next), `frame ${frame} and ${frame + 1} differ`);
  }
  assert.notEqual(grainPlacement({ parameters: { seed: 7 }, time: 0, bounds: { x: 0, y: 0, width: W, height: H } }).variant,
    grainPlacement({ parameters: { seed: 7 }, time: 1 / 30, bounds: { x: 0, y: 0, width: W, height: H } }).variant, "the next step shows another tile");
  assert.deepEqual(draw("grain", { seed: 7, animated: false }, { time: 0 }).pixels, draw("grain", { seed: 7, animated: false }, { time: 2.5 }).pixels);
  assert.ok(differs(draw("grain", { seed: 7 }).pixels, draw("grain", { seed: 8 }).pixels), "another seed is other grain");
});

test("grain varies the picture around its own tone, keeps its shape, and amount 0 leaves it alone", () => {
  assert.equal(draw("grain", { amount: 0 }).output, SOURCE);
  const plain = draw("grain", { amount: 0 }).pixels, grained = draw("grain", { amount: 0.8 }).pixels;
  let changed = 0, total = 0, sum = 0;
  for (let y = 2; y < 28; y += 1) for (let x = 24; x < 40; x += 1) {
    total += 1; if (differs(at(grained, x, y), at(plain, x, y))) changed += 1;
    sum += luma(grained, x, y) - luma(plain, x, y);
  }
  assert.ok(changed > total * 0.8, `most pixels change (${changed}/${total})`);
  assert.ok(Math.abs(sum / total) < 8, `the mean tone stays (${sum / total})`);
  for (let x = 0; x < W; x += 7) assert.equal(at(grained, x, 35)[3], 0, "the see-through strip stays see-through");
  assert.equal(at(grained, 30, 10)[3], 255);
  // Color grain moves the channels apart; monochrome keeps them together on a gray.
  const gray = `<rect width="${W}" height="${H}" fill="#808080"/>`;
  const mono = draw("grain", { amount: 1 }, { content: gray }).pixels, colored = draw("grain", { amount: 1, monochrome: false }, { content: gray }).pixels;
  const spread = (pixels) => { let most = 0; for (let x = 0; x < W; x += 3) { const [r, g, b] = at(pixels, x, 20); most = Math.max(most, Math.max(r, g, b) - Math.min(r, g, b)); } return most; };
  assert.ok(spread(mono) <= 2 && spread(colored) > 20, `mono ${spread(mono)}, color ${spread(colored)}`);
});

test("vignette: clear in the middle, darkest at the corners, in its color, only on the layer's pixels", () => {
  const shape = { width: 16, height: 9, midpoint: 0.6, roundness: 0, feather: 0.6 };
  assert.equal(vignetteShade(0, 0, shape), 0);
  assert.equal(vignetteShade(1, 1, shape), 1);
  assert.equal(vignetteShade(0.5, 0.5, { ...shape, feather: 0 }), 0, "a hard edge, inside the midpoint");
  // Roundness 1 is a circle: on a wide layer the top middle is nearer than the left middle.
  assert.ok(vignetteShade(0, -1, { ...shape, roundness: 1 }) < vignetteShade(-1, 0, { ...shape, roundness: 1 }));
  assert.ok(vignetteShade(0.9, 0.9, { ...shape, roundness: -1 }) > vignetteShade(0.9, 0.9, shape) - 1e-9, "a rounded rectangle reaches the corners");
  const content = `<rect width="${W}" height="${H}" fill="#C0C0C0"/>`;
  assert.equal(draw("vignette", { amount: 0 }, { content }).output, content);
  const dark = draw("vignette", { amount: 1 }, { content }).pixels;
  assert.ok(luma(dark, 32, 20) > 185 && luma(dark, 1, 1) < 40, `middle ${luma(dark, 32, 20)}, corner ${luma(dark, 1, 1)}`);
  const white = draw("vignette", { amount: 1, color: "#FFFFFF" }, { content }).pixels;
  assert.ok(luma(white, 1, 1) > 240);
  const holed = draw("vignette", { amount: 1 }).pixels;
  assert.equal(at(holed, 1, 38)[3], 0, "the see-through corner stays see-through");
});

// Scene finish and letterbox (engine/sceneFinish.js): drawn above every layer of the scene.
const SW = 160, SH = 90;
const throwing = (path, message) => { throw new Error(`${path} ${message}`); };
function sceneFrame(fields, layers = [], options = {}, [width, height] = [SW, SH]) {
  const scene = createScene({ id: "s", width, height, duration: 1, background: "#808080", layers, ...fields });
  const svg = renderSceneSvg(scene, 0.2, { raster: true, ...options });
  const image = new Resvg(svg).render();
  return { svg, pixel: (x, y) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)] };
}

test("finish and letterbox fields: plain forms, limits, true is the documented starting point", () => {
  assert.deepEqual(normalizeSceneFinish(true, "finish", throwing), FINISH_START);
  assert.deepEqual(normalizeSceneFinish({ grain: 0.2, vignette: 0 }, "finish", throwing), { grain: 0.2 });
  for (const off of [false, null, undefined, {}]) assert.equal(normalizeSceneFinish(off, "finish", throwing), undefined);
  assert.throws(() => normalizeSceneFinish({ grain: 2 }, "finish", throwing), /finish.grain must be a number from 0 to 1/);
  assert.throws(() => normalizeSceneFinish({ glow: 0.5 }, "finish", throwing), /not a finish part; use grain, blackLift, halation, vignette/);
  assert.equal(normalizeLetterbox(2.35, "letterbox", throwing), 2.35);
  assert.throws(() => normalizeLetterbox(0.5, "letterbox", throwing), /from 1.2 to 6/);
  assert.equal(letterboxBar(1920, 1080, 2.35), 131.49, "2.35 on 16:9 takes 12% of the height at each edge");
  assert.equal(letterboxBar(1920, 1080, 1.5), 0, "a scene already wider than the ratio gets no bars");
  // A saved scene keeps them (and refuses a wrong one) through parseDocument.
  const saved = parseDocument(createDocument({ scenes: [createScene({ id: "s", finish: true, letterbox: 2 })] })).scenes[0];
  assert.deepEqual([saved.finish, saved.letterbox], [FINISH_START, 2]);
  assert.throws(() => parseDocument(createDocument({ scenes: [createScene({ id: "s", letterbox: 9 })] })), /letterbox/);
});

test("finish lifts blacks, darkens corners, adds grain, draws bars; text can sit above the bars; off changes nothing", () => {
  const plain = sceneFrame({});
  assert.equal(withSceneFinish(createScene({ layers: [] })).layers.length, 0, "no fields: the scene itself");
  const black = [createLayer("rectangle", { id: "black", x: 0, y: 0, width: SW, height: SH, fill: "#000000" })];
  const lifted = sceneFrame({ finish: { blackLift: 0.1 } }, black);
  assert.ok(Math.abs(lifted.pixel(80, 45)[0] - 26) <= 2, `black rises to about 10% gray: ${lifted.pixel(80, 45)}`);
  const vignette = sceneFrame({ finish: { vignette: 1 } });
  assert.ok(vignette.pixel(80, 45)[0] > 120 && vignette.pixel(2, 2)[0] < 70, `middle ${vignette.pixel(80, 45)}, corner ${vignette.pixel(2, 2)}`);
  const grain = sceneFrame({ finish: { grain: 0.5 } });
  let moved = 0;
  for (let x = 40; x < 120; x += 1) if (grain.pixel(x, 45)[0] !== plain.pixel(x, 45)[0]) moved += 1;
  assert.ok(moved > 60, `grain changes most pixels (${moved}/80)`);
  // A bright spot on gray: just outside it the picture glows red-orange (the plain scene is gray 128 there).
  const spot = createLayer("rectangle", { id: "spot", x: 240, y: 100, width: 160, height: 160, fill: "#FFFFFF" });
  const halation = sceneFrame({ finish: { halation: 1 } }, [spot], {}, [640, 360]);
  const [hr, hg, hb] = halation.pixel(238, 180);
  assert.ok(hr > 135 && hr > hg + 4 && hg >= hb, `a warm halo beside the bright spot (${halation.pixel(238, 180)})`);
  assert.deepEqual(halation.pixel(20, 20), [128, 128, 128], "far from the highlight nothing changes");
  const label = createLayer("rectangle", { id: "label", x: 0, y: 0, width: SW, height: 20, fill: "#FF0000" });
  const barred = sceneFrame({ letterbox: 2.35 }, [label]);
  assert.deepEqual(barred.pixel(80, 3), [0, 0, 0], "the bar covers a layer under it");
  assert.deepEqual(barred.pixel(80, 45), [128, 128, 128]);
  assert.deepEqual(barred.pixel(80, SH - 3), [0, 0, 0]);
  assert.deepEqual(sceneFrame({ letterbox: 2.35 }, [{ ...label, aboveLetterbox: true }]).pixel(80, 3), [255, 0, 0], "aboveLetterbox draws over the bar");
  assert.deepEqual(sceneFrame({ letterbox: 2.35 }, [label], { design: true }).pixel(80, 3), [255, 0, 0], "the design canvas shows the layers as edited");
  assert.deepEqual(sceneFinishLayers(createScene({ width: SW, height: SH, letterbox: 2.35, finish: { grain: 0.1 } })).map((layer) => layer.name),
    ["Finish grain", "Finish bar-top", "Finish bar-bottom"], "grain under the bars");
});

test("soften spreads a thin light line over the dark beside it and keeps dark areas deep; haze lifts beside highlights; both off unless set", () => {
  const dark = createLayer("rectangle", { id: "dark", x: 0, y: 0, width: 320, height: 180, fill: "#202020" });
  const line = createLayer("rectangle", { id: "line", x: 80, y: 0, width: 2, height: 180, fill: "#E0E0E0" });
  const light = createLayer("rectangle", { id: "light", x: 200, y: 0, width: 120, height: 180, fill: "#E0E0E0" });
  const ink = createLayer("rectangle", { id: "ink", x: 260, y: 0, width: 2, height: 180, fill: "#202020" });
  const plain = sceneFrame({}, [dark, line, light, ink], {}, [320, 180]);
  const soft = sceneFrame({ finish: { soften: 0.5 } }, [dark, line, light, ink], {}, [320, 180]);
  assert.equal(plain.pixel(83, 90)[0], 32);
  assert.ok(soft.pixel(83, 90)[0] > 36, `the line glows onto the dark beside it (${soft.pixel(83, 90)})`);
  assert.ok(soft.pixel(260, 90)[0] > 60, `a thin dark line on light softens (${soft.pixel(260, 90)})`);
  assert.equal(soft.pixel(30, 90)[0], 32, "a large dark area stays as deep");
  const hazy = sceneFrame({ finish: { haze: 1 } }, [dark, line, light], {}, [320, 180]);
  assert.ok(hazy.pixel(190, 90)[0] > plain.pixel(190, 90)[0] + 8 && hazy.pixel(190, 90)[0] > hazy.pixel(190, 90)[2], `a warm veil beside the highlight (${hazy.pixel(190, 90)})`);
  assert.ok(hazy.pixel(30, 90)[0] - 32 < hazy.pixel(190, 90)[0] - 32, "strongest near the highlights");
  assert.ok(FINISH_START.soften > 0 && FINISH_START.haze === undefined, "finish true softens a little and has no haze");
  assert.deepEqual(sceneFinishLayers(createScene({ width: SW, height: SH, finish: { grain: 0.1 } })).map((layer) => layer.name), ["Finish grain"], "a finish without them has neither");
});
