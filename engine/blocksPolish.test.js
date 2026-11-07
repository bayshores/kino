// The building blocks come out clean by default: even lines, a slow hold motion instead
// of a held still, no banned "looks generated" motion, and captions chunked by the energy of the
// speech. backend/blocks-polish.test.mjs runs the checker itself over every recipe and look.
import assert from "node:assert/strict";
import test from "node:test";
import { defaultFonts } from "./fonts.js";
import { layoutText } from "./textLayout.js";
import { RECIPES, RECIPE_NAMES } from "./blocks/recipes/index.js";
import { runRecipe } from "./blocks/recipe.js";
import { composeScene } from "./blocks/compose.js";
import { LOOK_NAMES, styleFor, typeFloor } from "./blocks/looks.js";
import { parseFormat, safeArea } from "./blocks/formats.js";
import { EXAMPLES } from "./blocks/examples.js";
import { textLayer, seeded } from "./blocks/build.js";
import { holdMotion } from "./blocks/hold.js";
import { deckFinish } from "./blocks/deckVariant.js";
import { captionEnergy, captionGroups, CAPTION_ENERGY } from "./blocks/moves/type.js";

const PICTURES = {
  product: { id: "product.png", src: "/api/media/product.png", width: 1600, height: 1000, name: "Product" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" },
};
const media = (ref) => PICTURES[ref];
const FORMATS = ["16:9", "9:16", "1:1"];

// A recipe as the A4 gate makes it: entering at 0.2 s, leaving 0.6 s after its hold.
function made(name, look, format, seed = 1, extra = {}) {
  const frame = parseFormat(format);
  const style = styleFor({ look, frame });
  const example = EXAMPLES[name];
  const options = { id: "r", settings: { copy: example.copy, seed, ...(example.media ? { media: "product" } : {}) }, style, frame, fonts: defaultFonts, start: 0.2, media, logo: { media: PICTURES.logo }, ...extra };
  const probe = runRecipe(RECIPES[name], { ...options, end: null });
  return { frame, ...runRecipe(RECIPES[name], { ...options, end: Math.round((0.2 + probe.needs + 0.6) * 10) / 10 }) };
}
const ctxFor = (format, look = "crisp") => {
  const frame = parseFormat(format);
  return { recipe: "test", style: styleFor({ look, frame }), frame, fonts: defaultFonts, rng: seeded(1), used: new Set() };
};
const linesOf = (layer) => layoutText(layer, defaultFonts).lines.map((line) => ({ text: line.text.trim(), width: line.width }));

test("text is balanced: no one-word last line under a long one, and a short title is never wrapped mid-phrase", () => {
  const ctx = ctxFor("9:16");
  const box = { x: 120, y: 300, width: 840, height: 500 };
  // "Everything in one / place" was the default; now the lines are even.
  const head = textLayer(ctx, { text: "Everything in one place", role: "headline", step: "display", box, align: "center", maxLines: 3 });
  const lines = linesOf(head);
  assert.ok(lines.length >= 2);
  assert.ok(lines.at(-1).text.split(" ").length > 1 || lines.at(-1).width > 0.4 * lines.at(-2).width, lines.map((line) => line.text).join(" / "));
  // A two-word title gets smaller to fit one line, or kino breaks it between words (typed).
  const slam = textLayer(ctx, { text: "Stop double-booking", role: "headline", step: "display", box, align: "center", maxLines: 3 });
  assert.equal(linesOf(slam).length, slam.text.split("\n").length, "every line is a typed line: the wrap breaks nothing");
  // Where the word fits a line, it is never broken at its hyphen.
  const wide = textLayer(ctxFor("16:9"), { text: "Stop double-booking", role: "headline", step: "display", box: { x: 96, y: 200, width: 1100, height: 600 }, align: "left", maxLines: 3 });
  assert.ok(!/-\n/.test(wide.text) && linesOf(wide).length === wide.text.split("\n").length, JSON.stringify(wide.text));
  // A word too long for a line at the smallest size breaks after its hyphen, as a typed line.
  const loud = textLayer(ctx, { text: "Stop double-booking", role: "headline", step: "display", box, align: "center", maxLines: 3, uppercase: true });
  assert.equal(linesOf(loud).length, loud.text.split("\n").length);
  // Body copy at the type minimum: 36 px at 1080p in 16:9 and square frames, 32 in 9:16.
  assert.equal(typeFloor(parseFormat("16:9")).body, 36);
  assert.equal(typeFloor(parseFormat("1:1")).body, 36);
  assert.equal(typeFloor(parseFormat("9:16")).body, 32);
});

test("every recipe holds with a slow eased move: once, after it lands, until it leaves, inside the safe area", () => {
  for (const name of RECIPE_NAMES) for (const format of FORMATS) for (const look of ["crisp", "calm"]) {
    const { layers, frame } = made(name, look, format);
    const label = `${name} ${look} ${format}`;
    // A callout marks a place in the footage: it keeps still on it. screen-detail keeps still
    // but for its push into the region (Screen push), which moves the picture and the lifted card alike.
    if (RECIPES[name].still) {
      assert.ok(layers.every((layer) => !layer.animations.some((animation) => animation.id.endsWith(".hold") && animation.name !== "Screen push")), `${label}: keeps still`);
      continue;
    }
    const holds = layers.map((layer) => layer.animations.filter((animation) => animation.id.endsWith(".hold")));
    assert.ok(holds.every((list) => list.length <= 1), `${label}: one hold a layer`);
    const all = holds.flat();
    const settledAt = Math.max(...layers.flatMap((layer) => layer.animations.filter((animation) => animation.kind === "in").map((animation) => animation.start + animation.duration)));
    const leavingAt = Math.min(...layers.flatMap((layer) => layer.animations.filter((animation) => animation.kind === "out").map((animation) => animation.start)));
    // A hold under 1.2 s (after a 0.1 s settle) is left to the entrance and the exit.
    if (leavingAt - settledAt < 1.4) continue;
    assert.ok(all.length, `${label}: the recipe moves while it is read`);
    // One gesture: every layer of the recipe holds with the same timing and easing.
    assert.equal(new Set(all.map((hold) => `${hold.start} ${hold.duration} ${hold.easing}`)).size, 1, `${label}: the group drifts as one`);
    const [hold] = all;
    assert.notEqual(hold.easing, "linear");
    assert.ok(Array.isArray(hold.easing) && hold.easing[1] <= 0.15 && hold.easing[3] >= 0.85, `${label}: eased in and out, no overshoot`);
    assert.ok(hold.start >= settledAt - 1e-6 && hold.start + hold.duration <= leavingAt + 1e-6, `${label}: from landing to leaving`);
    const safe = safeArea(frame);
    for (const layer of layers) {
      const own = layer.animations.find((animation) => animation.id.endsWith(".hold"));
      if (!own) continue;
      const grow = own.to.scaleX / own.from.scaleX;
      assert.ok(grow >= 0.94 - 1e-9 && grow <= 1.04 + 1e-9, `${label}: ${layer.id} push of ${grow}`);
      // Its exit starts where the hold leaves it.
      const exit = layer.animations.find((animation) => animation.kind === "out");
      if (exit?.from.y !== undefined) assert.equal(exit.from.y, own.to.y, `${label}: ${layer.id} leaves from where it drifted`);
      if (layer.type !== "text") continue;
      const [w, h] = [layer.width * own.to.scaleX, layer.height * own.to.scaleY];
      const [cx, cy] = [own.to.x + layer.width / 2, own.to.y + layer.height / 2];
      const inside = (x0, y0, x1, y1) => x0 >= safe.x - 1 && y0 >= safe.y - 1 && x1 <= safe.x + safe.width + 1 && y1 <= safe.y + safe.height + 1;
      if (inside(layer.x, layer.y, layer.x + layer.width, layer.y + layer.height))
        assert.ok(inside(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), `${label}: ${layer.id} stays in the safe area`);
    }
  }
});

test("banned defaults: no looping or bouncing title, no title moving after it lands but the slow hold, not everything fading up", () => {
  for (const name of RECIPE_NAMES) for (const format of FORMATS) for (const look of LOOK_NAMES) {
    const { layers } = made(name, look, format);
    const label = `${name} ${look} ${format}`;
    for (const layer of layers) for (const animation of layer.animations) {
      assert.ok(!("loop" in animation) && !("repeat" in animation) && !("yoyo" in animation), `${label}: ${animation.id} does not loop`);
      if (layer.type !== "text" || ["in", "out", "counter"].includes(animation.kind) || animation.id.endsWith(".hold")) continue;
      // A text may only move with its own entrance (a value riding up with its bar).
      const entrance = layer.animations.find((entry) => entry.kind === "in");
      assert.ok(animation.start + animation.duration <= entrance.start + entrance.duration + 0.7, `${label}: ${animation.id} keeps ${layer.id} moving after it lands`);
    }
    const entering = layers.filter((layer) => layer.animations.some((animation) => animation.kind === "in"));
    if (entering.length >= 3) {
      const names = entering.map((layer) => layer.animations.find((animation) => animation.kind === "in").name);
      assert.ok(new Set(names).size > 1, `${label}: not every part enters with ${names[0]}`);
    }
  }
  // Scenes do not all enter the same way: a composition's beats lead with different entrances.
  const scene = composeScene({ format: "16:9", look: "crisp", beats: [
    { recipe: "headline-reveal", text: "Plan the week in one view" }, { recipe: "feature-callout", text: "Smart scheduling" },
    { recipe: "price-pop", price: "$29" }, { recipe: "cta-end", text: "Try Orbit free" },
  ] }, { fonts: defaultFonts, media, logo: { media: PICTURES.logo }, sceneId: "s" });
  const leads = scene.beats.map((beat) => scene.layers.find((layer) => layer.id === beat.id).animations.find((animation) => animation.kind === "in"));
  assert.ok(new Set(leads.map((animation) => `${animation.name} ${JSON.stringify(Object.keys(animation.from))}`)).size >= 3, "beats enter in different ways");
});

test("the hold is varied by the seed and left out under reduced motion", () => {
  const frame = parseFormat("16:9");
  const layers = [{ id: "a", type: "text", role: "headline", fontSize: 120, x: 500, y: 400, width: 900, height: 140 }, { id: "b", type: "text", role: "subhead", fontSize: 40, x: 600, y: 600, width: 700, height: 50 }];
  const moves = Array.from({ length: 12 }, (_, seed) => holdMotion(layers, { frame, from: 1, to: 4, seed: seed + 1 }).get("a").animation);
  assert.ok(new Set(moves.map((move) => `${Math.sign(move.to.x - move.from.x)} ${Math.sign(move.to.y - move.from.y)} ${move.to.scaleX > 1}`)).size >= 4, "directions and pushes differ by seed");
  assert.equal(holdMotion(layers, { frame, from: 1, to: 4, seed: 1, reduced: true }).size, 0);
  assert.equal(holdMotion(layers, { frame, from: 1, to: 2, seed: 1 }).size, 0, "a hold under 1.2 s is left to the entrance and exit");
  const reduced = made("headline-reveal", "crisp", "16:9", 1, { reduced: true });
  assert.ok(reduced.layers.every((layer) => layer.animations.every((animation) => !animation.id.endsWith(".hold"))));
});

test("a deck camera card takes the place of a picture's hold, and its exit leaves from the picture's own place", () => {
  const { layers, frame } = made("device-slide", "crisp", "16:9");
  const picture = layers.find((layer) => layer.id === "r");
  assert.ok(picture.animations.some((animation) => animation.id === "r.hold"));
  const exitBefore = picture.animations.find((animation) => animation.kind === "out");
  const hold = picture.animations.find((animation) => animation.id === "r.hold");
  deckFinish(layers, { seed: 3, cards: [{ tag: "slow-push" }] }, { frame: { ...frame, width: 1920, height: 1080 }, duration: 6, id: "s" });
  assert.ok(!picture.animations.some((animation) => animation.id === "r.hold"));
  const exit = picture.animations.find((animation) => animation.kind === "out");
  if (exitBefore.from.y !== undefined) assert.equal(exit.from.y, picture.y, `${hold.to.y} drift taken out`);
});

test("caption-words chunks by energy, never flashes a caption under 0.35 s, and holds the last line 2 s", () => {
  const timed = (count, gap, start = 0) => Array.from({ length: count }, (_, index) => ({ text: ["we", "plan", "the", "week", "for", "you", "and", "it", "just", "works", "every", "time"][index % 12], at: start + index * gap }));
  // Fast, loud speech: 2 to 3 words a caption; calm speech: 4 to 6.
  const fast = timed(12, 0.26);
  assert.equal(captionEnergy(fast, fast.at(-1).at + 0.4), "high");
  const calm = timed(12, 0.6);
  assert.equal(captionEnergy(calm, calm.at(-1).at + 0.8), "calm");
  const talk = timed(12, 0.38);
  assert.equal(captionEnergy(talk, talk.at(-1).at + 0.6), "talk");
  assert.equal(captionEnergy(talk, talk.at(-1).at + 0.6, 132), "high", "fast music lifts conversational speech");
  for (const [energy, words] of [["talk", talk], ["calm", calm]]) {
    const groups = captionGroups(words, words.at(-1).at + 0.8, { energy });
    const [, most] = CAPTION_ENERGY[energy];
    // Groups stay within the word limit unless they had to take more to be read.
    for (const group of groups.slice(0, -1)) assert.ok(group.words.length <= most || group.end - group.at < 1, `${energy}: "${group.text}"`);
    assert.ok(groups.length < words.length, `${energy}: words are grouped`);
  }
  // Every group is on screen 0.35 s or more, whatever the pace.
  for (const words of [fast, talk, calm, timed(6, 0.12)]) {
    const groups = captionGroups(words, words.at(-1).at + 0.5);
    for (const group of groups) assert.ok(group.end - group.at >= 0.35 - 1e-9, `"${group.text}" shows ${group.end - group.at} s`);
    assert.deepEqual(groups.flatMap((group) => group.words), words, "no word is lost or reordered");
  }
  // A breath (a pause of 0.15 s or more after a word ends) breaks the caption.
  const breath = captionGroups([{ text: "we", at: 0, end: 0.2 }, { text: "plan", at: 0.25, end: 0.5 }, { text: "then", at: 1.2, end: 1.4 }, { text: "ship.", at: 1.45, end: 3 }], 3, { energy: "talk" });
  assert.deepEqual(breath.map((group) => group.text), ["we plan", "then ship."]);
  // The last line stays 2 s when the scene has room, and only to the scene's end when not.
  const last = captionGroups([{ text: "done.", at: 1, end: 1.4 }], 1.4, { until: 10 });
  assert.equal(last.at(-1).end, 3);
  assert.equal(captionGroups([{ text: "done.", at: 1, end: 1.4 }], 1.4, { until: 2.2 }).at(-1).end, 2.2);
});
