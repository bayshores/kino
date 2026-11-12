import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { EFFECTS, effectDefaults } from "../engine/effects/catalog.js";
import { cubeText, LUT_MIME } from "../engine/effects/colorMath.js";
import { EFFECT_PRESET_DEFINITIONS } from "../engine/effects/presetCatalog.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";
import { readImage, startTestServer } from "./media.test.support.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

const WIDTH = 160;
const HEIGHT = 120;
const LOOK_TIME = 0.72;
const PALETTE = ["#03045E", "#0077B6", "#00B4D8", "#90E0EF", "#CAF0F8", "#F77F00", "#D62828", "#00FF00"];

let server;
before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function createProject(document) {
  const response = await server.api("/api/projects", { method: "POST", body: { document } });
  assert.equal(response.status, 201);
}

async function saved(project) {
  const response = await server.api(`/api/projects/${project}`);
  assert.equal(response.status, 200);
  return response.json();
}

function fixture(project, { backdrop = false } = {}) {
  const art = createLayer("group", { id: "art", name: "Artwork", x: 12, y: 12, width: 136, height: 96, clipContent: true });
  const squares = [];
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      squares.push(createLayer("rectangle", {
        id: `tile-${row}-${column}`, name: `Tile ${row}-${column}`, parentId: art.id,
        x: column * 17, y: row * 16, width: 15, height: 14,
        fill: PALETTE[(row * 3 + column * 5) % PALETTE.length], radius: 0, strokeWidth: 0,
      }));
    }
  }
  const layers = [art, ...squares];
  if (backdrop) {
    layers.push(createLayer("rectangle", {
      id: "pane", name: "Pane", x: 28, y: 20, width: 104, height: 76,
      fill: "#FFFFFF99", radius: 0, strokeWidth: 0,
    }));
  }
  return parseDocument(createDocument({
    id: project, name: project,
    scenes: [createScene({ id: "main", name: "Main", width: WIDTH, height: HEIGHT, duration: 2, background: "#101114", layers })],
  }));
}

async function lookFrame(project) {
  const reply = await agent("look", { project, scene: "main", mode: "frame", t: LOOK_TIME, width: WIDTH });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.images?.[0]?.mime, "image/png");
  return readImage(Buffer.from(reply.images[0].data, "base64"));
}

async function assertLookMatchesSavedRender(project, document, actual) {
  const scene = expandComponents(document, "main");
  // The media folder lets the export read uploaded files, such as the lut effect's .cube.
  const output = await exportScene(scene, { format: "png", time: LOOK_TIME, width: WIDTH }, { mediaRoot: path.join(server.dataDirectory, "media") });
  const expected = await readImage(output.buffer);
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      assert.deepEqual(actual.pixel(x, y), expected.pixel(x, y), `look pixel (${x}, ${y}) matches the saved-document renderer`);
    }
  }
}

function changedPixelCount(before, after, threshold = 4) {
  assert.deepEqual([before.width, before.height], [after.width, after.height]);
  let count = 0;
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      const a = before.pixel(x, y), b = after.pixel(x, y);
      if (a.some((channel, index) => Math.abs(channel - b[index]) > threshold)) count += 1;
    }
  }
  return count;
}

// Each export starts a Chromium worker, so renders are what make this file slow. Every effect's
// project starts as the same fixture, so its look before the edit is drawn once (and checked
// against the saved-document export once) and shared.
const baselines = {};
function baselineLook({ backdrop = false } = {}) {
  const project = backdrop ? "reach-baseline-backdrop" : "reach-baseline";
  baselines[project] ??= (async () => {
    const document = fixture(project, { backdrop });
    await createProject(document);
    const frame = await lookFrame(project);
    await assertLookMatchesSavedRender(project, document, frame);
    return frame;
  })();
  return baselines[project];
}

/**
 * The agent's edit stores the animation, and the look after it differs from the shared baseline.
 * `matchSaved` also checks the look against the saved document's export pixel for pixel; look
 * always draws with that same export, so a few tests check it rather than every effect.
 */
async function addAnimationEvidence(project, operation, expectedType, { created = false, matchSaved = false } = {}) {
  const baseline = await baselineLook();
  if (!created) await createProject(fixture(project));

  const reply = await agent("edit", { project, ops: [operation] });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved(project);
  const animation = record.document.scenes[0].layers.find((layer) => layer.id === "art")?.animations?.[0];
  assert.ok(animation, "agent edit stores an animation on Artwork");
  assert.equal(animation.kind, expectedType);
  const frame = await lookFrame(project);
  if (matchSaved) await assertLookMatchesSavedRender(project, record.document, frame);
  const changed = changedPixelCount(baseline, frame);
  assert.ok(changed > 8, `${operation.effect ?? operation.preset} changes ${changed} look pixels at ${LOOK_TIME}s`);
}

const EFFECT_PARAMETER_OVERRIDES = {
  bulge: { amount: 1.8 },
  displacement: { amplitude: 64, offset: 1.75, repeat: 3.5, direction: "both" },
  "fluid-warp": { amount: 72, noiseScale: 0.75, octaves: 5, speed: 1.2, contain: false },
  "fluted-glass": { columns: 8, strength: 0.9, glowStrength: 0.35, glowWidth: 0.8 },
  "noise-warp": { amount: 72, noiseScale: 1.4, speed: 0.8, contain: false },
  ripple: { speed: 1.1, strength: 0.45, frequency: 5, centerX: 0.43, centerY: 0.57, falloff: 1.6, sharpness: 5 },
  twirl: { angle: 240, radius: 0.6, centerX: 0.45, centerY: 0.55 },
  dithering: { darkColor: "#03045E", lightColor: "#CAF0F8", subdivisions: 8, contrast: 2.2 },
  "dot-grid": { gridRepetition: 10, dotScale: 7, contrast: 2, shadowColor: "#03045E", highlightColor: "#F77F00", invertDetection: false },
  duotone: { midpoint: 0.42, contrast: 1.8, shadowColor: "#03045E", highlightColor: "#F77F00" },
  "luma-highlight": { lumaThreshold: 0.55, fuzzWidth: 0.15, fuzzIntensity: 1 },
  "noise-mask": { threshold: 0.42, scale: 0.8, seed: 71, octaves: 5, edgeSoftness: 0.08 },
  pixelate: { pixelSize: 12, pixelSizeStep: 8, noiseScale: 1.2, noiseThreshold: 0.45, noiseEnabled: true },
  "threshold-color": { contrast: 2, defaultColor: "#03045E", colorThreshold: 0.35, softness: 0.12, invertLuma: false },
  tritone: { threshold1: 0.28, threshold2: 0.7, softness: 0.2, contrast: 1.6, shadowColor: "#03045E", midtoneColor: "#D62828", highlightColor: "#CAF0F8" },
  "rgb-shift": { amount: 0.9, direction: 37, overflow: true },
  "edge-lines": { color: "#00FFCC", width: 3, threshold: 0.06, background: "keep", smooth: 0.5, dim: 0.4 },
  grain: { amount: 0.8, size: 2, seed: 11, monochrome: false, rate: 24 },
  vignette: { amount: 0.9, midpoint: 0.4, roundness: 0.5, feather: 0.4, color: "#03045E" },
  "3d-orbit": { rotateY: 42, rotateX: 28, rotateZ: -12, pivotZ: 5, perspective: 0.65, cameraDistance: 3.5, showFront: true, showBack: true },
  "card-flip": { rotationY: 82, rotationX: 18, rotationZ: -7, pivotX: 0.25, pivotY: -0.2, perspective: 0.62, frontFace: true, backFace: true },
  "color-grade": { exposure: 1.65, brightness: 0.82, contrast: 2.5, saturation: 0.25 },
  "color-remover": { targetColor: "#00FF00", range: 0.55, softness: 0.1 },
  "grid-scroll-x": { repeatX: 8, repeatY: 6, gapX: 18, gapY: 20, baseSpeed: 1.4, speedVariation: 0.9, lineOffset: 0.4, scaleFactor: 0.9 },
  "grid-scroll-y": { repeatX: 6, repeatY: 8, gapX: 20, gapY: 18, baseSpeed: 1.3, speedVariation: 0.85, lineOffset: 0.35, scaleFactor: 0.92 },
  "inward-echoes": { scaleDown: 0.55, repeatCount: 8, centerX: 0.43, centerY: 0.57 },
  "noise-tile": { repetitionsX: 7, repetitionsY: 6, gapX: 4, gapY: 4, scale: 1.2, noiseScale: 1.2, noiseMoveX: 1.4, noiseMoveY: -0.8, fps: 20, threshold: 0.25, seedOffset: 37 },
  "radial-repeat-blur": { angle: 160, centerX: 0.15, centerY: -0.15, blurAmount: 1.2, repeats: 12, edgeFalloff: 0.6 },
  wiggle: { wiggleX: 22, wiggleY: 14, speed: 2, angle: 35, seed: 7 },
  curves: { master: [[0, 0.08], [0.3, 0.2], [0.7, 0.85], [1, 1]], red: [[0, 0], [0.5, 0.62], [1, 1]], blue: [[0, 0.1], [1, 0.85]] },
  "hue-saturation": { hue: 120, saturation: 1.3, lightness: 0.05 },
  "white-balance": { temperature: 70, tint: -30 },
  "color-wheels": { liftBlue: 0.12, liftRed: -0.04, gamma: 1.2, gainRed: 0.15, gainBlue: -0.15 },
  "keep-color": { targetColor: "#D62828", hueRange: 20, softness: 10 },
  "color-look": { look: "harbor", amount: 0.7 },
  "color-ranges": { blueHue: -30, orangeSaturation: 0.4, greenLightness: -0.3, highlights: 0.3, shadows: -0.2 },
  "directional-blur": { length: 36, angle: 20 },
  "zoom-blur": { amount: 0.35, centerX: 0.4, centerY: 0.6 },
  "spin-blur": { angle: 24, centerX: 0.45, centerY: 0.55 },
  "focus-band": { shape: "rect", centerX: 0.4, centerY: 0.55, width: 0.3, height: 0.2, maxBlur: 10, falloff: 0.2 },
  "edge-fill": { mode: "mirror", extend: 0.25 },
  mirror: { angle: 30, centerX: 0.45, centerY: 0.5 },
  kaleidoscope: { segments: 5, angle: 15, centerX: 0.5, centerY: 0.45 },
  glow: { strength: 2.5, radius: 10, passes: 3, threshold: 0.45, color: "#FFB070", colorMix: 0.5 },
  "light-rays": { strength: 2, length: 0.55, decay: 0.4, centerX: 0.3, centerY: 0.35, threshold: 0.45 },
  "lens-flare": { style: "rings", x: 0.2, y: 0.25, size: 1.2, color: "#9FD0FF" },
  "rim-light": { angle: 300, width: 10, spread: 24, color: "#FFE08A" },
  field: { use: "color", expression: "0.5 + 0.5*sin(u*tau*3 + t*a)", a: 2, color: "#F77F00" },
  "speed-lines": { count: 40, thickness: 6, taper: 0.7, variation: 0.4, color: "#CAF0F8", opacity: 0.9, angle: 90, length: 0.5, speed: 2, seed: 5 },
  "impact-lines": { count: 60, thickness: 10, inner: 0.35, centerX: 0.4, centerY: 0.55, rate: 8, seed: 5, color: "#F77F00" },
  "film-burn": { amount: 0.8, edge: "right", reach: 0.6, speed: 0.5, seed: 9 },
  invert: { amount: 0.8, keepHue: true },
  lightning: { bolts: 2, branches: 4, startX: 0.2, startY: 0.1, endX: 0.8, endY: 0.9, thickness: 14, color: "#FFD36B", seed: 5 },
  mosaic: { cell: 16, gap: 4, order: "sweep", angle: 45, outline: 1, outlineColor: "#000000", seed: 3 },
};

assert.equal(EFFECTS.length, 62,"the A5 evidence covers the current catalog size");
function effectOperation(definition, layer = "Artwork") {
  return {
    op: "add_animation", layer, effect: definition.key,
    start: definition.kind === "value" ? 0.1 : 0,
    duration: definition.kind === "value" ? 1.2 : 1.5,
    parameters: { ...effectDefaults(definition.key), ...EFFECT_PARAMETER_OVERRIDES[definition.key] },
    ...(definition.kind === "ranged" ? { keepStill: "both" } : {}),
  };
}

// Every effect but lut (its own test below imports a .cube) through one agent edit, one layer each.
test("agent add_animation reaches every catalog effect with its settings in one edit", async () => {
  const project = "reach-effect-every";
  const definitions = EFFECTS.filter((definition) => definition.key !== "lut");
  await createProject(parseDocument(createDocument({ id: project, name: project, scenes: [createScene({
    id: "main", name: "Main", width: WIDTH, height: HEIGHT, duration: 2, background: "#101114",
    layers: definitions.map((definition) => createLayer("rectangle", { id: `layer-${definition.key}`, name: `Layer ${definition.key}`, x: 12, y: 12, width: 136, height: 96, fill: "#0077B6" })),
  })] })));
  const reply = await agent("edit", { project, ops: definitions.map((definition) => effectOperation(definition, `Layer ${definition.key}`)) });
  assert.equal(reply.isError, undefined, reply.text);
  const layers = (await saved(project)).document.scenes[0].layers;
  for (const definition of definitions) {
    const animation = layers.find((layer) => layer.id === `layer-${definition.key}`).animations[0];
    assert.deepEqual([animation?.kind, animation?.effect], ["effect", definition.key], `${definition.key} is stored`);
  }
});

test("agent add_animation refuses a field expression the parser cannot read, with its message", async () => {
  const project = "reach-effect-field-refused";
  await createProject(fixture(project));
  const reply = await agent("edit", { project, ops: [{ op: "add_animation", layer: "Artwork", effect: "field",
    parameters: { use: "alpha", expression: "noise(u*8, v*8) + wobble" } }] });
  assert.equal(reply.isError, true);
  const refusal = JSON.parse(reply.text);
  assert.match(refusal.reason, /parameters\.expression: unknown name "wobble"; allowed names: inputs u, v, t, seed, a, b, c;.*\(at character 19\)/);
  // The retry keeps the field effect, without the refused setting (its default).
  assert.deepEqual(JSON.parse(refusal.next.replace(/^edit /, "")).fix["0"], { op: "add_animation", layer: "Artwork", effect: "field", parameters: { use: "alpha" } });
  assert.equal((await saved(project)).document.scenes[0].layers.find((layer) => layer.id === "art").animations?.length ?? 0, 0, "nothing is saved");
});

// Each effect drawing the right pixels is checked in engine/effects/*.test.js; here the first effect
// of each group renders through the agent's look. EVERY_EFFECT=1 renders every effect (by hand).
const firstOfGroup = (definition, index, all) => all.findIndex((item) => item.group === definition.group) === index;
const RENDERED_EFFECTS = process.env.EVERY_EFFECT ? EFFECTS.filter((definition) => definition.key !== "lut") : EFFECTS.filter(firstOfGroup);
for (const definition of RENDERED_EFFECTS) {
  test(`agent add_animation reaches ${definition.group} effect ${definition.key} and renders matching pixels`, async () => {
    await addAnimationEvidence(`reach-effect-${definition.key}`, effectOperation(definition), "effect");
  });
}

test("agent import reaches a .cube LUT, the lut effect grades with it, and the look matches the saved render", async () => {
  const project = "reach-effect-lut";
  await createProject(fixture(project));
  // A teal-and-orange look that mixes the channels, so the effect takes its 3D path.
  const cube = cubeText({ size: 9, title: "Reach teal orange", color: (r, g, b) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [Math.min(1, r * 0.75 + 0.3 * y), g * 0.92, Math.min(1, b * 0.6 + 0.3 * (1 - y))];
  } });
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST", headers: { "content-type": LUT_MIME, "x-file-name": "teal-orange.cube" }, body: Buffer.from(cube),
  });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  assert.deepEqual(media.lut, { type: "3d", size: 9, title: "Reach teal orange" });
  assert.match(media.src, /^\/api\/media\/[a-f0-9-]+\.cube$/);
  await addAnimationEvidence(project, {
    op: "add_animation", layer: "Artwork", effect: "lut", start: 0, duration: 1.5, keepStill: "both",
    parameters: { lut: media.src, strength: 1 },
  }, "effect", { created: true, matchSaved: true });

  // A broken .cube is refused at import with the line that is wrong.
  const broken = await server.api("/api/media", {
    method: "POST", headers: { "content-type": LUT_MIME, "x-file-name": "broken.cube" }, body: Buffer.from("LUT_3D_SIZE 2\n0 0 0\n"),
  });
  assert.equal(broken.status, 400);
  assert.match((await broken.json()).error, /needs 8 table lines, but the file has 1/);
  // A lut effect that does not name an imported .cube is refused by the edit.
  const refused = await agent("edit", { project, ops: [
    { op: "add_animation", layer: "Artwork", effect: "lut", parameters: { lut: "/api/media/not-a-lut.png" } },
  ] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /\.cube/);
});

test("agent update_layer reaches the add (linear dodge) blend mode and the look matches the saved render", async () => {
  const project = "reach-blend-add";
  await createProject(fixture(project, { backdrop: true }));
  const normal = await agent("edit", { project, ops: [{ op: "update_layer", layer: "Pane", properties: { fill: "#40306080" } }] });
  assert.equal(normal.isError, undefined, normal.text);
  const baseline = await lookFrame(project);
  const reply = await agent("edit", { project, ops: [{ op: "update_layer", layer: "Pane", properties: { blendMode: "add" } }] });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await saved(project);
  assert.equal(record.document.scenes[0].layers.find((layer) => layer.id === "pane").blendMode, "add");
  const frame = await lookFrame(project);
  await assertLookMatchesSavedRender(project, record.document, frame);
  assert.ok(changedPixelCount(baseline, frame) > 8, "add looks different from normal");
  // Add sums the colours: inside the pane each channel is the art under it plus half of #403060.
  const under = await readImage((await exportScene(expandComponents(fixture("under"), "main"), { format: "png", time: LOOK_TIME, width: WIDTH })).buffer);
  const pane = [0x40, 0x30, 0x60].map((channel) => channel * 128 / 255);
  for (const [x, y] of [[40, 30], [80, 60], [120, 80]]) {
    const expected = under.pixel(x, y).slice(0, 3).map((channel, index) => Math.min(255, channel + pane[index]));
    frame.pixel(x, y).slice(0, 3).forEach((channel, index) =>
      assert.ok(Math.abs(channel - expected[index]) <= 2, `pixel (${x}, ${y}) is ${frame.pixel(x, y)}, expected about ${expected}`));
  }
});

test("agent add_animation reaches Noise Mask Cell Size and the look matches the saved render", async () => {
  const project = "reach-effect-noise-mask-cell-size";
  await addAnimationEvidence(project, {
    op: "add_animation", layer: "Artwork", effect: "noise-mask", start: 0, duration: 1.5, keepStill: "both",
    parameters: { ...effectDefaults("noise-mask"), threshold: 0.5, octaves: 1, edgeSoftness: 0, cellSize: 2 },
  }, "effect");
  const record = await saved(project);
  assert.equal(record.document.scenes[0].layers.find((layer) => layer.id === "art").animations[0].to.cellSize, 2);
});

const PRESET_PARAMETER_OVERRIDES = {
  dissolve: { scale: 8, sharpness: 85, variant: 17 },
  pixel: { pixelSize: 22, variant: 31 },
  "pixel-wipe": { direction: "left", scale: 14, spread: 38, variant: 19 },
  "luma-reveal": { sharpness: 82, direction: "dark-to-light" },
  glitch: { sliceSize: 15, speed: 85, colorShift: 75, variant: 23 },
  barrel: { intensity: 1.35, direction: "outward" },
  "film-roll": { direction: "right", copies: 5, motionBlur: 65, stretch: 55 },
};

assert.equal(Object.keys(EFFECT_PRESET_DEFINITIONS).length, 7, "the A5 evidence covers all effect presets");
const presetOperation = (preset, layer = "Artwork") => ({
  op: "add_animation", layer, preset: `preset-${preset.id}`, mode: "in", start: 0.1, duration: 1.2,
  parameters: { ...preset.parameters, ...PRESET_PARAMETER_OVERRIDES[preset.id] },
});

test("agent add_animation reaches every effect preset with its settings in one edit", async () => {
  const project = "reach-preset-every";
  const presets = Object.values(EFFECT_PRESET_DEFINITIONS);
  await createProject(parseDocument(createDocument({ id: project, name: project, scenes: [createScene({
    id: "main", name: "Main", width: WIDTH, height: HEIGHT, duration: 2, background: "#101114",
    layers: presets.map((preset) => createLayer("rectangle", { id: `layer-${preset.id}`, name: `Layer ${preset.id}`, x: 12, y: 12, width: 136, height: 96, fill: "#0077B6" })),
  })] })));
  const reply = await agent("edit", { project, ops: presets.map((preset) => presetOperation(preset, `Layer ${preset.id}`)) });
  assert.equal(reply.isError, undefined, reply.text);
  const layers = (await saved(project)).document.scenes[0].layers;
  for (const preset of presets) {
    const animation = layers.find((layer) => layer.id === `layer-${preset.id}`).animations[0];
    assert.equal(animation?.kind, "in", `${preset.id} is stored as an entrance`);
  }
});

// Two presets render through look (a pixel one and a moving one); EVERY_EFFECT=1 renders all seven.
const RENDERED_PRESETS = Object.values(EFFECT_PRESET_DEFINITIONS).filter((preset, index) => process.env.EVERY_EFFECT || index === 0 || preset.id === "film-roll");
for (const [index, preset] of RENDERED_PRESETS.entries()) {
  test(`agent add_animation reaches effect preset ${preset.id} and renders matching pixels`, async () => {
    await addAnimationEvidence(`reach-preset-${preset.id}`, presetOperation(preset), "in", { matchSaved: index === 0 });
  });
}

const BACKDROP_CASES = [
  {
    key: "backgroundBlur", label: "background blur",
    properties: { backgroundBlur: { enabled: true, radius: 14, blend: 100 } },
  },
  {
    key: "glass", label: "glass",
    properties: { glass: { enabled: true, refraction: 85, depth: 78, dispersion: 62, frost: 18, lightIntensity: 135, lightAngle: 32, blend: 100 } },
  },
];

for (const { key, label, properties } of BACKDROP_CASES) {
  test(`agent update_layer reaches ${label} and renders matching backdrop pixels`, async () => {
    const project = `reach-backdrop-${key.toLowerCase()}`;
    const baseline = await baselineLook({ backdrop: true });
    await createProject(fixture(project, { backdrop: true }));

    const reply = await agent("edit", { project, ops: [
      { op: "update_layer", layer: "Pane", properties },
    ] });
    assert.equal(reply.isError, undefined, reply.text);
    const record = await saved(project);
    assert.deepEqual(record.document.scenes[0].layers.find((layer) => layer.id === "pane")[key], properties[key]);
    const frame = await lookFrame(project);
    if (key === "glass") await assertLookMatchesSavedRender(project, record.document, frame);
    const changed = changedPixelCount(baseline, frame);
    assert.ok(changed > 8, `${label} changes ${changed} look pixels at ${LOOK_TIME}s`);
  });
}
