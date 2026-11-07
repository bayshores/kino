// The Letter spacing operation outside the editor: Lottie, PNG stills and the PNG frames that
// GIF and video encode, the saved project store, the HTTP API and the agent edit tool.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { DOCUMENT_VERSION } from "../engine/schema.js";
import { letterSpacingPixels } from "../engine/letterSpacing.js";
import { layoutText } from "../engine/textLayout.js";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage, startTestServer } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

const fonts = await loadBundledFonts();

function spacing(to, { from = {}, unit = "layer", stagger = 0 } = {}) {
  return { id: "spacing", name: "Letter spacing", kind: "custom", start: 0, duration: 1, easing: "linear", from, to: { letterSpacing: to }, unit, stagger, order: "forward" };
}

function title(overrides = {}) {
  return createLayer("text", { id: "t", name: "Title", x: 10, y: 10, width: 200, height: 60, text: "HHH", fontSize: 40, textAlign: "left", textResize: "width-height", fill: "#000000", ...overrides });
}

function scene(layers, { width = 400, height = 100, duration = 1 } = {}) {
  return createScene({ id: "scene", name: "Scene", width, height, duration, background: "#ffffff", layers });
}

async function lottie(input, fps = 4) {
  const result = await exportScene(input, { format: "lottie", fps }, { fonts });
  return { result, animation: JSON.parse(result.buffer.toString("utf8")) };
}

// Every glyph group of the exported text, in order: { name, shapes: the glyph's path shapes }.
function glyphGroups(animation) {
  return animation.layers.filter((layer) => layer.nm.startsWith("Title")).reverse()
    .flatMap((layer) => layer.shapes.filter((shape) => shape.ty === "gr" && /Glyph \d+$/.test(shape.nm)))
    .map((group) => ({ name: group.nm, shapes: group.it.filter((item) => item.ty === "sh") }));
}

// The first vertex's x of a path shape at each keyframe: [[frame, x]].
function firstX(shape) {
  if (shape.ks.a === 0) return [[0, shape.ks.k.v[0][0]]];
  return shape.ks.k.map((keyframe) => [keyframe.t, keyframe.s[0].v[0][0]]);
}

async function pixels(input, time) {
  const image = await readImage((await exportScene(input, { format: "png", time }, { fonts })).buffer);
  const values = [];
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) values.push(...image.pixel(x, y));
  return values;
}

test("Lottie keys every glyph at each frame's letter spacing, with no warning", async () => {
  const { result, animation } = await lottie(scene([title({ animations: [spacing(40)] })]));
  assert.equal(result.warnings, undefined, "Letter spacing exports exactly");
  const groups = glyphGroups(animation);
  assert.equal(groups.length, 3);
  // The first H stays put; the others move 16 px (40 % of 40 px) per letter over the second.
  assert.equal(groups[0].shapes[0].ks.a, 0);
  for (const group of groups.slice(1)) assert.equal(group.shapes[0].ks.a, 1, `${group.name} is animated`);
  const xs = groups.map((group) => firstX(group.shapes[0]));
  for (let frame = 0; frame <= 4; frame += 1) {
    const letterSpacing = (40 * frame) / 4;
    // Where the editor's layout puts each letter at that frame's spacing.
    const layout = layoutText(title({ letterSpacing }), fonts).lines[0].glyphs.map((glyph) => glyph.x);
    for (const index of [1, 2]) {
      const exported = xs[index].find(([time]) => time === frame)[1] - xs[0][0][1];
      assert.ok(Math.abs(exported - (layout[index] - layout[0])) < 1e-3, `frame ${frame} letter ${index + 1}: ${exported}`);
    }
    const added = letterSpacingPixels(letterSpacing, 40);
    const plain = layoutText(title(), fonts).lines[0].glyphs.map((glyph) => glyph.x);
    assert.ok(Math.abs(layout[2] - plain[2] - 2 * added) < 1e-6, "two gaps of the frame's spacing");
  }
});

test("Lottie exports letters, words and lines that the spacing wraps onto other lines, each letter once", async () => {
  for (const [rest, to] of [[0, 80], [80, 0]]) {
    for (const unit of ["letters", "words", "lines"]) {
      const layer = title({ text: "AB CD EF", textResize: "height", letterSpacing: rest, animations: [spacing(to, { unit, stagger: unit === "letters" ? 0.05 : 0 })] });
      const { result, animation } = await lottie(scene([layer], { height: 300, duration: 1.5 }));
      assert.equal(result.warnings, undefined);
      const groups = glyphGroups(animation);
      assert.equal(groups.length, 6, `${unit} from ${rest} % to ${to} %: six letters`);
      assert.ok(groups.some((group) => group.shapes.some((shape) => shape.ks.a === 1)), "the letters move");
    }
  }
});

test("by lines, each line of the layer's own layout keeps its letters when the spacing wraps them", async () => {
  // At rest "AB CD EF" is one line; at 80 % it wraps onto three, and Lottie still has the one
  // line's layer, whose letters move onto the new lines like the editor draws them.
  const layer = title({ text: "AB CD EF", textResize: "height", animations: [spacing(80, { unit: "lines" })] });
  const wrapped = layoutText({ ...layer, letterSpacing: 80 }, fonts);
  assert.ok(wrapped.lines.length > 1);
  const { result, animation } = await lottie(scene([layer], { height: 300 }));
  assert.equal(result.warnings, undefined);
  const lineLayers = animation.layers.filter((item) => item.nm.startsWith("Title"));
  assert.equal(lineLayers.length, 1, "one layer for the one line at rest");
  const groups = glyphGroups(animation);
  assert.equal(groups.length, 6);
  // The last letter, F, ends on the last line of the wrapped layout.
  const [lastFrame] = groups[5].shapes[0].ks.k.slice(-1);
  const lastY = Math.max(...lastFrame.s[0].v.map((vertex) => vertex[1]));
  const lastLine = wrapped.lines.at(-1);
  assert.ok(Math.abs(lastY - lastLine.y) < 1, `F's baseline ${lastY} is on the last line (${lastLine.y})`);
});

test("a PNG still draws the frame's letter spacing like text saved with that spacing", async () => {
  const animated = scene([title({ animations: [spacing(40)] })], { width: 240, height: 70 });
  for (const [time, letterSpacing] of [[0, 0], [0.5, 20], [1, 40]]) {
    const still = scene([title({ letterSpacing })], { width: 240, height: 70 });
    assert.deepEqual(await pixels(animated, time), await pixels(still, 0), `${time} s`);
  }
  assert.notDeepEqual(await pixels(animated, 0), await pixels(animated, 1), "the letters move");
});

test("the PNG frames GIF and video are made from match the stills at each time", async (t) => {
  const animated = scene([title({ text: "AB CD", animations: [spacing(60, { unit: "letters", stagger: 0.1 })] })], { width: 300, height: 70 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-letter-spacing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = path.join(directory, "frames");
  await mkdir(sequenceDirectory);
  await exportScene(animated, { format: "png-sequence", fps: 4 }, { fonts, sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 4);
  for (const [index, name] of names.entries()) {
    const image = await readImage(await readFile(path.join(sequenceDirectory, name)));
    const frame = [];
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) frame.push(...image.pixel(x, y));
    assert.deepEqual(frame, await pixels(animated, index / 4), `${name} is the still at ${index / 4} s`);
  }
});

test("a store saved with document version 1 opens with the same spacing in percent and is saved back as version 2", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kino-letter-spacing-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "data");
  const store = await openStore(root);
  const document = createDocument({ id: "old_project", name: "Old project", scenes: [scene([title({ fontSize: 48, letterSpacing: 10 })])] });
  await store.createProject(document);
  // Rewrite the saved file as a version 1 kino wrote it: 10 % of 48 px was stored as 4.8 px.
  const file = path.join(root, "store.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const project = saved.projects[0];
  project.document.version = 1;
  project.document.scenes[0].layers[0].letterSpacing = 4.8;
  await writeFile(file, JSON.stringify(saved));

  const reopened = await openStore(root);
  const opened = await reopened.getProject("old_project");
  assert.equal(opened.document.version, DOCUMENT_VERSION);
  assert.ok(Math.abs(opened.document.scenes[0].layers[0].letterSpacing - 10) < 1e-9);
  const rewritten = JSON.parse(await readFile(file, "utf8")).projects[0].document;
  assert.equal(rewritten.version, DOCUMENT_VERSION, "the file is saved back as version 2");
  assert.ok(Math.abs(rewritten.scenes[0].layers[0].letterSpacing - 10) < 1e-9);
  // Opening it again changes nothing more.
  assert.deepEqual((await (await openStore(root)).getProject("old_project")).document, opened.document);
});

test("the API and the agent edit tool take version 1 files and Letter spacing operations", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  // An older .motion file (or an agent's document) of version 1, with 6 px of spacing on 24 px text.
  const older = createDocument({ id: "older_file", name: "Older file", scenes: [scene([title({ fontSize: 24 }), createLayer("rectangle", { id: "box", name: "Box" })])] });
  const created = await server.api("/api/projects", { method: "POST", body: { document: { ...older, version: 1, scenes: [{ ...older.scenes[0], layers: [{ ...older.scenes[0].layers[0], letterSpacing: 6 }, older.scenes[0].layers[1]] }] } } });
  assert.equal(created.status, 201, await created.clone().text());
  const record = await created.json();
  assert.equal(record.document.version, DOCUMENT_VERSION);
  assert.equal(record.document.scenes[0].layers[0].letterSpacing, 25, "6 px on 24 px text is 25 %");

  // The agent's edit tool, as the MCP server and the kino command call it.
  const edit = async (ops) => (await server.api("/api/agent/edit", { method: "POST", body: { project: "older_file", ops } })).json();
  const edited = await edit([{ op: "add_animation", layer: "Title", preset: "letter-spacing", start: 0.25 }]);
  assert.equal(edited.isError, undefined, edited.text);
  const read = await (await server.api("/api/projects/older_file")).json();
  const animation = read.document.scenes[0].layers[0].animations[0];
  assert.equal(animation.name, "Letter spacing");
  assert.deepEqual(animation.from, {});
  assert.deepEqual(animation.to, { letterSpacing: 45 });

  const refused = await edit([{ op: "add_animation", layer: "Box", animation: { ...spacing(20), id: "box_spacing" } }]);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /a Letter spacing animation needs a text layer; only text has letter spacing/);
});
