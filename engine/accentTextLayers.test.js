// light-sweep and accent-hit on pictures (through their own alpha) with their new fields, and
// headline-write, count-up, voice-type and masked-type on your own text layer.
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { sweepRect } from "./blocks/moves/accent.js";

const frame = { width: 1920, height: 1080 };
const logo = () => createLayer("image", { id: "logo", x: 800, y: 400, width: 300, height: 300, src: "/api/media/logo.png" });
const title = (extra = {}) => createLayer("text", { id: "title", x: 400, y: 300, width: 1100, height: 140, text: "Ship it today", fontSize: 110, fontFamily: "Inter", fill: "#E8E2D6", textAlign: "center", ...extra });
const clip = () => createLayer("video", { id: "clip", x: 0, y: 0, width: 1920, height: 1080, src: "/api/media/c.mp4", mediaDuration: 10 });
function run(name, raw, layers, { start = 0.5, dur = null, reduced = false } = {}) {
  const scene = createScene({ id: "s", name: "S", width: 1920, height: 1080, duration: 6, layers });
  return runMove(MOVES[name], { id: "m", input: readMoveInput(MOVES[name], raw), scene, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start, dur, reduced, media: () => null });
}
const part = (result, name) => result.added.find((entry) => entry.layer.move.part === name)?.layer;
const keys = (layer) => layer.animations.map((animation) => animation.id.split(".").pop());

test("light-sweep on a picture: a mask group of a white copy and a turned band rectangle", () => {
  const result = run("light-sweep", { layer: "logo", angle: 20 }, [logo()]);
  const group = part(result, "overlay");
  assert.equal(group.type, "group");
  assert.equal(group.isMaskGroup, true);
  assert.deepEqual(result.added[0].place, { above: "logo" });
  const mask = part(result, "overlay-mask");
  assert.equal(mask.isMask, true);
  assert.equal(mask.parentId, group.id);
  assert.equal(mask.animations[0].effect, "hue-saturation", "whitened: its alpha is the mask");
  const band = part(result, "overlay-paint");
  assert.equal(band.parentId, group.id);
  assert.equal(band.rotation, 20);
  assert.equal(band.animations.filter((animation) => animation.id.includes("sweep-")).length, 10);
  assert.ok(keys(group).includes("halo"), "the halo glows on the group, past the alpha's edge");
  // The band's rectangle covers every corner of the box at that slant.
  const rect = sweepRect({ x: 0, y: 0, width: 300, height: 100 }, 20);
  assert.ok(rect.width >= 300 * Math.cos(Math.PI / 9) + 100 * Math.sin(Math.PI / 9));
});

test("light-sweep direction, ease and repeat change the sweep; repeat makes it longer", () => {
  const base = run("light-sweep", { layer: "title" }, [title()]);
  const copy = (result) => part(result, "overlay");
  const middle = (result, index) => copy(result).animations.filter((animation) => animation.id.includes("sweep-"))[index].to.fill.stops[2].offset;
  const left = run("light-sweep", { layer: "title", direction: "left" }, [title()]);
  assert.equal(copy(left).animations.find((animation) => animation.id.endsWith("sweep-1")).to.fill.angle, 180);
  const eased = run("light-sweep", { layer: "title", ease: "settle" }, [title()]);
  assert.ok(middle(eased, 1) > middle(base, 1) + 0.05, "settle covers more ground early");
  const twice = run("light-sweep", { layer: "title", repeat: 2 }, [title()]);
  assert.equal(copy(twice).animations.filter((animation) => animation.id.includes("sweep-")).length, 20);
  assert.equal(twice.end, round(0.5 + 2.4));
  // A leaning band on text goes through the text's own shape too.
  const leaning = run("light-sweep", { layer: "title", angle: -15 }, [title()]);
  assert.equal(part(leaning, "overlay-paint").rotation, -15);
  assert.equal(part(leaning, "overlay-mask").fill, "#FFFFFF");
});

test("light-sweep up or down on text: a narrow band crossing only its lines", () => {
  const box = title({ height: 200, textAlign: "left" });
  const stops = (result, key) => part(result, "overlay").animations.find((animation) => animation.id.endsWith(key)).to.fill.stops.map((stop) => stop.offset);
  const sideways = stops(run("light-sweep", { layer: "title" }, [box]), "sweep-5");
  for (const direction of ["up", "down"]) {
    const [, a, middle, b] = stops(run("light-sweep", { layer: "title", direction }, [box]), "sweep-5");
    assert.ok(b - a < 0.25, `${direction}: the band is ${round(b - a)} of the box, not the whole word`);
    assert.ok(b - a > 0.02, `${direction}: the band is still there`);
    assert.ok(middle > 0.05 && middle < 0.75, `${direction}: halfway, it is on the lines (${middle}), not the empty box below`);
  }
  assert.ok(sideways[3] - sideways[1] < 0.2, "sideways is unchanged and narrow");
  // The first and last keyframes start and end just outside the lines, not the whole box.
  const first = stops(run("light-sweep", { layer: "title", direction: "down" }, [box]), "sweep-1");
  const last = stops(run("light-sweep", { layer: "title", direction: "down" }, [box]), "sweep-10");
  assert.ok(last[2] < 0.9, `down ends just past the last line (${last[2]})`);
  assert.ok(first[2] >= 0, "down starts at the top of the lines");
});

test("accent-hit on a picture flashes the color through its alpha; repeat and ease", () => {
  const result = run("accent-hit", { layer: "logo", color: "#7FE3FF", repeat: 2, ease: "fade" }, [logo()]);
  const group = part(result, "overlay");
  assert.equal(group.isMaskGroup, true);
  assert.equal(group.opacity, 0);
  assert.equal(part(result, "overlay-paint").fill, "#7FE3FF");
  assert.deepEqual(keys(group).filter((key) => key.startsWith("flash")), ["flash", "flash-2"]);
  assert.deepEqual(group.animations[0].easing, [0.33, 0, 0.67, 1]);
  assert.equal(result.end, round(0.5 + 2 * (0.067 + 0.1 + 0.2)));
  assert.throws(() => run("accent-hit", { layer: "logo", word: "x" }, [logo()]), /not text/);
  // Reduced, the gentler flash is timed in the span: a repeated hit ends where its span does.
  const reduced = run("accent-hit", { layer: "logo", repeat: 6 }, [logo()], { reduced: true });
  assert.equal(reduced.end, round(0.5 + 6 * (0.15 + 0.1 + 0.2)));
  const late = createScene({ id: "s", name: "S", width: 1920, height: 1080, duration: 3.2, layers: [logo()] });
  const ending = runMove(MOVES["accent-hit"], { id: "m", input: readMoveInput(MOVES["accent-hit"], { layer: "logo", repeat: 6 }), scene: late, style: styleFor({ look: "crisp", frame }), fonts: defaultFonts, start: 3, align: "end", reduced: true, media: () => null });
  assert.equal(ending.end, 3, "ends at its aligned end, inside the 3.2 s scene");
});

test("headline-write on your text layer writes it on as it is", () => {
  const result = run("headline-write", { layer: "title", exit: "dim" }, [title({ opacity: 0.8 })]);
  assert.equal(result.added.length, 0, "no text of its own");
  const names = result.animations.map((entry) => `${entry.layerId}:${entry.animation.id}`);
  assert.ok(names.includes("title:m.layer-arrive") && names.includes("title:m.layer-ink") && names.includes("title:m.layer-dim"));
  const ink = result.animations.find((entry) => entry.animation.id === "m.layer-ink").animation;
  assert.equal(ink.unit, "words");
  assert.equal(ink.to.opacity, 0.8, "its own opacity stays the full one");
  assert.throws(() => run("headline-write", { layer: "title", headline: "x" }, [title()]), /exactly one of headline or layer/);
});

test("count-up on your text layer counts to its own text", () => {
  const result = run("count-up", { layer: "title", label: "faster" }, [title({ text: "98%" })]);
  const count = result.animations.find((entry) => entry.animation.kind === "counter");
  assert.equal(count.layerId, "title");
  assert.equal(count.animation.to, 98);
  assert.equal(part(result, "label").text, "faster");
  assert.throws(() => run("count-up", { layer: "title" }, [title()]), /no number/);
});

test("voice-type on your text layer: each word shows when it is said", () => {
  const words = [{ text: "Ship", at: 0.4 }, { text: "it", at: 0.7 }, { text: "today", at: 1.1, end: 1.5 }];
  const result = run("voice-type", { layer: "title", words }, [clip(), title()]);
  const land = result.animations.find((entry) => entry.animation.id === "m.layer-in").animation;
  assert.deepEqual(land.delays, [0, 0.3, 0.7]);
  assert.equal(land.unit, "words");
  assert.deepEqual(result.added.map((entry) => entry.place), [{ below: "title" }], "the shade goes under your words");
  assert.throws(() => run("voice-type", { layer: "title", words: words.slice(0, 2) }, [clip(), title()]), /3 words and the line has 2/);
});

test("masked-type on your text layer: the footage plays through a copy of it, yours hides meanwhile", () => {
  const result = run("masked-type", { layer: "clip", textLayer: "title" }, [clip(), title()], { dur: 2.6 });
  const mask = part(result, "word");
  assert.equal(mask.isMask, true);
  assert.equal(mask.fontSize, 110);
  assert.equal(mask.fontFamily, "Inter");
  assert.equal(mask.text, "Ship it today");
  const yours = result.animations.filter((entry) => entry.layerId === "title").map((entry) => entry.animation.kind);
  assert.deepEqual(yours, ["hide", "show"]);
});

function round(value) { return Math.round(value * 1000) / 1000; }
