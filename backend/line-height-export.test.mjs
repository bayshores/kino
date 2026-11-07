// The Line height operation outside the editor: Lottie, PNG stills and the PNG frames that GIF
// and video encode, the saved project store and the agent edit tool.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateLayer } from "../engine/animation.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { glyphContours, layoutText, resizeTextLayer, textUnits, unitGlyphs } from "../engine/textLayout.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

const fonts = await loadBundledFonts();

// The agent's edit tool (POST /api/agent/edit) on a store of its own, holding `document`.
async function agentEdit(t, document) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "kino-line-height-agent-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  await store.createProject(document);
  const service = createAgentService({
    store, agentState: createAgentStateStore(dataRoot), agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({ fonts }),
    // No quality pass: this checks what the edit saves, not the check's findings.
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (projectId, before, saved, revision, options) => store.updateProject(projectId, saved, revision, options),
  });
  return {
    edit: (ops) => service.call("edit", { project: document.id, ops }),
    read: async () => (await store.getProject(document.id)).document,
  };
}

function lineHeight(to, { from = {}, unit = "layer", stagger = 0, id = "line_height" } = {}) {
  return { id, name: "Line height", kind: "custom", start: 0, duration: 1, easing: "linear", from, to: { lineHeight: to }, unit, stagger, order: "forward" };
}

function spacing(to, { unit = "layer", stagger = 0 } = {}) {
  return { id: "spacing", name: "Letter spacing", kind: "custom", start: 0, duration: 1, easing: "linear", from: {}, to: { letterSpacing: to }, unit, stagger, order: "forward" };
}

// Three lines of 40 px text, 1.2 apart, in an auto height box saved at the height they take.
function title(overrides = {}) {
  return createLayer("text", {
    id: "t", name: "Title", x: 10, y: 10, width: 200, height: 144, text: "H\nH\nH", fontSize: 40, lineHeight: 1.2, textAlign: "left", textResize: "height", fill: "#000000", ...overrides,
  });
}

function scene(layers, { width = 300, height = 300, duration = 1 } = {}) {
  return createScene({ id: "scene", name: "Scene", width, height, duration, background: "#ffffff", layers });
}

async function lottie(input, fps = 4) {
  const result = await exportScene(input, { format: "lottie", fps }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

// The value of a Lottie property at `frame`: a still value, or the keyframes read the way a Lottie
// player does for these linear keys (between two keys it moves in a straight line from s to e).
function lottieValue(property, frame) {
  if (property.a !== 1) return property.k;
  const keys = property.k;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (frame < key.t) continue;
    if (key.h === 1 || !key.e || index === keys.length - 1) return key.s;
    const amount = (frame - key.t) / (keys[index + 1].t - key.t);
    return key.s.map((value, axis) => value + (key.e[axis] - value) * amount);
  }
  return keys[0].s;
}

// Every exported glyph, in order: its layer and its path shape.
function exportedGlyphs(animation) {
  return animation.layers.filter((layer) => layer.nm.startsWith("Title")).reverse()
    .flatMap((layer) => layer.shapes.filter((shape) => shape.ty === "gr" && /Glyph \d+$/.test(shape.nm))
      .map((group) => ({ layer, name: group.nm, shape: group.it.find((item) => item.ty === "sh") })));
}

// Where a glyph's first outline point is on the canvas at `frame`: its path point plus its layer's
// position less its anchor (these layers are not turned, scaled or parented).
function canvasStart({ layer, shape }, frame) {
  const vertices = shape.ks.a === 0 ? shape.ks.k : shape.ks.k.find((key) => key.t === frame).s[0];
  const [px, py] = lottieValue(layer.ks.p, frame);
  const [ax, ay] = lottieValue(layer.ks.a, frame);
  assert.equal(layer.parent, undefined);
  return [px - ax + vertices.v[0][0], py - ay + vertices.v[0][1]];
}

// Where the editor puts each glyph's first outline point at `time`, unit by unit as render.js does.
function editorStarts(layer, time) {
  const units = textUnits(layoutText(layer, fonts), layer.animations.find((item) => item.unit !== "layer")?.unit ?? "layer");
  return units.flatMap((unit, unitIndex) => {
    const state = resizeTextLayer(evaluateLayer(layer, time, { unitIndex, unitCount: units.length, fonts }), fonts);
    return unitGlyphs(layoutText(state, fonts), unit).filter((glyph) => glyph.path)
      .map((glyph) => { const [x, y] = glyphContours(glyph)[0].start; return [state.x + x, state.y + y]; });
  });
}

function assertSamePlaces(animation, layer, frames, fps) {
  const glyphs = exportedGlyphs(animation);
  for (const frame of frames) {
    const expected = editorStarts(layer, frame / fps);
    assert.equal(glyphs.length, expected.length, `frame ${frame}: one exported glyph per drawn glyph`);
    for (const [index, glyph] of glyphs.entries()) {
      const [x, y] = canvasStart(glyph, frame);
      assert.ok(Math.abs(x - expected[index][0]) < 1e-3 && Math.abs(y - expected[index][1]) < 1e-3, `frame ${frame} ${glyph.name}: [${x}, ${y}], editor [${expected[index]}]`);
    }
  }
}

async function pixels(input, time) {
  const image = await readImage((await exportScene(input, { format: "png", time }, { fonts })).buffer);
  const values = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) values.push(...image.pixel(x, y));
  return values;
}

test("Lottie keys every line at each frame's line height, where the editor draws it, with no warning", async () => {
  for (const verticalAlign of ["top", "middle", "bottom"]) {
    const layer = title({ verticalAlign, animations: [lineHeight(2)] });
    const { result, animation } = await lottie(scene([layer]));
    assert.equal(result.warnings, undefined, `${verticalAlign}: Line height exports exactly`);
    const glyphs = exportedGlyphs(animation);
    assert.equal(glyphs.length, 3, "the same three glyphs on every frame (no topology change)");
    for (const glyph of glyphs) assert.equal(glyph.shape.ks.a, 1, `${verticalAlign} ${glyph.name} moves`);
    assertSamePlaces(animation, layer, [0, 1, 2, 3, 4], 4);
    // The lines are lineHeight × 40 px apart on each frame: 48 px at 0 s, 64 px at 0.5 s, 80 px at 1 s.
    for (const [frame, gap] of [[0, 48], [2, 64], [4, 80]]) {
      const ys = glyphs.map((glyph) => canvasStart(glyph, frame)[1]);
      for (const index of [1, 2]) assert.ok(Math.abs(ys[index] - ys[index - 1] - gap) < 1e-6, `${verticalAlign} frame ${frame} line ${index}: ${ys[index] - ys[index - 1]}`);
    }
  }
});

test("Lottie exports Line height by lines with stagger, together with Letter spacing that wraps the text", async () => {
  // Each line of "H\nH\nH" moves at its own time.
  const staggered = title({ animations: [lineHeight(2, { unit: "lines", stagger: 0.25 })] });
  const lines = await lottie(scene([staggered], { duration: 1.5 }));
  assert.equal(lines.result.warnings, undefined);
  assert.equal(lines.animation.layers.filter((layer) => layer.nm.startsWith("Title")).length, 3, "one Lottie layer per line");
  assertSamePlaces(lines.animation, staggered, [0, 1, 2, 3, 4, 5, 6], 4);

  // "AB CD EF" is one line at rest; 80 % letter spacing wraps it onto three while the lines move
  // apart, by letters, words and lines.
  for (const unit of ["letters", "words", "lines"]) {
    const layer = title({ text: "AB CD EF", height: 48, animations: [lineHeight(2, { unit, stagger: 0.1 }), spacing(80, { unit, stagger: 0.1 })] });
    const { result, animation } = await lottie(scene([layer], { duration: 1.5 }));
    assert.equal(result.warnings, undefined, unit);
    assert.equal(exportedGlyphs(animation).length, 6, `${unit}: six letters`);
    assertSamePlaces(animation, layer, [0, 2, 4, 6], 4);
  }
});

test("a PNG still draws the frame's line height like text saved with that line height", async () => {
  for (const verticalAlign of ["top", "bottom"]) {
    const animated = scene([title({ verticalAlign, animations: [lineHeight(2)] })], { width: 120, height: 280 });
    for (const [time, value] of [[0, 1.2], [0.5, 1.6], [1, 2]]) {
      const still = scene([title({ verticalAlign, lineHeight: value })], { width: 120, height: 280 });
      assert.deepEqual(await pixels(animated, time), await pixels(still, 0), `${verticalAlign} at ${time} s`);
    }
    assert.notDeepEqual(await pixels(animated, 0), await pixels(animated, 1), "the lines move");
  }
});

test("the PNG frames GIF and video are made from match the stills at each time", async (t) => {
  const animated = scene([title({ text: "AB\nCD", animations: [lineHeight(2.2, { unit: "lines", stagger: 0.25 }), spacing(40)] })], { width: 200, height: 200 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-line-height-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = path.join(directory, "frames");
  await mkdir(sequenceDirectory);
  await exportScene(animated, { format: "png-sequence", fps: 4 }, { fonts, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 4);
  const frames = [];
  for (const [index, name] of names.entries()) {
    const image = await readImage(await readFile(path.join(sequenceDirectory, name)));
    const frame = [];
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) frame.push(...image.pixel(x, y));
    assert.deepEqual(frame, await pixels(animated, index / 4), `${name} is the still at ${index / 4} s`);
    frames.push(frame);
  }
  assert.notDeepEqual(frames[0], frames[3], "the frames change");
});

test("the store saves and reopens a Line height animation, and the agent edit adds and refuses one", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kino-line-height-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "data");
  const document = createDocument({ id: "saved_project", name: "Saved project", scenes: [scene([title({ animations: [lineHeight(2, { from: { lineHeight: 0.8 } })] })])] });
  await (await openStore(root)).createProject(document);
  const reopened = await (await openStore(root)).getProject("saved_project");
  const saved = reopened.document.scenes[0].layers[0].animations[0];
  assert.deepEqual([saved.from, saved.to], [{ lineHeight: 0.8 }, { lineHeight: 2 }]);

  const { edit, read } = await agentEdit(t, createDocument({ id: "agent_file", name: "Agent file", scenes: [scene([title({ lineHeight: 1.5 }), createLayer("rectangle", { id: "box", name: "Box" })])] }));
  const edited = await edit([{ op: "add_animation", layer: "Title", preset: "line-height", start: 0.25 }]);
  assert.equal(edited.isError, undefined, edited.text);
  const animation = (await read()).scenes[0].layers[0].animations[0];
  assert.equal(animation.name, "Line height");
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { lineHeight: 1.9 });
  assert.equal(animation.start, 0.25);

  const refused = await edit([{ op: "add_animation", layer: "Box", animation: { ...lineHeight(2), id: "box_line_height" } }]);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /a Line height animation needs a text layer; only text has a line height/);
  const preset = await edit([{ op: "add_animation", layer: "Box", preset: "line-height" }]);
  assert.equal(preset.isError, true);
  assert.match(preset.text, /Line height preset requires a text layer/);
});
