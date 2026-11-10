// Unit tests for the moves library (engine/blocks/move.js and engine/blocks/moves/): every move is
// described for the library with technique tags and a runnable example; readMoveInput refuses
// bad fields with a plain answer; runMove is deterministic for a seed, works at 16:9 and 9:16
// and in reduced motion; placeMove and removeMove put a move in and take it out again exactly;
// caption-words groups fast words so every group can be read. The gates on rendered pixels are
// in backend/agent-moves.test.mjs (a sample) and tests/moves-gate.mjs (by hand).
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { placeMove, readMoveInput, removeMove, runMove } from "./blocks/move.js";
import { applyOperations } from "./operations.js";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { layoutText } from "./textLayout.js";
import { MOVES, MOVE_NAMES, moveOf } from "./blocks/moves/index.js";
import { captionGroups, wordKeys } from "./blocks/moves/type.js";
import { textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";
import { DETECTABLE_TAGS, TECHNIQUE_TAGS } from "./techniques.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { techniquesUsed } from "./quality/techniques.js";
import { sameMotion } from "./quality/rules/motion.js";
import { flashCandidates } from "./quality/pixels.js";
import { runQuality } from "./quality/index.js";
import { createDocument, parseDocument } from "./model.js";
import { rampTimes } from "./blocks/moves/roll.js";
import { hide as hideAt } from "./blocks/moves/kit.js";
import { frameTransform } from "./camera.js";
import { homeCamera } from "./blocks/moves/plane.js";
import { groupLayers } from "./grouping.js";
import { compactRecording } from "./recording.js";
import { worldMatrix, point } from "./geometry.js";

const round3 = (value) => Math.round(value * 1000) / 1000;

const VOCABULARY = new Set(TECHNIQUE_TAGS);
// The moves whose library example runs as is (impact-accent needs a measured cue: its own test below).
const SWEPT = MOVE_NAMES.filter((name) => !MOVES[name].needsCue);

const PICTURES = {
  "screen-a": { id: "screen-a.png", src: "/api/media/screen-a.png", width: 720, height: 1564, name: "screen-a" },
  "screen-b": { id: "screen-b.png", src: "/api/media/screen-b.png", width: 720, height: 1564, name: "screen-b" },
  "screen-c": { id: "screen-c.png", src: "/api/media/screen-c.png", width: 720, height: 1564, name: "screen-c" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "logo" },
};
const media = (ref) => {
  if (!PICTURES[ref]) throw new Error(`No picture ${ref}.`);
  return PICTURES[ref];
};

// The clip is a screen recording too (screen-recording's example): a pointer slide and one click.
const CLIP_RECORDING = compactRecording({ frame: { width: 1600, height: 900 }, scale: 1, duration: 8, cursors: { c1: { shape: "arrow" } } }, [
  { t: 0, type: "move", x: 300, y: 300, cursor: "c1" }, { t: 0.8, type: "move", x: 900, y: 500, cursor: "c1" },
  { t: 1, type: "down", x: 900, y: 500, button: "left", clicks: 1, source: "agent" }, { t: 1.08, type: "up", x: 900, y: 500, button: "left", source: "agent" },
]);

/** A scene with the layers the library examples name: a clip under two full-frame shots, and a phone. */
function sceneFor(width, height, duration = 5) {
  const phoneHeight = Math.round(height * 0.62);
  const phoneWidth = Math.round(phoneHeight * 720 / 1564);
  return createScene({ id: "s", name: "Scene", width, height, duration, layers: [
    createLayer("video", { id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width, height, mediaSourceDuration: 8, mediaFreeze: "none", recording: CLIP_RECORDING }),
    createLayer("image", { id: "shot-b", name: "shot-b", src: "/api/media/wall.png", x: 0, y: 0, width, height }),
    createLayer("image", { id: "shot-a", name: "shot-a", src: "/api/media/street.png", x: 0, y: 0, width, height }),
    createLayer("image", { id: "phone", name: "phone", src: "/api/media/phone.png", x: Math.round((width - phoneWidth) / 2), y: Math.round((height - phoneHeight) / 2), width: phoneWidth, height: phoneHeight }),
    createLayer("path", { id: "underline", name: "underline", x: width * 0.3, y: height * 0.6, width: width * 0.4, height: 40, path: "M0 20 C200 0 400 40 600 20", fillEnabled: false, stroke: "#ffffff", strokeWidth: 8 }),
    // carry's example carries this card into the phone's screen.
    createLayer("rectangle", { id: "app-card", name: "app-card", x: width * 0.08, y: height * 0.1, width: width * 0.3, height: width * 0.18, radius: 32, fill: "#2A2D33" }),
    // type-on's example types this prompt into its box.
    createLayer("rectangle", { id: "prompt-field", name: "prompt-field", x: width * 0.1, y: height * 0.45, width: width * 0.25, height: 110, radius: 26, fill: "#1A1D22" }),
    createLayer("text", { id: "prompt", name: "prompt", x: width * 0.1 + 40, y: height * 0.45 + 28, width: 400, height: 56, text: "Find issues with loading", fontSize: 44, textResize: "width-height", textAlign: "left", fill: "#EDEEF0", role: "ui" }),
  ] });
}

/** Runs a move's library example on a scene, like the move op does (at defaults to 0.3). */
function runExample(name, scene, { reduced = false, seed = 1 } = {}) {
  const definition = MOVES[name];
  const { at = 0.3, dur = null, ...fields } = definition.example;
  const frame = { width: scene.width, height: scene.height };
  return runMove(definition, {
    id: name, input: readMoveInput(definition, fields), scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts,
    start: at, dur, media, logo: { media: PICTURES.logo }, reduced, seed,
  });
}

test("every move is described for the library with tags from the vocabulary and an example", () => {
  assert.equal(MOVE_NAMES.length, 45);
  for (const name of MOVE_NAMES) {
    const move = MOVES[name];
    assert.equal(move.name, name);
    for (const key of ["about", "fits", "setup"]) assert.ok(typeof move[key] === "string" && move[key].length > 3, `${name} has ${key}`);
    assert.ok(move.tags.length >= 1);
    for (const tag of move.tags) assert.ok(VOCABULARY.has(tag), `${name}: ${tag} is in the technique vocabulary`);
    for (const [key, field] of Object.entries(move.fields)) assert.ok(field.about, `${name}.${key} says what it is`);
    assert.ok(move.example && typeof move.example === "object");
    if (move.needsAt) assert.equal(typeof move.example.at, move.needsCue ? "string" : "number", `${name}'s example gives at`);
  }
  assert.throws(() => moveOf("zoom-thru"), /zoom-through/);
});

test("align puts a move's span starting at, centered on or ending at its at (FilmCraft start_for)", () => {
  const scene = sceneFor(1920, 1080);
  const run = (align) => runMove(MOVES.flash, { id: "flash", input: readMoveInput(MOVES.flash, { from: "shot-a", to: "shot-b" }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 2, dur: 0.4, align, media });
  assert.deepEqual(["start", "center", "end"].map((align) => run(align).start), [2, 1.8, 1.6]);
  assert.throws(() => runMove(MOVES.flash, { id: "flash", input: readMoveInput(MOVES.flash, { from: "shot-a", to: "shot-b" }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.1, dur: 0.4, align: "end", media }), /would start at -0.3 s/);
});

test("readMoveInput refuses missing, unknown-shaped and out-of-range fields", () => {
  const zoom = MOVES["zoom-through"];
  assert.throws(() => readMoveInput(zoom, { from: "shot-a" }), /to/);
  assert.throws(() => readMoveInput(zoom, { from: "shot-a", to: "shot-b", point: [10] }), /point/);
  assert.throws(() => readMoveInput(MOVES["caption-words"], { words: [{ text: "a", at: 0 }], text: "a b" }), /exactly one of words or text/);
  assert.throws(() => readMoveInput(MOVES["caption-words"], {}), /words or text/);
  assert.equal(readMoveInput(MOVES["caption-words"], { text: "a b", position: "center" }).position, "middle");
  assert.throws(() => readMoveInput(MOVES["rgb-split-hit"], { layer: "shot-a", strength: 3 }), /strength/);
  assert.throws(() => readMoveInput(MOVES["whip-pan"], { from: "shot-a", to: "shot-b", direction: "sideways" }), /direction/);
  assert.deepEqual(readMoveInput(zoom, { from: "shot-a", to: "shot-b" }).from, "shot-a");
});

test("every example builds at 16:9 and 9:16 and in reduced motion, the same way for the same seed", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    for (const name of SWEPT) {
      const made = runExample(name, sceneFor(width, height));
      assert.ok(made.added.length + made.animations.length > 0, `${name} makes something`);
      assert.ok(made.end > made.start && made.end <= 5, `${name} ends inside the scene`);
      for (const { layer } of made.added) assert.ok(layer.id.startsWith(`${name}-`) && layer.move.instance === name, `${layer.id} is named after the move`);
      // The name an agent reads is the layer's ID: unique, and it works in an edit.
      for (const { layer } of made.added) assert.equal(layer.name, layer.id, `${name}: ${layer.id} is called by its ID`);
      for (const { animation } of made.animations) assert.ok(animation.id.startsWith(`${name}.`), `${animation.id} is named after the move`);
      assert.deepEqual(runExample(name, sceneFor(width, height)), made, `${name} is the same for the same seed`);
      const reduced = runExample(name, sceneFor(width, height), { reduced: true });
      // Reduced motion has no blur sweeps: no animated blur effect and no streaks.
      const effects = [...reduced.animations.map((entry) => entry.animation), ...reduced.added.flatMap((entry) => entry.layer.animations)]
        .filter((animation) => animation.kind === "effect");
      assert.ok(effects.every((animation) => !["zoom-blur", "directional-blur", "spin-blur", "sparks"].includes(animation.effect)), `${name} reduced has no blur sweeps`);
    }
  }
  // Another seed changes the seeded choices of a move that has them.
  assert.notDeepEqual(runExample("rgb-split-hit", sceneFor(1920, 1080), { seed: 2 }), runExample("rgb-split-hit", sceneFor(1920, 1080)));
});

test("freeze-shutter stops the clip on the beat, blinks once and plays again; masked-type fills a word with the clip or stands it behind the subject", () => {
  const scene = sceneFor(1920, 1080);
  const run = (name, fields, at, dur = null, reduced = false) => runMove(MOVES[name], { id: name, input: readMoveInput(MOVES[name], fields), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: at, dur, media, reduced });
  const freeze = run("freeze-shutter", { layer: "clip", hold: 0.8, release: "cut" }, 1);
  const speed = Object.fromEntries(freeze.animations.filter(({ animation }) => animation.to?.speed !== undefined).map(({ animation }) => [animation.name, [animation.start, animation.to.speed]]));
  assert.deepEqual(speed, { Freeze: [1, 0], "Play again": [1.8, 1] });
  assert.equal(freeze.end, 1.8);
  const blink = freeze.added.find(({ layer }) => layer.id === "freeze-shutter-shutter").layer.animations.find((animation) => animation.name === "Blink");
  assert.ok(blink.start === 1 && blink.duration <= 0.12 && blink.from.opacity <= 0.9, "one short white blink, under the flash limit");
  assert.deepEqual(freeze.tags, ["freeze-frame", "flash"]);
  assert.equal(run("freeze-shutter", { layer: "clip", shutter: "kick" }, 1).added.length, 0, "a kick has no blink");
  assert.throws(() => run("freeze-shutter", { layer: "shot-a" }, 1), /video layer/);
  assert.throws(() => run("freeze-shutter", { layer: "clip", hold: 0.6, label: "the crosswalk is clear now" }, 1), /hold of at least/);
  // Inside the word: plate, then the word as a mask, then a silent copy of the clip it shows.
  const filled = run("masked-type", { layer: "clip", text: "walk" }, 0.5, 2.4);
  assert.deepEqual(filled.added.map(({ layer, place }) => [layer.move.part, place]), [["plate", { above: "clip" }], ["word", { above: "masked-type-plate" }], ["fill", { above: "masked-type-word" }]]);
  const [, word, fill] = filled.added.map(({ layer }) => layer);
  assert.ok(word.isMask && word.type === "text" && word.text === "walk" && word.textCase === "upper");
  assert.ok(fill.type === "video" && fill.src === "/api/media/clip.mp4" && fill.volume === 0);
  // Behind the subject: the word goes under the cut-out, over a soft wash.
  scene.layers.push(createLayer("video", { id: "person", name: "person", src: "/api/media/clip-subject.webm", x: 0, y: 0, width: 1920, height: 1080 }));
  const behind = run("masked-type", { layer: "clip", text: "walk", subject: "person", place: "top" }, 0.5, 2.4);
  assert.deepEqual(behind.added.map(({ layer, place }) => [layer.move.part, place]), [["wash", { below: "person" }], ["word", { below: "person" }]]);
  assert.ok(behind.tags.includes("parallax") && behind.tags.includes("type-behind"));
  assert.ok(!filled.tags.includes("type-behind"));
  // A light brand's text color is dark: the word over the dark wash takes the light one.
  const light = runMove(MOVES["masked-type"], { id: "masked-type", input: readMoveInput(MOVES["masked-type"], { layer: "clip", text: "walk", subject: "person" }), scene, style: styleFor({ look: "crisp", brand: { colors: { bg: "#F7F5F0", text: "#141414", accent: "#FF4D94" } }, frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.5, dur: 2.4, media });
  assert.equal(light.added.find(({ layer }) => layer.move.part === "word").layer.fill, "#F7F5F0");
});

test("tile-ring tiles from other clips play from the move's start, so a ring late in a long video still shows them", () => {
  const scene = sceneFor(1920, 1080, 40);
  const clips = { ...PICTURES, "reel.mp4": { id: "reel.mp4", src: "/api/media/reel.mp4", width: 1920, height: 1080, duration: 5, name: "reel.mp4" } };
  const ring = runMove(MOVES["tile-ring"], { id: "tile-ring", input: readMoveInput(MOVES["tile-ring"], { layer: "clip", pictures: ["reel.mp4"], count: 8 }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 30, dur: 3.2, media: (ref) => clips[ref] });
  const reels = ring.added.map(({ layer }) => layer).filter((layer) => layer.src === "/api/media/reel.mp4");
  assert.equal(reels.length, 4);
  for (const tile of reels) {
    assert.equal(tile.mediaStart, 30);
    assert.equal(tile.mediaFreeze, "last");
    assert.ok(tile.mediaOffset >= 0 && tile.mediaOffset + 3.2 <= 5, "each tile has picture to the end of the move");
  }
});

test("placeMove puts a move in and removeMove takes exactly that out again", () => {
  const scene = sceneFor(1920, 1080);
  const before = structuredClone(scene);
  const made = runExample("mask-through-shape", scene);
  placeMove(scene, { id: "mask-through-shape", name: "mask-through-shape", settings: { at: 1 } }, made);
  assert.deepEqual(scene.moves, [{ id: "mask-through-shape", name: "mask-through-shape", settings: { at: 1 }, tags: ["mask-wipe"], start: made.start, end: made.end }]);
  const order = scene.layers.map((layer) => layer.id);
  assert.ok(order.indexOf("shot-b") > order.indexOf("shot-a"), "the shot being revealed is raised above the other");
  assert.equal(order[order.indexOf("shot-b") - 1], "mask-through-shape-mask", "the mask sits just below what it reveals");
  // delete_layer of everything the move touched drops its record too; one layer left keeps it.
  const doc = (layers) => applyOperations(createDocument({ id: "d", name: "moves", scenes: [{ ...structuredClone(scene), id: "s" }] }),
    layers.map((layerId) => ({ type: "delete_layer", sceneId: "s", layerId }))).scenes[0].moves?.length ?? 0;
  assert.equal(doc(["mask-through-shape-mask"]), 1);
  assert.equal(doc(["mask-through-shape-mask", "mask-through-shape-ring", "shot-a", "shot-b"]), 0);
  removeMove(scene, "mask-through-shape");
  assert.deepEqual(scene.moves, []);
  assert.deepEqual(scene.layers.map((layer) => [layer.id, layer.animations]).sort(), before.layers.map((layer) => [layer.id, layer.animations]).sort());
});

test("check names the techniques a move built, set pieces included, once each", () => {
  // Set pieces only moves make: check finds them from the scene's move records.
  for (const tag of ["tile-ring", "swipe-cards", "logo-match-move", "status-line", "speed-lines", "screen-zoom"]) assert.ok(DETECTABLE_TAGS.includes(tag), `${tag} is detectable`);
  const found = (name) => {
    const scene = sceneFor(1920, 1080);
    const made = runExample(name, scene);
    placeMove(scene, { id: name, name, settings: {} }, made);
    const document = parseDocument(createDocument({ id: "d", name: "moves", scenes: [{ ...scene, id: "scene" }] }));
    return { found: techniquesUsed(kinoTimeline(document, "scene", { fonts: defaultFonts })), made };
  };
  for (const name of ["tile-ring", "swipe-cards", "status-line", "logo-match-move", "speed-lines-phone", "window-punch-in", "lift-focus", "card-into-device", "draw-on"]) {
    const { found: tags, made } = found(name);
    for (const tag of MOVES[name].tags) {
      assert.ok(tags[tag]?.some((entry) => entry.at >= made.start - 0.3 && entry.at <= made.end + 0.3), `${name}: check finds ${tag}`);
    }
  }
  // A tag the document already shows (rgb-split from its two hits) is not counted again.
  const { found: hit } = found("rgb-split-hit");
  assert.equal(hit["rgb-split"].length, 2);
});

test("roll speeds up along its ramp, lands with a hold and a cue per item; swipe-cards ramps its gaps", () => {
  assert.deepEqual(rampTimes(3, 1.6, 0.1, "expo"), [1.6, 0.4, 0.1]);
  assert.deepEqual(rampTimes(3, 1, 0.2, "linear"), [1, 0.6, 0.2]);
  assert.deepEqual(rampTimes(2, 1, 0.2, "none"), [1, 1]);
  const run = (name, fields, at = 0.3, scene = sceneFor(1920, 1080)) => runMove(MOVES[name], { id: name, input: readMoveInput(MOVES[name], fields), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: at, media });
  const made = run("roll", { items: ["a", "b", "c", "d"], land: "KINO", lead: "NEW", first: 1.6, last: 0.1 }, 0.3);
  assert.deepEqual(made.cues.map((cue) => cue.name), ["roll.1", "roll.2", "roll.3", "roll.4", "roll.land"]);
  const gaps = made.cues.slice(1).map((cue, index) => round3(cue.time - made.cues[index].time));
  assert.ok(gaps.every((gap, index) => index === 0 || gap < gaps[index - 1]), `each item shows shorter than the one before: ${gaps}`);
  assert.equal(gaps[0], 1.6);
  assert.ok(made.end - made.cues.at(-1).time >= 1.6, "the land holds");
  // Each item cuts on at its cue; the land and the lead then slide together into one line.
  const parts = Object.fromEntries(made.added.map(({ layer }) => [layer.move.part, layer]));
  assert.equal(run("roll", { items: ["a", "screen-a"] }).added[1].layer.type, "image", "an uploaded picture's name rolls the picture");
  assert.throws(() => run("roll", { items: ["a", "screen-a"], lead: "NEW" }), /lead goes with words only/);
  assert.deepEqual(parts.item2.animations.map((animation) => [animation.kind, animation.start]), [["show", 1.9], ["hide", made.cues[2].time]]);
  const together = parts.item5.animations.find((animation) => animation.name === "Slide together");
  assert.ok(together && together.to.x < together.from.x && parts.lead.animations.some((animation) => animation.name === "Slide together"));
  // The wheel turns every item up a slot per step: the middle one full, its neighbors dim.
  const wheel = run("roll", { items: ["one", "two", "three", "four"], layout: "wheel" });
  const third = wheel.added.find(({ layer }) => layer.move.part === "item3").layer;
  assert.equal(third.opacity, 0, "two slots away it is not shown yet");
  const turns = third.animations.map((animation) => animation.to.opacity);
  assert.deepEqual(turns, [0.32, 1, 0.32, 0], "it comes up dim, is the middle, goes dim above the land, then clears");
  assert.throws(() => run("roll", { layers: ["shot-a", "shot-b"], layout: "wheel" }), /wheel takes items/);
  const short = run("roll", { items: ["one", "two", "three", "four", "five", "six", "seven", "eight"], layout: "wheel", hold: 0.6 }, 0.3, sceneFor(1920, 1080, 8));
  const lastMotion = Math.max(...short.added.flatMap(({ layer }) => layer.animations.filter((animation) => animation.kind !== "hide").map((animation) => animation.start + (animation.duration ?? 0))));
  assert.ok(short.end >= round3(lastMotion), `a short hold still ends after the clearing fade (${short.end} vs ${lastMotion})`);
  // With dur, it lands at dur minus hold; a clip item plays from its own show time, and taking
  // the move away puts the clip's own timing back.
  const reel = sceneFor(1920, 1080, 8);
  const timed = runMove(MOVES.roll, { id: "roll", input: readMoveInput(MOVES.roll, { layers: ["shot-a", "clip", "shot-b"], hold: 2.4 }), scene: reel, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.3, dur: 4.8, media });
  assert.equal(timed.cues.at(-1).time, 2.7);
  assert.deepEqual(timed.sets, [{ layerId: "clip", properties: { mediaStart: timed.cues[1].time } }]);
  placeMove(reel, { id: "roll", name: "roll", settings: {} }, timed);
  assert.equal(reel.layers.find((layer) => layer.id === "clip").mediaStart, timed.cues[1].time);
  removeMove(reel, "roll");
  assert.equal(reel.layers.find((layer) => layer.id === "clip").mediaStart, 0);
  // swipe-cards: the gaps shrink from every to last, and a fast card's swipe shrinks to fit,
  // but its YES or NO stays up long enough to read (the reading-time gate needs 0.67 s).
  const swipes = (fields) => run("swipe-cards", { pictures: ["screen-a", "screen-b", "screen-c", "logo"], answers: ["no", "yes", "no"], ...fields }, 0.3, sceneFor(1920, 1080, 12)).added;
  const shows = (added) => added.filter(({ layer }) => /^fill\d$/.test(layer.move.part)).map(({ layer }) => layer.animations.find((animation) => animation.name === "Show").start);
  const steady = shows(swipes({}));
  const fast = swipes({ every: 3, ramp: "expo" });
  const ramped = shows(fast);
  assert.deepEqual(steady.slice(1).map((time, index) => round3(time - steady[index])), [2, 2]);
  const ramp = ramped.slice(1).map((time, index) => round3(time - ramped[index]));
  assert.ok(ramp[0] > ramp[1] && ramp[1] < 1.5, `swipes speed up: ${ramp}`);
  for (const { layer } of fast.filter((entry) => /^answer\d$/.test(entry.layer.move.part))) {
    const stamp = layer.animations.find((animation) => animation.name === "Stamp");
    const fling = layer.animations.find((animation) => /^Swipe/.test(animation.name));
    assert.ok(fling.start - (stamp.start + stamp.duration) >= 0.67, `${layer.text} reads for ${round3(fling.start - stamp.start - stamp.duration)} s`);
  }
});

test("caption-words groups fast words so every group stays long enough to read", () => {
  const fast = ["we", "built", "a", "tiny", "app", "that", "talks", "back"].map((text, index) => ({ text, at: 0.3 + index * 0.15 }));
  const groups = captionGroups(fast, 2.6);
  assert.ok(groups.length < fast.length, "fast words are merged");
  assert.deepEqual(groups.flatMap((group) => group.words), fast, "no word is lost or reordered");
  for (const group of groups) assert.ok(group.end - group.at >= 0.66, `"${group.text}" is on screen ${group.end - group.at} s`);
  // No caption ends on a small word like "the" or "in".
  const judge = [["this", 0.61], ["is", 1.16], ["lowkey", 1.46], ["the", 1.75], ["best", 1.89], ["project", 2.18], ["we", 2.54], ["saw", 2.72], ["in", 2.86], ["this", 2.97], ["hackathon.", 3.11]]
    .map(([text, at]) => ({ text, at }));
  for (const group of captionGroups(judge, 4.2, { energy: "high" })) assert.ok(!/\b(the|in)$/.test(group.text), `"${group.text}" ends on a small word`);
  const slow = ["one", "two", "three"].map((text, index) => ({ text, at: index * 1.2 }));
  assert.equal(captionGroups(slow, 4).length, 3, "slow words stay one at a time");
  // group 1: one word a caption; a word shown under the 0.67 s reading time still takes the next.
  const talk = ["so", "we", "gave", "the", "team"].map((text, index) => ({ text, at: index * 0.85 }));
  assert.deepEqual(captionGroups(talk, 5, { group: 1 }).map((group) => group.text), ["so", "we", "gave", "the", "team"]);
  assert.ok(captionGroups(fast, 2.6, { group: 1 }).every((group) => group.end - group.at >= 0.35));
  // A word a little short holds (the next waits, never over 0.3 s behind) instead of joining.
  const brisk = ["hey", "oak", "take", "me", "home"].map((text, index) => ({ text, at: 3 + index * 0.7 }));
  const singles = captionGroups(brisk, 7, { group: 1, until: 9 });
  assert.ok(singles.length >= 4 && singles.every((group) => group.at - group.words[0].at <= 0.3 + 1e-9), JSON.stringify(singles.map((group) => [group.text, group.at])));
  // Fast speech (4 words a second) never joins into one long line.
  const rapid = ["hey", "oak", "whats", "on", "my", "calendar", "today"].map((text, index) => ({ text, at: 3 + index * 0.25 }));
  assert.ok(captionGroups(rapid, 5, { group: 1, until: 9 }).length >= 3);
  // The move's span starts at its first word, not at its at.
  const scene = sceneFor(1920, 1080, 12);
  const made = runMove(MOVES["caption-words"], { id: "cw", input: readMoveInput(MOVES["caption-words"], { words: brisk, group: 1 }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0, media });
  assert.equal(made.start, 3);
});

test("caption-words highlight active and entrance pop key each word to when it is said", () => {
  const group = { at: 0.4, end: 2.6, words: [{ text: "so", at: 0.4 }, { text: "we gave", at: 0.8 }, { text: "it eyes.", at: 1.4 }] };
  assert.deepEqual(wordKeys(group).say.delays, [0, 0.4, 0.4, 1, 1], "a timed phrase times each of its words");
  assert.deepEqual(wordKeys(group).said.delays, [0.4, 1, 1, 2.2, 2.2], "the last words keep the accent until the group ends");
  const frame = { width: 1080, height: 1920 };
  const made = runMove(MOVES["caption-words"], {
    id: "c", input: readMoveInput(MOVES["caption-words"], { highlight: "active", entrance: "pop", words: group.words.map((word, index) => (index === 2 ? { ...word, end: 2.6 } : word)) }),
    scene: sceneFor(1080, 1920, 4), style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.4, media,
  });
  const scene = createScene({ id: "s", width: 1080, height: 1920, duration: 4, layers: made.added.map(({ layer }) => layer) });
  const layer = parseDocument(createDocument({ id: "d", scenes: [scene] })).scenes[0].layers.find((entry) => entry.move?.part === "w1");
  const plan = textAnimationPlan(layer, defaultFonts);
  const at = (time) => plan.units.map((unit, index) => textAnimationUnitState(plan, index, time));
  // At 1 s "we gave" is said: accent, popped in; "so" sits at 70%; "it eyes." waits in place,
  // shown at 70% and 92% so the line stays centered.
  const [so, we, gave, it] = at(1);
  assert.equal(so.fill.toLowerCase(), "#f4f2eeb3");
  assert.equal(we.fill.toLowerCase(), "#ff6b4aff");
  assert.equal(gave.fill, we.fill);
  assert.equal(it.fill.toLowerCase(), "#f4f2eeb3");
  assert.deepEqual([we.opacity, we.scaleX, it.opacity, it.scaleX], [1, 1, 1, 0.92]);
  // 0.06 s after its onset a word is between 92% and 100%, never past it (no overshoot).
  const popping = at(1.46)[3];
  assert.ok(popping.scaleX > 0.92 && popping.scaleX < 1, String(popping.scaleX));
});

test("rgb-split-hit with kick 0 leaves the scale alone and is not a beat-kick", () => {
  const run = (fields) => runMove(MOVES["rgb-split-hit"], {
    id: "hit", input: readMoveInput(MOVES["rgb-split-hit"], { layer: "shot-a", beats: [2.2], ...fields }), scene: sceneFor(1920, 1080),
    style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 1, media, logo: { media: PICTURES.logo },
  });
  const scales = (made) => made.animations.filter(({ animation }) => "scaleX" in (animation.to ?? {}));
  const kicked = run({});
  assert.ok(kicked.tags.includes("beat-kick"));
  assert.equal(scales(kicked).length, 4, "a kick and a settle on each hit");
  // The kick sets only the scale, so the layer's own moves of x and y go on.
  assert.ok(scales(kicked).every(({ animation }) => !("x" in animation.to) && !("y" in animation.to)));
  const still = run({ kick: 0 });
  assert.deepEqual(still.tags, ["rgb-split", "glitch-hit"]);
  assert.equal(scales(still).length, 0);
  assert.ok(still.animations.some(({ animation }) => animation.effect === "rgb-shift"), "the colors still split");
});

test("speed-lines-phone pushes in after the layer's own rise, from where the rise leaves it", () => {
  const scene = sceneFor(1920, 1080, 6);
  const phone = scene.layers.find((layer) => layer.id === "phone");
  phone.animations = [{ id: "rise", name: "Rise", kind: "custom", start: 1, duration: 0.7, easing: "smooth", from: { y: phone.y + 500, scaleX: 0.7, scaleY: 0.7 }, to: { y: phone.y, scaleX: 1, scaleY: 1 } }];
  const run = (dur) => runMove(MOVES["speed-lines-phone"], {
    id: "drop", input: readMoveInput(MOVES["speed-lines-phone"], { layer: "phone" }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }),
    fonts: defaultFonts, start: 1, dur, media,
  });
  const push = run(3.8).animations.find(({ animation }) => animation.name === "Push in").animation;
  assert.equal(push.start, 1.7, "it waits for the rise to end");
  assert.equal(push.from.y, phone.y, "from where the rise leaves the phone");
  assert.equal(push.from.scaleX, 1);
  assert.ok(Math.abs(push.to.scaleX - 1.05) < 1e-6);
  // Too little time after the rise: no push, and the receipt says why.
  const short = run(1.2);
  assert.ok(!short.animations.some(({ animation }) => animation.name === "Push in"));
  assert.ok(short.notes.some((note) => /no push in: phone moves by its own animations until 1.7 s/.test(note)), short.notes.join("; "));
});

test("status-line: a square icon is the tile itself and the brand's name is not written under it", () => {
  const scene = sceneFor(1920, 1080);
  const frame = { width: 1920, height: 1080 };
  const made = runMove(MOVES["status-line"], {
    id: "s", input: readMoveInput(MOVES["status-line"], { icon: "logo", lines: [{ text: "is listening…", at: 0.6 }] }), scene, style: styleFor({ look: "crisp", frame }),
    fonts: defaultFonts, start: 0.3, media, logo: { media: PICTURES.logo, text: "oak" },
  });
  const parts = Object.fromEntries(made.added.map(({ layer }) => [layer.move.part, layer]));
  assert.equal(parts.name, undefined, "no second name under a wordmark icon");
  assert.equal(parts.tile, undefined, "no white plate around the icon");
  assert.equal(parts.icon.width, 216);
  assert.ok(parts.icon.radius > 0, "the icon has rounded corners");
  const right = runMove(MOVES["status-line"], {
    id: "s", input: readMoveInput(MOVES["status-line"], { icon: "logo", side: "right", lines: [{ text: "is listening…", at: 0.6 }] }), scene, style: styleFor({ look: "crisp", frame }),
    fonts: defaultFonts, start: 0.3, media, logo: { media: PICTURES.logo },
  });
  const icon = right.added.find(({ layer }) => layer.move.part === "icon").layer;
  assert.equal(icon.x + icon.width / 2, 1920 - (parts.icon.x + parts.icon.width / 2), "side right mirrors the left column");
  // place bottom-left (a badge): a small tile low in the corner, the line under it on its
  // left edge, and the words switch with a cut.
  const badge = runMove(MOVES["status-line"], {
    id: "s", input: readMoveInput(MOVES["status-line"], { icon: "logo", place: "bottom-left", lines: [{ text: "is controlling…", at: 0.6 }, { text: "is drawing…", at: 2.4 }] }),
    scene: sceneFor(1920, 1080, 5), style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.3, media, logo: { media: PICTURES.logo },
  });
  const corner = Object.fromEntries(badge.added.map(({ layer }) => [layer.move.part, layer]));
  assert.ok(corner.icon.width < 130 && corner.icon.x < 200, JSON.stringify([corner.icon.x, corner.icon.width]));
  assert.equal(corner.status.x, corner.icon.x, "the line starts at the tile's left edge");
  assert.ok(corner.status.y > corner.icon.y + corner.icon.height && corner.status.y + corner.status.height > 900, "low in the frame, under the tile");
  assert.ok(corner.status.fontSize < 50, `small type (${corner.status.fontSize} px)`);
  const swap = badge.added.flatMap(({ layer }) => layer.animations).find((animation) => animation.kind === "change-text");
  assert.equal(swap.in.preset, "fade-in");
  // A dip to black already in the scene: the badge leaves as it starts, not over the black.
  const dipped = sceneFor(1920, 1080, 5);
  dipped.layers.push(createLayer("rectangle", { id: "dip", x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", animations: [{ id: "dip.in", kind: "show", start: 4.2 }] }));
  const quiet = runMove(MOVES["status-line"], {
    id: "s", input: readMoveInput(MOVES["status-line"], { icon: "logo", place: "bottom-left", lines: [{ text: "is controlling…", at: 0.6 }, { text: "is drawing…", at: 2.4 }] }),
    scene: dipped, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.3, media, logo: { media: PICTURES.logo },
  });
  assert.ok(quiet.added.every(({ layer }) => layer.animations.some((animation) => animation.kind === "hide" && animation.start === 4.2)), quiet.notes.join("; "));
  // Footage added after it (the same edit or later) goes under the badge; other layers still go on top.
  const placed = sceneFor(1920, 1080, 5);
  placeMove(placed, { id: "s", name: "status-line", settings: {} }, badge);
  const stacked = applyOperations(createDocument({ id: "d", name: "badge", scenes: [placed] }), [
    { type: "add_layer", sceneId: placed.id, layerType: "video", properties: { id: "later-clip", src: "/api/media/clip.mp4", width: 1920, height: 1080 } },
    { type: "add_layer", sceneId: placed.id, layerType: "rectangle", properties: { id: "flash", width: 1920, height: 1080 } },
  ]).scenes[0].layers.map((layer) => layer.move?.part ?? layer.id);
  assert.deepEqual(stacked.slice(-(badge.added.length + 2)), ["later-clip", ...badge.added.map(({ layer }) => layer.move.part), "flash"]);
});

test("caption-words puts its shade under a phone it keeps clear of, so the phone is not darkened", () => {
  const scene = sceneFor(1920, 1080);
  scene.layers.find((layer) => layer.id === "phone").x = 1300;
  const frame = { width: 1920, height: 1080 };
  const made = runMove(MOVES["caption-words"], {
    id: "c", input: readMoveInput(MOVES["caption-words"], { words: [{ text: "turn right", at: 0.5 }, { text: "now.", at: 1.4 }], scrim: true }), scene, style: styleFor({ look: "crisp", frame }),
    fonts: defaultFonts, start: 0.5, media,
  });
  const shade = made.added.find(({ layer }) => layer.move.part === "scrim");
  assert.deepEqual(shade.place, { below: "phone" });
  // The shade hugs the words (a padded, feathered box), never a gradient over the frame.
  const words = made.added.find(({ layer }) => layer.move.part === "w1").layer;
  assert.equal(typeof shade.layer.fill, "string");
  assert.ok(shade.layer.height < 1080 * 0.25 && shade.layer.x < words.x && shade.layer.x + shade.layer.width > words.x + words.width, JSON.stringify(shade.layer));
  // A card in the middle leaves no clear spot: the captions sit over it, and so does the shade.
  const card = sceneFor(1920, 1080);
  Object.assign(card.layers.find((layer) => layer.id === "phone"), { x: 300, width: 1320, y: 100, height: 900 });
  const over = runMove(MOVES["caption-words"], {
    id: "c", input: readMoveInput(MOVES["caption-words"], { words: [{ text: "turn right", at: 0.5 }, { text: "now.", at: 1.4 }], scrim: true }), scene: card, style: styleFor({ look: "crisp", frame }),
    fonts: defaultFonts, start: 0.5, media,
  });
  assert.equal(over.added.find(({ layer }) => layer.move.part === "scrim").place, "top");
  // By default no box: light words in their halo shadow pass contrast over any picture.
  // Words dimmed to 70% (karaoke) could fail over white, so they keep the shade.
  const caption = (fields) => runMove(MOVES["caption-words"], { id: "c", input: readMoveInput(MOVES["caption-words"], { words: [{ text: "turn right", at: 0.5 }], ...fields }),
    scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.5, media }).added.map(({ layer }) => layer.move.part);
  assert.ok(!caption({}).includes("scrim"));
  assert.ok(caption({ highlight: "active" }).includes("scrim"));
  assert.ok(!caption({ highlight: "active", scrim: false }).includes("scrim"));
  const sizeOf = (size) => runMove(MOVES["caption-words"], { id: "c", input: readMoveInput(MOVES["caption-words"], { words: [{ text: "hi", at: 0.5 }], size }),
    scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.5, media }).added.find(({ layer }) => layer.move.part === "w1").layer.fontSize;
  assert.ok(sizeOf("small") < sizeOf("big") * 0.6, `small ${sizeOf("small")} px, big ${sizeOf("big")} px`);
  const status = runMove(MOVES["status-line"], { id: "s", input: readMoveInput(MOVES["status-line"], { label: "oak", lines: [{ text: "is listening…", at: 0.6 }] }),
    scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 0.3, media });
  assert.ok(!status.added.some(({ layer }) => layer.move.part === "pill"), "no pill behind a light, shadowed status line");
});

test("perceive-insert cuts to the marked subject of the same footage, in sync and muted, then cuts back", () => {
  const frame = { width: 1920, height: 1080 };
  const scene = sceneFor(1920, 1080, 6);
  scene.layers.push(createLayer("video", { id: "street", name: "street", src: "/api/media/street.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaStart: 0, mediaOffset: 10, mediaDuration: 6,
    subjectBoxes: { src: "/api/media/street.mp4", boxes: [{ at: 12.5, box: [60, 20, 20, 20], by: "agent" }] } }));
  const definition = MOVES["perceive-insert"];
  const run = (fields, extra = {}) => runMove(definition, { id: "pi", input: readMoveInput(definition, fields), scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 2, media, ...extra });
  const made = run({ layer: "street" });
  const shot = made.added[0].layer;
  // The box at 60 to 80% x, 20 to 40% y would need 5x: held at 3.2x so the footage stays sharp.
  assert.deepEqual([shot.width, shot.height], [1920 * 3.2, 1080 * 3.2]);
  assert.ok(shot.x <= 0 && shot.x + shot.width >= 1920 && shot.y <= 0 && shot.y + shot.height >= 1080, "the insert covers the frame");
  assert.deepEqual([shot.mediaStart, shot.mediaOffset, shot.volume], [2, 12, 0]);
  assert.deepEqual(shot.animations.map((animation) => [animation.kind, animation.start]), [["show", 2], ["hide", 3]]);
  assert.equal(made.end, 3);
  const pushed = run({ layer: "street", region: [40, 40, 50, 50], entry: "push", label: "bus 42" }, { dur: 1.2 });
  const push = pushed.added[0].layer.animations.find((animation) => animation.id.endsWith(".push"));
  assert.deepEqual([push.start, push.duration, push.from.width, push.to.width], [2, 0.24, 1920, 3840]);
  // The push blurs (no judder) and the region is the insert's subject (no crop_no_subject).
  assert.ok(pushed.added[0].layer.animations.some((animation) => animation.effect === "zoom-blur"));
  assert.deepEqual(pushed.added[0].layer.subjectBoxes.boxes[0].box, [40, 40, 50, 50]);
  assert.ok(pushed.added.some(({ layer }) => layer.text === "bus 42"));
  assert.throws(() => run({ layer: "shot-a" }), /give region/);
});

test("voice-type sets a spoken line from the transcript, each word on as it is said, held after the last", async () => {
  const { spokenLine } = await import("./blocks/moves/footage.js");
  const scene = sceneFor(1920, 1080, 6);
  scene.layers.push(createLayer("audio", { id: "vo", name: "vo", src: "/api/media/vo.wav", mediaStart: 1, mediaDuration: 5, mediaOffset: 0 }));
  const transcript = { words: [{ text: "Um,", start: 0.1, end: 0.3 }, { text: "I", start: 0.4, end: 0.5 }, { text: "can", start: 0.6, end: 0.8 }, { text: "see", start: 0.9, end: 1.2 }, { text: "the", start: 1.3, end: 1.4 }, { text: "bus.", start: 1.5, end: 1.9 }] };
  const words = spokenLine(scene, scene.layers.at(-1), transcript, "see the bus");
  assert.deepEqual(words, [{ text: "see", at: 1.9, end: 2.2 }, { text: "the", at: 2.3, end: 2.4 }, { text: "bus.", at: 2.5, end: 2.9 }]);
  assert.throws(() => spokenLine(scene, scene.layers.at(-1), transcript, "see a car"), /not said/);
  const definition = MOVES["voice-type"];
  const style = styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } });
  const made = runMove(definition, { id: "vt", input: readMoveInput(definition, { words, over: "plate" }), scene, style, fonts: defaultFonts, start: 0, media });
  const placed = made.added.filter(({ layer }) => layer.type === "text").map(({ layer }) => layer);
  assert.deepEqual(placed.map((layer) => layer.text), ["see", "the", "bus."]);
  assert.deepEqual(placed.map((layer) => layer.animations.find((animation) => animation.kind === "show").start), [1.9, 2.3, 2.5]);
  assert.ok(placed.every((layer) => layer.animations.find((animation) => animation.kind === "hide").start === 3.7), "the line holds 0.8 s after the last word");
  assert.equal(placed[2].fill, style.colors.accent);
  assert.ok(placed[0].x < placed[1].x && placed[1].x < placed[2].x && placed[0].fontSize >= 100, "big, in reading order");
  assert.equal(made.end, 3.7);
  // Over footage the shade hugs the line: a full-frame dim fading in failed luma_jump on real footage.
  const over = runMove(definition, { id: "vt", input: readMoveInput(definition, { words }), scene, style, fonts: defaultFonts, start: 0, media });
  assert.ok(over.added.find(({ layer }) => layer.move.part === "back").layer.height < 1080 / 2);
});

test("type-on types each letter at its keystroke, the caret steps to the last letter's advance, the field grows and each word cues", () => {
  const made = runExample("type-on", sceneFor(1920, 1080));
  const letters = made.animations.find((entry) => entry.animation.id === "type-on.text-letters").animation;
  assert.equal(letters.unit, "letters");
  // About 14 letters a second, a word pause after each space ("Find issues"), never two keys at once.
  const gaps = letters.delays.slice(1).map((delay, index) => round3(delay - letters.delays[index]));
  assert.ok(gaps.every((gap) => gap > 0 && gap <= 0.18), `keystroke gaps ${gaps}`);
  assert.ok(gaps[4] - gaps[3] > 0.04, "the letter after a space waits the word pause");
  const caret = made.added.find((entry) => entry.layer.move.part === "caret").layer;
  const steps = caret.animations.filter((entry) => /\.k\d+$/.test(entry.id));
  assert.ok(steps.length > 20 && steps.every((step, index) => index === 0 || step.to.x > steps[index - 1].to.x), "the caret moves right letter by letter");
  assert.ok(caret.animations.some((entry) => entry.id.includes("idle-off")), "it blinks after the typing");
  const grow = made.animations.filter((entry) => entry.layerId === "prompt-field");
  assert.ok(grow.length && grow.at(-1).animation.to.width > 480, "the field widens to keep the text inside it");
  assert.deepEqual([made.cues[0].name, made.cues.at(-1).name, made.cues.length], ["type-on.1", "type-on.typed", 5]);
  // A short dur speeds the typing up to fit; a picture layer is refused.
  const definition = MOVES["type-on"];
  const options = { id: "type-on", scene: sceneFor(1920, 1080), style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.3, media };
  const quick = runMove(definition, { ...options, input: readMoveInput(definition, { layer: "prompt" }), dur: 1.5 });
  assert.equal(quick.end, 1.8);
  assert.match(quick.notes.join(" "), /to fit dur 1.5/);
  // A dur shorter than the wait still types every letter before the end.
  const tight = runMove(definition, { ...options, input: readMoveInput(definition, { layer: "prompt" }), dur: 0.4 });
  const typed = tight.animations.find((entry) => entry.animation.id === "type-on.text-letters").animation;
  assert.ok(typed.start + typed.delays.at(-1) + typed.duration <= tight.end + 1e-6, `last letter at ${typed.start + typed.delays.at(-1)}, end ${tight.end}`);
  // A gradient text gives the caret its first stop's color.
  const gradient = sceneFor(1920, 1080);
  gradient.layers.find((layer) => layer.id === "prompt").fill = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#FFB000" }, { offset: 1, color: "#FF4D94" }] };
  const tinted = runMove(definition, { ...options, scene: gradient, input: readMoveInput(definition, { layer: "prompt" }) });
  assert.equal(tinted.added.find((entry) => entry.layer.move.part === "caret").layer.fill, "#FFB000");
  assert.throws(() => runMove(definition, { ...options, input: { layer: "phone" } }), /give a text layer/);
  // The typed line goes with the caret after the hold, or at until.
  const gone = (made) => made.animations.find((entry) => entry.animation.id === "type-on.text-gone")?.animation.start;
  assert.equal(gone(quick), 1.8);
  // The field goes with the typed line, so no emptied box stays on screen.
  assert.equal(made.animations.find((entry) => entry.animation.id === "type-on.field-gone")?.animation.start, gone(made));
  const kept = runMove(definition, { ...options, input: readMoveInput(definition, { layer: "prompt", until: 4.2 }) });
  assert.deepEqual([gone(kept), kept.end], [4.2, 4.2]);
});

test("stream holds the hot color on the newest words and settles the rest; rewrite blurs the old words out; decode settles random same-case letters into any text", () => {
  const scene = sceneFor(1920, 1080);
  const made = runExample("stream", scene);
  const arrive = made.animations.find((entry) => entry.animation.id === "stream.text-arrive").animation;
  const settle = made.animations.find((entry) => entry.animation.id === "stream.text-settle").animation;
  // "Find issues with loading": 4 words at 4 a second; each settles two words after it arrives.
  assert.deepEqual([arrive.unit, arrive.stagger, arrive.to.fill, settle.from.fill, settle.to.fill], ["words", 0.25, "#FF6B4A", "#FF6B4A", "#EDEEF0"]);
  assert.equal(round3(settle.start - arrive.start), 0.5);
  assert.equal(made.end, round3(0.3 + 0.25 * 5 + 0.375));
  const plan = textAnimationPlan({ ...scene.layers.find((layer) => layer.id === "prompt"), animations: [arrive, settle] }, defaultFonts);
  const fillAt = (index, time) => String(textAnimationUnitState(plan, index, time).fill).toUpperCase();
  assert.equal(fillAt(2, 0.3 + 0.25 * 2 + 0.2), "#FF6B4A", "the newest word is still hot");
  assert.equal(fillAt(0, 1.6), "#EDEEF0", "an earlier word has settled to the text's color");
  const style = styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } });
  assert.throws(() => runMove(MOVES.stream, { id: "s1", input: readMoveInput(MOVES.stream, { layer: "prompt", from: "red" }), scene, style, fonts: defaultFonts, start: 0, media }), /not accent, accent2, dim/);
  // Letters count every space too (the renderer gives each its turn), so the last letter settles by the end.
  const letters = runMove(MOVES.stream, { id: "s1", input: readMoveInput(MOVES.stream, { layer: "prompt", unit: "letters" }), scene, style, fonts: defaultFonts, start: 0.3, dur: 0.8, media });
  const lettersSettle = letters.animations.find((entry) => entry.animation.id === "s1.text-settle").animation;
  assert.ok(lettersSettle.start + lettersSettle.stagger * ([..."Find issues with loading"].length - 1) + lettersSettle.duration <= letters.end + 1e-6);
  // A secondary line at part opacity streams to that opacity, not to full.
  const faint = sceneFor(1920, 1080);
  faint.layers.find((layer) => layer.id === "prompt").opacity = 0.6;
  const faded = runMove(MOVES.stream, { id: "s1", input: readMoveInput(MOVES.stream, { layer: "prompt", from: "dim" }), scene: faint, style, fonts: defaultFonts, start: 0.3, media });
  assert.deepEqual([faded.animations[0].animation.to.opacity, faded.animations[1].animation.to.opacity], [0.24, 0.6]);
  const swapped = runExample("rewrite", scene);
  const out = swapped.animations.find((entry) => entry.animation.id === "rewrite.text-out").animation;
  assert.ok(out.to.blur > 0 && out.to.opacity === 0, "the old words blur out");
  // The layer's own words (shown from 0) stay long enough to read: 24 characters at 20 a second.
  assert.equal(out.start, 1.2);
  const copy = swapped.added.find((entry) => entry.layer.move.part === "new").layer;
  assert.equal(copy.text, "Optimistic loading refactor");
  assert.equal(copy.animations.find((entry) => entry.id.endsWith(".arrive")).unit, "letters");
  // After type-on hid the line (2.66 s), nothing blurs out: the new words draw and stream from the start.
  const typed = sceneFor(1920, 1080);
  typed.layers.find((layer) => layer.id === "prompt").animations = [{ id: "t.gone", ...hideAt(2.66) }];
  const late = runMove(MOVES.rewrite, { id: "r", input: readMoveInput(MOVES.rewrite, { layer: "prompt", new: "Loading fixed", rate: 7 }), scene: typed, style, fonts: defaultFonts, start: 2.75, dur: 1.4, media });
  const fresh = late.added.find((entry) => entry.layer.move.part === "new").layer;
  assert.deepEqual([fresh.visible, fresh.opacity, fresh.animations.find((entry) => entry.id.endsWith(".arrive")).start], [true, 1, 2.75]);
  assert.ok(!late.animations.some((entry) => entry.animation.id === "r.text-out") && /not showing at 2.75 s/.test(late.notes.join(" ")));
  // A dur that would squeeze the words past reading speed is refused with the dur that reads.
  assert.throws(() => runMove(MOVES.rewrite, { id: "r", input: readMoveInput(MOVES.rewrite, { layer: "prompt", new: "Loading fixed" }), scene, style, fonts: defaultFonts, start: 0.3, dur: 1.4, media }), /16.7 words a second .* give dur 1.5 s or more \(2.\d s at 4 a second\)/);
  const decoded = runExample("decode", scene);
  const noise = decoded.added.find((entry) => entry.layer.move.part === "noise").layer;
  assert.equal(noise.role, "decor");
  assert.match(noise.text, /^[A-Z][a-z]{3} [a-z]{6} [a-z]{4} [a-z]{7}$/, "random letters keep each letter's case");
  const last = noise.animations.filter((entry) => entry.kind === "change-text").at(-1);
  assert.ok(last.text.startsWith("Find issues with"), "the letters settle left to right");
  assert.ok(decoded.animations.find((entry) => entry.animation.id === "decode.text-in").animation.start < decoded.end, "the layer is full before the noise hides");
});

test("assemble scatters each letter by its own seeded offset, turn and size and settles them into the word; out flies them apart", () => {
  const scene = sceneFor(1920, 1080);
  const prompt = scene.layers.find((layer) => layer.id === "prompt");
  const made = runExample("assemble", scene);
  const { layerId, animation } = made.animations.find((entry) => entry.animation.id === "assemble.text-in");
  const fade = made.animations.find((entry) => entry.animation.id === "assemble.text-fade-in").animation;
  assert.deepEqual([layerId, made.animations.length, animation.unit, animation.textAnchor, animation.kind], ["prompt", 2, "letters", "letters", "in"]);
  // The letters show fast, so the scatter is seen, and with the same stagger as their flight.
  assert.ok(fade.duration < 0.2 && fade.stagger === animation.stagger && !fade.scatter);
  assert.deepEqual([animation.scatter.x, animation.scatter.y, animation.scatter.rotation, animation.scatter.scale], [60, 80, 30, 0.5]);
  // The scatter survives a save: the document keeps it on the animation.
  const saved = parseDocument(JSON.stringify(createDocument({ scenes: [createScene({ id: "s", name: "S", layers: [{ ...prompt, animations: [animation] }] })] })));
  assert.deepEqual(saved.scenes[0].layers[0].animations[0].scatter, animation.scatter);
  const plan = textAnimationPlan({ ...prompt, animations: [animation, fade] }, defaultFonts);
  const at = (index, time) => textAnimationUnitState(plan, index, time);
  // Mid-flight every letter is somewhere else, turned and sized its own way; at the end all are home.
  const early = [0, 1, 2].map((index) => at(index, 0.35));
  assert.equal(new Set(early.map((state) => Math.round(state.x))).size, 3, "the letters start at different places");
  assert.ok(early.some((state) => Math.abs(state.rotation) > 1) && early.some((state) => Math.abs(state.scaleX - 1) > 0.05));
  for (const index of [0, 5, 23]) {
    const home = at(index, made.end + 0.01);
    assert.deepEqual([round3(home.x), round3(home.y), round3(home.rotation), round3(home.scaleX), home.opacity, home.blur], [prompt.x, prompt.y, 0, 1, 1, 0]);
  }
  assert.ok(made.end - made.start <= 1.2, "the word has formed in about a second");
  assert.equal(runExample("assemble", scene).animations[0].animation.scatter.seed, animation.scatter.seed, "the same seed scatters the same way");
  assert.notEqual(runExample("assemble", scene, { seed: 2 }).animations[0].animation.scatter.seed, animation.scatter.seed);
  assert.ok(at(0, 0.3 + fade.duration).opacity === 1 && Math.abs(at(0, 0.3 + fade.duration).y - prompt.y) > 5, "a letter is full while still away");
  const style = styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } });
  const apart = runMove(MOVES.assemble, { id: "a", input: readMoveInput(MOVES.assemble, { layer: "prompt", mode: "out" }), scene, style, fonts: defaultFonts, start: 1, media });
  const fly = apart.animations.find((entry) => entry.animation.id === "a.text-out").animation;
  const gone = apart.animations.find((entry) => entry.animation.id === "a.text-fade-out").animation;
  assert.deepEqual([fly.kind, fly.to.blur > 0, gone.to.opacity, round3(gone.start + gone.duration)], ["out", true, 0, round3(fly.start + fly.duration)]);
  assert.equal(apart.animations.find((entry) => entry.animation.id === "a.text-hide").animation.start, apart.end);
  const calm = runExample("assemble", scene, { reduced: true });
  assert.deepEqual(Object.keys(calm.animations[0].animation.from), ["opacity"], "reduced motion only fades");
  assert.throws(() => readMoveInput(MOVES.assemble, { layer: "prompt", spread: { x: 10, z: 4 } }), /spread is \{x\?, y\?, angle\?, scale\?\}/);
});

test("split_image cuts a picture into clipped pieces in place; build-in resolves them top-down after the empty beat", async () => {
  const { splitImage } = await import("./splitImage.js");
  const scene = createScene({ id: "s", name: "Scene", width: 1920, height: 1080, duration: 5, layers: [
    createLayer("image", { id: "app", name: "app", src: "/api/media/app.png", x: 160, y: 90, width: 1600, height: 900 }),
  ] });
  const made = splitImage(scene, "app", [{ name: "row2", rect: [5, 40, 90, 10] }, { name: "row1", rect: [5, 20, 90, 10] }], { source: { width: 1000, height: 562 } });
  assert.deepEqual(made.pieces, ["app-row2", "app-row1"]);
  const piece = made.layers.find((layer) => layer.id === "app-row1");
  const pixels = made.layers.find((layer) => layer.id === "app-row1-px");
  // The piece's box is its part of the picture; the whole picture inside sits exactly where it was.
  assert.deepEqual([piece.type, piece.clipContent, piece.x, piece.y, piece.width, piece.height], ["group", true, 240, 270, 1440, 90]);
  assert.deepEqual([pixels.parentId, piece.x + pixels.x, piece.y + pixels.y, pixels.width, pixels.height, pixels.src], ["app-row1", 160, 90, 1600, 900, "/api/media/app.png"]);
  assert.ok(!made.layers.some((layer) => layer.id === "app"));
  assert.match(made.notes.join(" "), /1\.6x its pixels/);
  assert.throws(() => splitImage(scene, "app", [{ name: "a", rect: [50, 0, 60, 10] }]), /inside 0 to 100/);

  const next = { ...scene, layers: made.layers };
  const definition = MOVES["build-in"];
  const built = runMove(definition, {
    id: "build", input: readMoveInput(definition, { layers: ["app-row2", "app-row1"], empty: 0.6, finish: "resolve" }), scene: next,
    style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 1, media,
  });
  const resolve = built.animations.filter((entry) => entry.animation.name === "Resolve");
  assert.deepEqual(resolve.map((entry) => [entry.layerId, entry.animation.start]), [["app-row1", 1.6], ["app-row2", 1.8]]);
  assert.deepEqual(resolve[0].animation.from, { opacity: 0.3, blur: 6, y: 280.8 });
  assert.deepEqual(resolve[0].animation.to, { opacity: 1, blur: 0, y: 270 });
  assert.deepEqual(resolve.map((entry) => entry.animation.duration), [0.4, 0.424]);
  assert.equal(built.end, 2.224);
  assert.ok(built.animations.some((entry) => entry.layerId === "app-row1" && entry.animation.kind === "show" && entry.animation.start === 1.6));
  // Five equal rows alone in a scene still pass the blocking same_motion gate: later rows settle longer.
  const rows = splitImage(scene, "app", [0, 1, 2, 3, 4].map((index) => ({ name: `r${index}`, rect: [0, index * 12, 100, 12] })));
  const rowScene = { ...scene, layers: rows.layers };
  const rowMade = runMove(definition, {
    id: "rows", input: readMoveInput(definition, { layers: rows.pieces, empty: 0.6 }), scene: rowScene,
    style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0, media,
  });
  placeMove(rowScene, { id: "rows", name: "build-in", settings: {} }, rowMade);
  const rowDocument = parseDocument(createDocument({ id: "d", name: "rows", scenes: [{ ...rowScene, id: "scene" }] }));
  assert.deepEqual(sameMotion(kinoTimeline(rowDocument, "scene", { fonts: defaultFonts }), { sceneName: "Scene" }), []);
});

test("carry tweens one layer's box, radius and fill into the next's, crossfades in the middle third and the join into it is no speed_jump", async () => {
  const slide = { id: "tile-in", name: "Slide", kind: "custom", start: 0, duration: 1, easing: [0.4, 0, 1, 1], unit: "layer", stagger: 0, order: "forward", from: { y: 0 }, to: { y: 300 } };
  const scene = createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, layers: [
    createLayer("rectangle", { id: "tile", name: "tile", x: 800, y: 300, width: 320, height: 320, radius: 72, fill: "#2A2D33", animations: [slide] }),
    createLayer("rectangle", { id: "pill", name: "pill", x: 860, y: 900, width: 200, height: 60, radius: 30, fill: "#FFFFFF" }),
  ] });
  const made = runMove(MOVES.carry, { id: "carry", input: readMoveInput(MOVES.carry, { from: "tile", to: "pill" }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 1, media });
  placeMove(scene, { id: "carry", name: "carry", settings: {} }, made);
  const at = (id, time) => evaluateLayer(scene.layers.find((layer) => layer.id === id), time);
  // Both ride one box: the tile's at the start, the pill's (radius and fill too) at the end.
  for (const id of ["tile", "pill"]) {
    assert.deepEqual([at(id, 1).x, at(id, 1).y, at(id, 1).width, at(id, 1).radius], [800, 300, 320, 72]);
    assert.deepEqual([at(id, 1.5).x, at(id, 1.5).y, at(id, 1.5).width, at(id, 1.5).radius, at(id, 1.5).fill.toUpperCase()], [860, 900, 200, 30, "#FFFFFF"]);
  }
  // The pill is hidden until the middle third and drawn over the tile, which then fades and hides.
  assert.deepEqual([at("pill", 0.5).opacity, at("pill", 1.15).opacity, at("pill", 1.34).opacity], [0, 0, 1]);
  assert.ok(scene.layers.findIndex((layer) => layer.id === "pill") > scene.layers.findIndex((layer) => layer.id === "tile"));
  assert.equal(at("tile", 1.3).opacity, 1);
  assert.equal(at("tile", 1.6).visible, false);
  // The tile was already sliding when the carry took over: its joins are a hand-off, not a speed_jump.
  // A linear move that starts as the carry lands (at almost no speed) is still a jump.
  const jumps = async (layers) => {
    const document = parseDocument(createDocument({ id: "d", name: "carry", scenes: [{ ...scene, layers }] }));
    const { findings } = await runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes: ["speed_jump"], pixels: false });
    return findings.map((finding) => finding.itemId);
  };
  // Also when another move made the tile (its animations are found by id, not by the layer's move).
  assert.deepEqual(await jumps(scene.layers.map((layer) => (layer.id === "tile" ? { ...layer, move: { name: "status-line", instance: "line", part: "tile" } } : layer))), []);
  const away = { id: "pill-away", name: "Away", kind: "custom", start: 1.5, duration: 0.5, easing: "linear", unit: "layer", stagger: 0, order: "forward", from: { x: 860 }, to: { x: 1400 } };
  assert.deepEqual(await jumps(scene.layers.map((layer) => (layer.id === "pill" ? { ...layer, animations: [...layer.animations, away] } : layer))), ["pill"]);
  // toRect: the card lands centered in the phone's screen and stays on top; the phone rides around it.
  const phone = sceneFor(1920, 1080);
  placeMove(phone, { id: "carry", name: "carry", settings: {} }, runExample("carry", phone));
  const order = (id) => phone.layers.findIndex((layer) => layer.id === id);
  assert.ok(order("app-card") > order("phone"));
  const card = evaluateLayer(phone.layers[order("app-card")], 1.2);
  const device = evaluateLayer(phone.layers[order("phone")], 1.2);
  assert.ok(Math.abs(card.x + card.width / 2 - (device.x + device.width / 2)) < 1 && card.opacity === 1 && device.opacity === 1, JSON.stringify([card, device].map(({ x, y, width, height, scaleX, opacity }) => ({ x, y, width, height, scaleX, opacity }))));
  // A second carry out of the phone takes the landed card along into the pill, then both go.
  phone.layers.push(createLayer("rectangle", { id: "pill", name: "pill", x: 760, y: 495, width: 400, height: 90, radius: 45, fill: "#F2F2F2" }));
  const again = runMove(MOVES.carry, { id: "carry-2", input: readMoveInput(MOVES.carry, { from: "phone", to: "pill" }), scene: phone, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 2.1, dur: 0.5, media });
  assert.match(again.notes.join(" "), /app-card rides along/);
  placeMove(phone, { id: "carry-2", name: "carry", settings: {} }, again);
  const box = (id, time) => { const state = evaluateLayer(phone.layers[order(id)], time); const w = state.width * state.scaleX, h = state.height * state.scaleY; return { cx: state.x + state.width / 2, cy: state.y + state.height / 2, w, h, opacity: state.opacity, visible: state.visible }; };
  const [ridden, landed] = [box("app-card", 2.55), box("phone", 2.55)];
  assert.ok(Math.abs(ridden.cx - landed.cx) < 40 && ridden.w < landed.w * 1.05, JSON.stringify({ ridden, landed }));
  assert.equal(box("app-card", 2.7).visible, false);
  assert.ok(order("pill") > order("app-card"), "the pill fades in over the card it takes along");
  // to: a split_image piece inside a laid-out group lands at its place on screen (in its group's
  // coordinates); a plain layer in a group names the group and the toRect for it.
  const layout = createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, layers: [
    createLayer("rectangle", { id: "tile", name: "tile", x: 800, y: 300, width: 320, height: 320, fill: "#2A2D33" }),
    createLayer("group", { id: "shot", name: "shot", x: 100, y: 50, width: 1720, height: 980 }),
    createLayer("group", { id: "shot-view", name: "shot-view", parentId: "shot", x: 20, y: 60, width: 800, height: 700, clipContent: true }),
    createLayer("rectangle", { id: "shot-view-px", name: "shot-view-px", parentId: "shot-view", x: 0, y: 0, width: 800, height: 700 }),
    createLayer("rectangle", { id: "shot-num", name: "shot-num", parentId: "shot", x: 900, y: 60, width: 400, height: 100 }),
  ] });
  const onto = (to) => runMove(MOVES.carry, { id: "carry", input: readMoveInput(MOVES.carry, { from: "tile", to }), scene: layout, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 1, media });
  placeMove(layout, { id: "carry", name: "carry", settings: {} }, onto("shot-view"));
  const view = layout.layers.find((layer) => layer.id === "shot-view");
  const [startState, endState] = [evaluateLayer(view, 1), evaluateLayer(view, 1.5)];
  // Its center on screen starts on the tile's (960, 460) and ends at its own place (520, 460), unscaled.
  const center = (state) => [Math.round(100 + state.x + state.width / 2), Math.round(50 + state.y + state.height / 2), Math.round(state.scaleX * 1000) / 1000];
  assert.deepEqual([center(startState).slice(0, 2), center(endState)], [[960, 460], [520, 460, 1]]);
  assert.ok(layout.layers.findIndex((layer) => layer.id === "shot") > layout.layers.findIndex((layer) => layer.id === "tile"), "the piece's group goes over the tile");
  assert.throws(() => onto("shot-num"), /give to: "shot" with toRect: \[52\.3, 6\.1, 23\.3, 10\.2\]/);
  // A piece whose group is scaled (ui-plane on the group) names the group's toRect too.
  layout.layers.find((layer) => layer.id === "shot").scaleX = 1.1;
  assert.throws(() => onto("shot-view"), /scaled or turned .*give to: "shot" with toRect: \[1\.2, 6\.1, 46\.5, 71\.4\]/);
});

test("ui-plane tilts the UI over a void with a falloff that moves with it, rests, swings flat; the vignette hides nothing; frame sees through the tilt; stays sharp; lands flat after frame", async () => {
  const scene = sceneFor(1920, 1080);
  const made = runExample("ui-plane", scene);
  assert.deepEqual(made.added.map(({ layer, place }) => [layer.move.part, place]), [["void", { below: "shot-b" }], ["falloff", { above: "shot-b" }], ["vignette", { above: "ui-plane-falloff" }]]);
  const plane = Object.fromEntries(made.animations.filter(({ layerId }) => layerId === "shot-b").map(({ animation }) => [animation.name, animation]));
  assert.ok(plane["Plane drift"].from.rotateX === 32 && plane["Plane drift"].from.rotateY === 18, "the linear angle: 32 degrees back, turned away to the right");
  // The drift comes to rest just before the swing, so the swing starts from still (no speed_jump).
  assert.ok(plane["Plane drift"].start + plane["Plane drift"].duration < 2.6 - 0.02);
  assert.deepEqual([plane["Swing flat"].start, plane["Swing flat"].to.rotateX, plane["Swing flat"].to.rotateY, plane["Swing flat"].to.rotation], [2.6, 0, 0, 0]);
  const falloff = made.added[1].layer;
  assert.deepEqual(falloff.animations.find((animation) => animation.name === "Plane drift").to, plane["Plane drift"].to, "the falloff is tilted and moved with the plane");
  placeMove(scene, { id: "ui-plane", name: "ui-plane", settings: {} }, made);
  const document = parseDocument(createDocument({ id: "d", name: "plane", scenes: [{ ...scene, id: "scene" }] }));
  const model = kinoTimeline(document, "scene", { fonts: defaultFonts });
  assert.equal(model.items.find((item) => item.id === "ui-plane-vignette").opaque, false, "a gradient that is clear in the middle is not a plate");
  // frame under tilt: the top of a plane tipped back is further away, so framing it zooms in more.
  const cam = createLayer("group", { id: "cam", x: 0, y: 0, width: 1920, height: 1080 });
  const tilted = { ...createLayer("image", { id: "ui", x: 460, y: 240, width: 1000, height: 600, parentId: "cam" }), rotateX: 32, perspective: 1500 };
  const fit = (layer, rect) => frameTransform({ group: cam, layer, layers: [cam, layer], rect, frame: { width: 1920, height: 1080 } }).scaleX;
  assert.ok(fit(tilted, [0, 0, 100, 20]) > fit(tilted, [0, 80, 100, 20]) * 1.1);
  const flat = { ...tilted, rotateX: 0 };
  assert.equal(fit(flat, [0, 0, 100, 20]), fit(flat, [0, 80, 100, 20]));
  // A full-frame 1920 px screenshot stays under 1.3x through the drift, its end and the pushed flat pose.
  const WALL = { width: 1920, height: 1080 };
  const sharp = async (duration, fields) => {
    const shot = sceneFor(1920, 1080, duration);
    shot.layers = shot.layers.filter((layer) => layer.id === "shot-b"); // shot-a would cover it
    const run = runMove(MOVES["ui-plane"], { id: "ui-plane", input: readMoveInput(MOVES["ui-plane"], fields), scene: shot, style: styleFor({ look: "crisp", frame: WALL }), fonts: defaultFonts, start: 0.3, dur: null, media: (ref) => (ref === "/api/media/wall.png" ? { ...WALL, src: ref } : media(ref)) });
    placeMove(shot, { id: "ui-plane", name: "ui-plane", settings: {} }, run);
    const sharpDocument = parseDocument(createDocument({ id: "d", name: "plane", scenes: [{ ...shot, id: "scene" }] }));
    const { findings } = await runQuality(kinoTimeline(sharpDocument, "scene", { fonts: defaultFonts }), { codes: ["soft_upscale"], pixels: false, context: { mediaSizes: { "/api/media/wall.png": WALL } } });
    return findings.map((finding) => finding.measured);
  };
  assert.deepEqual(await sharp(8, { layer: "shot-b" }), []);
  assert.deepEqual(await sharp(5, { layer: "shot-b", flat: 2.6 }), []);
  // frame (a camera group zoomed 2x at 1.2 s) then the swing: the camera goes home, the plane lands centered at 90%.
  const framed = document.scenes[0];
  framed.layers = groupLayers(document, "scene", ["shot-b", "ui-plane-falloff"], { id: "shot-b-camera" }).layers;
  const group = framed.layers.find((layer) => layer.id === "shot-b-camera");
  group.animations = [{ id: "zoom", name: "Camera move", kind: "custom", start: 1.2, duration: 0.7, easing: "expo-out", unit: "layer", stagger: 0, order: "forward", from: { x: group.x, y: group.y, scaleX: 1, scaleY: 1 }, to: { x: group.x - 900, y: group.y - 500, scaleX: 2, scaleY: 2 } }];
  assert.equal(homeCamera(group, framed.layers, { width: 1920, height: 1080 }), 1);
  const landed = (() => {
    const shotB = framed.layers.find((layer) => layer.id === "shot-b");
    const matrix = worldMatrix(shotB, framed.layers, (layer) => evaluateLayer(layer, 2.6 + 0.45));
    const [a, b] = [point(matrix, 0, 0), point(matrix, shotB.width, shotB.height)];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, height: (b.y - a.y) / 1080 };
  })();
  assert.ok(Math.abs(landed.cx - 960) < 2 && Math.abs(landed.cy - 540) < 2 && Math.abs(landed.height - 0.9) < 0.01, JSON.stringify(landed));
  // A roll item: a group of split_image pieces at 0.8x of a 720 px recording, hidden 1-1.8 s.
  // The void and vignette hide and show with it, and the flat plane stays at or under 1.3x its pixels.
  const rec = createScene({ id: "rec", name: "Scene", width: 1920, height: 1080, duration: 5, layers: [
    createLayer("group", { id: "lidar", name: "lidar", x: 660, y: 340, width: 600, height: 400, animations: [{ ...hideAt(1), id: "h" }, { id: "s", name: "Show", kind: "show", start: 1.8 }] }),
    createLayer("group", { id: "lidar-view", name: "lidar-view", parentId: "lidar", x: 0, y: 0, width: 600, height: 400, clipContent: true }),
    createLayer("image", { id: "lidar-px", name: "lidar-px", parentId: "lidar-view", src: "/api/media/rec.png", x: 0, y: 0, width: 576, height: 1024 }),
  ] });
  const onRec = runMove(MOVES["ui-plane"], { id: "ui-plane", input: readMoveInput(MOVES["ui-plane"], { layer: "lidar", flat: 2.6 }), scene: rec, style: styleFor({ look: "crisp", frame: WALL }), fonts: defaultFonts, start: 0.3, media, fileSize: (src) => (src === "/api/media/rec.png" ? { width: 720, height: 1280 } : null) });
  const recVoid = onRec.added.find(({ layer }) => layer.move.part === "void").layer;
  assert.deepEqual([0.5, 1.2, 2].map((time) => evaluateLayer(recVoid, time).visible), [true, false, true]);
  assert.match(onRec.notes.join(" "), /flat at 2\.6 s: the plane lands at [\d.]+x, \d+% of the frame \(not 90%: lidar-px in lidar shows its 720x1280 px file at 0\.8x/);
  const pushed = onRec.animations.find(({ animation }) => animation.name === "Slow push").animation.to.scaleX;
  assert.ok(pushed * 0.8 <= 1.3 && pushed * 0.8 > 1.2, String(pushed));
});

test("accent-hit flashes one word in two frames and decays back in 4-8; light-sweep crosses once; reduced is a plain color change; no same_motion, flashing or spring_on_fade", async () => {
  const drift = { id: "line-drift", name: "Drift", kind: "custom", start: 0, duration: 3, easing: [0.37, 0, 0.63, 1], unit: "layer", stagger: 0, order: "forward", from: { y: 500 }, to: { y: 480 } };
  const build = () => createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, layers: [
    createLayer("text", { id: "line", name: "line", x: 460, y: 500, width: 1000, height: 120, text: "careful, bicycle ahead.", fontSize: 96, textResize: "width-height", fill: "#FFFFFF", animations: [drift] }),
    createLayer("text", { id: "mark", name: "mark", x: 800, y: 760, width: 300, height: 140, text: "oak", fontSize: 120, textResize: "width-height", fill: "#FFFFFF" }),
  ] });
  const style = styleFor({ look: "crisp", brand: { colors: { bg: "#0B0B0D", text: "#FFFFFF", accent: "#FF4F9A" } }, frame: { width: 1920, height: 1080 } });
  const run = (scene, name, fields, start, reduced = false) => runMove(MOVES[name], { id: name, input: readMoveInput(MOVES[name], fields), scene, style, fonts: defaultFonts, start, media, reduced });
  const scene = build();
  const hit = run(scene, "accent-hit", { layer: "line", word: "bicycle" }, 1);
  const sweep = run(scene, "light-sweep", { layer: "mark", width: "40px" }, 1.5);
  const [overlay] = hit.added.map(({ layer }) => layer);
  // Only "bicycle" takes the brand accent; the rest of the copy is transparent, and the line keeps its color.
  assert.deepEqual(overlay.textStyleRanges, [{ start: 9, end: 16, style: { fill: "#FF4F9A" } }]);
  assert.equal(overlay.fill, "#00000000");
  placeMove(scene, { id: "accent-hit", name: "accent-hit", settings: {} }, hit);
  placeMove(scene, { id: "light-sweep", name: "light-sweep", settings: {} }, sweep);
  const at = (id, time) => evaluateLayer(scene.layers.find((layer) => layer.id === id), time);
  assert.deepEqual([at("accent-hit-overlay", 0.9).opacity, at("accent-hit-overlay", 1.067).opacity, at("accent-hit-overlay", 1.15).opacity], [0, 1, 1]);
  const decayFrames = Math.round((hit.end - 1.167) * 30);
  assert.ok(decayFrames >= 4 && decayFrames <= 8, String(decayFrames));
  assert.equal(at("accent-hit-overlay", hit.end + 0.01).visible, false);
  // The copy rides the line's drift, so the word stays on its letters.
  assert.equal(at("accent-hit-overlay", 1.1).y, at("line", 1.1).y);
  const glow = overlay.animations.filter((animation) => animation.effect === "glow");
  assert.deepEqual(glow.map((animation) => [animation.to.radius, animation.to.color, animation.keepStill]), [[30, "#FF4F9A", "off"], [30, "#FF4F9A", "off"]]);
  // The sweep's brightest stop crosses the wordmark once, left to right, at one speed.
  const peak = (time) => at("light-sweep-overlay", time).fill.stops[2].offset;
  const peaks = [1.6, 1.9, 2.2, 2.5].map(peak);
  assert.ok(peaks.every((value, index) => index === 0 || value > peaks[index - 1]), JSON.stringify(peaks));
  assert.ok(Math.abs((peaks[2] - peaks[1]) - (peaks[3] - peaks[2])) < 0.02, JSON.stringify(peaks));
  assert.equal(at("light-sweep-overlay", 1.4).visible, false);
  assert.deepEqual(sweep.tags, ["light-sweep"]);
  // Reduced motion: no glow and no sweep, the word just turns the color and back.
  const calm = [run(build(), "accent-hit", { layer: "line" }, 1, true), run(build(), "light-sweep", { layer: "mark" }, 1, true)];
  for (const made of calm) {
    const animations = made.added.flatMap(({ layer }) => layer.animations);
    assert.ok(animations.every((animation) => animation.kind !== "effect" && typeof animation.from?.fill !== "object"), animations.map((animation) => animation.name).join());
  }
  // Reduced and short: the color's on and off never overlap.
  const short = runMove(MOVES["light-sweep"], { id: "light-sweep", input: readMoveInput(MOVES["light-sweep"], { layer: "mark" }), scene: build(), style, fonts: defaultFonts, start: 1, dur: 0.4, media, reduced: true }).added[0].layer.animations;
  const [on, off] = ["Color on", "Color off"].map((name) => short.find((animation) => animation.name === name));
  assert.ok(on.start + on.duration <= off.start + 1e-9 && off.start + off.duration <= 1.4 + 1e-9, JSON.stringify([on, off]));
  // A styled bigger word keeps its size in the copy, so the hit lands on the real letters; a
  // blur-slide entrance (y and blur) still carries the copy; a fade during the hit is refused.
  const big = createLayer("text", { id: "big", name: "big", x: 200, y: 300, width: 1500, height: 300, text: "watch the BIG bicycle", fontSize: 96, textResize: "width-height", fill: "#FFFFFF",
    textStyleRanges: [{ start: 10, end: 13, style: { fontSize: 160, fontWeight: 800, fill: "#FFD84F" } }] });
  big.animations = [presetAnimation("blur-slide", big, 0.8)];
  const styled = build();
  styled.layers.push(big);
  const bigHit = run(styled, "accent-hit", { layer: "big", word: "bicycle" }, 1);
  const bigCopy = bigHit.added[0].layer;
  assert.deepEqual(bigCopy.textStyleRanges.map(({ style }) => style), [{ fontSize: 160, fontWeight: 800 }, { fill: "#FF4F9A" }]);
  const lines = (layer) => layoutText(layer, defaultFonts).lines.map((line) => [Math.round(line.width), Math.round(line.y ?? 0)]);
  assert.deepEqual(lines(bigCopy), lines(big));
  placeMove(styled, { id: "accent-hit", name: "accent-hit", settings: {} }, bigHit);
  const styledAt = (id) => evaluateLayer(styled.layers.find((layer) => layer.id === id), 1.05);
  assert.ok(styledAt("big").y !== big.y && styledAt("accent-hit-overlay").y === styledAt("big").y, `${styledAt("big").y} ${styledAt("accent-hit-overlay").y}`);
  const faded = build();
  faded.layers[1].animations = [{ id: "out", name: "Fade", kind: "out", start: 1, duration: 0.5, easing: "ease-in", from: { opacity: 1 }, to: { opacity: 0 } }];
  assert.throws(() => run(faded, "accent-hit", { layer: "mark" }, 1.2), /mark fades during the move/);
  assert.throws(() => run(build(), "accent-hit", { layer: "line", word: "car" }, 1), /"car" is not in/);
  assert.throws(() => run(build(), "accent-hit", { layer: "line", color: "pink" }, 1), /hex color/);
  // check: the hit is one flash (no flashing candidate), and the copies add no same_motion or spring_on_fade.
  const document = parseDocument(createDocument({ id: "d", name: "accent", scenes: [scene] }));
  const model = kinoTimeline(document, "scene", { fonts: defaultFonts });
  assert.deepEqual(flashCandidates(model), []);
  const { findings } = await runQuality(model, { codes: ["same_motion", "spring_on_fade", "linear_motion", "easing_repeat", "flashing"], pixels: false });
  assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.itemId}`), []);
});

test("cursor glides on an arc to a layer, squishes 3% and presses the target 2.5% at the click; a drag grabs the layer and it follows a beat behind", () => {
  const scene = sceneFor(1920, 1080);
  const run = (fields) => runMove(MOVES.cursor, { id: "cursor", input: readMoveInput(MOVES.cursor, fields), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0.5, media });
  assert.deepEqual(readMoveInput(MOVES.cursor, { to: [[10, 20], { layer: "phone", point: [50, 10] }] }).to, [{ point: [10, 20] }, { layer: "phone", point: [50, 10] }]);
  assert.throws(() => readMoveInput(MOVES.cursor, { to: [1, 2, 3] }), /a layer, \[x, y\]/);
  const click = run({ to: "app-card" });
  const pointer = click.added.find(({ layer }) => layer.id === "cursor-pointer").layer;
  const anim = (layer, name) => layer.animations.find((entry) => entry.id === `${layer.id}.${name}`);
  // Two curves for x and y: the path bows; the hotspot lands on the card's middle.
  assert.notDeepEqual(anim(pointer, "leg1-x").easing, anim(pointer, "leg1-y").easing);
  const card = scene.layers.find((layer) => layer.id === "app-card");
  const k = 65 / 24;
  assert.ok(Math.abs(anim(pointer, "leg1-x").to.x + 7.75 * k - (card.x + card.width / 2)) < 0.2 && Math.abs(anim(pointer, "leg1-y").to.y + k - (card.y + card.height / 2)) < 0.2);
  assert.equal(anim(pointer, "press1").to.scaleX, 0.97);
  const pressed = click.animations.find(({ animation }) => animation.id === "cursor.target-press1");
  assert.deepEqual([pressed.layerId, pressed.animation.to.scaleX, pressed.animation.start], ["app-card", 0.975, anim(pointer, "press1").start]);
  assert.deepEqual(click.cues, [{ name: "cursor.click", time: pressed.animation.start }]);
  // A drag closes the hand on the card, the card lifts and follows the pointer 0.07 s behind, then drops.
  const drag = run({ drag: "app-card", to: [1400, 700] });
  const dragged = drag.added.find(({ layer }) => layer.id === "cursor-pointer").layer;
  const follow = drag.animations.find(({ animation }) => animation.id === "cursor.drag-follow1-x").animation;
  assert.equal(round3(follow.start - anim(dragged, "leg2-x").start), 0.07);
  assert.equal(round3(follow.to.x - follow.from.x), round3(anim(dragged, "leg2-x").to.x - anim(dragged, "leg2-x").from.x));
  assert.deepEqual(drag.cues.map((cue) => cue.name), ["cursor.grab", "cursor.drop"]);
  assert.ok(drag.added.some(({ layer }) => layer.id === "cursor-grab") && !drag.animations.some(({ animation }) => animation.id === "cursor.target-press1"));
  // The lifted card rides above the highest layer it crosses.
  assert.deepEqual(drag.raises, [{ layerId: "app-card", aboveId: "prompt" }]);
  // A target that is hidden at the click, or turned, is refused.
  const swap = (properties) => { const before = { ...card }; Object.assign(card, properties); try { run({ to: "app-card" }); } finally { Object.assign(card, before); } };
  assert.throws(() => swap({ visible: false }), /app-card is not on screen at/);
  assert.throws(() => swap({ rotation: 8 }), /cannot aim at app-card: .*turned/);
});

test("impact-accent runs only at a cue that motivates its kind; a shake peaks on the hit's frame and is under 30% by the 4th", () => {
  const scene = sceneFor(1920, 1080);
  const definition = MOVES["impact-accent"];
  // song-drop-1 is fit_music's (fitted); song-drop-2 was set by hand. onset-1..5: a fill 0.2 s apart before fill-1.
  const fill = [3.0, 3.2, 3.4, 3.6, 3.8].map((time, index) => ({ name: `onset-${index + 1}`, time, kind: "onset" }));
  const cues = [{ name: "hit-1", time: 2, kind: "marker", layer: "clip", media: 2 }, { name: "beat-5", time: 2, kind: "beat" }, { name: "song-drop-1", time: 3, kind: "marker", fitted: true }, { name: "song-drop-2", time: 2.6, kind: "marker" }, ...fill, { name: "fill-1", time: 4, kind: "marker" }];
  const events = [{ kind: "impact", how: "contact", dir: "right", confidence: 0.8, at: 2.03, media: 2.03, layer: "clip" }];
  const run = (kind, at, start, { own = [], align, dur = null } = {}) => {
    const shots = { ...scene, layers: scene.layers.map((layer) => (layer.id === "clip" ? { ...layer, animations: own } : layer)) };
    return runMove(definition, { id: "hit", input: readMoveInput(definition, { kind, layer: "clip" }), scene: shots, align, dur,
      style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start, media, cueFacts: { at, cues, events } });
  };
  assert.throws(() => run("shake", 2, 2), /at 2 is a time, not a reason\. An accent needs a cue that motivates it .*try at "cue:hit-1"/);
  assert.throws(() => run("shake", "cue:beat-5", 2), /beat number, not a reason.*cue:hit-1/);
  assert.throws(() => run("flash", "cue:hit-1", 2), /an impact in the footage; flash needs .*try at "cue:song-drop-1"/);
  assert.throws(() => run("shake", "cue:hit-1+0.1", 2.1), /never late/);
  assert.throws(() => run("flash", "cue:song-drop-2", 2.6), /set by hand, not measured: song seams and rests come from fit_music.*try at "cue:song-drop-1"/);
  // align and dur would move it off its cue (align end with dur 1.5 s would put it 1.5 s early).
  assert.throws(() => run("flash", "cue:song-drop-1", 3, { align: "end", dur: 1.5 }), /takes no align or dur/);
  assert.throws(() => run("flash", "cue:song-drop-1", 3, { align: "end" }), /takes no align or dur/);
  const x = (made, own, t) => evaluateLayer({ ...scene.layers.find((layer) => layer.id === "clip"), animations: [...own, ...made.animations.map((entry) => entry.animation)] }, t).x;
  const shake = run("shake", "cue:hit-1", 2);
  // It names its reason, which effect_fit reads from the move's record.
  assert.deepEqual(shake.trigger, { cue: "hit-1", at: 2, motive: "impact", weight: 0.8, kind: "shake" });
  const swing = [0, 1, 2, 3].map((frame) => Math.abs(x(shake, [], 2 + frame / 30)));
  const size = 1920 * 0.018;
  assert.ok(Math.max(swing[0], swing[1]) >= size * 0.95, `the hit's frame is the peak (${swing.map(round3)})`);
  assert.ok(swing[3] < 0.3 * size, `under 30% by the 4th frame (${round3(swing[3])} of ${size})`);
  assert.ok(Math.abs(x(shake, [], 2.5)) < 0.01, "nothing is held after it");
  // The shake adds to the shot's own place: a pan that ended before it stays where it ended, a drift through it goes on.
  const pan = [{ id: "pan", name: "pan", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: -120 } }];
  const panned = run("shake", "cue:hit-1", 2, { own: pan });
  assert.deepEqual([2.5, 4].map((t) => round3(x(panned, pan, t))), [-120, -120]);
  assert.ok(Math.abs(x(panned, pan, 2) + 120) >= size * 0.95, "it shakes around where the pan left it");
  const drift = [{ id: "clip.hold", name: "drift", kind: "custom", start: 0, duration: 5, easing: "linear", from: { x: 0 }, to: { x: 40 } }];
  const drifting = run("shake", "cue:hit-1", 2, { own: drift });
  assert.deepEqual([3, 4].map((t) => round3(x(drifting, drift, t))), [24, 32]);
  // A seam flash lifts the shot's own exposure (its colors carry it) by the cue's weight, 1 frame early.
  const flash = run("flash", "cue:song-drop-1", 3).animations.map((entry) => entry.animation);
  assert.deepEqual(flash.map((animation) => [animation.effect, round3(animation.start), animation.to.stops]), [["color-grade", round3(3 - 1 / 30), 2], ["color-grade", 3, 0]]);
  // A strobe over a fill 0.2 s apart lights at most 3 times in any second, the last on the cue.
  const lit = run("strobe", "cue:fill-1", 4).animations.map((entry) => entry.animation).filter((animation) => animation.name === "Strobe up").map((animation) => round3(animation.start + animation.duration));
  assert.equal(lit.at(-1), 4);
  assert.ok(lit.every((at) => lit.filter((other) => other >= at && other < at + 1).length <= 3), `at most 3 flashes a second (${lit})`);
});
