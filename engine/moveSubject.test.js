// ctx.subject (engine/blocks/subject.js): words or any drawn layer as a move's subject, with its
// box, scene box, center and a white mask copy; and moves that take a layer inside a group (nested).
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { placeMove, readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { renderSceneSvg } from "./render.js";

const frame = { width: 1920, height: 1080 };
const scene = (layers) => createScene({ id: "s", name: "Scene", width: 1920, height: 1080, duration: 4, layers });
const options = (layers, input = {}) => ({ id: "probe", input, scene: scene(layers), style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.5, media: () => null });

/** Runs a move whose build reads ctx.subject(input) and, when `mask` is set, adds its mask. */
function probe(layers, input, { mask = false } = {}) {
  let found;
  const definition = { name: "probe", fields: {}, length: 1, tags: [], build(ctx) {
    found = ctx.subject(input);
    if (mask) found.made = found.mask("mask");
  } };
  const run = runMove(definition, options(layers));
  return { subject: found, run };
}

test("plain words are a subject with no layer, box or mask", () => {
  const { subject } = probe([], { text: " GO " });
  assert.equal(subject.kind, "words");
  assert.equal(subject.text, "GO");
  assert.equal(subject.layer, null);
  assert.equal(subject.mask("m"), null);
});

test("a text layer: its box as its words lay out, center from its lines, a white copy as its mask", () => {
  const text = createLayer("text", { id: "t", x: 100, y: 200, width: 10, height: 10, text: "Hello", fontSize: 80, textResize: "width-height", fill: "#FF0000",
    textStyleRanges: [{ start: 0, end: 1, style: { fill: "#00FF00", fontSize: 100 } }] });
  const { subject, run } = probe([text], "t", { mask: true });
  assert.equal(subject.kind, "text");
  assert.ok(subject.box.width > 150 && subject.box.height > 80, "sized to its words");
  assert.equal(subject.centerFrom, "lines");
  assert.ok(Math.abs(subject.center.x - (subject.box.x + subject.box.width / 2)) < 2);
  const mask = run.added[0].layer;
  assert.equal(mask.isMask, true);
  assert.equal(mask.fill, "#FFFFFF");
  assert.deepEqual(mask.textStyleRanges, [{ start: 0, end: 1, style: { fontSize: 100 } }], "sizes stay, colors go");
  assert.deepEqual(run.added[0].place, { below: "t" });
});

test("a picture: its box center, and a mask whitened by a held hue-saturation", () => {
  const image = createLayer("image", { id: "logo", x: 600, y: 300, width: 400, height: 200, src: "/api/media/logo.png", scaleX: 0.5, scaleY: 0.5 });
  const { subject, run } = probe([image], "logo", { mask: true });
  assert.equal(subject.kind, "image");
  assert.equal(subject.centerFrom, "box");
  assert.deepEqual(subject.box, { x: 700, y: 350, width: 200, height: 100 });
  assert.deepEqual(subject.center, { x: 800, y: 400 });
  const [white] = run.added[0].layer.animations;
  assert.equal(white.effect, "hue-saturation");
  assert.equal(white.to.lightness, 1);
  assert.equal(white.keepStill, "both");
  // Drawn: the mask (below the logo, so it masks the logo) carries the whitening filter.
  const drawn = scene([image]);
  placeMove(drawn, { id: "probe", name: "probe", settings: {} }, run);
  assert.deepEqual(drawn.layers.map((layer) => layer.id), ["probe-mask", "logo"]);
  const svg = renderSceneSvg(drawn, 1);
  assert.match(svg, /<mask [^>]*mask-type:luminance[^>]*>(?:(?!<\/mask>).)*filter=/s);
});

test("a clip is a subject like a picture", () => {
  const clip = createLayer("video", { id: "clip", x: 0, y: 0, width: 1920, height: 1080, src: "/api/media/clip.mp4", mediaSourceDuration: 8 });
  const { subject } = probe([clip], "clip");
  assert.equal(subject.kind, "video");
  assert.deepEqual(subject.center, { x: 960, y: 540 });
});

test("a path: center from its outline, not its box", () => {
  const path = createLayer("path", { id: "p", x: 10, y: 20, width: 100, height: 100, path: "M50 0 L100 0 L100 50 Z", pathBounds: { x: 0, y: 0, width: 100, height: 100 }, fill: "#123456" });
  const { subject } = probe([path], "p");
  assert.equal(subject.kind, "path");
  assert.equal(subject.centerFrom, "path");
  assert.deepEqual(subject.center, { x: 85, y: 45 });
});

test("rectangles, ellipses and stars are shapes; their box follows their scale and turn", () => {
  for (const type of ["rectangle", "ellipse", "star"]) {
    const shape = createLayer(type, { id: "s1", x: 100, y: 100, width: 100, height: 50, scaleX: 2, scaleY: 2, rotation: 90 });
    const { subject } = probe([shape], "s1");
    assert.equal(subject.kind, "shape", type);
    assert.equal(subject.type, type);
    assert.deepEqual(subject.box, { x: 50, y: 75, width: 200, height: 100 });
    assert.deepEqual(subject.sceneBox, { x: 100, y: 25, width: 100, height: 200 }, `${type} turned a quarter`);
    assert.deepEqual(subject.center, { x: 150, y: 125 });
  }
});

test("a group: center from its parts, and a mask group copy holding white copies of its parts", () => {
  const group = createLayer("group", { id: "g", x: 100, y: 100, width: 1000, height: 1000 });
  const a = createLayer("rectangle", { id: "a", parentId: "g", x: 0, y: 0, width: 100, height: 100, fill: "#FF0000" });
  const b = createLayer("ellipse", { id: "b", parentId: "g", x: 200, y: 0, width: 100, height: 100, fill: "#00FF00" });
  const { subject, run } = probe([group, a, b], "g", { mask: true });
  assert.equal(subject.kind, "group");
  assert.equal(subject.centerFrom, "parts");
  assert.deepEqual(subject.center, { x: 250, y: 150 });
  const [top, ...parts] = run.added.map((entry) => entry.layer);
  assert.equal(top.type, "group");
  assert.equal(top.isMask, true);
  assert.deepEqual(parts.map((part) => [part.type, part.parentId, part.fill]), [["rectangle", "probe-mask", "#FFFFFF"], ["ellipse", "probe-mask", "#FFFFFF"]]);
});

test("a layer inside a group, in a move that lists it as nested: scene box through the group, local center in its coordinates", () => {
  const group = createLayer("group", { id: "g", x: 300, y: 200, width: 800, height: 400 });
  const text = createLayer("text", { id: "t", parentId: "g", x: 20, y: 30, width: 400, height: 80, text: "Hi", fontSize: 60 });
  const other = createLayer("rectangle", { id: "r", parentId: "g", x: 0, y: 200, width: 50, height: 50 });
  let found;
  const definition = { name: "probe", nested: ["layer"], fields: {}, length: 1, tags: [], build(ctx) { found = ctx.subject("t"); found.mask("mask"); } };
  const made = runMove(definition, options([group, text, other]));
  assert.equal(found.layer.id, "t");
  assert.equal(found.sceneBox.x, 320);
  assert.equal(found.sceneBox.y, 230);
  assert.ok(Math.abs(found.center.x - found.localCenter.x - 300) < 0.01);
  assert.equal(made.added[0].layer.parentId, "g", "the mask goes beside it in its group");
  // A move that does not list the field still refuses a layer inside a group.
  const plain = { ...definition, nested: undefined };
  assert.throws(() => runMove(plain, options([group, text, other])), /inside a group; give the group/);
});

/** Runs a library move on `layers` with `fields`. */
function runNamed(name, layers, fields) {
  const definition = MOVES[name];
  const built = scene(layers);
  const made = runMove(definition, { id: name, input: readMoveInput(definition, fields), scene: built, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.5, media: () => null });
  return { made, built };
}

test("type-on, accent-hit and light-sweep take a text layer inside a group as itself, with their parts in that group", () => {
  const layers = () => [
    createLayer("group", { id: "card", x: 400, y: 300, width: 900, height: 300 }),
    createLayer("rectangle", { id: "box", parentId: "card", x: 0, y: 0, width: 900, height: 300, fill: "#1A1D22" }),
    createLayer("text", { id: "line", parentId: "card", x: 40, y: 40, width: 600, height: 60, text: "Find the bike", fontSize: 48, textResize: "width-height", fill: "#EDEEF0" }),
  ];
  const typed = runNamed("type-on", layers(), { layer: "line" });
  assert.ok(typed.made.animations.some((entry) => entry.layerId === "line"), "the letters are typed on the nested text");
  const caret = typed.made.added.find((entry) => entry.layer.move.part === "caret").layer;
  assert.equal(caret.parentId, "card");
  assert.ok(caret.x > 40 && caret.x < 120, "caret in the group's coordinates");
  placeMove(typed.built, { id: "type-on", name: "type-on", settings: {} }, typed.made);
  assert.ok(typed.built.layers.findIndex((layer) => layer.id === "type-on-caret") > typed.built.layers.findIndex((layer) => layer.id === "line"));
  for (const name of ["accent-hit", "light-sweep"]) {
    const { made } = runNamed(name, layers(), { layer: "line" });
    assert.equal(made.added[0].layer.parentId, "card", `${name} overlay in the group`);
    assert.equal(made.added[0].layer.x, 40);
  }
  // The text's field must share its group.
  const outside = [...layers(), createLayer("rectangle", { id: "field", x: 0, y: 0, width: 100, height: 100 })];
  assert.throws(() => runNamed("type-on", outside, { layer: "line", field: "field" }), /must be in the same group/);
});
