// The shared move fields (move.js SHARED: ease, speed, color, accent, angle) on the two-shot
// cuts (engine/blocks/moves/cuts.js) and transitions (transitions.js), their new knobs, and a
// guard that those files name colors and curves only in their defaults tables.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";

const CUT_NAMES = ["zoom-blur", "flash", "light-leak", "slice", "glitch", "blur-dissolve", "card-tilt", "shape-wipe"];

function sceneOf(width = 1920, height = 1080, group = false) {
  const layers = [
    createLayer("image", { id: "shot-b", name: "shot-b", src: "/b.png", x: 0, y: 0, width, height }),
    createLayer("image", { id: "shot-a", name: "shot-a", src: "/a.png", x: 0, y: 0, width, height }),
  ];
  if (group) {
    layers[1] = createLayer("group", { id: "shot-a", name: "shot-a", x: 0, y: 0, width, height });
    layers.push(createLayer("image", { id: "inner", name: "inner", src: "/a.png", x: 0, y: 0, width, height, parentId: "shot-a" }));
  }
  return createScene({ id: "s", name: "S", width, height, duration: 5, layers });
}

function run(name, fields = {}, { seed = 1, scene = sceneOf(), dur = null } = {}) {
  const definition = MOVES[name];
  return runMove(definition, { id: "m", input: readMoveInput(definition, { from: "shot-a", to: "shot-b", ...fields }), scene,
    style: styleFor({ look: "crisp", frame: { width: scene.width, height: scene.height } }), fonts: defaultFonts, start: 1, dur, media: () => null, seed });
}
const json = (made) => JSON.stringify(made);
const times = (made) => [...made.animations.map((entry) => entry.animation), ...made.added.flatMap((entry) => entry.layer.animations)]
  .flatMap((animation) => [animation.start, animation.start + (animation.duration ?? 0)]);

for (const file of ["cuts.js", "transitions.js"]) test(`${file} names hex colors and curves only in its defaults table`, () => {
  const source = readFileSync(new URL(`./blocks/moves/${file}`, import.meta.url), "utf8");
  const begin = source.indexOf("// defaults:start");
  const end = source.indexOf("// defaults:end");
  assert.ok(begin > 0 && end > begin, `${file} has one defaults table`);
  const rest = source.slice(0, begin) + source.slice(end);
  assert.equal(source.split("// defaults:start").length, 2);
  assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], "no hex color outside the table");
  assert.deepEqual(rest.match(/\bCURVES\b/g) ?? [], [], "no kit CURVES read outside the table");
  // Four numbers a bezier could hold (x 0 to 1, y within 3); a rect such as [0, 0, 100, 100] is not one.
  const beziers = (rest.match(/\[\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\]/g) ?? [])
    .filter((text) => JSON.parse(text).every((number) => Math.abs(number) <= 3));
  assert.deepEqual(beziers, [], "no bezier literal outside the table");
});

test("every cut takes ease and speed, and each changes what it makes", () => {
  for (const name of CUT_NAMES) {
    const plain = json(run(name));
    assert.notEqual(json(run(name, { ease: "whip" })), plain, `${name} ease`);
    assert.notEqual(json(run(name, { ease: [0.2, 0.8, 0.2, 1] })), plain, `${name} ease bezier`);
    assert.notEqual(json(run(name, { speed: 2 }, { dur: 0.8 })), json(run(name, {}, { dur: 0.8 })), `${name} speed`);
  }
});

test("speed keeps every beat inside the move and only gathers the motion toward its key moment", () => {
  for (const name of CUT_NAMES) {
    const made = run(name, { speed: 3 }, { dur: 0.8 });
    const plain = run(name, {}, { dur: 0.8 });
    const [low, high] = [Math.min(...times(plain)), Math.max(...times(plain))];
    for (const time of times(made)) assert.ok(time >= low - 1e-6 && time <= high + 1e-6, `${name}: ${time} stays in ${low}..${high}`);
    // Slice ends when its last band has left, so it may end sooner; none ends later.
    assert.ok(made.end <= plain.end && made.start === plain.start, `${name} stays in its span`);
  }
  // Slower: glitch's two-frame jump lasts longer.
  const jump = (made) => made.animations.find((entry) => entry.animation.id === "m.from-jump").animation.duration;
  assert.ok(jump(run("glitch", { speed: 0.5 }, { dur: 0.6 })) > jump(run("glitch", {}, { dur: 0.6 })));
});

test("the new knobs change the look, and their defaults give the old one", () => {
  const changes = {
    "zoom-blur": [{ punch: 1.6 }, { blur: 0.3 }, { settle: 1.4 }],
    flash: [{ color: "#ff3355" }],
    "light-leak": [{ color: "#3366ff" }, { accent: "#ffffff" }],
    slice: [{ color: "#112233" }, { accent: "#ff0000" }],
    glitch: [{ split: 0.2 }, { angle: 90 }, { blocks: 3 }],
    "blur-dissolve": [{ blur: 60 }, { overlap: 0.3 }],
    "card-tilt": [{ turn: 20 }, { shift: 0.6 }, { scale: 0.6 }, { direction: "up" }],
    "shape-wipe": [{ color: "#00ff88" }],
  };
  for (const [name, list] of Object.entries(changes)) {
    for (const fields of list) assert.notEqual(json(run(name, { direction: undefined, ...fields })), json(run(name)), `${name} ${JSON.stringify(fields)}`);
  }
  const same = { "zoom-blur": { punch: 1.25, blur: 0.75, settle: 1.15 }, glitch: { split: 0.45, angle: 0, blocks: 0 }, "blur-dissolve": { blur: 28, overlap: 0.55 },
    "card-tilt": { direction: "left", turn: 50, shift: 0.32, scale: 0.82 }, flash: { color: "#ffffff", speed: 1 } };
  for (const [name, fields] of Object.entries(same)) {
    const base = name === "card-tilt" ? { direction: "left" } : {};
    assert.equal(json(run(name, fields)), json(run(name, base)), `${name} defaults`);
  }
});

test("shared fields are checked: ease names or a bezier, hex colors, speed and angle ranges", () => {
  const flash = MOVES.flash;
  assert.throws(() => readMoveInput(flash, { from: "a", to: "b", ease: "bouncy" }), /linear, accelerate/);
  assert.throws(() => readMoveInput(flash, { from: "a", to: "b", ease: [2, 0, 0, 1] }), /x1 and x2 from 0 to 1/);
  assert.throws(() => readMoveInput(flash, { from: "a", to: "b", color: "red" }), /hex color/);
  assert.throws(() => readMoveInput(flash, { from: "a", to: "b", speed: 9 }), /0.5 to 4/);
  assert.throws(() => readMoveInput(MOVES.glitch, { from: "a", to: "b", angle: 270 }), /-180 to 180/);
  assert.equal(readMoveInput(flash, { from: "a", to: "b", color: "#abcdef" }).color, "#ABCDEF");
  assert.deepEqual(readMoveInput(flash, { from: "a", to: "b", ease: [0.1, 0, 0.2, 1] }).ease, [0.1, 0, 0.2, 1]);
  const made = run("flash", { ease: "linear" });
  assert.deepEqual(made.added[0].layer.animations.find((animation) => animation.name === "Flash fades").easing, [0, 0, 1, 1]);
});

test("glitch: split and rgb shift follow angle, torn bands are seeded mask pairs on screen only around the jump", () => {
  const made = run("glitch", { angle: 90, blocks: 3 }, { seed: 4 });
  const split = made.animations.find((entry) => entry.animation.id === "m.from-split").animation;
  assert.equal(split.to.direction, 90);
  const jump = made.animations.find((entry) => entry.animation.id === "m.from-jump").animation;
  assert.ok(jump.to.y > jump.from.y, "a 90 degree jump goes down");
  const masks = made.added.filter((entry) => entry.layer.isMask);
  const copies = made.added.filter((entry) => entry.layer.move.part.startsWith("block-") && !entry.layer.isMask);
  assert.equal(masks.length, 3);
  assert.equal(copies.length, 3);
  for (const { layer } of [...masks, ...copies]) assert.deepEqual(layer.animations.map((animation) => animation.kind), ["show", "hide"]);
  for (const { layer } of copies) assert.equal(layer.src, "/a.png");
  // Vertical bands for an up or down jump.
  for (const { layer } of masks) assert.equal(layer.height, 1080);
  assert.equal(json(run("glitch", { blocks: 3 }, { seed: 4 })), json(run("glitch", { blocks: 3 }, { seed: 4 })));
  assert.notEqual(json(run("glitch", { blocks: 3 }, { seed: 4 })), json(run("glitch", { blocks: 3 }, { seed: 5 })));
  const grouped = run("glitch", { blocks: 2 }, { scene: sceneOf(1920, 1080, true) });
  assert.ok(grouped.notes.some((note) => note.includes("no bands")));
});

test("card-tilt up and down turn about the horizontal axis and slide in y", () => {
  const made = run("card-tilt", { direction: "up" });
  const away = made.animations.find((entry) => entry.animation.id === "m.from-tilt").animation;
  assert.ok(away.to.rotateX > 0 && away.to.y < 0 && away.to.rotateY === undefined && away.to.x === undefined);
  const into = made.animations.find((entry) => entry.animation.id === "m.to-tilt").animation;
  assert.equal(into.easing, "back-out");
  assert.deepEqual(run("card-tilt", { direction: "down", ease: "fly" }).animations.find((entry) => entry.animation.id === "m.to-tilt").animation.easing, [0.76, 0, 0.24, 1]);
});

// transitions.js: zoom-through (push, target, reverse), whip-pan and mask-through-shape.
const TRANSITIONS = {
  "zoom-through": {}, "zoom-through target": { to: undefined, target: { layer: "phone-screen" } }, "zoom-through reverse": { to: undefined, reverse: true, title: "title" },
  "whip-pan": { direction: "left" }, "mask-through-shape": {},
};
function runT(label, fields = {}, { dur = null } = {}) {
  const scene = sceneOf();
  scene.layers.push(createLayer("group", { id: "phone", name: "phone", x: 660, y: 140, width: 600, height: 800 }),
    createLayer("rectangle", { id: "phone-screen", name: "phone-screen", x: 40, y: 40, width: 520, height: 720, parentId: "phone" }),
    createLayer("text", { id: "title", name: "title", text: "Hi", x: 600, y: 480, width: 720, height: 120 }));
  const name = label.split(" ")[0];
  const base = { ...TRANSITIONS[label], ...(label === "zoom-through target" ? { from: "phone" } : {}) };
  return run(name, { ...base, ...fields }, { scene, dur });
}

test("every transition takes ease and speed, each changes what it makes, and speed stays inside the move", () => {
  for (const label of Object.keys(TRANSITIONS)) {
    const plain = runT(label, {}, { dur: 1 });
    assert.notEqual(json(runT(label, { ease: "linear" }, { dur: 1 })), json(plain), `${label} ease`);
    const quick = runT(label, { speed: 3 }, { dur: 1 });
    assert.notEqual(json(quick), json(plain), `${label} speed`);
    const [low, high] = [Math.min(...times(plain)), Math.max(...times(plain))];
    for (const time of times(quick)) assert.ok(time >= low - 1e-6 && time <= high + 1e-6, `${label}: ${time} stays in ${low}..${high}`);
  }
});

test("transition knobs change the look, and their defaults give the old one", () => {
  const flashOf = (made) => made.added.find((entry) => entry.layer.move.part === "flash")?.layer;
  assert.equal(flashOf(runT("zoom-through", { color: "#ff3355" })).fill, "#FF3355", "color alone turns the flash on");
  assert.equal(flashOf(runT("zoom-through", { color: "#ff3355", flash: "none" })), undefined);
  assert.equal(json(runT("zoom-through", { flash: "white", color: "#ffffff" })), json(runT("zoom-through", { flash: "white" })));
  // whip-pan: an axis angle is its direction; smear 0.24 is the default.
  for (const [angle, direction] of [[0, "right"], [180, "left"], [90, "down"], [-90, "up"]])
    assert.equal(json(runT("whip-pan", { direction: undefined, angle })), json(runT("whip-pan", { direction })), `angle ${angle}`);
  assert.equal(json(runT("whip-pan", { smear: 0.24 })), json(runT("whip-pan")));
  const smearOf = (made) => made.animations.find((entry) => entry.animation.id === "m.from-smear").animation.to;
  assert.equal(smearOf(runT("whip-pan", { smear: 0.5 })).length, 960);
  // Off the axes both shots move in x and y, the smear along the angle, and they meet along an edge.
  const slant = runT("whip-pan", { direction: undefined, angle: 30 });
  const whip = slant.animations.find((entry) => entry.animation.id === "m.to-whip").animation;
  assert.deepEqual(Object.keys(whip.to), ["x", "y"]);
  assert.equal(smearOf(slant).angle, 30);
  // The smear holds that angle while it rises, on the shots and their copies.
  const smears = [...slant.animations.map((entry) => entry.animation), ...slant.added.flatMap((entry) => entry.layer.animations)]
    .filter((animation) => animation.name === "Smear");
  assert.equal(smears.length, 4);
  for (const smear of smears) assert.deepEqual(smear.from, { length: 0, angle: 30 });
  assert.equal(whip.to.y - whip.from.y, 1080, "the steeper side sets the travel: up to the frame's height");
  assert.throws(() => runT("whip-pan", { angle: 30 }), /direction or angle/);
  // Copies fill the corners: beside from one frame width back (rows), beside to one forward.
  const fills = Object.fromEntries(slant.added.map((entry) => [entry.layer.move.part, entry.layer]));
  const fromWhip = slant.animations.find((entry) => entry.animation.id === "m.from-whip").animation;
  assert.equal(fills["fill-to"].src, "/b.png");
  assert.equal(fills["fill-to"].animations.find((animation) => animation.name === "Whip").from.x, fromWhip.from.x - 1920);
  assert.equal(fills["fill-from"].animations.find((animation) => animation.name === "Whip").to.x, whip.to.x + 1920);
  // Near the x axis the width bounds the travel: copies sit a frame height away; an axis angle adds none.
  const steep = runT("whip-pan", { direction: undefined, angle: 10 });
  assert.equal(steep.added.find((entry) => entry.layer.move.part === "fill-to").layer.animations[0].from.y, steep.animations.find((entry) => entry.animation.id === "m.from-whip").animation.from.y - 1080);
  assert.equal(runT("whip-pan", { direction: undefined, angle: 90 }).added.length, 0);
  // mask-through-shape: ring width and color; 0 drops the ring.
  const ringOf = (made) => made.added.find((entry) => entry.layer.move.part === "ring")?.layer;
  const style = styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } });
  assert.equal(json(runT("mask-through-shape", { ring: 5, accent: style.colors.accent })), json(runT("mask-through-shape")));
  assert.equal(ringOf(runT("mask-through-shape", { ring: 12, accent: "#00ff88" })).strokeWidth, 12);
  assert.equal(ringOf(runT("mask-through-shape", { accent: "#00ff88" })).stroke, "#00FF88");
  assert.equal(ringOf(runT("mask-through-shape", { ring: 0 })), undefined);
});
