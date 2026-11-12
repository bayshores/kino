// caption-words type knobs: fontFamily, fontWeight, fill, accent, activeScale, saidOpacity,
// unsaidOpacity and activeBackground. Left out (or set to today's values) they change nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createScene, parseDocument } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";
import { evaluateLayer } from "./animation.js";

const move = MOVES["caption-words"];
const frame = { width: 1920, height: 1080 };
const style = styleFor({ look: "crisp", frame });
// "so" at 0.4, "we gave" at 0.8, "it eyes." at 1.4: one caption of four units.
const WORDS = [{ text: "so", at: 0.4 }, { text: "we gave", at: 0.8 }, { text: "it eyes.", at: 1.4, end: 2.6 }];
const SERIF = { fontFamily: "Noto Serif", fontSource: "", fontWeight: 700, fontStyle: "normal" };
const run = (fields = {}, extra = {}) => runMove(move, {
  id: "c", input: readMoveInput(move, { words: WORDS, ...fields }), scene: createScene({ id: "s", width: 1920, height: 1080, duration: 4, layers: [] }),
  style, fonts: defaultFonts, start: 0.4, media: () => null, seed: 2, ...extra,
});
const part = (made, name) => made.added.find(({ layer }) => layer.move.part === name)?.layer;
// Each word's evaluated state at a time: [so, we, gave, it, eyes.].
function unitsAt(made, time) {
  const scene = createScene({ id: "s", width: 1920, height: 1080, duration: 4, layers: made.added.map(({ layer }) => layer) });
  const layer = parseDocument(createDocument({ id: "d", scenes: [scene] })).scenes[0].layers.find((entry) => entry.move?.part === "w1");
  const plan = textAnimationPlan(layer, defaultFonts);
  return plan.units.map((unit, index) => textAnimationUnitState(plan, index, time));
}

test("caption-words knobs left out or set to today's values make the same captions", () => {
  for (const fields of [{}, { highlight: "active" }, { entrance: "pop" }, { entrance: "rise", highlight: "active" }]) {
    const active = fields.highlight === "active";
    const same = { fill: style.colors.text, activeScale: 1, activeBackground: "none", saidOpacity: active ? 0.7 : 1, unsaidOpacity: active || fields.entrance === "pop" ? 0.7 : 1, ...(active ? { accent: style.colors.accent } : {}) };
    assert.deepEqual(run({ ...fields, ...same }), run(fields), JSON.stringify(fields));
  }
});

test("fill colors the words and accent colors the said word under karaoke", () => {
  const made = run({ highlight: "active", fill: "#22aaff", accent: "#ffd400" });
  const [so, we, , it] = unitsAt(made, 1);
  assert.equal(we.fill.toUpperCase(), "#FFD400FF");
  assert.equal(so.fill.toUpperCase(), "#22AAFFB3");
  assert.equal(it.fill.toUpperCase(), "#22AAFFB3");
  assert.equal(part(run({ fill: "#22aaff" }), "w1").fill, "#22AAFF", "without karaoke the words are just that color");
});

test("saidOpacity and unsaidOpacity dim the words said and not said yet", () => {
  const [so, we, , it] = unitsAt(run({ highlight: "active", saidOpacity: 0.3, unsaidOpacity: 0.5 }), 1);
  assert.equal(so.fill.slice(7).toUpperCase(), "4D");
  assert.equal(it.fill.slice(7).toUpperCase(), "80");
  assert.equal(we.fill.toUpperCase(), `${style.colors.accent.toUpperCase()}FF`);
  // Without karaoke a said word dims too (a reading guide): plain captions take the knobs.
  const plain = unitsAt(run({ saidOpacity: 0.4 }), 1);
  assert.equal(plain[0].fill.slice(7).toUpperCase(), "66");
  assert.match(plain[1].fill.toUpperCase(), new RegExp(`^${style.colors.text.toUpperCase()}(FF)?$`), "the said word is full");
  assert.throws(() => readMoveInput(move, { words: WORDS, saidOpacity: 1.5 }), /from 0 to 1/);
});

test("activeScale grows the said word and settles it after; with pop it pops to that size", () => {
  const [so, we, , it] = unitsAt(run({ activeScale: 1.25 }), 1);
  assert.deepEqual([so.scaleX, we.scaleX, it.scaleX], [1, 1.25, 1]);
  const popped = unitsAt(run({ activeScale: 1.25, entrance: "pop" }), 1);
  assert.deepEqual([popped[0].scaleX, popped[1].scaleX, popped[3].scaleX], [1, 1.25, 0.92]);
  assert.throws(() => readMoveInput(move, { words: WORDS, activeScale: 3 }), /from 1 to 2/);
});

test("activeBackground puts a box under the caption that slides to each word as it is said", () => {
  const made = run({ activeBackground: "#ff6b4a" });
  const order = made.added.map(({ layer }) => layer.move.part);
  assert.ok(order.indexOf("hl1") < order.indexOf("w1"), "the box is under the words");
  const box = part(made, "hl1");
  const words = part(made, "w1");
  assert.equal(box.fill, "#FF6B4A");
  const at = (time) => evaluateLayer(box, time);
  // Behind "so" at first, behind "we gave" once it is said, inside the caption's line.
  const first = at(0.6);
  const second = at(1.2);
  assert.ok(first.x >= words.x - 40 && second.x > first.x + first.width * 0.5, `${first.x} ${second.x}`);
  assert.ok(second.width > first.width, "a two-word entry gets a wider box");
  assert.ok(first.y > words.y - 30 && first.y + first.height < words.y + words.height + 30);
  assert.equal(at(0.2).opacity, 0, "not before the first word");
  assert.ok(words.shadow?.color, "a light word on its box keeps its shadow");
  // A dark word on a light box drops its shadow (a dark halo there would muddy it).
  assert.equal(part(run({ highlight: "active", accent: "#111111", activeBackground: "#FFD84A" }), "w1").shadow?.color ?? null, null);
  assert.equal(part(run({ activeBackground: "none" }), "hl1"), undefined);
  assert.throws(() => run({ activeBackground: "red" }), /"none" or a hex color/);
});

test("fontFamily and fontWeight set the captions' type", () => {
  const made = run({ fontFamily: "Noto Serif" }, { fontFaces: { "Noto Serif": SERIF } });
  assert.deepEqual([part(made, "w1").fontFamily, part(made, "w1").fontWeight], ["Noto Serif", 700]);
  assert.equal(part(run({ fontWeight: 800 }), "w1").fontWeight, 800);
  // A weight alone draws in the face the caller loaded for the default family at that weight.
  const body = style.fonts.body.fontFamily;
  const heavy = part(run({ fontWeight: 900 }, { fontFaces: { [body]: { fontFamily: body, fontSource: "/api/fonts/heavy.ttf", fontWeight: 900, fontStyle: "normal" } } }), "w1");
  assert.deepEqual([heavy.fontFamily, heavy.fontSource, heavy.fontWeight], [body, "/api/fonts/heavy.ttf", 900]);
  assert.throws(() => run({ fontFamily: "Nope Sans" }), /no font "Nope Sans"/);
  assert.throws(() => readMoveInput(move, { words: WORDS, fontWeight: 1000 }), /from 100 to 900/);
});
