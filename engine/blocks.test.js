// Unit tests for the building blocks (engine/blocks/): tokens, formats and slots, looks, relative
// timing, recipe settings, compose, backgrounds, transitions and the saved block fields.
import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createScene, parseDocument } from "./model.js";
import { evaluateScene } from "./animation.js";
import { defaultFonts } from "./fonts.js";
import { durationFromToken, durationOf, easingFromToken, easingOf } from "./blocks/tokens.js";
import { parseFormat, safeArea, slotBox, parseSlot } from "./blocks/formats.js";
import { LOOKS, LOOK_NAMES, styleFor, typeFloor } from "./blocks/looks.js";
import { parseAt, resolveAt } from "./blocks/timing.js";
import { RECIPES, RECIPE_NAMES, ALL_RECIPE_NAMES, recipeOf, describeRecipes } from "./blocks/recipes/index.js";
import { runRecipe, settingsFrom } from "./blocks/recipe.js";
import { composeScene, readComposition } from "./blocks/compose.js";
import { backdropLayers } from "./blocks/backdrop.js";
import { imageFacts, looksLikeScreen, looksLikeScreenClip } from "./imageFacts.js";
import { applyTransition } from "./blocks/recipes/transitions.js";
import { EXAMPLES } from "./blocks/examples.js";

const PICTURES = {
  product: { id: "product.png", src: "/api/media/product.png", width: 1600, height: 1000, name: "Product" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" },
  recording: { id: "recording.mp4", src: "/api/media/recording.mp4", width: 1920, height: 1080, name: "Recording", kind: "video", duration: 6 },
};
const media = (ref) => {
  if (!PICTURES[ref]) throw new Error(`No picture ${ref}.`);
  return PICTURES[ref];
};
const env = { fonts: defaultFonts, media, logo: { media: PICTURES.logo }, sceneId: "s" };
const hex = (color) => /^#[0-9A-F]{6}$/i.test(color);
const isPurple = (color) => {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return false;
  let hue = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
  hue = ((hue * 60) + 360) % 360;
  return hue >= 255 && hue <= 320;
};
const luminance = (color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);

test("motion tokens give the plan's bands and curves, and read names with intensities", () => {
  assert.equal(durationOf("micro", 0), 0.15);
  assert.equal(durationOf("hero", 1), 2);
  assert.equal(durationOf("standard"), 0.7);
  assert.equal(durationOf("emphasis"), 0.85);
  assert.deepEqual(easingOf("enter"), [0.5, 0, 0, 1]);
  assert.deepEqual(easingOf("exit"), [0.3, 0, 0.8, 0.15]);
  assert.deepEqual(easingOf("move"), [0.5, 0, 0, 1]);
  assert.deepEqual(easingOf("hero"), [0.4, 0.14, 0.3, 1]);
  const gentle = easingOf("enter", 0);
  const sharp = easingOf("enter", 1);
  assert.ok(gentle[1] > 0 && sharp[1] === 0, "intensity moves the curve away from a straight line");
  assert.notDeepEqual(gentle, [0.5, 0.5, 0, 0]);
  assert.deepEqual(easingFromToken("exit:0.5"), [0.3, 0, 0.8, 0.15]);
  assert.deepEqual(easingFromToken({ token: "move", intensity: 0.5 }), [0.5, 0, 0, 1]);
  assert.equal(easingFromToken("smooth"), null);
  assert.equal(durationFromToken("emphasis:0"), 0.7);
  assert.equal(durationFromToken("0.4"), null);
  assert.throws(() => durationOf("slow"), /Durations: micro, standard, emphasis, hero/);
});

test("formats, the safe area and the 6×6 slot grid", () => {
  assert.deepEqual(parseFormat("16:9"), { width: 1920, height: 1080, name: "1920x1080" });
  assert.deepEqual(parseFormat("vertical"), { width: 1080, height: 1920, name: "1080x1920" });
  assert.deepEqual(parseFormat("800x600"), { width: 800, height: 600, name: "800x600" });
  assert.throws(() => parseFormat("huge"), /Unknown format/);
  for (const name of ["16:9", "9:16", "1:1"]) {
    const frame = parseFormat(name);
    const safe = safeArea(frame);
    const full = slotBox(frame, "A1:F6");
    assert.ok(Math.abs(full.x - safe.x) <= 1 && Math.abs(full.width - safe.width) <= 2, `${name}: A1:F6 is the safe area`);
  }
  assert.deepEqual(parseSlot("e3:c2"), { column0: 2, row0: 1, column1: 4, row1: 2 });
  assert.throws(() => parseSlot("G7"), /columns A–F, rows 1–6/);
  assert.deepEqual(slotBox(parseFormat("16:9"), { x: 10, y: 20, width: 30, height: 40 }), { x: 10, y: 20, width: 30, height: 40 });
});

test("the five looks are dark, never purple, and keep type above the checker's floor", () => {
  assert.deepEqual(LOOK_NAMES, ["crisp", "editorial", "bold", "calm", "data"]);
  for (const name of LOOK_NAMES) {
    for (const color of Object.values(LOOKS[name].colors)) {
      assert.ok(hex(color), `${name} ${color} is a hex colour`);
      assert.ok(!isPurple(color), `${name} ${color} is not purple`);
    }
    assert.ok(luminance(LOOKS[name].colors.bg) < 0.03, `${name} background is dark`);
    for (const format of ["16:9", "9:16", "1:1", "4:5"]) {
      const frame = parseFormat(format);
      const style = styleFor({ look: name, frame });
      const floor = typeFloor(frame);
      for (const step of ["display", "h1", "h2"]) assert.ok(style.type[step] >= floor.headline, `${name} ${format} ${step}`);
      for (const step of ["body", "label", "caption"]) assert.ok(style.type[step] >= floor.body, `${name} ${format} ${step}`);
    }
  }
  const branded = styleFor({ look: "crisp", frame: parseFormat("16:9"), brand: { name: "acme", colors: { accent: "#3CC8B4" }, motion: "calm" } });
  assert.equal(branded.colors.accent, "#3CC8B4");
  assert.equal(branded.colors.bg, LOOKS.crisp.colors.bg);
  assert.equal(branded.feel.name, "calm");
});

test("relative timing reads seconds, after:, with:, cue: and auto, with offsets", () => {
  assert.deepEqual(parseAt(1.5), { kind: "seconds", seconds: 1.5 });
  assert.deepEqual(parseAt("after:hero-title.in-0.2"), { kind: "after", target: "hero-title.in", offset: -0.2, whole: "hero-title.in-0.2" });
  assert.deepEqual(parseAt("auto+0.3"), { kind: "auto", offset: 0.3 });
  const spans = { "hero-title": [0.4, 1.2], "step-2": [2, 2.5], step: [1, 1.5] };
  const lookup = {
    span: (name) => { if (!spans[name]) throw new Error(`No layer ${name}.`); return spans[name]; },
    cue: (name) => { if (name !== "drop") throw new Error(`No cue ${name}.`); return 3.25; },
    auto: () => 1.4,
  };
  assert.equal(resolveAt("after:hero-title", lookup), 1.2);
  assert.equal(resolveAt("with:hero-title+0.1", lookup), 0.5);
  assert.equal(resolveAt("cue:drop-0.25", lookup), 3);
  assert.equal(resolveAt("auto", lookup), 1.4);
  assert.equal(resolveAt("after:step-2", lookup), 2.5, "a whole name that exists wins over a name minus seconds");
  assert.equal(resolveAt("after:step-1", lookup), 0.5);
  assert.throws(() => resolveAt("cue:nope", lookup), /No cue nope/);
  assert.throws(() => resolveAt("with:hero-title-1", lookup), /before the scene starts/);
  assert.throws(() => parseAt("later"), /is not a time/);
});

test("27 recipes: 24 layer recipes and 3 transitions, each with a working example", () => {
  assert.equal(RECIPE_NAMES.length, 24);
  assert.equal(ALL_RECIPE_NAMES.length, 27);
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...RECIPE_NAMES].sort());
  assert.throws(() => recipeOf("headline"), /Did you mean headline-reveal/);
  const described = describeRecipes();
  assert.equal(described.length, 27);
  assert.ok(described.every((entry) => entry.about && entry.group));
});

test("recipe settings: loose copy fields, choices a recipe lacks, and bad copy are errors", () => {
  const headline = RECIPES["headline-reveal"];
  assert.deepEqual(settingsFrom(headline, { text: "Ship faster", sub: "Now" }).copy, { text: "Ship faster", sub: "Now" });
  assert.deepEqual(settingsFrom(headline, { copy: "Ship faster" }).copy, { text: "Ship faster" });
  assert.throws(() => settingsFrom(headline, { copy: { title: "x" } }), /has no copy field "title"/);
  assert.throws(() => settingsFrom(headline, { align: "middle" }), /align is left, center or right/);
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const run = (name, settings) => runRecipe(RECIPES[name], { id: "r", settings, style, frame: style.frame, fonts: defaultFonts, start: 0.2, media, logo: { media: PICTURES.logo } });
  assert.throws(() => run("cta-end", { copy: { text: "Go" }, uppercase: true }), /cta-end has no uppercase choice/);
  assert.throws(() => run("device-slide", { copy: { text: "Hi" } }), /device-slide needs media/);
  const made = run("headline-reveal", { copy: { text: "Ship faster", sub: "Shared calendars" }, seed: 3 });
  assert.equal(made.layers[0].id, "r");
  assert.ok(made.layers.some((layer) => layer.id === "r-sub"));
  assert.equal(made.layers[0].recipe.name, "headline-reveal");
  assert.deepEqual(made.layers[0].recipe.settings.copy, { text: "Ship faster", sub: "Shared calendars" });
  assert.ok(made.layers.every((layer) => layer.animations.some((animation) => animation.id === `${layer.id}.in`)));
  assert.ok(made.assertions.length >= 1);
  const again = run("headline-reveal", { copy: { text: "Ship faster", sub: "Shared calendars" }, seed: 3 });
  assert.deepEqual(again.layers, made.layers, "the same seed makes the same layers");
  // An old kicker is accepted but not drawn: a label stacked over a headline reads as a template.
  for (const name of ["headline-reveal", "title-type", "hook-slam"]) {
    const old = run(name, { copy: { text: "Ship faster", kicker: "New" } });
    assert.ok(!old.layers.some((layer) => layer.id === "r-kicker"), name);
    assert.match(old.notes.join(), /kicker left out/);
    assert.deepEqual(old.layers[0].recipe.settings.copy, { text: "Ship faster" }, "the kicker is not saved, so it is not noted again");
  }
});

test("callout: one group of corner brackets and a measured label plate, kept in the safe area", () => {
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const run = (box, extra = {}) => runRecipe(RECIPES.callout, { id: "c", settings: { copy: { text: "Keys found" }, box, ...extra }, style, frame: style.frame, fonts: defaultFonts, start: 0.5, end: 5 });
  const made = run([700, 400, 400, 300], { color: "#ff4f9a" });
  const [group, ...children] = made.layers;
  assert.equal(group.type, "group");
  assert.ok(children.every((layer) => layer.parentId === "c"), "every part is inside the group");
  assert.equal(children.filter((layer) => layer.id.startsWith("c-t") || layer.id.startsWith("c-b")).length, 8, "two bars at each corner");
  const plate = children.find((layer) => layer.id === "c-plate");
  const label = children.find((layer) => layer.id === "c-label");
  assert.equal(label.role, "label");
  assert.equal(plate.fill, "#ff4f9a");
  // The plate is the measured text plus its padding, and sits above the box.
  assert.equal(plate.width, label.width + 2 * (label.x - plate.x));
  assert.ok(group.y + plate.y + plate.height <= 400);
  // Only the group leaves, with a fade; nothing drifts off what it marks.
  assert.deepEqual(made.layers.flatMap((layer) => layer.animations.filter((animation) => animation.kind === "out").map((animation) => [layer.id, Object.keys(animation.to).join()])), [["c", "opacity"]]);
  assert.ok(made.layers.every((layer) => !layer.animations.some((animation) => animation.id.endsWith(".hold"))));
  // A box at the top edge: the label goes below it, inside the safe area.
  const low = run([700, 20, 400, 300]);
  const lowPlate = low.layers.find((layer) => layer.id === "c-plate");
  assert.ok(low.layers[0].y + lowPlate.y >= 320);
  assert.throws(() => settingsFrom(RECIPES.callout, { text: "x", box: [1, 2, 3] }), /box is \[x, y, width, height\]/);
  assert.throws(() => run(undefined, { hero: true }), /callout has no hero choice/);
  assert.throws(() => runRecipe(RECIPES["cta-end"], { id: "r", settings: { copy: { text: "Go" }, box: [0, 0, 10, 10] }, style, frame: style.frame, fonts: defaultFonts, start: 0 }), /cta-end has no box choice/);
});

test("reduced motion makes recipes fade in place", () => {
  const style = styleFor({ look: "bold", frame: parseFormat("9:16") });
  for (const name of RECIPE_NAMES) {
    const example = EXAMPLES[name];
    const made = runRecipe(RECIPES[name], {
      id: "r", settings: { copy: example.copy, ...(example.media ? { media: "product" } : {}) }, style, frame: style.frame,
      fonts: defaultFonts, start: 0.2, end: 8, media, logo: { media: PICTURES.logo }, reduced: true,
    });
    for (const layer of made.layers) for (const animation of layer.animations) {
      const keys = new Set([...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})]);
      for (const key of keys) assert.ok(["opacity", "value"].includes(key) || animation.kind === "counter", `${name} ${animation.id} moves ${key} under reduced motion`);
    }
  }
});

test("every recipe layer stays hidden until its entrance starts", () => {
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const run = (name) => runRecipe(RECIPES[name], {
    id: "r", settings: { copy: EXAMPLES[name].copy, ...(EXAMPLES[name].media ? { media: "product" } : {}) }, style, frame: style.frame,
    fonts: defaultFonts, start: 0.5, end: 9, media, logo: { media: PICTURES.logo },
  });
  for (const name of RECIPE_NAMES) for (const layer of run(name).layers) {
    // A move's 0.2 s fade-in is its own animation (`.fade`) that starts with it.
    const entrance = layer.animations.find((animation) => animation.id === `${layer.id}.in`);
    const fade = layer.animations.find((animation) => animation.id === `${layer.id}.fade`);
    const hidden = entrance.from?.opacity === 0 || entrance.from?.sweep === 0 || entrance.from?.reveal?.progress === 0
      || (fade?.from?.opacity === 0 && fade.start === entrance.start);
    assert.ok(hidden, `${name} ${layer.id} shows before its entrance (${entrance.name})`);
  }
  // A bar that grows from 1 px was a visible dot before its beat; now it is hidden, then full width.
  const made = run("feature-callout");
  const scene = parseDocument(createDocument({ id: "d", name: "d", scenes: [createScene({ id: "s", name: "s", width: 1920, height: 1080, duration: 10, layers: made.layers })] })).scenes[0];
  const mark = scene.layers.find((layer) => layer.id === "r-mark");
  const grow = mark.animations.find((animation) => animation.id === "r-mark.in");
  const at = (time) => evaluateScene(scene, time).layers.find((layer) => layer.id === "r-mark");
  assert.equal(at(grow.start - 0.1).opacity, 0);
  assert.equal(at(grow.start + grow.duration).width, mark.width);
  assert.equal(at(grow.start + grow.duration).opacity, 1);
});

const PROMO = [
  { recipe: "logo-sting", tagline: "Plan the week in one view" },
  { recipe: "device-slide", media: "product", text: "Everything in one view", transition: "push" },
  { recipe: "price-pop", price: "$29", text: "per month" },
  { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app", transition: "mask-wipe" },
];

test("compose fills the duration, snaps beats to frames and keeps every ID unique", () => {
  const made = composeScene({ format: "16:9", look: "crisp", duration: 15, type: "promo", beats: PROMO }, env);
  assert.equal(made.duration, 15);
  assert.equal(made.beats.length, 4);
  assert.equal(made.beats[0].start, 0);
  assert.equal(made.beats.at(-1).end, 15);
  for (const beat of made.beats) assert.ok(Math.abs(beat.start * 30 - Math.round(beat.start * 30)) < 0.05, `${beat.id} starts on a frame`);
  // At 23.976 (24000/1001) beats start on that rate's frames, k * 1001 / 24000 s.
  const ntsc = composeScene({ format: "16:9", look: "crisp", duration: 15, type: "promo", fps: "23.976", beats: PROMO }, env);
  assert.equal(ntsc.composition.fps, 24000 / 1001);
  for (const beat of ntsc.beats) {
    const frame = Math.round(beat.start * 24000 / 1001);
    assert.equal(beat.start, Math.round(frame * 1001 / 24) / 1000, `${beat.id} starts on 23.976 frame ${frame}`);
  }
  const ids = made.layers.flatMap((layer) => [layer.id, ...layer.animations.map((animation) => animation.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(made.layers.some((layer) => layer.id === "cta-end-mask-wipe-bar"), "mask-wipe adds its bar");
  assert.deepEqual(made.composition.beats.map((beat) => beat.id), ["logo-sting", "device-slide", "price-pop", "cta-end"]);
  // The saved composition makes the same scene again.
  const again = composeScene(made.composition, env);
  assert.deepEqual(again.layers, made.layers);
  // Every beat's layers have left before the next beat's layers enter.
  for (const [index, beat] of made.beats.entries()) {
    if (index === made.beats.length - 1) continue;
    const mine = made.layers.filter((layer) => layer.id === beat.id || layer.id.startsWith(`${beat.id}-`));
    for (const layer of mine) {
      const out = layer.animations.find((animation) => animation.kind === "out");
      assert.ok(out && out.start + out.duration <= beat.end + 1e-6, `${layer.id} leaves by ${beat.end}`);
    }
  }
  // A scene made from it parses.
  const scene = createScene({ id: "s", name: "Promo", width: 1920, height: 1080, duration: made.duration, background: made.background, layers: made.layers, assertions: made.assertions, composition: made.composition });
  const document = parseDocument(createDocument({ id: "d", name: "t", scenes: [scene] }));
  assert.equal(document.scenes[0].composition.look, "crisp");
});

test("compose explains what does not fit and what is wrong", () => {
  const long = [...PROMO.slice(0, 3), { recipe: "headline-reveal", text: "One more message here", sub: "and a sub line" }, PROMO[3]];
  assert.throws(() => composeScene({ format: "16:9", look: "calm", duration: 12, beats: long }, env), /more than duration 12\. Make duration at least/);
  assert.throws(() => readComposition({ format: "16:9", beats: [{ recipe: "cta-end", text: "Go", transition: "push" }] }), /first beat has nothing to change from/);
  assert.throws(() => readComposition({ beats: [{ recipe: "price-pop", text: "x" }] }), /beat 1: price-pop needs copy\.price/);
  assert.throws(() => readComposition({ beats: [{ recipe: "cta-end", text: "Go", headline: "x" }] }), /has no field "headline"/);
  assert.throws(() => readComposition({ look: "neon", beats: [{ recipe: "cta-end", text: "Go" }] }), /Looks: crisp, editorial, bold, calm, data/);
  assert.throws(() => composeScene({ beats: [{ recipe: "cta-end", text: "Go", dur: 0.6 }] }, env), /needs .* but dur is 0\.6/);
  const taken = new Set(["cta-end"]);
  const renamed = composeScene({ beats: [{ recipe: "cta-end", text: "Go" }] }, { ...env, taken });
  assert.equal(renamed.beats[0].id, "cta-end-2");
  assert.throws(() => composeScene({ beats: [{ recipe: "cta-end", text: "Go", id: "cta-end" }] }, { ...env, taken }), /already used/);
  const variant = composeScene({ beats: [{ recipe: "cta-end", text: "Go" }] }, { ...env, suffix: "-v2" });
  assert.equal(variant.beats[0].id, "cta-end-v2");
});

test("promo stretching keeps the first headline within 5 seconds", () => {
  for (const look of LOOK_NAMES) {
    const made = composeScene({ format: "16:9", look, duration: 15, type: "promo", beats: PROMO }, env);
    assert.ok(made.beats[1].start < 4.5, `${look}: the headline beat starts at ${made.beats[1].start}`);
  }
  // With no headline beat, a logo-sting with a tagline still leaves room for the next beat by 4.2 s.
  const plain = composeScene({ format: "16:9", duration: 15, type: "promo", beats: [{ recipe: "logo-sting", text: "Orbit", tagline: "Plan the week in one view" },
    { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" }, { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app" }] }, env);
  assert.ok(plain.beats[1].start <= 4.2, `the message beat starts at ${plain.beats[1].start}`);
});

test("backgrounds: decor only, and the glow keeps still under reduced motion", () => {
  const frame = parseFormat("16:9");
  for (const look of LOOK_NAMES) {
    const style = styleFor({ look, frame });
    const layers = backdropLayers(style, { frame, duration: 10, id: "s-bg" });
    assert.ok(layers.every((layer) => layer.role === "decor" && layer.allowOverlap), look);
    assert.equal(layers.length, style.background === "solid" ? 0 : 1, look);
  }
  const calm = styleFor({ look: "calm", frame });
  assert.equal(backdropLayers(calm, { frame, duration: 10, id: "g" })[0].animations.length, 1);
  assert.equal(backdropLayers(calm, { frame, duration: 10, id: "g", reduced: true })[0].animations.length, 0);
});

test("transitions keep moving layers inside the frame and fade under reduced motion", () => {
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const layer = (id, x) => ({ id, type: "text", x, y: 400, width: 600, height: 100, animations: [{ id: `${id}.in`, kind: "in", start: 0.2, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }] });
  const outgoing = [layer("a", 60)];
  const incoming = [layer("b", 1300)];
  applyTransition("push", { style, frame: style.frame }, { outgoing, incoming, at: 3, id: "b-push" });
  const out = outgoing[0].animations.find((animation) => animation.id === "a.out");
  assert.ok(out.to.x >= 0, "the push stops at the left edge");
  assert.ok(Math.abs(out.start + out.duration - 3) < 1e-6, "the exit ends at the boundary");
  const entering = incoming[0].animations[0];
  assert.ok(entering.from.x + 600 <= 1920, "the push in starts inside the frame");
  assert.ok(entering.start >= 3);
  const quiet = [layer("c", 300)];
  const bars = applyTransition("mask-wipe", { style, frame: style.frame, reduced: true }, { outgoing: quiet, incoming: [layer("d", 300)], at: 2, id: "d-mask-wipe" });
  assert.equal(bars.length, 0, "no sweeping bar under reduced motion");
  assert.deepEqual(Object.keys(quiet[0].animations.find((animation) => animation.kind === "out").to), ["opacity"]);
  assert.throws(() => applyTransition("spin", { style, frame: style.frame }, { outgoing: [], incoming: [], at: 1, id: "x" }), /Transitions: cut-on-motion, push, mask-wipe/);
});

test("saved block fields: brands, composition, variant, template and recipe records", () => {
  const scene = createScene({
    id: "s", name: "S", width: 1920, height: 1080, duration: 10,
    composition: { format: "1920x1080", beats: [{ recipe: "cta-end", text: "Go" }] },
    variant: { of: "s0", set: "set-1", label: "Slower", vary: "timing", picked: true },
    template: { length: 10, intro: 1.5, outro: 1.5, fields: [{ name: "title", layer: "t", property: "text" }] },
    layers: [{ id: "t", type: "text", text: "Hi", recipe: { name: "cta-end", instance: "t", settings: { copy: { text: "Hi" } } } }],
  });
  const document = parseDocument(createDocument({
    id: "d", name: "t", scenes: [scene],
    brands: [{ name: "acme", colors: { accent: "#3cc8b4" }, fonts: [{ family: "Inter", weight: 700 }], logos: [{ text: "ACME" }], motion: "snappy" }],
  }));
  assert.equal(document.brands[0].colors.accent, "#3CC8B4");
  assert.equal(document.scenes[0].variant.picked, true);
  assert.equal(document.scenes[0].template.intro, 1.5);
  assert.equal(document.scenes[0].layers[0].recipe.instance, "t");
  const bad = (patch, pattern) => assert.throws(() => parseDocument(createDocument({ id: "d", name: "t", scenes: [createScene({ id: "s", ...patch })] })), pattern);
  bad({ variant: { of: "s0", set: "x", label: "L", vary: "colour" } }, /vary must be one of timing, layout, look/);
  bad({ template: { length: 4, intro: 2, outro: 2 } }, /intro and outro together must be shorter/);
  assert.throws(() => parseDocument(createDocument({ id: "d", name: "t", brands: [{ name: "a" }, { name: "a" }] })), /repeats the brand name a/);
  assert.throws(() => parseDocument(createDocument({ id: "d", name: "t", brands: [{ name: "a", colors: { accent: "red" } }] })), /must be a hex colour/);
  const plain = parseDocument(createDocument({ id: "d", name: "t" }));
  assert.equal("brands" in plain, false, "documents without the fields stay as they were");
});

test("screens: a screenshot's busiest region is measured, and device-slide pushes into it unless region is false", () => {
  // A flat 96x60 picture with a checkered patch in its lower right.
  const gray = new Uint8Array(96 * 60).fill(20);
  for (let y = 36; y < 58; y += 1) for (let x = 60; x < 94; x += 1) gray[y * 96 + x] = (x + y) % 2 ? 220 : 20;
  const facts = imageFacts(gray, 96, 60);
  assert.ok(facts.busy[0] >= 50 && facts.busy[1] >= 50, `busy ${facts.busy}`);
  assert.ok(looksLikeScreen({ width: 1440, height: 900, edges: 0.1, flat: 0.8 }) && !looksLikeScreen({ width: 1440, height: 900, edges: 0.3, flat: 0.3 }));
  // A video frame (384 px, exact flats): UI fills and text edges, not camera grain.
  assert.ok(looksLikeScreenClip({ width: 2560, height: 1536, edges: 0.11, flat: 0.5 }) && !looksLikeScreenClip({ width: 1920, height: 1080, edges: 0.1, flat: 0.21 }) && !looksLikeScreenClip({ width: 1920, height: 1080, edges: 0.007, flat: 0.95 }));
  const shot = { ...PICTURES.product, edges: 0.1, flat: 0.8, busy: [55, 55, 40, 40] };
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const run = (settings) => runRecipe(RECIPES["device-slide"], { id: "r", settings: { media: "product", ...settings }, style, frame: style.frame, fonts: defaultFonts, start: 0, end: 5, media: () => shot });
  const push = run({}).layers[0].animations.find((animation) => animation.id === "r.hold");
  assert.equal(push.name, "Screen push");
  assert.ok(push.to.scaleX >= 1.06 && push.to.x < push.from.x, "it grows about the lower right, so its corner moves left");
  assert.notEqual(run({ region: false }).layers[0].animations.find((animation) => animation.id === "r.hold").name, "Screen push");
  assert.throws(() => settingsFrom(RECIPES["device-slide"], { region: [0, 0, 0, 10] }), /region is \[x, y, w, h\]/);
  // screen-detail: the lifted card pushes with the picture (same time, same growth), so it stays on its region.
  const detail = runRecipe(RECIPES["screen-detail"], { id: "d", settings: { media: "product" }, style, frame: style.frame, fonts: defaultFonts, start: 0, end: 5, media: () => shot });
  const [picture, card] = ["d-screen", "d"].map((id) => detail.layers.find((layer) => layer.id === id).animations.find((animation) => animation.id === `${id}.hold`));
  assert.deepEqual([card.start, card.duration], [picture.start, picture.duration]);
  assert.ok(Math.abs(card.to.scaleX / card.from.scaleX - picture.to.scaleX) < 0.01);
  // feature-callout: its screenshot pushes in while the card drifts, and ends inside the card.
  const endBox = (layer, animation) => {
    const [w, h] = [layer.width * animation.to.scaleX, layer.height * animation.to.scaleY];
    const [cx, cy] = [animation.to.x + layer.width / 2, animation.to.y + layer.height / 2];
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  };
  for (const seed of [1, 2, 3]) {
    const callout = runRecipe(RECIPES["feature-callout"], { id: "f", seed, settings: { media: "product", copy: { text: "Shared calendars", sub: "Everyone sees the same week" } }, style, frame: style.frame, fonts: defaultFonts, start: 0, end: 6, media: () => shot });
    const [shotLayer, cardLayer] = ["f-picture", "f"].map((id) => callout.layers.find((layer) => layer.id === id));
    const [pushed, drift] = [shotLayer, cardLayer].map((layer) => layer.animations.find((animation) => animation.id === `${layer.id}.hold`));
    assert.equal(pushed.name, "Screen push", `seed ${seed}`);
    assert.ok(pushed.to.scaleX >= 1.06 && JSON.stringify(pushed.easing) === JSON.stringify(drift.easing), JSON.stringify(pushed));
    const [inner, outer] = [endBox(shotLayer, pushed), endBox(cardLayer, drift)];
    assert.ok(inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1, `seed ${seed}: ${JSON.stringify([inner, outer])}`);
  }
});

test("a video format fills its slots into a compose plan with fixed shape, pacing and cues", async () => {
  const { expandVideoFormat, buildVideoFormat, VIDEO_FORMATS } = await import("./blocks/videoFormats.js");
  const expanded = expandVideoFormat("product-launch", { ...VIDEO_FORMATS["product-launch"].example, product: "product", logo: "logo" });
  assert.equal(expanded.compose.format, "16:9");
  assert.equal(expanded.compose.duration, 30);
  assert.deepEqual(expanded.cues.map((cue) => cue.name), ["open", "headline", "hero", "feature-1", "feature-2", "feature-3", "price", "outro"]);
  const { made } = await buildVideoFormat(expanded, (compose) => composeScene(compose, env));
  assert.equal(made.duration, 30);
  assert.equal(made.beats[2].end - made.beats[2].start, 5.5, "one 5.5 s hero hold");
  // A screen recording in app-demo plays, silent, from when its step enters; a wide shot alone in 9:16 runs edge to edge.
  const demo = await buildVideoFormat(expandVideoFormat("app-demo", { ...VIDEO_FORMATS["app-demo"].example, recordings: ["recording", "product"], logo: "logo" }, { aspect: "9:16" }), (compose) => composeScene(compose, env));
  const clip = demo.made.layers.find((layer) => layer.type === "video");
  assert.equal(clip.src, "/api/media/recording.mp4");
  assert.equal(clip.volume, 0);
  assert.ok(Math.abs(clip.mediaStart - demo.made.beats[2].start) < 0.5, `plays from its step (${clip.mediaStart} s, step at ${demo.made.beats[2].start} s)`);
  const promo = await buildVideoFormat(expandVideoFormat("social-promo", { ...VIDEO_FORMATS["social-promo"].example, product: "product", logo: "logo" }), (compose) => composeScene(compose, env));
  const hero = promo.made.layers.find((layer) => layer.role === "hero" && layer.type === "image");
  assert.equal(hero.width, 1080);
  assert.throws(() => expandVideoFormat("social-promo", { name: "Orbit", hook: "Hi", product: "p", words: ["one"], cta: "Go" }), /words is a list of 2 to 4 texts/);
  assert.throws(() => expandVideoFormat("testimonial", { name: "Orbit", quote: "Hi", person: "Ann", cta: "Go" }, { aspect: "21:9" }), /comes in 1:1/);
});
