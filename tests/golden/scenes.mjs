// Golden-frame fixtures: small documents that each exercise one or two engine features.
//
// Each fixture is { name, document, sceneId?, times, width? }. `document` is built with the real
// engine (createLayer/createScene/createDocument, plus apply_operations for grouping, masks,
// components and stagger) and checked by parseDocument, exactly like a saved project.
// `times` are seconds at which a frame is rendered; they land in the middle of the animations so
// that motion, not only the resting design, is compared. scripts/golden-update.mjs stores those
// frames and tests/golden-frames.test.mjs checks that the engine still draws them the same way.
//
// Every layer and animation has a fixed ID, so a fixture is the same document on every run.
// Only the bundled fonts (Inter, Montserrat, Noto Serif) are used. The clip speed fixtures
// (`media: true`) play a video and a GIF made fresh on every run (tests/golden/media.mjs), and
// the colour grading fixture reads a .cube LUT made there too.
import { createDocument, createLayer, createScene, parseDocument } from "../../engine/model.js";
import { applyOperations } from "../../engine/operations.js";
import { createCatalogAnimation } from "../../engine/presetCatalog.js";
import { fonts } from "./render.mjs";
import { encodePng } from "./compare.mjs";
import { GOLDEN_LUT, GOLDEN_MEDIA } from "./media.mjs";
import { effectDefaults } from "../../engine/effects/catalog.js";
import { moveScenes } from "./moves.mjs";

const MAIN = "main";

const BLUE = "#2f6fdf";
const RED = "#e2553f";
const GREEN = "#3aa675";
const YELLOW = "#f5b700";
const VIOLET = "#7a5af8";
const INK = "#111827";
const PAPER = "#f4f1ea";

const linear = (angle, ...colors) => ({
  type: "linear",
  angle,
  stops: colors.map((color, index) => ({ offset: index / (colors.length - 1), color })),
});

// A Custom animation: From and To values, like the Animate tab's Custom presets make.
function custom(id, start, duration, easing, from, to, extra = {}) {
  return { id, name: id, kind: "custom", start, duration, easing, from, to, ...extra };
}

// A catalog preset (Slide, Mask, Wipe, ...) with a fixed ID, built by the same function that
// add_animation uses. `fields` then changes timing or units, as the Animate tab would.
function preset(presetId, layer, start, id, { parameters, mode, ...fields } = {}) {
  return { ...createCatalogAnimation(presetId, layer, start, { parameters, mode, fonts }, id), ...fields };
}

function text(id, value, properties = {}) {
  return createLayer("text", { id, name: id, text: value, fill: INK, ...properties });
}

function shape(type, id, properties = {}) {
  return createLayer(type, { id, name: id, ...properties });
}

// One fixture: a document whose first scene is `main` (640 × 360 unless `scene` says otherwise),
// optionally edited with apply_operations, then checked by parseDocument.
function fixture(name, { layers = [], scene = {}, extraScenes = [], operations = [], times, width, media = false }) {
  let document = createDocument({
    id: `golden-${name}`,
    name,
    scenes: [createScene({ id: MAIN, name, duration: 2, ...scene, layers }), ...extraScenes],
  });
  if (operations.length) document = applyOperations(document, operations, { fonts });
  return { name, document: parseDocument(document), times, ...(width ? { width } : {}), ...(media ? { media } : {}) };
}

// Uniform and per-corner radii, a stroke, a Resize around its center, and a Corners animation.
function rectangleCorners() {
  const rounded = shape("rectangle", "rounded", { x: 40, y: 70, width: 160, height: 120, radius: 28, fill: BLUE });
  rounded.animations = [custom("rounded-resize", 0, 1.2, "smooth", { width: 40, height: 30 }, { width: 160, height: 120 }, { anchor: "center" })];
  const mixed = shape("rectangle", "mixed", {
    x: 240, y: 70, width: 160, height: 120, cornerRadii: [0, 48, 8, 64], fill: RED, stroke: INK, strokeWidth: 6,
  });
  mixed.animations = [custom("mixed-rotate", 0, 1.2, "ease-out", { rotation: -30 }, { rotation: 0 })];
  const tall = shape("rectangle", "tall", { x: 440, y: 40, width: 160, height: 280, fill: GREEN });
  tall.animations = [custom("tall-corners", 0.2, 1.2, "linear", { cornerRadii: [0, 0, 0, 0] }, { cornerRadii: [80, 80, 0, 80] })];
  return fixture("rectangle-corners", { scene: { background: PAPER }, layers: [rounded, mixed, tall], times: [0.4, 1] });
}

// Ellipse donut, sweep and start angle (the Arc values), each animated.
function ellipseArcs() {
  const ring = shape("ellipse", "ring", { x: 40, y: 80, width: 180, height: 180, donut: 0.55, sweep: 0.75, startAngle: -90, fill: VIOLET });
  ring.animations = [custom("ring-sweep", 0, 1.5, "smooth", { sweep: 0.05 }, { sweep: 1 })];
  const pie = shape("ellipse", "pie", { x: 240, y: 80, width: 180, height: 180, sweep: 0.3, fill: YELLOW });
  pie.animations = [custom("pie-spin", 0, 2, "linear", { startAngle: 0 }, { startAngle: 360 })];
  const oval = shape("ellipse", "oval", { x: 450, y: 110, width: 160, height: 120, fill: "#16a3b8", stroke: "#0b3d4a", strokeWidth: 8 });
  oval.animations = [custom("oval-donut", 0.5, 1, "ease-in", { donut: 0 }, { donut: 0.8 })];
  return fixture("ellipse-arcs", { layers: [ring, pie, oval], times: [0.3, 0.9, 1.6] });
}

// Stars: spike count, thickness, and rotation.
function stars() {
  const classic = shape("star", "classic", { x: 40, y: 90, width: 170, height: 170, fill: YELLOW, stroke: INK, strokeWidth: 3 });
  classic.animations = [custom("classic-spin", 0, 1.5, "smooth", { rotation: 0 }, { rotation: 72 })];
  const burst = shape("star", "burst", { x: 240, y: 90, width: 170, height: 170, spikes: 12, starThickness: 0.75, fill: RED });
  burst.animations = [custom("burst-thickness", 0, 1.5, "ease-out", { starThickness: 0.3 }, { starThickness: 0.85 })];
  const growing = shape("star", "growing", { x: 440, y: 90, width: 170, height: 170, spikes: 3, starThickness: 0.5, fill: BLUE });
  growing.animations = [custom("growing-spikes", 0, 2, "linear", { spikes: 3 }, { spikes: 9 })];
  return fixture("stars", { scene: { background: "#1d2433" }, layers: [classic, burst, growing], times: [0.5, 1.3] });
}

// Vector paths: an even-odd hole, an open stroked curve, and a Morph between two shapes.
function vectorPaths() {
  const ring = "M100 0 C155 0 200 35 200 80 C200 125 155 160 100 160 C45 160 0 125 0 80 C0 35 45 0 100 0 Z " +
    "M100 50 C117 50 130 63 130 80 C130 97 117 110 100 110 C83 110 70 97 70 80 C70 63 83 50 100 50 Z";
  const hole = shape("path", "hole", { x: 30, y: 100, width: 200, height: 160, path: ring, fillRule: "evenodd", fill: BLUE, stroke: "#0d1b3e", strokeWidth: 4 });
  const square = "M0 0 C60 0 120 0 180 0 C180 60 180 120 180 180 C120 180 60 180 0 180 C0 120 0 60 0 0 Z";
  const diamond = "M90 0 C130 40 160 70 180 90 C140 130 110 160 90 180 C50 140 20 110 0 90 C40 50 70 20 90 0 Z";
  const morph = shape("path", "morph", { x: 270, y: 150, width: 180, height: 180, path: square, fill: RED });
  morph.animations = [custom("morph-shape", 0, 1.5, "smooth", { path: square }, { path: diamond })];
  const wave = shape("path", "wave", {
    x: 380, y: 30, width: 240, height: 120, path: "M0 60 C40 0 80 120 120 60 C160 0 200 120 240 60",
    fillEnabled: false, stroke: GREEN, strokeWidth: 2,
  });
  wave.animations = [custom("wave-width", 0, 1.5, "linear", { strokeWidth: 2 }, { strokeWidth: 12 })];
  return fixture("vector-paths", { scene: { background: PAPER }, layers: [hole, morph, wave], times: [0.5, 1.1] });
}

// Trim paths and dashes (strokeTrim.js): an underline drawing on (strokeEnd), a dashed box whose
// dashes travel (dashOffset), a ring trimmed and turned (strokeOffset) with an inside stroke and
// its fill whole, and a two-contour path trimmed per contour with a dash inside the trim.
function trimPaths() {
  const underline = shape("path", "underline", { x: 40, y: 290, width: 560, height: 40, path: "M0 20 C140 0 420 40 560 20", fillEnabled: false, stroke: RED, strokeWidth: 10 });
  underline.animations = [custom("underline-draw", 0, 1, "smooth", { strokeEnd: 0 }, { strokeEnd: 1 }, { kind: "in" })];
  const box = shape("rectangle", "dashed", { x: 40, y: 40, width: 220, height: 140, radius: 18, fill: "#dbe7ff", stroke: BLUE, strokeWidth: 6, dash: [18, 10] });
  box.animations = [custom("dashed-travel", 0, 1.2, "linear", { dashOffset: 0 }, { dashOffset: 56 })];
  const ring = shape("ellipse", "ring", { x: 300, y: 40, width: 150, height: 150, fill: YELLOW, stroke: INK, strokeWidth: 12, strokeAlign: "inside", strokeStart: 0.1, strokeEnd: 0.6 });
  ring.animations = [custom("ring-turn", 0, 1.2, "smooth", { strokeOffset: 0 }, { strokeOffset: 0.5 })];
  const pair = shape("path", "pair", { x: 480, y: 50, width: 120, height: 130, path: "M0 0 L120 0 L120 50 M0 80 L120 80 L120 130", fillEnabled: false, stroke: GREEN, strokeWidth: 6, strokeEnd: 0.8, dash: [24, 8] });
  return fixture("trim-paths", { scene: { background: PAPER }, layers: [box, ring, pair, underline], times: [0.6] });
}

// Text layout: weights, styles, alignment, a styled range, line height, letter spacing,
// auto width, upper case, and fixed boxes that wrap; Letter spacing and Line height animations.
function textLayout() {
  const title = text("title", "Golden frames", { x: 40, y: 24, width: 560, height: 60, fontSize: 48, fontWeight: 700, letterSpacing: -2 });
  const paragraph = text("paragraph", "Every frame is rendered\nby the real export path\nand compared pixel by pixel.", {
    x: 30, y: 110, width: 300, height: 140, fontFamily: "Noto Serif", fontSize: 20, lineHeight: 1.6, textAlign: "center", textResize: "height",
  });
  paragraph.animations = [custom("paragraph-leading", 0, 1.5, "smooth", { lineHeight: 1 }, { lineHeight: 1.6 })];
  const right = text("right", "Right aligned", {
    x: 360, y: 104, width: 250, height: 44, fontFamily: "Montserrat", fontWeight: 600, fontStyle: "italic", fontSize: 28, textAlign: "right", fill: BLUE,
  });
  const auto = text("auto", "auto width", { x: 360, y: 170, fontSize: 24, textResize: "width-height", textCase: "upper", letterSpacing: 20, fill: GREEN });
  auto.animations = [custom("auto-tracking", 0, 1.5, "smooth", { letterSpacing: 0 }, { letterSpacing: 40 })];
  const wrapped = text("wrapped", "A fixed box wraps long text onto more lines and aligns it to the bottom.", {
    x: 360, y: 220, width: 250, height: 120, fontSize: 18, verticalAlign: "bottom", fill: "#4b5563",
  });
  return fixture("text-layout", {
    layers: [title, paragraph, right, auto, wrapped],
    operations: [{ type: "style_text_range", sceneId: MAIN, layerId: "title", text: "frames", style: { fill: RED, fontStyle: "italic" } }],
    times: [0.5, 1.2],
  });
}

// Text animation presets by letter and by word: Slide, Mask (clipped), Custom text, Blur.
function textEffects() {
  const slide = text("slide", "Slide by letter", { x: 40, y: 30, fontSize: 40, fontWeight: 700, textResize: "width-height" });
  slide.animations = [preset("preset-slide", slide, 0, "slide-letters", { unit: "letters", stagger: 0.04, duration: 0.5 })];
  const mask = text("mask", "Mask reveal by word", { x: 40, y: 110, fontSize: 36, textResize: "width-height", fill: BLUE });
  mask.animations = [preset("preset-mask", mask, 0.1, "mask-words", { unit: "words", stagger: 0.15 })];
  const customText = text("custom-text", "Custom text effect", { x: 40, y: 190, fontSize: 36, textResize: "width-height", fill: RED });
  customText.animations = [preset("preset-custom-text", customText, 0, "custom-letters", { parameters: { moveY: 60, angle: 45, opacity: 0 } })];
  const blur = text("blur", "Blur word by word", { x: 40, y: 270, fontSize: 36, textResize: "width-height", fill: GREEN });
  blur.animations = [preset("preset-blur", blur, 0, "blur-words", { unit: "words", stagger: 0.2 })];
  return fixture("text-effects", { layers: [slide, mask, customText, blur], times: [0.35, 0.8] });
}

// Change text: Out then In effects by letter, and an overlapping swap by word.
function textChange() {
  const headline = text("headline", "Hello", { x: 60, y: 70, fontSize: 64, fontWeight: 700, textResize: "width-height" });
  headline.animations = [{
    id: "headline-swap", name: "Change text", kind: "change-text", start: 0.4, text: "Golden frames", overlap: false,
    out: { preset: "fade-out", duration: 0.4, easing: "linear", unit: "letters", stagger: 0.03, order: "forward" },
    in: { preset: "slide-up", duration: 0.5, easing: "ease-out", unit: "letters", stagger: 0.04, order: "forward", distance: 40 },
  }];
  const sub = text("sub", "Before the swap", { x: 60, y: 210, fontSize: 40, textResize: "width-height", fill: BLUE });
  sub.animations = [{
    id: "sub-swap", name: "Change text", kind: "change-text", start: 0.6, text: "After an overlap", overlap: true,
    out: { preset: "shrink-out", duration: 0.6, easing: "smooth", unit: "layer", stagger: 0, order: "forward" },
    in: { preset: "grow-in", duration: 0.6, easing: "smooth", unit: "words", stagger: 0.1, order: "reverse" },
  }];
  return fixture("text-change", { layers: [headline, sub], times: [0.55, 1.05, 1.4] });
}

// Counter: a formatted currency count, a slow count with per-step effects, and decimals.
function counters() {
  const price = text("price", "$1,000", { x: 60, y: 50, fontSize: 64, fontWeight: 700, textResize: "width-height" });
  price.animations = [{ id: "price-count", name: "Counter", kind: "counter", start: 0.2, duration: 1.6, easing: "smooth", from: 1000, to: 25000, step: 250, out: null, in: null }];
  const digit = text("digit", "0", { x: 60, y: 170, fontSize: 96, fontWeight: 700, textResize: "width-height", fill: RED });
  digit.animations = [{
    id: "digit-count", name: "Counter", kind: "counter", start: 0, duration: 2, easing: "linear", from: 0, to: 5, step: 1,
    out: { preset: "fade-out", duration: 0.1 }, in: { preset: "slide-up", duration: 0.2, distance: 30 },
  }];
  const percent = text("percent", "0.0%", { x: 340, y: 190, fontSize: 56, fontFamily: "Montserrat", fontWeight: 500, textResize: "width-height", fill: BLUE });
  percent.animations = [{ id: "percent-count", name: "Counter", kind: "counter", start: 0, duration: 2, easing: "ease-in", from: 0, to: 100, step: 0.5, out: null, in: null }];
  return fixture("counter", { layers: [price, digit, percent], times: [0.5, 1.3] });
}

// Linear and radial gradient fills, a gradient stroke and gradient text; a Color animation
// between two gradients.
function gradients() {
  const bar = shape("rectangle", "bar", { x: 40, y: 40, width: 260, height: 120, radius: 16, fill: linear(30, "#ff6b6b", "#ffd93d", "#6bcb77") });
  bar.animations = [custom("bar-color", 0, 1.6, "smooth", { fill: linear(30, "#ff6b6b", "#ffd93d", "#6bcb77") }, { fill: linear(210, BLUE, VIOLET, "#ff6b6b") })];
  const sun = shape("ellipse", "sun", {
    x: 340, y: 30, width: 260, height: 260,
    fill: { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 0.6, color: BLUE }, { offset: 1, color: "#0d1b3e" }] },
  });
  const outlined = shape("star", "outlined", { x: 50, y: 190, width: 150, height: 150, fill: "#fff4d6", stroke: linear(90, RED, VIOLET), strokeWidth: 10 });
  const word = text("word", "Gradient", { x: 220, y: 250, fontSize: 64, fontWeight: 700, textResize: "width-height", fill: linear(0, RED, YELLOW) });
  return fixture("gradients", { layers: [bar, sun, outlined, word], times: [0.5, 1.2] });
}

// Stroke alignment inside, center and outside (with a thin guide at each box edge), stroke
// width and stroke color animations, and a stroked text.
function strokeAlignment() {
  const layers = [];
  ["inside", "center", "outside"].forEach((strokeAlign, index) => {
    const x = 50 + index * 200;
    const box = shape("rectangle", `box-${strokeAlign}`, { x, y: 50, width: 140, height: 110, fill: "#dbe7ff", stroke: "#1f3a93", strokeWidth: 18, strokeAlign });
    box.animations = [custom(`box-${strokeAlign}-width`, 0, 1.5, "smooth", { strokeWidth: 2 }, { strokeWidth: 18 })];
    const guide = shape("rectangle", `guide-${strokeAlign}`, { x, y: 50, width: 140, height: 110, fillEnabled: false, stroke: RED, strokeWidth: 1 });
    layers.push(box, guide);
  });
  const ring = shape("ellipse", "ring", { x: 60, y: 210, width: 120, height: 120, fill: "#fff4d6", stroke: RED, strokeWidth: 12, strokeAlign: "outside" });
  ring.animations = [custom("ring-stroke", 0, 2, "linear", { stroke: RED }, { stroke: GREEN })];
  const star = shape("star", "star", { x: 240, y: 205, width: 130, height: 130, fill: YELLOW, stroke: INK, strokeWidth: 8, strokeAlign: "inside" });
  const word = text("word", "Stroke", { x: 410, y: 230, fontSize: 60, fontWeight: 700, textResize: "width-height", fill: "#ffffff", stroke: INK, strokeWidth: 3 });
  return fixture("stroke-alignment", { layers: [...layers, ring, star, word], times: [0.5, 1.6] });
}

// Drop shadows (static and a Shadow animation from none) and layer blur (static and animated).
function shadowAndBlur() {
  const card = shape("rectangle", "card", { x: 50, y: 60, width: 200, height: 140, radius: 20, fill: "#ffffff", shadow: { color: "#0f172a59", x: 10, y: 14, blur: 18 } });
  card.animations = [custom("card-shadow", 0, 1.2, "smooth", { shadow: null }, { shadow: { color: "#0f172a59", x: 10, y: 14, blur: 18 } })];
  const glow = shape("star", "glow", { x: 80, y: 230, width: 110, height: 110, fill: YELLOW, shadow: { color: `${RED}cc`, x: -6, y: -4, blur: 4 } });
  const soft = shape("ellipse", "soft", { x: 320, y: 50, width: 140, height: 140, fill: RED, blur: 8 });
  const focus = text("focus", "Focus", { x: 300, y: 220, fontSize: 72, fontWeight: 700, textResize: "width-height", shadow: { color: "#2f6fdf80", x: 4, y: 6, blur: 2 } });
  focus.animations = [custom("focus-blur", 0.2, 1.2, "ease-out", { blur: 16 }, { blur: 0 })];
  return fixture("shadow-blur", { scene: { background: "#e8ecf4" }, layers: [card, glow, soft, focus], times: [0.3, 0.8, 1.5] });
}

// Blend modes over a gradient top half and a dark bottom half, with labels; one animated
// opacity and one animated move.
function blendModes() {
  const top = shape("rectangle", "top", { x: 0, y: 0, width: 640, height: 180, fill: linear(0, "#ff6b6b", BLUE) });
  const bottom = shape("rectangle", "bottom", { x: 0, y: 180, width: 640, height: 180, fill: "#1b1b1b" });
  const modes = ["multiply", "screen", "overlay", "difference", "color-burn"];
  const circles = modes.map((blendMode, index) => shape("ellipse", `circle-${blendMode}`, {
    x: 15 + index * 125, y: 115, width: 120, height: 120, fill: YELLOW, blendMode,
  }));
  circles[3].animations = [custom("difference-fade", 0, 2, "linear", { opacity: 0.2 }, { opacity: 1 })];
  circles[1].animations = [custom("screen-drop", 0, 2, "smooth", { y: 40 }, { y: 115 })];
  const labels = modes.map((mode, index) => text(`label-${mode}`, mode, {
    x: 15 + index * 125, y: 290, width: 120, height: 30, fontSize: 16, textAlign: "center", fill: "#ffffff",
  }));
  return fixture("blend-modes", { layers: [top, bottom, ...circles, ...labels], times: [0.5, 1.5] });
}

// Masks: a mask group made with create_mask (an animated ellipse revealing stripes and text),
// and a plain text mask over the gradient bar above it.
function masks() {
  const spot = shape("ellipse", "spot", { x: 60, y: 60, width: 220, height: 220, fill: "#ffffff" });
  spot.animations = [custom("spot-grow", 0, 1.5, "smooth", { scaleX: 0.3, scaleY: 0.3 }, { scaleX: 1, scaleY: 1 })];
  const stripes = shape("rectangle", "stripes", {
    x: 40, y: 40, width: 260, height: 260,
    fill: { type: "linear", angle: 45, stops: [
      { offset: 0, color: BLUE }, { offset: 0.25, color: BLUE }, { offset: 0.25, color: YELLOW },
      { offset: 0.5, color: YELLOW }, { offset: 0.5, color: BLUE }, { offset: 0.75, color: BLUE },
      { offset: 0.75, color: YELLOW }, { offset: 1, color: YELLOW },
    ] },
  });
  const label = text("label", "MASK", { x: 95, y: 140, fontSize: 56, fontWeight: 700, textResize: "width-height" });
  const word = text("word", "MASKED", { x: 335, y: 140, fontSize: 60, fontWeight: 700, textResize: "width-height", fill: "#ffffff", isMask: true });
  const sweep = shape("rectangle", "sweep", { x: 320, y: 110, width: 300, height: 130, fill: linear(0, RED, VIOLET) });
  sweep.animations = [custom("sweep-move", 0, 1.5, "smooth", { x: 40 }, { x: 320 })];
  return fixture("masks", {
    scene: { background: PAPER },
    layers: [spot, stripes, label, word, sweep],
    operations: [{ type: "create_mask", sceneId: MAIN, layerIds: ["spot", "stripes", "label"], groupId: "mask-group", name: "Mask group" }],
    times: [0.4, 1.2],
  });
}

// Groups: a filled, rounded group that clips its moving children while it rocks, and a group
// without clipping that scales from its center.
function groupClipping() {
  const frame = createLayer("group", {
    id: "frame", name: "frame", x: 60, y: 50, width: 340, height: 260, clipContent: true, fillEnabled: true, fill: "#1d2433", radius: 28,
  });
  frame.animations = [custom("frame-rock", 0, 2, "smooth", { rotation: -4 }, { rotation: 4 })];
  const ball = shape("ellipse", "ball", { parentId: "frame", x: -60, y: 70, width: 120, height: 120, fill: YELLOW });
  ball.animations = [custom("ball-roll", 0, 2, "linear", { x: -80 }, { x: 300 })];
  const bar = shape("rectangle", "bar", { parentId: "frame", x: 40, y: -30, width: 60, height: 320, rotation: 20, fill: RED });
  const loose = createLayer("group", { id: "loose", name: "loose", x: 440, y: 80, width: 160, height: 200 });
  loose.animations = [custom("loose-scale", 0, 1.5, "ease-out", { scaleX: 0.6, scaleY: 0.6 }, { scaleX: 1, scaleY: 1 })];
  const plank = shape("rectangle", "plank", { parentId: "loose", x: -20, y: 20, width: 200, height: 40, fill: GREEN });
  const dot = shape("ellipse", "dot", { parentId: "loose", x: 30, y: 100, width: 100, height: 100, fill: BLUE });
  return fixture("group-clipping", { scene: { background: PAPER }, layers: [frame, ball, bar, loose, plank, dot], times: [0.5, 1.4] });
}

// Components: create_component_from_layers turns a card into a main component; a second
// instance starts later and overrides the title text and the background fill.
function componentOverride() {
  const background = shape("rectangle", "card-bg", { x: 40, y: 90, width: 220, height: 140, radius: 18, fill: BLUE });
  const title = text("card-title", "Card", { x: 60, y: 108, fontSize: 32, fontWeight: 700, textResize: "width-height", fill: "#ffffff" });
  const badge = shape("ellipse", "card-dot", { x: 204, y: 174, width: 40, height: 40, fill: YELLOW });
  badge.animations = [custom("card-dot-pop", 0, 1.2, "elastic", { scaleX: 0.2, scaleY: 0.2 }, { scaleX: 1, scaleY: 1 })];
  return fixture("component-override", {
    scene: { background: PAPER },
    layers: [background, title, badge],
    operations: [
      { type: "create_component_from_layers", sceneId: MAIN, layerIds: ["card-bg", "card-title", "card-dot"], componentSceneId: "card", instanceId: "card-a", name: "Card" },
      { type: "insert_component", sceneId: MAIN, componentSceneId: "card", properties: { id: "card-b", x: 340, y: 90, componentStart: 0.4 } },
      { type: "set_component_overrides", sceneId: MAIN, layerId: "card-b", overrides: { "card-title": { text: "Override" }, "card-bg": { fill: RED } } },
    ],
    times: [0.3, 0.9],
  });
}

// Move animations along motion paths: a curved path that turns the layer along it, and a
// path with explicit handles.
function motionPaths() {
  const rocket = shape("rectangle", "rocket", { x: 540, y: 60, width: 60, height: 30, radius: 6, fill: RED });
  rocket.animations = [custom("rocket-path", 0, 2, "natural", { x: 40, y: 280 }, { x: 540, y: 60 }, {
    motionPath: { points: [{ x: 200, y: 40 }, { x: 380, y: 300 }], bezierControls: true, alignToPath: true },
  })];
  const puck = shape("ellipse", "puck", { x: 580, y: 250, width: 36, height: 36, fill: BLUE });
  puck.animations = [custom("puck-path", 0, 2, "linear", { x: 30, y: 250 }, { x: 580, y: 250 }, {
    motionPath: { points: [{ x: 300, y: 290, in: { x: -120, y: 0 }, out: { x: 120, y: 0 } }], bezierControls: true },
  })];
  return fixture("motion-paths", { scene: { background: PAPER }, layers: [rocket, puck], times: [0.4, 1, 1.6] });
}

// Reveal: Mask and Wipe presets (with softness and directions) and a custom reveal animation.
function reveals() {
  const colors = [BLUE, RED, GREEN, VIOLET];
  const [up, wipe, soft, left] = colors.map((fill, index) => shape("rectangle", `reveal-${index}`, { x: 30 + index * 155, y: 80, width: 130, height: 200, fill }));
  up.animations = [preset("mask-up", up, 0, "reveal-mask-up")];
  wipe.animations = [preset("wipe", wipe, 0, "reveal-wipe")];
  soft.animations = [preset("preset-wipe", soft, 0, "reveal-soft", { parameters: { direction: "down", softness: 80 } })];
  left.animations = [custom("reveal-left", 0, 0.8, "linear",
    { reveal: { progress: 0, direction: "left", softness: 0 } }, { reveal: { progress: 1, direction: "left", softness: 0 } })];
  return fixture("reveals", { layers: [up, wipe, soft, left], times: [0.3, 0.6] });
}

// The same Scale, Rotate and Opacity keyframes with every easing (and a custom curve and a
// strong intensity), mid-flight.
function easings() {
  const rows = [
    ["linear", "smooth", "natural", "ease-in", "ease-out", "elastic"],
    ["bounce", "overshoot", "impulse", "swing", [0.7, -0.4, 0.3, 1.4], "smooth-90"],
  ];
  const layers = rows.flatMap((row, rowIndex) => row.map((easing, index) => {
    const square = shape("rectangle", `ease-${rowIndex}-${index}`, {
      x: 50 + index * 95, y: 70 + rowIndex * 150, width: 70, height: 70, radius: 8, fill: rowIndex ? RED : BLUE,
    });
    const strong = easing === "smooth-90";
    square.animations = [custom(`ease-${rowIndex}-${index}-in`, 0, 1, strong ? "smooth" : easing,
      { scaleX: 0.2, scaleY: 0.2, rotation: -120, opacity: 0.1 }, { scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      strong ? { intensity: 90 } : {})];
    return square;
  }));
  return fixture("easings", { scene: { duration: 1.5 }, layers, times: [0.25, 0.5, 0.8] });
}

// Scene background Color animations: solid to solid, then solid to a gradient.
function sceneBackground() {
  const card = shape("rectangle", "card", { x: 170, y: 110, width: 300, height: 140, radius: 24, fill: "#ffffff" });
  const label = text("label", "Background", { x: 210, y: 155, fontSize: 40, fontWeight: 600, textResize: "width-height" });
  return fixture("scene-background", {
    scene: {
      background: "#101820",
      backgroundAnimations: [
        custom("background-first", 0, 1, "linear", { fill: "#101820" }, { fill: BLUE }),
        custom("background-second", 1, 1, "smooth", { fill: BLUE }, { fill: linear(90, YELLOW, RED) }),
      ],
    },
    layers: [card, label],
    times: [0.5, 1.5],
  });
}

// stagger_animations: Slide Up presets staggered in layer order, and grow animations staggered
// in a seeded random order.
function stagger() {
  const dots = Array.from({ length: 8 }, (_, index) => {
    const dot = shape("ellipse", `dot-${index}`, { x: 40 + index * 72, y: 90, width: 50, height: 50, fill: index % 2 ? BLUE : RED });
    dot.animations = [preset("slide-up", dot, 0, `dot-${index}-in`)];
    return dot;
  });
  const bars = Array.from({ length: 8 }, (_, index) => {
    const bar = shape("rectangle", `bar-${index}`, { x: 45 + index * 72, y: 210, width: 40, height: 100, fill: index % 2 ? GREEN : YELLOW });
    bar.animations = [custom(`bar-${index}-grow`, 0, 0.6, "overshoot", { scaleY: 0 }, { scaleY: 1 })];
    return bar;
  });
  return fixture("stagger", {
    layers: [...dots, ...bars],
    operations: [
      { type: "stagger_animations", sceneId: MAIN, items: dots.map((dot) => ({ layerId: dot.id })), delay: 0.1 },
      { type: "stagger_animations", sceneId: MAIN, items: bars.map((bar) => `${bar.id}-grow`), delay: 0.12, order: "random", seed: 7 },
    ],
    times: [0.4, 0.8],
  });
}

// Visibility over time: a hidden layer (never drawn), a play range, a held play range,
// Hide and Show operations, and an animation that is turned off.
function playbackVisibility() {
  const hidden = shape("rectangle", "hidden", { x: 20, y: 20, width: 600, height: 320, fill: "#ff00ff", visible: false });
  const windowed = shape("rectangle", "windowed", { x: 40, y: 110, width: 120, height: 120, fill: BLUE, playbackWindows: [{ start: 0.5, end: 1.5, visibility: "during", hold: false }] });
  windowed.animations = [custom("windowed-spin", 0, 2, "linear", { rotation: 0 }, { rotation: 180 })];
  const held = shape("rectangle", "held", { x: 175, y: 130, width: 150, height: 80, fill: GREEN, playbackWindows: [{ start: 0.6, end: 1, visibility: "both", hold: true }] });
  held.animations = [custom("held-spin", 0, 2, "linear", { rotation: 0 }, { rotation: 180 })];
  const blinking = shape("ellipse", "blinking", { x: 340, y: 110, width: 120, height: 120, fill: RED });
  blinking.animations = [{ id: "blinking-hide", name: "Hide", kind: "hide", start: 0.8 }, { id: "blinking-show", name: "Show", kind: "show", start: 1.6 }];
  const steady = shape("rectangle", "steady", { x: 490, y: 120, width: 100, height: 100, fill: YELLOW });
  steady.animations = [
    custom("steady-fade", 0, 2, "linear", { opacity: 0 }, { opacity: 1 }, { enabled: false }),
    custom("steady-drop", 0, 2, "linear", { y: 40 }, { y: 200 }),
  ];
  return fixture("playback-visibility", { scene: { background: PAPER }, layers: [hidden, windowed, held, blinking, steady], times: [0.3, 1.2, 1.8] });
}

// Nested transforms: a rotated, scaled group holding a skewed, spinning group, a mirrored text,
// and a Composed animation group (group_animations) with a delayed member.
function nestedTransforms() {
  const outer = createLayer("group", { id: "outer", name: "outer", x: 60, y: 50, width: 300, height: 260, rotation: 12, scaleX: 0.9, scaleY: 0.9 });
  const inner = createLayer("group", { id: "inner", name: "inner", parentId: "outer", x: 40, y: 40, width: 200, height: 140, skewX: 15 });
  inner.animations = [custom("inner-spin", 0, 2, "smooth", { rotation: -30 }, { rotation: 30 })];
  const panel = shape("rectangle", "panel", { parentId: "inner", x: 0, y: 0, width: 200, height: 140, radius: 12, fill: BLUE });
  const mirrored = text("mirrored", "Mirror", { parentId: "inner", x: 30, y: 40, fontSize: 44, fontWeight: 700, textResize: "width-height", fill: "#ffffff", scaleX: -1 });
  const corner = shape("rectangle", "corner", { parentId: "outer", x: 200, y: 180, width: 100, height: 80, fill: YELLOW, skewX: -20 });
  const pulse = shape("ellipse", "pulse", { x: 430, y: 100, width: 160, height: 160, fill: RED });
  pulse.animations = [
    custom("pulse-scale", 0, 1, "smooth", { scaleX: 0.4, scaleY: 0.4 }, { scaleX: 1, scaleY: 1 }),
    custom("pulse-fade", 0.5, 1, "linear", { opacity: 1 }, { opacity: 0.3 }),
  ];
  return fixture("nested-transforms", {
    scene: { background: PAPER },
    layers: [outer, inner, panel, mirrored, corner, pulse],
    operations: [{ type: "group_animations", sceneId: MAIN, animationIds: ["pulse-scale", "pulse-fade"], name: "Pulse" }],
    times: [0.4, 1.1],
  });
}

// Clip speed (engine/mediaTime.js) on generated footage, drawn at its own size: a video whose speed
// ramps from 1× down to 0.25× and back up, and a GIF ramping from 2× to 0.5×. The file frame on
// screen is the integral of the speed: at 0.5 s the video has read 0.34375 s of its file (frame 10).
function mediaSpeedRamp() {
  const { width, height } = GOLDEN_MEDIA;
  const video = createLayer("video", { id: "ramp-video", name: "ramp-video", x: 0, y: 0, width, height, src: "/api/media/golden.mp4", mediaSourceDuration: 2, mediaFreeze: "both" });
  video.animations = [
    custom("ramp-slow", 0, 0.6, "linear", { speed: 1 }, { speed: 0.25 }),
    custom("ramp-back", 1, 0.6, "smooth", { speed: 0.25 }, { speed: 1 }),
  ];
  const gif = createLayer("image", { id: "ramp-gif", name: "ramp-gif", x: 0, y: height, width, height, src: "/api/media/golden.gif", mediaDuration: 2 });
  gif.animations = [custom("ramp-gif-speed", 0, 2, "ease-in", { speed: 2 }, { speed: 0.5 })];
  return fixture("media-speed-ramp", { scene: { width, height: height * 2, background: PAPER }, layers: [video, gif], times: [0.5, 1.3], width, media: true });
}

// Played backwards: the video plays its file from 1.7 s back to 0.2 s, and the GIF (a 1 s loop)
// plays 4 s of loops backwards at 2×, holding each picture for 1/12 s (mediaFrameRate).
function mediaReverse() {
  const { width, height } = GOLDEN_MEDIA;
  const video = createLayer("video", { id: "reverse-video", name: "reverse-video", x: 0, y: 0, width, height, src: "/api/media/golden.mp4", mediaSourceDuration: 2, mediaOffset: 0.2, mediaDuration: 1.5, mediaReverse: true, mediaFreeze: "both" });
  const gif = createLayer("image", { id: "reverse-gif", name: "reverse-gif", x: 0, y: height, width, height, src: "/api/media/golden.gif", mediaDuration: 2, mediaSpeed: 2, mediaReverse: true, mediaFrameRate: 12 });
  return fixture("media-reverse", { scene: { width, height: height * 2, background: PAPER }, layers: [video, gif], times: [0.4, 1.1], width, media: true });
}

// Subject cut-out (cut_out): a title band between a clip and its cut-out, which shows the clip's
// own pictures with only the subject (the white bar) opaque, as cut_out writes it (VP9 WebM with
// transparency; tests/golden/media.mjs makes it losslessly). The bar crosses the band in front of
// it, lined up with the clip's own bar above and below the band, frame for frame.
function cutoutPop() {
  const { width, height } = GOLDEN_MEDIA;
  const clip = createLayer("video", { id: "pop-clip", name: "pop-clip", x: 0, y: 0, width, height, src: "/api/media/golden.mp4", mediaSourceDuration: 2 });
  const title = shape("rectangle", "pop-title", { x: 0, y: 30, width, height: 30, fill: INK, radius: 0, strokeWidth: 0 });
  const subject = createLayer("video", { id: "pop-subject", name: "pop-subject", x: 0, y: 0, width, height, src: "/api/media/golden-subject.webm",
    mediaSourceDuration: 2, allowOverlap: true });
  return fixture("cutout-pop", { scene: { width, height, background: PAPER }, layers: [clip, title, subject], times: [0.5, 1.3], width, media: true });
}

// Caption look "pop" (add_captions {look}) in a portrait frame: 3-word phrases revealed word by
// word, the key word bigger in the accent color and popping in, up to 3 lines before shrinking.
function captionPop() {
  const said = ["Everything", "your", "team", "needs,", "finally", "in", "one", "place."];
  const words = said.map((text, index) => ({ text, start: 0.1 + index * 0.24, end: 0.3 + index * 0.24 }));
  return fixture("caption-pop", { scene: { width: 360, height: 640, background: "#20242A" }, operations: [{ type: "add_captions", sceneId: MAIN, words, look: "pop" }], times: [0.7, 1.75] });
}

// Colour grading: one test card per tile (colour bars, a black-to-white gradient, three skin
// tones and a sky blue), graded by each Color effect, plus an "add" (linear dodge) blend.
// The hue tile turns the hue a full circle over the scene (a hue cycle), so the two frames differ.
// The lut tile reads the .cube made in tests/golden/media.mjs (GOLDEN_LUT).
function colorGrading() {
  const bars = ["#BFBFBF", "#BFBF00", "#00BFBF", "#00BF00", "#BF00BF", "#BF0000", "#0000BF"];
  const patches = ["#E8B796", "#C68642", "#8D5524", "#6A8EC2"];
  const layers = [];
  function card(index, effect, parameters, extra = {}) {
    const id = `card-${index}`;
    const group = createLayer("group", { id, name: id, x: 16 + (index % 4) * 156, y: 16 + Math.floor(index / 4) * 176, width: 140, height: 160 });
    layers.push(group);
    bars.forEach((fill, bar) => layers.push(shape("rectangle", `${id}-bar-${bar}`, { parentId: id, x: bar * 20, y: 0, width: 20, height: 60, fill, radius: 0, strokeWidth: 0 })));
    layers.push(shape("rectangle", `${id}-ramp`, { parentId: id, x: 0, y: 60, width: 140, height: 40, fill: linear(0, "#000000", "#FFFFFF"), radius: 0, strokeWidth: 0 }));
    patches.forEach((fill, patch) => layers.push(shape("rectangle", `${id}-patch-${patch}`, { parentId: id, x: patch * 35, y: 100, width: 35, height: 60, fill, radius: 0, strokeWidth: 0 })));
    if (effect) group.animations = [{ id: `${id}-${effect}`, name: effect, kind: "effect", effect, start: 0, duration: 2, easing: "linear",
      to: parameters, keepStill: "both", ...extra }];
    return group;
  }
  card(0);
  card(1, "curves", { master: [[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]], red: [[0, 0], [0.5, 0.56], [1, 1]],
    green: [[0, 0], [1, 1]], blue: [[0, 0.08], [0.5, 0.46], [1, 0.92]], strength: 1 });
  card(2, "lut", { lut: GOLDEN_LUT, strength: 1 });
  card(3, "hue-saturation", { hue: 360, saturation: 1.2, lightness: 0, colorize: false, tint: "#C8935A" }, { from: { hue: 0 } });
  card(4, "white-balance", { temperature: 45, tint: -15 });
  card(5, "color-wheels", { lift: 0, liftRed: -0.04, liftGreen: 0.02, liftBlue: 0.08, gamma: 1.1, gammaRed: 0, gammaGreen: 0, gammaBlue: 0,
    gain: 1, gainRed: 0.08, gainGreen: 0, gainBlue: -0.08 });
  card(6, "keep-color", { targetColor: "#BF0000", hueRange: 25, softness: 15, amount: 1 });
  card(7);
  layers.push(shape("rectangle", "add-wash", { x: 16 + 3 * 156, y: 192, width: 140, height: 160, fill: "#203850", radius: 0, strokeWidth: 0, blendMode: "add" }));
  return fixture("color-grading", { scene: { background: "#111111" }, layers, times: [0.5, 1.5], media: true });
}

// Four tiles, each a group that clips its content (so a smear or an edge fill stays in its tile),
// for the blur and edge fixtures. `content(id)` makes the tile's layers, with the tile as parent.
function tiles(prefix, background, content) {
  const layers = [];
  for (let index = 0; index < 4; index += 1) {
    const id = `${prefix}-tile-${index}`;
    layers.push(createLayer("group", { id, name: id, x: 16 + (index % 2) * 312, y: 16 + Math.floor(index / 2) * 172, width: 296, height: 156,
      clipContent: true, fillEnabled: true, fill: background, radius: 0 }));
    layers.push(...content(index, id));
  }
  return layers;
}

// A small test card: colour bars, a white dot and a dark bar, in one group.
function testCard(id, parentId, x, y, width, height) {
  const bars = ["#BFBFBF", "#BFBF00", "#00BFBF", "#00BF00", "#BF00BF", "#BF0000", "#0000BF"];
  return [
    createLayer("group", { id, name: id, parentId, x, y, width, height }),
    ...bars.map((fill, bar) => shape("rectangle", `${id}-bar-${bar}`, { parentId: id, x: bar * width / 7, y: 0, width: width / 7, height: height * 0.7, fill, radius: 0, strokeWidth: 0 })),
    shape("rectangle", `${id}-base`, { parentId: id, x: 0, y: height * 0.7, width, height: height * 0.3, fill: INK, radius: 0, strokeWidth: 0 }),
    shape("ellipse", `${id}-dot`, { parentId: id, x: width * 0.4, y: height * 0.15, width: height * 0.4, height: height * 0.4, fill: "#FFFFFF", strokeWidth: 0 }),
  ];
}

const effect = (id, name, start, duration, from, to, extra = {}) => ({ id, name, kind: "effect", effect: name, start, duration, easing: "linear", from, to, ...extra });

// Directional, zoom and spin blur (engine/effects/motionBlurs.js), each growing over the scene, on
// text, a group of shapes, footage and a large 45° smear of shapes.
function blurEffects() {
  const layers = tiles("blur", "#1d2433", (index, parentId) => {
    if (index === 0) {
      const title = text("whip-text", "WHIP", { parentId, x: 44, y: 34, fontSize: 72, fontWeight: 800, textResize: "width-height", fill: "#FFFFFF" });
      title.animations = [effect("whip-blur", "directional-blur", 0, 2, { length: 0, angle: 0 }, { length: 80, angle: 0 })];
      return [title];
    }
    if (index === 1) {
      const card = testCard("zoom-card", parentId, 48, 18, 200, 120);
      card[0].animations = [effect("zoom-blur", "zoom-blur", 0, 2, { amount: 0, centerX: 0.5, centerY: 0.5 }, { amount: 0.6, centerX: 0.5, centerY: 0.5 })];
      return card;
    }
    if (index === 2) {
      const clip = createLayer("video", { id: "spin-video", name: "spin-video", parentId, x: 4, y: 36, width: 288, height: 81, src: "/api/media/golden.mp4", mediaSourceDuration: 2, mediaFreeze: "both" });
      clip.animations = [effect("spin-blur", "spin-blur", 0, 2, { angle: 0, centerX: 0.5, centerY: 0.5 }, { angle: 40, centerX: 0.5, centerY: 0.5 })];
      return [clip];
    }
    const shapes = createLayer("group", { id: "smear-shapes", name: "smear-shapes", parentId, x: 98, y: 28, width: 100, height: 100 });
    shapes.animations = [effect("smear-blur", "directional-blur", 0, 2, { length: 0, angle: 45 }, { length: 160, angle: 45 })];
    return [shapes,
      shape("ellipse", "smear-ball", { parentId: "smear-shapes", x: 0, y: 0, width: 60, height: 60, fill: YELLOW, strokeWidth: 0 }),
      shape("rectangle", "smear-block", { parentId: "smear-shapes", x: 50, y: 50, width: 50, height: 50, fill: RED, radius: 0, strokeWidth: 0 })];
  });
  return fixture("blur-effects", { scene: { background: "#0b1020" }, layers, times: [0.5, 1.5], media: true });
}

// Edge fill (mirror and tile), mirror and kaleidoscope (engine/effects/edges.js): a shaking,
// shrunken card whose edges are mirrored, text tiled past its box, footage mirrored about a
// turning line, and a turning kaleidoscope of a test card.
function edgeEffects() {
  const still = { keepStill: "both" };
  const layers = tiles("edge", "#000000", (index, parentId) => {
    if (index === 0) {
      const card = testCard("shake-card", parentId, 88, 38, 120, 80);
      card[0].animations = [
        effect("shake-fill", "edge-fill", 0, 2, { mode: "mirror", extend: 1 }, { mode: "mirror", extend: 1 }, still),
        custom("shake-turn", 0, 2, "linear", { rotation: -12 }, { rotation: 12 }),
      ];
      return card;
    }
    if (index === 1) {
      const word = text("tile-text", "TILE", { parentId, x: 108, y: 58, width: 80, height: 40, fontSize: 30, fontWeight: 800, textAlign: "center", fill: GREEN });
      word.animations = [effect("tile-fill", "edge-fill", 0, 2, { mode: "tile", extend: 2 }, { mode: "tile", extend: 2 }, still)];
      return [word];
    }
    if (index === 2) {
      const clip = createLayer("video", { id: "mirror-video", name: "mirror-video", parentId, x: 4, y: 36, width: 288, height: 81, src: "/api/media/golden.mp4", mediaSourceDuration: 2, mediaFreeze: "both" });
      clip.animations = [effect("mirror-turn", "mirror", 0, 2, { angle: 0, centerX: 0.5, centerY: 0.5 }, { angle: 90, centerX: 0.5, centerY: 0.5 }, still)];
      return [clip];
    }
    const card = testCard("kaleido-card", parentId, 0, 0, 296, 156);
    card[0].animations = [effect("kaleido-turn", "kaleidoscope", 0, 2, { segments: 6, angle: 0, centerX: 0.5, centerY: 0.5 }, { segments: 6, angle: 60, centerX: 0.5, centerY: 0.5 }, still)];
    return card;
  });
  return fixture("edge-effects", { scene: { background: "#0b1020" }, layers, times: [0.5, 1.5], media: true });
}

// Light: a "footage" group (a dusk sky, a bright disc and a stripe) with bloom and god rays from
// the disc; a neon title whose glow grows; a title with a light behind it; a sun that moves with
// a rings flare on it (the flare follows the sun); and a lamp with an anamorphic streak.
function light() {
  const effect = (id, key, parameters, extra = {}) => ({ id, name: key, kind: "effect", effect: key, start: 0, duration: 2, easing: "linear",
    to: parameters, keepStill: "both", ...extra });
  const footage = createLayer("group", { id: "footage", name: "footage", x: 0, y: 0, width: 300, height: 360 });
  footage.animations = [
    effect("footage-bloom", "glow", { strength: 0.8, radius: 12, passes: 2, threshold: 0.7 }),
    effect("footage-rays", "light-rays", { centerX: 0.6, centerY: 0.25, length: 0.6, decay: 0.6, strength: 1.2, threshold: 0.65 }),
  ];
  const child = (id, type, properties) => shape(type, id, { parentId: "footage", strokeWidth: 0, ...properties });
  const neon = text("neon", "Neon", { x: 330, y: 40, width: 280, height: 90, fontSize: 72, fontWeight: 700, fill: "#FFFFFF", textAlign: "center" });
  neon.animations = [effect("neon-glow", "glow", { strength: 2.5, radius: 5, passes: 3, threshold: 0, softness: 0, color: "#FF2A6D", colorMix: 1 }, { from: { strength: 0.5 } })];
  const behind = text("behind", "Dawn", { x: 330, y: 200, width: 280, height: 90, fontSize: 72, fontWeight: 700, fill: "#1A1F2B", textAlign: "center" });
  behind.animations = [effect("behind-rays", "light-rays", { source: "behind", lightSize: 0.6, length: 0.5, strength: 1.5, color: "#FFD9A0" })];
  const sun = shape("ellipse", "sun", { x: 380, y: 150, width: 24, height: 24, fill: "#FFF4DA", strokeWidth: 0 });
  sun.animations = [effect("sun-flare", "lens-flare", { style: "rings", x: 0.5, y: 0.5, strength: 0.9 }), custom("sun-move", 0, 2, "linear", { x: 380 }, { x: 560 })];
  const lamp = shape("ellipse", "lamp", { x: 590, y: 320, width: 12, height: 12, fill: "#CFE0FF", strokeWidth: 0 });
  lamp.animations = [effect("lamp-flare", "lens-flare", { style: "anamorphic", x: 0.5, y: 0.5, strength: 0.6, color: "#7FB2FF" })];
  const layers = [
    footage,
    child("sky", "rectangle", { x: 0, y: 0, width: 300, height: 360, fill: linear(90, "#1C2840", "#3A3048"), radius: 0 }),
    child("disc", "ellipse", { x: 160, y: 70, width: 40, height: 40, fill: "#FFF2D0" }),
    child("stripe", "rectangle", { x: 20, y: 280, width: 260, height: 6, fill: "#FFFFFF", radius: 0 }),
    neon, behind, sun, lamp,
  ];
  return fixture("light", { scene: { background: "#0B0E14" }, layers, times: [0.5, 1.5] });
}

// Particle overlays: one tile per generator (engine/effects/particles.js), each a dark card with a
// word on it and the generator on a carrier rectangle above, on the add blend for light and the
// normal blend for snow, rain and fog. Sizes and speeds are scaled down to fit the small tiles.
// Rain loops every second, so its tile at 0.5 s and 1.5 s is the same picture.
function particleOverlays() {
  const looks = [
    ["embers", "add", { count: 60, size: 5, speed: 40, lifetime: 4 }],
    ["sparks", "add", { count: 120, size: 2, speed: 160, gravity: 260, originY: 0.8 }],
    ["snow", "normal", { count: 80, size: 4, speed: 25, wind: 8, turbulence: 6 }],
    ["dust", "add", { count: 50, size: 3, speed: 5, turbulence: 8 }],
    ["rain", "normal", { count: 120, size: 1, speed: 420, wind: -30, loop: 1 }],
    ["bokeh", "add", { count: 16, size: 30, speed: 6, turbulence: 6 }],
    ["fog", "normal", { count: 6, size: 110, speed: 10, turbulence: 10, opacity: 0.2 }],
    ["light-leaks", "add", { count: 2, size: 160, speed: 20, turbulence: 20, opacity: 0.5 }],
  ];
  const layers = [];
  looks.forEach(([effect, blendMode, parameters], index) => {
    const x = 16 + (index % 4) * 156, y = 16 + Math.floor(index / 4) * 172;
    layers.push(shape("rectangle", `${effect}-card`, { x, y, width: 140, height: 156, fill: linear(180, "#141C26", "#30241A"), radius: 0, strokeWidth: 0 }));
    layers.push(text(`${effect}-word`, effect, { x, y: y + 64, width: 140, fontSize: 18, fill: "#E8E2D6", textAlign: "center" }));
    const carrier = shape("rectangle", `${effect}-overlay`, { x, y, width: 140, height: 156, fillEnabled: false, strokeWidth: 0, blendMode });
    carrier.animations = [{ id: `${effect}-generator`, name: effect, kind: "effect", effect, start: 0, duration: 2, easing: "linear",
      to: { ...effectDefaults(effect), ...parameters }, keepStill: "both" }];
    layers.push(carrier);
  });
  return fixture("particle-overlays", { scene: { background: "#0B0D10" }, layers, times: [0.5, 1.5] });
}

// A tilted app screen, as the ui-plane move draws one: a clipping card with a picture of
// fine detail, a blurred glow and a partly transparent panel, turned in 3D. Final renders draw its
// flat drawing once and give each triangle its piece (backend/flatten-tilts.mjs); this frame keeps
// that path matching the triangles.
const tiltedPicture = await (async () => {
  const width = 200, height = 120, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const line = x % 8 === 0 || y % 8 === 0, check = (Math.floor(x / 4) + Math.floor(y / 4)) % 2;
      pixels.set(line ? [17, 24, 39, 255] : check ? [245, 183, 0, 255] : [47, 111, 223, 255], (y * width + x) * 4);
    }
  return `data:image/png;base64,${Buffer.from(await encodePng(width, height, pixels)).toString("base64")}`;
})();

function tiltedPlane() {
  const card = createLayer("group", { id: "plane", name: "plane", x: 150, y: 50, width: 340, height: 260, rotateX: 18, rotateY: -28, perspective: 900, clipContent: true, radius: 24 });
  card.animations = [custom("plane-turn", 0, 2, "smooth", { rotateY: -40 }, { rotateY: -16 })];
  const screen = shape("rectangle", "screen", { parentId: "plane", x: 0, y: 0, width: 340, height: 260, fill: PAPER });
  const picture = createLayer("image", { id: "picture", name: "picture", parentId: "plane", x: 20, y: 20, width: 200, height: 120, src: tiltedPicture });
  const glow = shape("ellipse", "glow", { parentId: "plane", x: 230, y: 30, width: 90, height: 90, fill: RED, blur: 6 });
  const panel = shape("rectangle", "panel", { parentId: "plane", x: 120, y: 120, width: 200, height: 120, radius: 14, fill: BLUE, opacity: 0.6 });
  const label = text("label", "Tilted", { parentId: "plane", x: 30, y: 170, fontSize: 40, fontWeight: 700, textResize: "width-height" });
  return fixture("tilted-plane", { scene: { background: "#1b1b1b" }, layers: [card, screen, picture, glow, panel, label], times: [1] });
}

export const scenes = [
  rectangleCorners(),
  ellipseArcs(),
  stars(),
  vectorPaths(),
  trimPaths(),
  textLayout(),
  textEffects(),
  textChange(),
  counters(),
  gradients(),
  strokeAlignment(),
  shadowAndBlur(),
  blendModes(),
  masks(),
  groupClipping(),
  componentOverride(),
  motionPaths(),
  reveals(),
  easings(),
  sceneBackground(),
  stagger(),
  playbackVisibility(),
  nestedTransforms(),
  mediaSpeedRamp(),
  mediaReverse(),
  colorGrading(),
  cutoutPop(),
  captionPop(),
  blurEffects(),
  edgeEffects(),
  light(),
  particleOverlays(),
  tiltedPlane(),
  ...moveScenes(),
];
