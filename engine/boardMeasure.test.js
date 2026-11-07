import test from "node:test";
import assert from "node:assert/strict";
import { CAPTIONS_TOP, isPortrait, shotMeasures } from "./boardMeasure.js";

const portrait = { width: 1080, height: 1920 };
const landscape = { width: 1920, height: 1080 };
// A 9:16 crop of a 16:9 frame: 24% wide, 76% tall (the letterbox bars cut off).
const shot = (overrides = {}) => ({ media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], subject: { what: "her face", boxes: [[20, 15, 18, 37]], eyes: 29 }, text: "none", ...overrides });

// The three shots of the Sintel test clip as the golden board-sintel.png draws them (the
// storyboard reference's footage board on a 9:16 video).
test("the Sintel clip's three shots measure as the golden board shows them", () => {
  assert.deepEqual(shotMeasures(shot(), portrait), { inside: [100], edge: 8, eyes: 22, flags: [] });
  // The dragon's box is 1% of the source from the crop's left side: 1 / 24 of the crop's width.
  assert.deepEqual(shotMeasures(shot({ crop: [4, 12, 24, 76], subject: { what: "the red dragon", boxes: [[5, 40, 22, 23]] } }), portrait),
    { inside: [100], edge: 4, eyes: null, flags: ["subject 4% from the crop edge"] });
  assert.deepEqual(shotMeasures(shot({ crop: [13.5, 12, 24, 76], subject: { what: "the dragon's head", boxes: [[19, 34, 11, 18]] } }), portrait),
    { inside: [100], edge: 23, eyes: null, flags: [] });
});

test("each flag, in order", () => {
  const flags = (overrides, frame = portrait) => shotMeasures(shot(overrides), frame).flags;
  assert.deepEqual(flags({ subject: "none" }), ["no subject marked"]);
  // Half the box is outside the crop: cut, and its edge is 0.
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[30, 20, 24, 20]] } }), ["subject 50% in the crop"]);
  assert.equal(shotMeasures(shot({ subject: { what: "x", boxes: [[30, 20, 24, 20]] } }), portrait).edge, 0);
  // Inside but touching the right side.
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[30, 20, 12, 20]] } }), ["subject touches the crop edge"]);
  // Eyes at 5% of the source are above a crop that starts at 12%; a box 8% from the side is fine.
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[20, 20, 10, 20]], eyes: 5 } }), ["eyes outside the crop"]);
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[20, 20, 10, 20]], eyes: 60 } }), ["eyes 63% from the top"]);
  // On 9:16 the eyes at 63.2% or lower sit under the app's captions.
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[20, 20, 10, 60]], eyes: 60.1 } }), ["eyes 63% from the top", "eyes under the app's captions"]);
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[20, 20, 10, 60]], eyes: 60.1 } }, landscape), ["eyes 63% from the top"]);
  assert.deepEqual(flags({ text: { text: "Sale", family: "Inter", weight: 700, size: 96, y: 70 } }), ["text under the app's captions"]);
  assert.deepEqual(flags({ text: { text: "Sale", family: "Inter", weight: 700, size: 96, y: 70 } }, landscape), []);
  // Several flags come in the order above (the box: x 10–34% in a crop of 18–42%, so 16 of 24).
  assert.deepEqual(flags({ subject: { what: "x", boxes: [[10, 20, 24, 20]], eyes: 99 }, text: { text: "a", family: "Inter", y: 80 } }),
    ["subject 67% in the crop", "eyes outside the crop", "text under the app's captions"]);
});

test("the smallest share and edge of several boxes count", () => {
  const measured = shotMeasures(shot({ subject: { what: "two faces", boxes: [[19, 20, 5, 10], [30, 20, 6, 10]] } }), portrait);
  assert.deepEqual(measured.inside, [100, 100]);
  assert.equal(measured.edge, 4);
  assert.deepEqual(measured.flags, ["subject 4% from the crop edge"]);
});

test("a shot with no media has no numbers, only the text flag", () => {
  const card = { media: "none", in: "none", crop: "none", subject: "none", text: { text: "Ship faster", family: "Inter", weight: 700, size: 120, y: 50 } };
  assert.deepEqual(shotMeasures(card, landscape), { inside: [], edge: null, eyes: null, flags: [] });
  assert.deepEqual(shotMeasures({ ...card, text: { ...card.text, y: CAPTIONS_TOP } }, portrait).flags, ["text under the app's captions"]);
  // Text with no y is at the default 20% from the top.
  assert.deepEqual(shotMeasures({ ...card, text: { text: "a", family: "Inter" } }, portrait).flags, []);
});

test("a picture shown whole (crop none) is measured against the whole frame", () => {
  assert.deepEqual(shotMeasures(shot({ in: "none", crop: "none", subject: { what: "logo", boxes: [[40, 40, 20, 20]] } }), landscape),
    { inside: [100], edge: 40, eyes: null, flags: [] });
});

test("9:16 is a width per height within 2% of 9/16; the captions start at 63.2%", () => {
  assert.equal(isPortrait(portrait), true);
  assert.equal(isPortrait({ width: 1080, height: 1950 }), true);
  assert.equal(isPortrait({ width: 1080, height: 1350 }), false);
  assert.equal(isPortrait(landscape), false);
  assert.equal(CAPTIONS_TOP, 63.2);
});
