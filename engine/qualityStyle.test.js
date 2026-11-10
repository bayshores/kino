// The technique finder (engine/quality/techniques.js), the technique rules (engine/quality/rules/style.js)
// and the style spec (engine/styleSpec.js).
//
// Like qualityRules.test.js, each test builds a small kino document the way an agent would, turns
// it into the checker's model with kinoTimeline, and asks what it finds. Each technique kino can
// detect has a scene that uses it; each rule has a scene it fires on and one it stays quiet on.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { RULES, blocksFinal, ruleOf, runQuality } from "./quality/index.js";
import { ideaLines } from "./quality/rules/signature.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { pulses, techniquesUsed, textEntrances, transitions } from "./quality/techniques.js";
import { cutReasons, techniquesWanted } from "./quality/rules/style.js";
import { profileDevices, shotTimes } from "./quality/rules/reference.js";
import { sameWording } from "./quality/rules/spine.js";
import { DETECTABLE_TAGS, PLAIN_TAGS, TECHNIQUES, TECHNIQUE_TAGS, techniquesText } from "./techniques.js";
import { styleContext, styleLine } from "./styleSpec.js";
import { applySwap } from "./deck.js";

// ---------------------------------------------------------------- builders

const PAPER = "#f5f2ea";
const INK = "#1a1a1a";

function text(id, value, props = {}) {
  return { type: "text", id, name: id, text: value, fontFamily: "Noto Serif", fontSize: 72, fill: INK, textResize: "width-height", x: 200, y: 200, ...props };
}
function rect(id, props = {}) {
  return { type: "rectangle", id, name: id, fill: "#3a5a40", x: 200, y: 200, width: 320, height: 180, ...props };
}
// A full-frame clip or picture.
const clip = (id, props = {}) => ({ type: "video", id, name: id, src: `/api/media/${id}.mp4`, mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080, ...props });
const picture = (id, props = {}) => ({ type: "image", id, name: id, src: `/api/media/${id}.png`, x: 0, y: 0, width: 1920, height: 1080, ...props });

const fadeIn = (start, duration = 0.5) => ({ kind: "in", start, duration, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = (start, duration = 0.4) => ({ kind: "out", start, duration, easing: "ease-in", from: { opacity: 1 }, to: { opacity: 0 } });
const show = (start) => ({ kind: "show", start });
const hide = (start) => ({ kind: "hide", start });
const custom = (start, duration, from, to, easing = "smooth") => ({ kind: "custom", start, duration, easing, from, to });
// An effect animation. The blurs are one-shot (value) effects, which take no keepStill.
const ONE_SHOT = new Set(["directional-blur", "zoom-blur", "spin-blur", "bulge", "displacement"]);
const effect = (name, start, duration, to = {}, from) => ({ kind: "effect", effect: name, start, duration, easing: "linear", ...(ONE_SHOT.has(name) ? {} : { keepStill: "both" }), to, ...(from ? { from } : {}) });

function scene({ layers = [], rhythm, ...sceneFields } = {}) {
  const built = layers.map((layer) => {
    const { type, animations = [], ...fields } = layer;
    const named = animations.map((animation, index) => ({ id: `${fields.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation }));
    return createLayer(type, { ...fields, animations: named });
  });
  return parseDocument(createDocument({
    scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 4, background: PAPER, ...sceneFields, layers: built })],
    ...(rhythm ? { rhythm } : {}),
  }));
}

const modelOf = (document) => kinoTimeline(document, "scene", { fonts: defaultFonts });
const tagsOf = (document) => techniquesUsed(modelOf(document));
const covered = new Set();

/** Asserts the scene uses `tag` (and returns where). */
function uses(tag, document) {
  covered.add(tag);
  const found = tagsOf(document);
  assert.ok(found[tag]?.length, `${tag} should be found; found ${Object.keys(found).join(", ") || "nothing"}`);
  return found[tag];
}
function notUses(tag, document) {
  const found = tagsOf(document);
  assert.ok(!found[tag], `${tag} should not be found (at ${found[tag]?.map((entry) => entry.at).join(", ")})`);
}

const run = (code, document, context = {}) => runQuality(document.items ? document : modelOf(document), { codes: [code], pixels: false, context });
const rulesCovered = new Set();
async function fires(code, document, context) {
  rulesCovered.add(code);
  const { findings } = await run(code, document, context);
  assert.ok(findings.length > 0, `${code} should fire`);
  for (const finding of findings) {
    assert.equal(finding.rule, code);
    assert.ok(!finding.internal, finding.message);
    assert.equal(finding.severity, ruleOf(code).level);
    assert.ok(finding.measured && finding.required, "measured and required are given");
  }
  return findings;
}
async function silent(code, document, context) {
  rulesCovered.add(code);
  const { findings, notes } = await run(code, document, context);
  assert.deepEqual(findings.map((finding) => finding.message), [], `${code} should stay silent`);
  return notes;
}

// Two full-frame clips with a change at 2 s; `a` and `b` add animations to each.
const twoShots = ({ a = [hide(2)], b = [show(2)], aProps = {}, bProps = {}, more = [], ...fields } = {}) =>
  scene({ ...fields, layers: [clip("a", { animations: a, ...aProps }), clip("b", { animations: b, ...bProps }), ...more] });
// `count` shots 3 s apart, each a clip, a word and the clip's cut-out (cutoutOf) with the word
// between them (`front`: the word over the cut-out instead).
const wordsBehind = (count, front = false) => scene({ duration: count * 3, layers: Array.from({ length: count }, (unused, index) => {
  const animations = () => [...(index ? [show(index * 3)] : []), hide(index * 3 + 2.5)];
  const word = text(`word${index}`, `WORD ${index}`, { x: 400, y: 400, animations: animations() });
  const cut = clip(`person${index}`, { cutoutOf: `shot${index}`, allowOverlap: true, animations: animations() });
  return [clip(`shot${index}`, { animations: animations() }), ...(front ? [cut, word] : [word, cut])];
}).flat() });

// ---------------------------------------------------------------- the vocabulary

test("the vocabulary: 56 tags in 6 groups, each with a line and when it fits; the undetectable ones say why", () => {
  assert.equal(TECHNIQUES.length, 56);
  assert.equal(new Set(TECHNIQUE_TAGS).size, TECHNIQUE_TAGS.length, "tags are unique");
  for (const entry of TECHNIQUES) {
    assert.match(entry.tag, /^[a-z0-9]+(-[a-z0-9]+)*$/, entry.tag);
    assert.ok(entry.line && entry.fits, entry.tag);
    if (!entry.detect) assert.ok(entry.why, `${entry.tag} says why it cannot be found`);
  }
  assert.ok(PLAIN_TAGS.every((tag) => TECHNIQUE_TAGS.includes(tag)));
  const listing = techniquesText();
  assert.ok(listing.includes("transition: cut, match-cut*, dissolve"), listing);
  assert.match(techniquesText("dissolve"), /^dissolve \(transition\): .+ Fits: /);
  assert.equal(techniquesText("dissolves"), null);
});

// ---------------------------------------------------------------- transitions

test("transitions: a cut, a dissolve and a fade through black between two full-frame clips", () => {
  assert.deepEqual(transitions(modelOf(twoShots())).map((change) => change.tag), ["cut"]);
  uses("cut", twoShots());
  // The new clip fades in over the old one for 0.5 s.
  const dissolve = twoShots({ a: [hide(2.5)], b: [fadeIn(2, 0.5)] });
  assert.deepEqual(transitions(modelOf(dissolve)).map((change) => change.tag), ["dissolve"]);
  uses("dissolve", dissolve);
  // The old one fades out to a dark background, then the new one fades up.
  const black = twoShots({ background: "#050505", a: [fadeOut(1.6, 0.4)], b: [fadeIn(2, 0.4)] });
  uses("fade-black", black);
  notUses("dissolve", black);
  // The same fades over a light background are neither.
  notUses("fade-black", twoShots({ a: [fadeOut(1.6, 0.4)], b: [fadeIn(2, 0.4)] }));
  // Two floating clips in the same place, one fading out as the other fades in, also dissolve.
  const floating = (overlap) => scene({ layers: [clip("one", { x: 360, y: 140, width: 1200, height: 800, animations: [fadeOut(1.8, 0.5)] }),
    clip("two", { x: overlap ? 360 : 1500, y: 140, width: 1200, height: 800, animations: [fadeIn(1.8, 0.5)] })] });
  uses("dissolve", floating(true));
  notUses("dissolve", floating(false));
  // A dissolve where the new clip pushes in a little and, after the dissolve, shrinks away into
  // a tile (a tile-ring): the later shrink is not a zoom landing.
  const shrinkLater = twoShots({ duration: 5, a: [fadeOut(2, 0.6), hide(2.6)], b: [fadeIn(2, 0.6), custom(2, 0.84, { scaleX: 1, scaleY: 1 }, { scaleX: 1.06, scaleY: 1.06 }), custom(2.84, 0.45, { scaleX: 1.06, scaleY: 1.06 }, { scaleX: 0.14, scaleY: 0.14 })] });
  assert.deepEqual(transitions(modelOf(shrinkLater)).map((change) => change.tag), ["dissolve"]);
  // A real landing from larger, shrinking as it comes in, is still a zoom-through.
  const landing = twoShots({ a: [hide(2)], b: [show(2), custom(2, 0.5, { scaleX: 1.6, scaleY: 1.6 }, { scaleX: 1, scaleY: 1 }, "ease-out")] });
  assert.deepEqual(transitions(modelOf(landing)).map((change) => change.tag), ["zoom-through"]);
});

test("screen-zoom: a group holding a screen recording pushed in 3x so one detail fills the frame", () => {
  // A drawn phone (a group) with a recording in its screen, a fifth of the frame; it is pushed
  // to 3x in 0.6 s about a point on the screen, held, then pulled back out.
  const phone = (to, duration = 0.6, back = true) => scene({ duration: 6, layers: [
    rect("bg", { x: 0, y: 0, width: 1920, height: 1080, fill: "#202020" }),
    { type: "group", id: "phone", name: "phone", x: 1186, y: 60, width: 460, height: 960, animations: [
      custom(1, duration, { x: 1186, y: 60, scaleX: 1, scaleY: 1 }, { x: 983, y: -93, scaleX: to, scaleY: to }),
      ...(back ? [custom(3.5, 0.6, { x: 983, y: -93, scaleX: to, scaleY: to }, { x: 1186, y: 60, scaleX: 1, scaleY: 1 })] : [])] },
    rect("body", { x: 0, y: 0, width: 460, height: 960, fill: "#111111", parentId: "phone" }),
    clip("screen", { x: 16, y: 16, width: 428, height: 928, parentId: "phone" }),
  ] });
  const [zoom] = uses("screen-zoom", phone(3));
  assert.deepEqual(zoom, { at: 1, itemId: "phone" });
  uses("screen-zoom", phone(3, 0.6, false));
  // A small push (1.3x) or a slow one (over 3 s) is not a screen zoom.
  notUses("screen-zoom", phone(1.3));
  notUses("screen-zoom", phone(3, 3, false));
});

test("transitions: blur-through, zoom-through, whip-pan and push-transition", () => {
  uses("blur-through", twoShots({ a: [custom(1.6, 0.4, { blur: 0 }, { blur: 30 }), hide(2)], b: [show(2), custom(2, 0.4, { blur: 30 }, { blur: 0 })] }));
  uses("zoom-through", twoShots({ a: [custom(1.6, 0.4, { scaleX: 1, scaleY: 1 }, { scaleX: 1.6, scaleY: 1.6 }, "ease-in"), hide(2)] }));
  // Both pictures slide left together: a push. With a directional blur on a fast slide: a whip.
  const slide = (blur) => twoShots({
    a: [custom(1.8, 0.2, { x: 0 }, { x: -1920 }, "ease-in"), hide(2), ...(blur ? [effect("directional-blur", 1.8, 0.2, { length: 300, angle: 0 })] : [])],
    b: [show(2), custom(2, 0.2, { x: 1920 }, { x: 0 }, "ease-out")],
  });
  uses("push-transition", slide(false));
  uses("whip-pan", slide(true));
  notUses("whip-pan", slide(false));
});

test("transitions: mask-wipe, glitch-hit and flash", () => {
  const wipe = { kind: "in", start: 2, duration: 0.5, easing: "smooth", from: { reveal: { progress: 0, direction: "left", softness: 0 } }, to: { reveal: { progress: 1, direction: "left", softness: 0 } } };
  uses("mask-wipe", twoShots({ a: [hide(2.5)], b: [wipe] }));
  const glitch = { kind: "in", start: 2, duration: 0.3, easing: "ease-in", preset: { id: "glitch", mode: "in", parameters: { sliceSize: 24, speed: 65, colorShift: 60, variant: 2 } },
    from: { effectPreset: { id: "glitch", parameters: { sliceSize: 24, speed: 65, colorShift: 60, variant: 2 }, progress: 0 } },
    to: { effectPreset: { id: "glitch", parameters: { sliceSize: 24, speed: 65, colorShift: 60, variant: 2 }, progress: 1 } } };
  uses("glitch-hit", twoShots({ b: [show(2), glitch] }));
  // A white frame for 0.2 s between the clips.
  uses("flash", twoShots({ a: [hide(2)], b: [show(2.2)], more: [rect("white", { x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [show(2), hide(2.2)] })] }));
});

// ---------------------------------------------------------------- camera

test("camera: slow-push, drift and parallax", () => {
  uses("slow-push", scene({ layers: [picture("still", { animations: [custom(0, 4, { scaleX: 1, scaleY: 1 }, { scaleX: 1.08, scaleY: 1.08 })] })] }));
  // A fast zoom is not a slow push.
  notUses("slow-push", scene({ layers: [picture("still", { animations: [custom(0, 1.2, { scaleX: 1, scaleY: 1 }, { scaleX: 1.5, scaleY: 1.5 })] })] }));
  uses("drift", scene({ layers: [picture("wide", { width: 2200, animations: [custom(0, 4, { x: 0 }, { x: -120 })] })] }));
  // The backdrop drifts slowly while a card in front moves three times as fast.
  const layered = (cardMove) => scene({ layers: [picture("back", { width: 2200, animations: [custom(0, 4, { x: 0 }, { x: -60 })] }),
    rect("card", { x: 500, y: 200, width: 900, height: 600, animations: [custom(0, 4, { x: 500 }, { x: 500 + cardMove })] })] });
  uses("parallax", layered(-180));
  notUses("parallax", layered(-60));
});

test("camera: speed-ramp, freeze-frame, orbit-3d and shake", () => {
  uses("speed-ramp", scene({ layers: [clip("run", { animations: [custom(1, 0.5, { speed: 1 }, { speed: 3 }, "linear")] })] }));
  uses("freeze-frame", scene({ layers: [clip("run", { animations: [custom(1, 0.1, { speed: 1 }, { speed: 0 }, "linear")] })] }));
  uses("orbit-3d", scene({ layers: [rect("card", { animations: [effect("3d-orbit", 0, 2)] })] }));
  uses("shake", scene({ layers: [picture("still", { animations: [effect("wiggle", 1, 0.5)] })] }));
});

// ---------------------------------------------------------------- type

test("type: how each text enters", () => {
  const entering = (animations, props = {}) => scene({ layers: [text("line", "make them want to skate", { animations, ...props })] });
  uses("type-cut", entering([]));
  uses("type-fade", entering([fadeIn(0.5)]));
  uses("type-slide", entering([{ ...fadeIn(0.5), from: { opacity: 0, y: 260 }, to: { opacity: 1, y: 200 } }]));
  uses("type-pop", entering([{ ...fadeIn(0.5, 0.4), from: { opacity: 0, scaleX: 0.6, scaleY: 0.6 }, to: { opacity: 1, scaleX: 1, scaleY: 1 } }]));
  uses("type-words", entering([{ ...fadeIn(0.5, 0.4), unit: "words", stagger: 0.1 }]));
  uses("type-letters", entering([{ ...fadeIn(0.5, 0.3), unit: "letters", stagger: 0.03 }]));
  uses("type-blur-in", entering([{ ...fadeIn(0.5, 0.5), from: { opacity: 0, blur: 20 }, to: { opacity: 1, blur: 0 } }]));
  uses("type-mask-rise", entering([{ kind: "in", start: 0.5, duration: 0.5, easing: "smooth", from: { reveal: { progress: 0, direction: "up", softness: 0 } }, to: { reveal: { progress: 1, direction: "up", softness: 0 } } }]));
  // headline-reveal "lines": each line slides up out of a text clip, which is a mask rise, not a slide.
  const lines = entering([{ ...fadeIn(0.5, 0.4), from: { opacity: 0, y: 260 }, to: { opacity: 1, y: 200 }, unit: "lines", stagger: 0.1, textClip: true }]);
  uses("type-mask-rise", lines);
  notUses("type-slide", lines);
  // Only the reveal: a word-by-word entrance is type-words, not also type-fade.
  notUses("type-fade", entering([{ ...fadeIn(0.5, 0.4), unit: "words", stagger: 0.1 }]));
});

test("type: giant, counter, swap and kinetic type", () => {
  uses("type-giant", scene({ layers: [text("word", "now", { fontSize: 320 })] }));
  notUses("type-giant", scene({ layers: [text("word", "now", { fontSize: 120 })] }));
  uses("type-counter", scene({ layers: [text("count", "0", { animations: [{ kind: "counter", start: 0.5, duration: 1, easing: "smooth", from: 0, to: 100, step: 1, out: null, in: null }] })] }));
  uses("type-swap", scene({ layers: [text("swap", "fast", { animations: [{ kind: "change-text", text: "free", start: 2 }] })] }));
  uses("type-kinetic", scene({ layers: [text("spin", "around", { animations: [custom(1, 1, { rotation: 0 }, { rotation: 12 })] })] }));
});

// ---------------------------------------------------------------- texture and set pieces

test("texture: particles, light-sweep, rgb-split, grain, vignette, motion-blur and depth-blur", () => {
  const full = { x: 0, y: 0, width: 1920, height: 1080, fillEnabled: false, strokeWidth: 0 };
  uses("particles", scene({ layers: [rect("snow", { ...full, animations: [effect("snow", 0, 4, { count: 200 })] })] }));
  uses("light-sweep", scene({ layers: [rect("sun", { animations: [effect("lens-flare", 0, 2, { x: 1.2, y: 0.4 }, { x: -0.1, y: 0.2 })] })] }));
  uses("rgb-split", scene({ layers: [picture("still", { animations: [effect("rgb-shift", 1, 0.3)] })] }));
  uses("grain", scene({ layers: [picture("still", { animations: [effect("grain", 0, 4)] })] }));
  uses("vignette", scene({ layers: [picture("still", { animations: [effect("vignette", 0, 4)] })] }));
  uses("motion-blur", scene({ layers: [rect("panel", { animations: [custom(1, 0.4, { x: -800 }, { x: 560 }), effect("directional-blur", 1, 0.2, { length: 300, angle: 0 })] })] }));
  // Back-to-back blur keys on one layer (judder's fix) are one use.
  const keyed = scene({ layers: [rect("panel", { animations: [custom(1, 0.4, { x: -800 }, { x: 560 }),
    effect("directional-blur", 1, 0.1, { length: 300 }, { length: 0 }), effect("directional-blur", 1.1, 0.1, { length: 0 })] })] });
  assert.equal(techniquesUsed(modelOf(keyed))["motion-blur"].length, 1);
  // A blurred picture behind a sharp title; the same picture sharp is no depth blur.
  const behind = (blur) => scene({ layers: [picture("scene-shot", { blur }), text("title", "hello", { x: 200, y: 700 })] });
  uses("depth-blur", behind(24));
  notUses("depth-blur", behind(0));
});

test("set piece: split-screen is two clips side by side; one covered by a full-frame card is not", () => {
  const pair = (more = []) => scene({ layers: [clip("left", { width: 900, height: 1000, x: 40, y: 40 }), clip("right", { width: 900, height: 1000, x: 980, y: 40 }), ...more] });
  uses("split-screen", pair());
  notUses("split-screen", pair([rect("card", { x: 0, y: 0, width: 1920, height: 1080, fill: "#111111" })]));
  // type-behind: a word above a clip and under the cut-out of that clip (cutoutOf); in front, none.
  uses("type-behind", wordsBehind(1));
  notUses("type-behind", wordsBehind(1, true));
});

// ---------------------------------------------------------------- rhythm

test("rhythm: beat-cut, syncopated, beat-kick and hold", () => {
  // 120 bpm: beats every 0.5 s. A cut at 2 s is on the beat; one at 2.25 s is between beats.
  uses("beat-cut", twoShots({ rhythm: { bpm: 120, offset: 0 } }));
  uses("syncopated", twoShots({ rhythm: { bpm: 120, offset: 0 }, a: [hide(2.25)], b: [show(2.25)] }));
  notUses("syncopated", twoShots({ rhythm: { bpm: 120, offset: 0 } }));
  // A 3% pulse: up in 0.06 s, back in 0.3 s.
  const kicks = [1, 2, 3].flatMap((at) => [custom(at, 0.06, { scaleX: 1, scaleY: 1 }, { scaleX: 1.03, scaleY: 1.03 }, "ease-out"), custom(at + 0.06, 0.3, { scaleX: 1.03, scaleY: 1.03 }, { scaleX: 1, scaleY: 1 }, "ease-out")]);
  const found = uses("beat-kick", scene({ layers: [rect("phone", { width: 500, height: 900, animations: kicks })] }));
  assert.equal(found.length, 3);
  // One kick is a hit, not a beat-kick; nor is a scale move over a whole bar as a layer appears
  // (a rush from 118% to 100% in 2 s), nor a 14% pop.
  notUses("beat-kick", scene({ layers: [rect("phone", { width: 500, height: 900, animations: kicks.slice(0, 2) })] }));
  const rush = scene({ layers: [rect("rewind", { x: 0, y: 0, width: 1920, height: 1080, animations: [show(0.5), custom(0.5, 2, { scaleX: 1.18, scaleY: 1.18 }, { scaleX: 1, scaleY: 1 }, "ease-out")] })] });
  assert.deepEqual(pulses(modelOf(rush)), []);
  const pops = [1, 2, 3].flatMap((at) => [custom(at, 0.06, { scaleX: 1, scaleY: 1 }, { scaleX: 1.14, scaleY: 1.14 }, "ease-out"), custom(at + 0.06, 0.3, { scaleX: 1.14, scaleY: 1.14 }, { scaleX: 1, scaleY: 1 }, "ease-out")]);
  notUses("beat-kick", scene({ layers: [rect("phone", { width: 500, height: 900, animations: pops })] }));
  // Nothing moves for the whole 4 s: a hold.
  uses("hold", scene({ layers: [text("still", "wait for it")] }));
  notUses("hold", scene({ layers: [text("still", "wait for it", { animations: [custom(0.5, 3, { x: 200 }, { x: 260 })] })] }));
  // Words revealed one by one early on do not keep the long still after them from being a hold.
  uses("hold", scene({ duration: 6, layers: [text("still", "wait for it"), text("words", "one two three", { y: 500, animations: [{ ...fadeIn(0, 0.3), unit: "words", stagger: 0.1 }] })] }));
});

test("set pieces built by moves are found from the scene's move records, while the move plays", () => {
  const record = (name, tags, start, end) => ({ id: name, name, settings: {}, tags, start, end });
  const document = scene({ duration: 8, layers: [picture("shot")], moves: [
    record("tile-ring", ["tile-ring", "depth-blur"], 0.5, 3), record("swipe-cards", ["swipe-cards"], 3, 6),
    record("logo-match-move", ["logo-match-move", "screen-zoom"], 6, 7.5), record("status-line", ["status-line", "type-swap"], 0, 8),
    record("speed-lines-phone", ["speed-lines", "particles", "slow-push"], 1, 4), record("draw-on", ["draw-on"], 2, 2.8), record("roll", ["roll"], 4, 6),
    record("build-in", ["ui-build"], 6, 7), record("accent-hit", ["accent-hit"], 7, 7.4), record("cursor", ["cursor"], 5, 6.5),
  ] });
  assert.deepEqual(uses("tile-ring", document).map((entry) => entry.at), [0.5]);
  for (const tag of ["swipe-cards", "logo-match-move", "screen-zoom", "status-line", "speed-lines", "draw-on", "roll", "ui-build", "accent-hit", "cursor"]) uses(tag, document);
  notUses("tile-ring", scene({ layers: [picture("shot")] }));
});

test("every technique kino says it can detect has a scene above", () => {
  assert.deepEqual(DETECTABLE_TAGS.filter((tag) => !covered.has(tag)), []);
});

// ---------------------------------------------------------------- the rules

// Captions over a flat card for `seconds` of an 8 s video, then a clip playing.
const cards = (seconds) => scene({ duration: 8, layers: [
  text("card", "every skater knows this street", { animations: [hide(seconds)] }),
  clip("street", { animations: [show(seconds)] }),
  text("caption", "now go", { y: 900, animations: [show(seconds), hide(8)] })] });

test("text_slides: text over a flat card for over 25% of the video, or a card held over 3 s, reads as slides", async () => {
  const [finding] = await fires("text_slides", cards(3.5));
  assert.match(finding.measured, /^4[0-9]% of the video/);
  assert.match(finding.fix.text, /slow-push|drift|type-words|particles/);
  // Text over blurred footage is a card too, so the hint never suggests depth-blur.
  assert.doesNotMatch(finding.fix.text, /depth-blur/);
  // 1.5 s of an 8 s video is under 25% and under 3 s.
  await silent("text_slides", cards(1.5));
  // A 3.5 s card at the start of a 20 s video is under 25%, but held too long.
  const opening = scene({ duration: 20, layers: [text("card", "every skater knows this street", { animations: [hide(3.5)] }), clip("street", { animations: [show(3.5)] })] });
  const [held] = await fires("text_slides", opening);
  assert.match(held.measured, /^1[0-9]% .* \(longest 3\.[0-9]+s\)/);
  // The same card with a slow push behind it is not a slide.
  const pushed = scene({ duration: 8, layers: [picture("still", { animations: [custom(0, 8, { scaleX: 1, scaleY: 1 }, { scaleX: 1.1, scaleY: 1.1 })] }), text("card", "every skater knows this street")] });
  await silent("text_slides", pushed);
  // Three 1.5 s lines on black between shots of a 20 s video: under 25% and under 3 s each, still a slideshow.
  const intertitles = scene({ duration: 20, layers: [0, 1, 2].flatMap((index) => [
    text(`card${index}`, `line ${index + 1} of the story`, { animations: [...(index ? [show(index * 6)] : []), hide(index * 6 + 1.5)] }),
    clip(`shot${index}`, { animations: [show(index * 6 + 1.5), hide(index * 6 + 6)] })]).concat([clip("last", { animations: [show(18)] })]) });
  const [row] = await fires("text_slides", intertitles);
  assert.match(row.measured, /in 3 cards/);
  // Two lines on the flat card and one over a playing clip under a full-frame 50% tint (fp-8) are
  // three cards too, and so is one over the clip blurred to a backdrop, or a line still typing on
  // over the tint (fp-8's prompt); over the clip alone, two.
  const tint = rect("tint", { x: 0, y: 0, width: 1920, height: 1080, fill: "#000000", opacity: 0.5, animations: [show(12), hide(13.5)] });
  const typing = [{ ...fadeIn(12, 0.05), unit: "letters", stagger: 0.06 }];
  const dimmed = (back, entrance = []) => scene({ duration: 20, layers: [
    text("card0", "line 1 of the story", { animations: [hide(1.5)] }), clip("shot0", { animations: [show(1.5), hide(6)] }),
    text("card1", "line 2 of the story", { animations: [show(6), hide(7.5)] }), clip("shot1", { animations: [show(7.5)] }), ...back,
    text("card2", "line 3 of the story", { fill: "#ffffff", animations: [show(12), ...entrance, hide(13.5)] })] });
  const [tinted] = await fires("text_slides", dimmed([tint]));
  assert.match(tinted.measured, /in 3 cards/);
  const blurred = dimmed([clip("log", { blur: 18, animations: [show(12), hide(13.5)] })]);
  await fires("text_slides", blurred);
  await fires("text_slides", dimmed([tint], typing));
  await silent("text_slides", dimmed([]));
  // A sharp screen at half size floating over the tint is the shot; a spec backing depth-blur keeps the blur a shot.
  await silent("text_slides", dimmed([tint, clip("screen", { x: 480, y: 270, width: 960, height: 540, animations: [show(12), hide(13.5)] })]));
  await silent("text_slides", blurred, { styleSpec: { wants: ["depth-blur"], by: "you", quote: "like the reference edit" } });
  // A closing card may hold: 2 s at the end of a 10 s video.
  const closing = scene({ duration: 10, layers: [clip("street", { animations: [hide(8)] }), text("end", "kino.dev", { animations: [show(8)] })] });
  await silent("text_slides", closing);
});

test("few_techniques: a 30 s video needs one designed device, not flat; cuts and plain text do not count", async () => {
  assert.equal(techniquesWanted(30), 1);
  assert.equal(techniquesWanted(8), 1);
  assert.equal(techniquesWanted(77.5), 2);
  const plain = scene({ duration: 30, layers: [0, 1, 2, 3].map((index) => clip(`shot${index}`, { animations: [...(index ? [show(index * 7.5)] : []), ...(index < 3 ? [hide(index * 7.5 + 7.5)] : [])] }))
    .concat([text("caption", "street skate", { y: 900 })]) });
  const [finding] = await fires("few_techniques", plain);
  assert.match(finding.measured, /^0 designed techniques/);
  assert.match(finding.fix.text, /dissolve|drift|type-words|depth-blur/);
  assert.doesNotMatch(finding.fix.text, /add (any )?motion/i);
  // With a signature and no set piece yet, a set piece is suggested first.
  const signature = { signatures: [{ beat: 0, what: "the zoom into the trick", source: "shot1.mp4", why: "only ours" }], by: "guessed" };
  assert.match((await fires("few_techniques", plain, { styleSpec: signature }))[0].fix.text, /where they fit: screen-zoom/);
  // Dissolves, a slow push, words and a depth blur: 4.
  const designed = scene({ duration: 30, layers: [
    picture("back", { blur: 24, animations: [custom(0, 30, { scaleX: 1, scaleY: 1 }, { scaleX: 1.1, scaleY: 1.1 })] }),
    clip("one", { x: 360, y: 140, width: 1200, height: 800, animations: [fadeOut(14.6, 0.6)] }),
    clip("two", { x: 360, y: 140, width: 1200, height: 800, animations: [fadeIn(14.6, 0.6)] }),
    text("caption", "make them want to skate", { y: 960, animations: [{ ...fadeIn(1, 0.6), unit: "words", stagger: 0.1 }] })] });
  await silent("few_techniques", designed);
});

test("plain_beats: only a plain hook, reveal or payoff warns; the first holds a final render when none of them is designed", async () => {
  // Four 5 s clips with captions and plain cuts: the opening and closing windows are plain, so the first holds the render.
  const layers = [0, 1, 2, 3].map((index) => clip(`shot${index}`, { animations: [...(index ? [show(index * 5)] : []), ...(index < 3 ? [hide(index * 5 + 5)] : [])] }))
    .concat([text("caption", "street skate", { y: 900 })]);
  const found = await fires("plain_beats", scene({ duration: 20, layers }));
  assert.deepEqual(found.map((entry) => [entry.at, entry.until, blocksFinal(entry), entry.final === true]), [[0, 2.5, true, true], [17.5, 20, true, false]]);
  assert.match(found[0].fix.text, /the hook \(0-2\.5s\) with a designed camera move: [a-z-]+ or [a-z-]+/);
  // A plain cut within a frame of a song seam (a fit_music cue) is designed: the payoff lands the drop.
  const quarters = [[0, 5], [5, 5], [10, 5], [15, 5]].map(([cue, dur]) => ({ cue, dur, move: null }));
  assert.ok((await fires("plain_beats", scene({ duration: 20, layers }), { board: quarters })).some((entry) => entry.at === 15));
  const seamed = await run("plain_beats", scene({ duration: 20, layers }), { board: quarters, cues: [{ name: "song-drop-1", time: 15.02, kind: "marker" }] });
  assert.ok(!seamed.findings.some((entry) => entry.at === 15));
  // The video already uses a zoom (into shot 3 at 9.6 s): a plain hook is told to reuse it, a motif.
  const zoomed = scene({ duration: 20, layers: layers.map((layer) => (layer.id === "shot1" ? { ...layer, animations: [show(5), custom(9.6, 0.4, { scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 3 }, "ease-in"), hide(10)] } : layer)) });
  assert.match((await fires("plain_beats", zoomed))[0].fix.text, /^Reuse [a-z-]+, the device this video already uses, on the hook \(0-2\.5s\): repeat it as a motif/);
  // With a board, the plain middle shots 2 and 3 are right and never judged; the hook and payoff are.
  const board = [[0, 3], [3, 7], [10, 7], [17, 3]].map(([cue, dur], index) => ({ cue, dur, move: index === 3 ? { kind: "ui" } : null }));
  const runs = await fires("plain_beats", zoomed, { board });
  assert.deepEqual(runs.map((entry) => [entry.at, entry.until]), [[0, 3], [17, 20]]);
  assert.match(runs[1].fix.text, /the payoff \(shot 4, last shot\) with a designed ui move: lift-focus or swipe-cards/);
  // A designed hook (the zoom lands at its end) releases the render; the plain payoff still warns.
  const [payoff, ...more] = await fires("plain_beats", zoomed, { board: [[0, 10], [10, 7], [17, 3]].map(([cue, dur]) => ({ cue, dur, move: null })) });
  assert.deepEqual([payoff.at, payoff.until, payoff.final === true, more.length], [17, 20, false, 0]);
  // A key shot with no move is offered the moves that fit what it holds (engine/movePicks.js).
  const [bare] = await fires("plain_beats", zoomed, { board: board.map((shot, index) => (index ? shot : { ...shot, media: "/api/media/a.mp4" })) });
  assert.match(bare.fix.text, /^Build the hook \(shot 1, footage\) with camera window-punch-in \(phone-film@3\.13\) or camera frame reframe \(agent-launch@11\.25\) \(edit \{ops:\[\{op:"move", name:"window-punch-in"/);
  // With a spine, the payoff is its payoff beat (shots 2 and 3, one beat), not the plain end shot after it.
  const spine = [{ role: "hook", from: 0, to: 11 }, { role: "payoff", from: 11, to: 17 }, { role: "end", from: 17, to: 20 }];
  const spined = await fires("plain_beats", zoomed, { board: [[0, 11], [11, 3], [14, 3], [17, 3]].map(([cue, dur]) => ({ cue, dur, move: null })), styleSpec: { spine } });
  assert.deepEqual(spined.map((entry) => [entry.at, entry.until]), [[11, 17]]);
  assert.match(spined[0].message, /payoff \(11s to 17s\)/);
  // Pure motion graphics (a shape that moves, no footage) are not plain; nor is a short sting.
  await silent("plain_beats", scene({ duration: 20, layers: [rect("bar", { animations: [custom(0, 20, { x: 0 }, { x: 1200 })] }), text("t", "hello")] }));
  await silent("plain_beats", scene({ duration: 6, layers: [clip("a")] }));
  // A slow push over the whole 12 s clip is designed in every beat it covers, not only where it starts.
  await silent("plain_beats", scene({ duration: 12, layers: [clip("a", { animations: [custom(0, 12, { scaleX: 1, scaleY: 1 }, { scaleX: 1.2, scaleY: 1.2 })] }), text("t", "street skate", { y: 900 })] }));
});

test("technique_repeat: one transition at most shot changes, a loud accent past its budget, one entrance on most texts", async () => {
  // Five shots joined by four dissolves; then two dissolves and two cuts.
  const shots = (dissolves) => scene({ duration: 10, layers: [0, 1, 2, 3, 4].map((index) => clip(`shot${index}`, {
    animations: [...(index ? [dissolves[index - 1] ? fadeIn(index * 2, 0.5) : show(index * 2)] : []), ...(index < 4 ? [hide(index * 2 + 2.5)] : [])] })) });
  const [finding] = await fires("technique_repeat", shots([true, true, true, true]));
  assert.match(finding.measured, /dissolve at 4 of 4 shot changes/);
  await silent("technique_repeat", shots([true, true, false, false]));
  // Three dissolves and one plain cut: a motif, not monotony.
  await silent("technique_repeat", shots([true, true, true, false]));
  // A spec that wants dissolves (backed by a reference time) lets them repeat.
  await silent("technique_repeat", shots([true, true, true, true]), { styleSpec: { wants: ["dissolve"], avoids: [], lines: [{ text: "dissolves between recordings", ref: "yt:3VHoNjrUD4Q", at: 12.4, tags: ["dissolve"] }], by: "guessed" } });
  // A loud accent past its budget counts even when the person's words want it.
  const shaken = scene({ duration: 10, layers: [clip("shot", { animations: [1, 3, 5, 7].map((at) => effect("wiggle", at, 0.1, { wiggleX: 10 })) })] });
  assert.match((await fires("technique_repeat", shaken, { styleSpec: { wants: ["shake"], by: "you", quote: "shake it on every hit" } }))[0].measured, /shake 4 times/);
  // A moment (style.moments) is a designed set piece: neither technique_repeat nor
  // vocabulary_budget counts it, and a taste warning inside a signature range is dropped.
  const moment = { moves: [{ tag: "drift", where: "every shot" }], moments: [{ tag: "dissolve", beat: 0, what: "the shots melt" }], by: "guessed" };
  await silent("technique_repeat", shots([true, true, true, true]), { styleSpec: moment });
  await silent("vocabulary_budget", shots([true, true, true, true]), { styleSpec: moment });
  const glue = { moves: moment.moves, by: "guessed" };
  assert.match((await fires("vocabulary_budget", shots([true, true, true, true]), { styleSpec: glue }))[0].measured, /outside the moves: dissolve/);
  // Only the uses inside the range are left out: the 3 dissolves after it still count.
  const melt = (to) => ({ styleSpec: { ...glue, spine: [{ role: "signature", from: 1, to, purpose: "the melt" }] } });
  assert.match((await fires("vocabulary_budget", shots([true, true, true, true]), melt(4)))[0].measured, /outside the moves: dissolve ×3/);
  await silent("vocabulary_budget", shots([true, true, true, true]), melt(9));
  // A word between a clip and its cut-out, four times: type-behind past the motif. A moment
  // leaves out only its own use (6 s, in its beat): four of five still warn, three of four do not.
  const [repeat] = await fires("technique_repeat", wordsBehind(4));
  assert.match(repeat.measured, /^type-behind 4 times$/);
  assert.match(repeat.message, /\(0s, 3s, 6s, 9s\)/);
  const turn = { styleSpec: { spine: [{ role: "turn", from: 5.5, to: 7, purpose: "the turn" }], moments: [{ tag: "type-behind", beat: 0, what: "the turn" }], by: "guessed" } };
  await silent("technique_repeat", wordsBehind(4), turn);
  assert.match((await fires("technique_repeat", wordsBehind(5), turn))[0].message, /\(0s, 3s, 9s, 12s\)/);
  // Six texts, all popping in.
  const pop = (start) => ({ ...fadeIn(start, 0.4), from: { opacity: 0, scaleX: 0.6, scaleY: 0.6 }, to: { opacity: 1, scaleX: 1, scaleY: 1 } });
  const texts = (count) => scene({ duration: 8, layers: [0, 1, 2, 3, 4, 5].map((index) => text(`t${index}`, `line ${index}`, { y: 60 + index * 160, animations: [index < count ? pop(index) : fadeIn(index)] })) });
  const [entrance] = await fires("technique_repeat", texts(6));
  assert.match(entrance.measured, /type-pop on 6 of 6 texts/);
  await silent("technique_repeat", texts(3));
  // The six word groups one caption move made are one entrance, so four other texts with their
  // own entrances are not drowned: 1 of 5 pops, not 6 of 10.
  const words = (count) => [0, 1, 2, 3, 4, 5].slice(0, count).map((index) => text(`said-w${index + 1}`, `word ${index}`, { y: 900, move: { name: "caption-words", instance: "said", part: `w${index + 1}` }, animations: [pop(index * 0.6), hide(index * 0.6 + 0.55)] }));
  const others = [fadeIn(4.5), custom(5, 0.4, { opacity: 0, y: 360 }, { opacity: 1, y: 300 }), custom(5.5, 0.4, { opacity: 0, blur: 12 }, { opacity: 1, blur: 0 }), { ...fadeIn(6, 0.6), unit: "words", stagger: 0.1 }]
    .map((animation, index) => text(`o${index}`, `other line ${index}`, { y: 100 + index * 160, x: 900, animations: [animation] }));
  const captioned = scene({ duration: 8, layers: [...words(6), ...others] });
  assert.equal(textEntrances(modelOf(captioned)).filter((entry) => entry.tag === "type-pop").length, 1);
  await silent("technique_repeat", captioned);
  // One phone sliding in and out the same 460 px: over 3 times is a loop.
  const slides = (count, gap = 3) => scene({ duration: 20, layers: Array.from({ length: count }, (unused, index) => rect(`phone${index}`, { x: 1531, y: 196, width: 332, height: 680,
    animations: [custom(index * gap, 0.4, index % 2 ? { x: 1531 } : { x: 1991 }, index % 2 ? { x: 1991 } : { x: 1531 })] })) });
  const many = slides(6);
  const [loop] = await fires("technique_repeat", many, { scene: many.scenes[0] });
  assert.match(loop.measured, /the same slide 6 times/);
  const few = slides(3);
  await silent("technique_repeat", few, { scene: few.scenes[0] });
  // Six cards staggered 0.1 s apart are one gesture.
  const row = slides(6, 0.1);
  await silent("technique_repeat", row, { scene: row.scenes[0] });
});

test("metronome: shots of nearly one length, or every cut on the beat at one count", async () => {
  const shots = (lengths, rhythm) => {
    const starts = lengths.reduce((list, length) => [...list, list.at(-1) + length], [0]);
    return scene({ duration: starts.at(-1), rhythm, layers: lengths.map((length, index) => clip(`shot${index}`, { animations: [...(index ? [show(starts[index])] : []), ...(index < lengths.length - 1 ? [hide(starts[index + 1])] : [])] })) });
  };
  const [finding] = await fires("metronome", shots([2, 2, 2, 2, 2, 2]));
  assert.match(finding.measured, /6 shots of 2s/);
  await silent("metronome", shots([1, 3, 1.5, 4, 0.8, 2.5]));
  // 120 bpm: lengths 2, 2, 2, 2, 2, 2, 4 spread enough, but every cut is on the beat and most every 4 beats.
  await fires("metronome", shots([2, 2, 2, 2, 2, 2, 4, 1], { bpm: 120, offset: 0 }));
  await silent("metronome", shots([2.25, 1.5, 3, 1.25, 2.5, 4, 1.5], { bpm: 120, offset: 0 }));
});

test("cut_motivation: over 40% of 8+ cuts on no beat, word edge or motion peak", async () => {
  const shots = (starts, rhythm, moveFirst = false) => scene({ duration: 13, rhythm, layers: starts.map((at, index) => clip(`shot${index}`, { animations: [
    ...(index ? [hide(0), show(at)] : []), ...(starts[index + 1] ? [hide(starts[index + 1])] : []),
    ...(moveFirst && index === 0 ? [custom(0.8, 1, { x: 0 }, { x: 600 }, "custom")] : [])] })) });
  const loose = [0, 1.3, 2.7, 3.6, 5.1, 6.3, 7.9, 8.7, 10.2, 11.6];
  const [finding] = await fires("cut_motivation", shots(loose, { bpm: 120, offset: 0 }));
  assert.match(finding.measured, /^9 of 9 cuts unmotivated/);
  // On the beat grid, on beat cues, or fewer than 8 cuts: quiet.
  // The beat grid, with syncopated cuts on the half beat (the "and").
  await silent("cut_motivation", shots([0, 1.5, 2.25, 4, 5.25, 6.5, 8, 8.75, 10, 11.5], { bpm: 120, offset: 0 }));
  await silent("cut_motivation", shots(loose), { beatCues: loose.slice(1, 7).map((time) => ({ time, kind: "beat" })) });
  await silent("cut_motivation", shots(loose.slice(0, 8)));
  // A cut at the fastest point of a move is a cut on action.
  assert.equal(cutReasons(modelOf(shots(loose, null, true)), {})[0].why, "motion");
});

test("beat_kick: the same small pulse six times or more", async () => {
  const kicks = (count, amount = (index) => 1.03) => [...Array(count).keys()].flatMap((index) => {
    const at = 0.5 + index;
    const peak = amount(index);
    return [custom(at, 0.06, { scaleX: 1, scaleY: 1 }, { scaleX: peak, scaleY: peak }, "ease-out"), custom(at + 0.06, 0.3, { scaleX: peak, scaleY: peak }, { scaleX: 1, scaleY: 1 }, "ease-out")];
  });
  const phone = (animations) => scene({ duration: 8, layers: [rect("phone", { width: 500, height: 900, animations })] });
  const [finding] = await fires("beat_kick", phone(kicks(7)));
  assert.match(finding.measured, /the same 3% pulse 7 times/);
  await silent("beat_kick", phone(kicks(4)));
  // Seven kicks of different sizes are not one tic.
  await silent("beat_kick", phone(kicks(7, (index) => 1.02 + index * 0.012)));
  // A spec that wants beat kicks (the person asked) turns the rule off.
  const notes = await silent("beat_kick", phone(kicks(7)), { styleSpec: { wants: ["beat-kick"], by: "you", quote: "kick the phone on every bass hit" } });
  assert.ok(notes.some((note) => note.startsWith("beat_kick is off")), notes.join(" | "));
});

test("flat_sections: adjacent sections must differ in 2 of cut rate, motion, picture and framing", async () => {
  // Two sections of the same kind: still text on the paper background, same size.
  const alike = scene({ duration: 8, layers: [text("one", "first part", { animations: [hide(4)] }), text("two", "second part", { animations: [show(4)] })] });
  const [finding] = await fires("flat_sections", alike);
  assert.match(finding.measured, /alike in all 4|differ only in/);
  // The second section is a clip playing full frame: picture and motion change.
  const contrast = scene({ duration: 8, layers: [text("one", "first part", { animations: [hide(4)] }), clip("two", { animations: [show(4)] })] });
  await silent("flat_sections", contrast);
});

test("style_avoided and style_wanted: the spec's avoided techniques warn when used, its wanted ones when missing", async () => {
  const spec = (fields) => ({ styleSpec: { wants: [], avoids: [], lines: [], by: "you", quote: "dissolves, no glitches", ...fields } });
  const glitchy = twoShots({ b: [show(2), { kind: "in", start: 2, duration: 0.3, easing: "ease-in", preset: { id: "glitch", mode: "in", parameters: {} },
    from: { effectPreset: { id: "glitch", parameters: {}, progress: 0 } }, to: { effectPreset: { id: "glitch", parameters: {}, progress: 1 } } }] });
  const [avoided] = await fires("style_avoided", glitchy, spec({ avoids: ["glitch-hit"] }));
  assert.match(avoided.measured, /glitch-hit 1 time/);
  // A guessed avoid (not the person's words) is a question: it warns and never blocks.
  const { findings: [guessed] } = await run("style_avoided", glitchy, { styleSpec: { wants: [], avoids: ["glitch-hit"], lines: [], by: "guessed" } });
  assert.equal(guessed.severity, "warn");
  // An approved spec whose avoids were copied from another project's brief: still a question.
  const { findings: [copied] } = await run("style_avoided", glitchy, spec({ avoids: ["beat-kick", "glitch-hit", "fade-black"], sources: { avoids: "copied" } }));
  assert.deepEqual([copied.severity, copied.required], ["warn", "no glitch-hit (the style spec avoids it, copied from another brief)"]);
  await silent("style_avoided", twoShots(), spec({ avoids: ["glitch-hit"] }));
  await silent("style_avoided", glitchy);
  // Wanted dissolves, used once, and the other clips cut hard: a wanted transition is a tool, hard cuts stay free.
  const cutting = scene({ duration: 8, layers: [0, 1, 2, 3].map((index) => clip(`shot${index}`, { animations: [...(index === 1 ? [fadeIn(2, 0.5)] : index ? [show(index * 2)] : []), ...(index < 3 ? [hide(index * 2 + (index ? 2 : 2.5))] : [])] })) });
  await silent("style_wanted", cutting, spec({ wants: ["dissolve"] }));
  const dissolving = scene({ duration: 8, layers: [0, 1, 2, 3].map((index) => clip(`shot${index}`, { animations: [...(index ? [fadeIn(index * 2, 0.5)] : []), ...(index < 3 ? [hide(index * 2 + 2.5)] : [])] })) });
  await silent("style_wanted", dissolving, spec({ wants: ["dissolve"] }));
  // A wanted technique that is not there at all.
  const [missing] = await fires("style_wanted", dissolving, spec({ wants: ["dissolve", "type-words"] }));
  assert.equal(missing.measured, "no type-words");
  // A guessed spec with no reference line silences nothing and asks for nothing.
  await silent("style_wanted", cutting, { styleSpec: { wants: ["dissolve"], avoids: [], lines: [], by: "guessed" } });
});

test("deck_unused: a video that uses fewer than half of its deck's cards; a card swapped out does not count", async () => {
  // The same 30 s as few_techniques: dissolves, a slow push, words and a depth blur.
  const designed = scene({ duration: 30, layers: [
    picture("back", { blur: 24, animations: [custom(0, 30, { scaleX: 1, scaleY: 1 }, { scaleX: 1.1, scaleY: 1.1 })] }),
    clip("one", { x: 360, y: 140, width: 1200, height: 800, animations: [fadeOut(14.6, 0.6)] }),
    clip("two", { x: 360, y: 140, width: 1200, height: 800, animations: [fadeIn(14.6, 0.6)] }),
    text("caption", "make them want to skate", { y: 960, animations: [{ ...fadeIn(1, 0.6), unit: "words", stagger: 0.1 }] })] });
  const card = (tag) => ({ tag, group: TECHNIQUES.find((entry) => entry.tag === tag).group, why: "deal" });
  const deck = (tags, setPiece = null) => ({ deck: { seed: 7, reroll: 0, cards: tags.map(card), setPiece, swaps: [] } });
  // 1 of 5 used (dissolve): it warns and names the 4 unused cards.
  const [finding] = await fires("deck_unused", designed, deck(["dissolve", "parallax", "type-giant", "particles"], { kind: "move", name: "zoom-through", tags: ["zoom-through"] }));
  assert.equal(finding.measured, "1 of 5 cards used (dissolve)");
  assert.match(finding.message, /parallax, type-giant, particles, zoom-through of the deck \(seed 7\)/);
  assert.match(finding.fix.text, /swap:\{out, in, why\}/);
  // Half used: quiet. After swapping two unused cards for ones the video uses, it is quiet too.
  await silent("deck_unused", designed, deck(["dissolve", "type-words", "parallax", "particles"]));
  const swapped = applySwap(applySwap(deck(["dissolve", "parallax", "type-giant", "particles"]).deck, { out: "parallax", in: "slow-push", why: "a still backdrop" }), { out: "type-giant", in: "type-words", why: "captions" });
  await silent("deck_unused", designed, { deck: swapped });
  // A move counts when the video shows a technique it is tagged with.
  // (parallax-stack's depth-blur is used, so 2 of 3 cards are.)
  await silent("deck_unused", designed, deck(["parallax", "dissolve"], { kind: "move", name: "parallax-stack", tags: ["parallax", "depth-blur"] }));
  // Drawn type cards are not forced once the references name the type (kino has no default type look).
  const typeCards = deck(["dissolve", "type-giant", "type-fade"]);
  await fires("deck_unused", designed, typeCards);
  await silent("deck_unused", designed, { ...typeCards, styleSpec: { wants: ["type-words"], by: "you", quote: "captions word by word like the reference" } });
  // No deck, or a video under 8 s: quiet.
  await silent("deck_unused", designed, {});
  await silent("deck_unused", scene({ duration: 4, layers: [text("title", "hello")] }), deck(["dissolve", "parallax", "particles"]));
});

test("busy_edit: many devices, moves on most shots, mixed text looks and bright-dark swings warn; a restrained edit is quiet", async () => {
  // Five full-frame shots of 2.4 s with plain cuts; moves and texts on top.
  const cuts = (index) => [...(index ? [show(index * 2.4)] : []), ...(index < 4 ? [hide((index + 1) * 2.4)] : [])];
  const record = (id, name, tags, start, end, settings = {}) => ({ id, name, settings, tags, start, end });
  const edit = (moves, texts = []) => scene({ duration: 12, moves, layers: [...[0, 1, 2, 3, 4].map((index) => clip(`s${index}`, { animations: cuts(index) })), ...texts] });
  // A frame of one gray level per shot: what check would render in the middle of each.
  const frames = (levels) => ({ renderFrames: async (times) => times.map((time) => ({ width: 2, height: 2, pixels: new Uint8Array(16).fill(levels[Math.min(4, Math.floor(time / 2.4))]) })) });
  const busy = edit([
    record("ui-plane", "ui-plane", ["orbit-3d", "drift"], 0.2, 2), record("carry", "carry", ["match-cut"], 2.4, 2.8), record("roll", "roll", ["roll"], 4.8, 6.5),
    record("build-in", "build-in", ["ui-build"], 7.4, 8), record("stream", "stream", ["type-words"], 9.8, 10.8, { from: "#F0508C" }), record("type-on", "type-on", ["type-letters"], 7.3, 8.5),
  ], [text("quote", "the best project", { fontFamily: "Inter", animations: [show(1), hide(4)] }), text("ask", "show me", { animations: [show(5), hide(8)] })]);
  // The model keeps each move's settings: a stream's color is part of its look.
  const found = await fires("busy_edit", busy, frames([200, 20, 200, 20, 200]));
  assert.deepEqual(found.map((finding) => finding.measured.split(" (")[0]), ["4 devices", "5 of 5 shots carry a designed move", "3 text looks", "4 brightness swings of 64+ levels"]);
  assert.match(found[2].measured, /type-on x1, stream from #F0508C x1; families Inter, Noto Serif/);
  // One motif on two of five shots, one family cutting in, one brightness: quiet.
  const restrained = edit([record("ui-plane", "ui-plane", ["orbit-3d", "drift"], 2.4, 4.6), record("ui-plane-2", "ui-plane", ["orbit-3d", "drift"], 7.2, 9.4)],
    [text("quote", "the best project", { animations: [show(1), hide(4)] }), text("ask", "show me", { animations: [show(5), hide(8)] })]);
  await silent("busy_edit", restrained, frames([120, 110, 130, 115, 125]));
  // A dark closing shot (an end mark on black) is not a swing.
  await silent("busy_edit", restrained, frames([120, 110, 130, 115, 10]));
});

test("reference_closeness: an edit cut to a reference's shot lengths in order, or the pooled contest device stack", async () => {
  const shots = (cuts, duration) => scene({ duration, layers: [0, ...cuts].map((at, index) => clip(`shot${index}`, { animations: [
    ...(index ? [hide(0), show(at)] : []), ...(index < cuts.length ? [hide(cuts[index])] : [])] })) });
  // A reference's cuts over 16 s, uneven; the edit scales them to 12 s (fit), as borrowing raw times did.
  const ref = { id: "yt:ref", seconds: 16, fps: 24, cuts: [0.8, 2.4, 2.9, 4.6, 5.4, 7.5, 8.1, 10.2, 11.4, 12.2, 14.4] };
  const copied = ref.cuts.map((time) => Math.round(time * 0.75 * 30) / 30);
  const [finding] = await fires("reference_closeness", shots(copied, 12), { closeRefs: [ref] });
  assert.match(finding.measured, /^\d+ shots in a row from [\d.]+s have yt:ref's shot lengths in order \(x0\.75\)/);
  // The same reference's lengths in a new order (borrow_rhythm), or an even grid any beat edit shares: quiet.
  await silent("reference_closeness", shots([0.6, 2.7, 3.3, 4.5, 6.1, 6.7, 7.3, 8.5, 10.1, 11.2], 12), { closeRefs: [ref] });
  const grid = { ...ref, cuts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
  await silent("reference_closeness", shots([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12), { closeRefs: [grid] });
  // Shots of 1 and 2 beats at 100 BPM against a reference of 1 and 2 beats at 120 BPM: two lengths
  // line up in order by chance (x1.2), so beat cutting is no copy.
  const beats = { id: "yt:beats", seconds: 10, fps: 24, cuts: [0.5, 1.5, 2, 3, 3.5, 4, 5, 5.5, 6.5, 7, 8] };
  await silent("reference_closeness", shots([0.6, 1.8, 2.4, 3.6, 4.2, 4.8, 6, 6.6, 7.8, 8.4], 10), { closeRefs: [beats] });
  // A black hole, then a seam flash, then a word card within 2 s: the pooled drop stack, in a music edit.
  const song = { cues: [{ name: "song-drop-1", time: 2, kind: "marker" }] };
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  const stack = (background, more = []) => scene({ duration: 6, background, layers: [
    clip("a", { animations: [hide(2)] }),
    clip("b", { animations: [hide(0), show(2.2), hide(3.2)] }),
    ...more,
    rect("flash", { ...full, fill: "#ffffff", animations: [hide(0), show(2.2), hide(2.3)] }),
    text("word", "NOW", { fontFamily: "Inter", fontSize: 400, fill: "#ffffff", x: 600, y: 300, animations: [hide(0), show(3.4), hide(4.4)] }),
    clip("c", { animations: [hide(0), show(4.4)] })] });
  const [stacked] = await fires("reference_closeness", stack("#000000"), song);
  assert.match(stacked.measured, /^black-hole then seam-flash then word-card from 2s/);
  // The same with the black frame and the word card's plain frame drawn as full-frame solids.
  const solids = stack(PAPER, [rect("black", { ...full, fill: "#000000", animations: [hide(0), show(2), hide(2.2)] }),
    rect("card", { ...full, fill: "#c0392b", animations: [hide(0), show(3.2), hide(4.4)] })]);
  assert.match((await fires("reference_closeness", solids, song))[0].measured, /^black-hole then seam-flash then word-card from 2s/);
  // A promo with no song: a dip to black, a flash and a title are its own reveal.
  await silent("reference_closeness", stack("#000000"));
  // A white frame inside one running shot (an impact frame) is a plain flash: no seam flash, no cut.
  const impact = modelOf(scene({ duration: 6, layers: [clip("a"), rect("hit", { ...full, fill: "#ffffff", animations: [hide(0), show(3), hide(3.1)] })] }));
  assert.deepEqual(profileDevices(impact), []);
  assert.deepEqual(shotTimes(impact), []);
});

test("a restrained edit (plain cuts, one device on the hook and the payoff) gets no contradicting variety warnings", async () => {
  // Five 2.4 s shots cut plainly; shots 1 and 4 zoom into the next, the same device twice.
  const zoomed = new Set([0, 3]);
  const edit = scene({ duration: 12, layers: [...[0, 1, 2, 3, 4].map((index) => clip(`s${index}`, { animations: [...(index ? [show(index * 2.4)] : []),
    ...(zoomed.has(index) ? [custom(index * 2.4 + 2, 0.4, { scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 3 }, "ease-in")] : []), ...(index < 4 ? [hide((index + 1) * 2.4)] : [])] })),
  text("caption", "street skate", { y: 900 })] });
  for (const code of ["busy_edit", "plain_beats", "technique_repeat", "few_techniques", "vocabulary_budget"]) await silent(code, edit);
});

test("every technique rule has a bad and a good example above", () => {
  const codes = ["text_slides", "few_techniques", "plain_beats", "technique_repeat", "metronome", "beat_kick", "flat_sections", "style_avoided", "style_wanted", "deck_unused", "busy_edit", "reference_closeness"];
  assert.deepEqual(codes.filter((code) => !RULES.some((entry) => entry.code === code)), [], "all are registered");
  assert.deepEqual(codes.filter((code) => !rulesCovered.has(code)), []);
  // style_avoided gates a final render when the person said no (by:"you"); the rest advise.
  const advice = new Set(["flat_sections", "deck_unused", "busy_edit"]);
  assert.ok(codes.every((code) => ruleOf(code).level === (code === "style_avoided" ? "error" : advice.has(code) ? "info" : "warn")), "warnings or advice, but style_avoided is a gate");
});

test("spine_drift and rejected_text: the timeline keeps to the locked spine, and turned-down text stays off screen", async () => {
  // 20 s: the hook clip 0-4 s, the problem clip 4-10 s, the payoff 10-20 s.
  const story = scene({ duration: 20, layers: [
    clip("hook", { animations: [hide(4)] }), clip("ask", { animations: [show(4), hide(10)] }), clip("win", { animations: [show(10)] }),
    // The slogan split over two layers shown together, as edits often set it.
    text("claim", "7 open models.", { y: 700, animations: [show(12), hide(15)] }), text("claim-2", "one rtx 4090.", { y: 850, animations: [show(12.5), hide(15)] })] });
  const beat = (role, from, to, uses) => ({ role, from, to, uses, purpose: `the ${role}` });
  const good = [beat("hook", 0, 4, ["hook"]), beat("problem", 2.5, 10, ["ask"]), beat("payoff", 10, 18.5, ["win"]), beat("end", 18.5, 20)];
  await silent("spine_drift", story, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: good } });
  // The problem late (4 s of 20 is 20%), a gap of 2.5 s no beat covers, a second payoff, a beat out of place.
  const bad = [beat("hook", 0, 4, ["hook"]), beat("problem", 4, 10, ["win"]), beat("payoff", 12.5, 15), beat("payoff", 15, 20)];
  const { findings: drift } = await run("spine_drift", story, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: bad } });
  assert.deepEqual(drift.map((finding) => [finding.measured, finding.severity]), [["10-12.5s in no beat", "error"], ["premise at 20%", "error"], ["2 payoff beats", "warn"], ["win first at 10s", "error"]], "a second payoff warns; the rest are gates");
  // A logo bumper at the start and the end, listed in both beats, is the plan; listed in the end and missing there is not.
  const bumper = scene({ duration: 20, layers: [text("logo", "ACME", { animations: [hide(2), show(18)] }), clip("shot", { animations: [show(2), hide(18)] })] });
  const bookends = [beat("hook", 0, 2, ["logo"]), beat("problem", 2, 17, ["shot"]), beat("end", 17, 20, ["logo"])];
  await silent("spine_drift", bumper, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: bookends } });
  const [missing] = await fires("spine_drift", story, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: [beat("hook", 0, 4, ["hook"]), beat("problem", 2.5, 10, ["ask"]), beat("end", 10, 20, ["hook"])] } });
  assert.equal(missing.measured, "hook not in end");
  // A beat may name a media file as the library lists it (with or without the extension), or a sound it plays.
  const heard = scene({ duration: 20, layers: [clip("shot-2"), { type: "audio", id: "voice", name: "voice", src: "/api/media/v.wav", mediaStart: 2, mediaDuration: 3, mediaSourceDuration: 3 }] });
  const files = { scene: heard.scenes[0], mediaNames: { "/api/media/shot-2.mp4": "target.mp4" } };
  const usesOf = (names) => ({ ...files, styleSpec: { wants: [], avoids: [], by: "guessed", spine: [beat("hook", 0, 2.5, names), beat("problem", 2.5, 20, ["voice"])] } });
  await silent("spine_drift", heard, usesOf(["target.mp4", "target"]));
  const [voiceLate] = await fires("spine_drift", heard, { ...files, styleSpec: { wants: [], avoids: [], by: "guessed", spine: [beat("hook", 0, 1.5, ["voice"]), beat("problem", 1.5, 20)] } });
  assert.equal(voiceLate.measured, "voice first at 2s", "a sound is placed by when it is heard");
  // A 10 s clip may open on a 2.5 s hook (the premise floor is 3 s).
  const [past] = await fires("spine_drift", story, { styleSpec: { wants: [], avoids: [], by: "guessed", spine: [...good, beat("proof", 21, 30)] } });
  assert.equal(past.measured, "proof at 21s", "a beat after the video ends");
  await silent("spine_drift", scene({ duration: 10, layers: [clip("shot")] }), { styleSpec: { wants: [], avoids: [], by: "guessed", spine: [beat("hook", 0, 2.5), beat("problem", 2.5, 10)] } });
  // The rejected slogan, reworded with digits and lower case, is a gate; another line is not.
  const [rejected] = await fires("rejected_text", story, { styleSpec: { wants: [], avoids: [], by: "guessed", rejected: ["Seven open-weight models. One RTX 4090."] } });
  assert.deepEqual([rejected.itemId, rejected.at], ["claim", 12.5]);
  assert.equal(sameWording("Seven open-weight models. One RTX 4090.", "7 open models."), false, "a part alone is not the line");
  await silent("rejected_text", story, { styleSpec: { wants: [], avoids: [], by: "guessed", rejected: ["The fastest way to ship"] } });
  // A caption layer that changes its text: each line is said alone, not all of them joined.
  const change = (start, value) => ({ kind: "change-text", start, text: value, overlap: false, out: null, in: null });
  const caption = scene({ duration: 6, layers: [text("caps", "she walks to the store", { animations: [change(2, "seven open-weight models. one rtx 4090."), change(4, "and the phone tells her where")] })] });
  await fires("rejected_text", caption, { styleSpec: { wants: [], avoids: [], by: "guessed", rejected: ["Seven open-weight models. One RTX 4090."] } });
  await silent("rejected_text", story);
});

test("signature_missing: an idea needs a signature range that holds a designed moment and outlasts the text cards", async () => {
  // 20 s: text cards for the hook (0-3 s), the problem (3-9 s) and the end (16-20 s); `middle` fills 9-16 s.
  const cards = (middle) => scene({ duration: 20, layers: [text("hook", "learning is slow", { animations: [hide(3)] }), text("ask", "you forget it all", { animations: [show(3), hide(9)] }),
    ...middle, text("end", "oak", { animations: [show(16)] })] });
  const shown = clip("streak", { animations: [show(9), hide(16)] });
  const beat = (role, from, to) => ({ role, from, to, purpose: `the ${role}` });
  const signature = { beat: 2, what: "the streak map", source: "home screen", why: "only oak keeps a streak map" };
  const spec = (to, extra = {}) => ({ styleSpec: { wants: [], avoids: [], by: "guessed", idea: "your streak becomes a map", signatures: [signature],
    spine: [beat("hook", 0, 3), beat("problem", 3, 9), beat("signature", 9, to), beat("end", to, 20)], ...extra } });
  // The full-frame screen fills the 7 s signature beat, longer than every card: quiet.
  await silent("signature_missing", cards([shown]), spec(16));
  // The signature range only shows another text card (fading in is no designed moment). The fix names the signature and the deck's set piece.
  const [plain] = await fires("signature_missing", cards([text("streak", "keep your streak", { animations: [fadeIn(9), hide(16)] })]), { ...spec(16), deck: { seed: 1, cards: [], setPiece: { kind: "move", name: "card-into-device", tags: [] } } });
  assert.equal(plain.measured, "no designed moment");
  assert.match(plain.fix.text, /^Make the streak map using home screen fill 9-16s: the deck's set piece card-into-device/);
  // A 3 s signature is shorter than the 8 s end card (12-20 s); the moments' tag is suggested.
  const short = cards([clip("streak", { animations: [show(9), hide(12)] }), text("more", "and more", { animations: [show(12), hide(16)] })]);
  const [brief] = await fires("signature_missing", short, spec(12, { moments: [{ tag: "screen-zoom", beat: 2, what: "zoom into the map" }] }));
  assert.equal(brief.measured, "signature 3s, end card 8s");
  assert.match(brief.fix.text, /the moments' screen-zoom/);
  // An idea with no signature range at all; signatures[].at alone is a range.
  const noRange = { styleSpec: { ...spec(16).styleSpec, spine: spec(16).styleSpec.spine.map((entry) => (entry.role === "signature" ? { ...entry, role: "proof" } : entry)) } };
  assert.equal((await fires("signature_missing", cards([shown]), noRange))[0].measured, "no signature range");
  await silent("signature_missing", cards([shown]), { styleSpec: { ...noRange.styleSpec, signatures: [{ ...signature, at: [9, 16] }] } });
  // No idea and no signature: kino's default edit, quiet.
  await silent("signature_missing", cards([]), { styleSpec: { wants: [], avoids: [], by: "guessed" } });
  // It warns while editing and blocks only a final render; reviewers get the idea and signature lines.
  assert.equal(blocksFinal(plain), true);
  assert.equal(blocksFinal({ ...plain, waived: "on purpose" }), false);
  // In a real edit every open warning holds a final render; advice (info) never does.
  assert.equal(blocksFinal({ severity: "warn", rule: "text_slides" }), true);
  assert.equal(blocksFinal({ severity: "info", rule: "busy_edit" }), false);
  // Outside a real edit (no brief, a sketch), a plain warning does not hold it; signature_missing still does.
  assert.equal(blocksFinal({ severity: "warn", rule: "text_slides" }, false), false);
  assert.equal(blocksFinal(plain, false), true);
  assert.deepEqual(ideaLines(styleContext(spec(16).styleSpec)), ["Idea: your streak becomes a map", "Signature: the streak map using home screen @9-16s"]);
});

// ---------------------------------------------------------------- the style spec and the default rules

// Three texts revealed word by word, the auto-caption look word_by_word warns about.
const captions = scene({ duration: 6, layers: [0, 1, 2].map((index) => text(`line${index}`, `say it word by word ${index}`, { y: 100 + index * 200,
  animations: [{ kind: "in", start: 0.2 + index, duration: 0.8, easing: "smooth", unit: "words", stagger: 0.1, from: { opacity: 0 }, to: { opacity: 1 } }] })) });

test("style spec: a wanted technique backed by a reference time or the person's words turns its default rule off", async () => {
  await fires("word_by_word", captions);
  const fromReference = { wants: ["type-words"], avoids: [], lines: [{ text: "lowercase captions, word by word", ref: "yt:3VHoNjrUD4Q", at: 8.2, tags: ["type-words"] }], by: "guessed" };
  const notes = await silent("word_by_word", captions, { styleSpec: fromReference });
  assert.ok(notes.includes("word_by_word is off: the style spec wants type-words."), notes.join(" | "));
  await silent("word_by_word", captions, { styleSpec: { wants: ["type-words"], by: "you", quote: "captions word by word like the reference" } });
  // A typed diary line: stagger_long (and its auto fix) leave the designed typing alone.
  const typing = scene({ duration: 4, layers: [text("diary", "i asked an ai about my homework.", { animations: [{ kind: "in", start: 0.5, duration: 0.05, easing: "smooth", unit: "letters", stagger: 0.035, from: { opacity: 0 }, to: { opacity: 1 } }] })] });
  await fires("stagger_long", typing);
  const typed = await silent("stagger_long", typing, { styleSpec: { wants: ["type-letters"], by: "you", quote: "typed out like a diary" } });
  assert.ok(typed.some((note) => note.startsWith("stagger_long leaves letter-by-letter typing alone")), typed.join(" | "));
});

test("style spec: a guessed want with no reference line is shown but turns no rule off", async () => {
  const guessed = { wants: ["type-words"], avoids: [], lines: [{ text: "captions word by word" }], by: "guessed" };
  const { findings, notes } = await run("word_by_word", captions, { styleSpec: guessed });
  assert.equal(findings.length, 1, "word_by_word still warns");
  assert.ok(notes.some((note) => note.startsWith("style spec: type-words is guessed")), notes.join(" | "));
  // A line with a ref but no time is not backed either.
  const { findings: still } = await run("word_by_word", captions, { styleSpec: { ...guessed, lines: [{ text: "type-words captions", ref: "yt:3VHoNjrUD4Q" }] } });
  assert.equal(still.length, 1);
  assert.deepEqual(styleContext(guessed).backed, []);
  assert.match(styleLine(guessed), /type-words not backed/);
  assert.equal(styleLine(null), "style: kino default (no style spec)");
});

test("style spec: soft_cuts, blurred_backdrop and same_entrance follow wanted tags; gates never change", async () => {
  const backed = (tags) => ({ styleSpec: { wants: tags, by: "you", quote: "like the reference edit" } });
  // Four sections, each leaving with a fade.
  const sectioned = scene({ duration: 8, layers: [0, 1, 2, 3].map((index) => text(`part${index}`, `Part ${index}`, {
    animations: [...(index ? [show(index * 2)] : []), ...(index < 3 ? [fadeOut(index * 2 + 1.65, 0.35)] : [])] })) });
  await fires("soft_cuts", sectioned);
  await silent("soft_cuts", sectioned, backed(["dissolve"]));
  // Wanting blur-through does not excuse a soft change at every section.
  await fires("soft_cuts", sectioned, backed(["blur-through"]));
  const backdrop = scene({ duration: 6, layers: [picture("footage", { blur: 20 }), ...[0, 1, 2].map((index) => text(`title${index}`, `Hello ${index}`, { x: 760, width: 400, height: 100, textResize: "fixed",
    animations: [...(index ? [show(index * 2)] : []), ...(index < 2 ? [hide(index * 2 + 2)] : [])] }))] });
  await fires("blurred_backdrop", backdrop);
  await silent("blurred_backdrop", backdrop, backed(["depth-blur"]));
  const preset = (id, start) => ({ kind: "in", start, duration: 0.5, easing: "smooth", preset: { id, mode: "in" }, from: { opacity: 0 }, to: { opacity: 1 } });
  const lines = scene({ duration: 6, layers: [0, 1, 2, 3].map((index) => text(`line${index}`, `Line ${index}`, { y: 100 + index * 200, animations: [preset("fade", 0.2 + index)] })) });
  await fires("same_entrance", lines);
  await silent("same_entrance", lines, backed(["type-fade"]));
  // Wanting a different entrance does not excuse this one.
  await fires("same_entrance", lines, backed(["type-words"]));
  // A gate: a 20 px body line is too small whatever the spec says.
  const small = scene({ layers: [text("body", "Classes every Saturday", { role: "body", fontSize: 20 })] });
  const { findings } = await run("type_min", small, backed(["type-words", "hold", "dissolve"]));
  assert.equal(findings.length, 1);
});
