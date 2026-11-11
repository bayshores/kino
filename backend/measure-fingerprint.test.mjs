// The fingerprint math (backend/measure/fingerprint.mjs), the suggested style lines (suggest.mjs),
// the strip moments (strips.mjs) and the comparison the reference_drift check uses
// (engine/quality/referenceCompare.js, engine/quality/rules/reference.js). No video, no Vision: the
// inputs are made here, so every expected number is known.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CELL_COLS, CELL_ROWS, classifyReveals, fingerprint, fitGlobalMotion, gradualTransitions, packPrint, pairMotion, palette, persistentElements,
  printDistance, revealOf, sameLine, trackText, unpackPrint,
} from "./measure/fingerprint.mjs";
import { suggestStyleLines, suggestionText, typeNote } from "./measure/suggest.mjs";
import { MAX_STRIPS, stripArgs, stripMoments } from "./measure/strips.mjs";
import { compareFingerprints } from "../engine/quality/referenceCompare.js";
import { drifted, pairTimes } from "../engine/quality/rules/reference.js";

const W = 640, H = 360;

// A 16 × 9 flow grid from a whole-frame move: pan (tx, ty) px, zoom s, rotation r (radians),
// plus `inside`: extra arrows on some cells (something moving inside the picture).
function grid({ tx = 0, ty = 0, s = 0, r = 0, inside = null } = {}) {
  const u = [], v = [];
  for (let row = 0; row < 9; row += 1)
    for (let col = 0; col < 16; col += 1) {
      const x = ((col + 0.5) / 16 - 0.5) * W, y = ((row + 0.5) / 9 - 0.5) * H;
      let du = tx + s * x - r * y, dv = ty + r * x + s * y;
      if (inside && col >= 6 && col < 10 && row >= 3 && row < 6) { du += inside[0]; dv += inside[1]; }
      u.push(du); v.push(dv);
    }
  return { cols: 16, rows: 9, u, v };
}

test("the whole-frame fit finds a pan, a zoom and a rotation, and leaves a moving subject out", () => {
  const pan = fitGlobalMotion(grid({ tx: -4, ty: 1 }), W, H);
  assert.ok(Math.abs(pan.tx + 4) < 1e-9 && Math.abs(pan.ty - 1) < 1e-9 && Math.abs(pan.s) < 1e-9 && pan.residual < 1e-9);
  const zoom = fitGlobalMotion(grid({ s: 0.01 }), W, H);
  assert.ok(Math.abs(zoom.s - 0.01) < 1e-9 && Math.abs(zoom.tx) < 1e-9 && Math.abs(zoom.r) < 1e-9);
  const turn = fitGlobalMotion(grid({ r: 0.005, tx: 2 }), W, H);
  assert.ok(Math.abs(turn.r - 0.005) < 1e-9 && Math.abs(turn.tx - 2) < 1e-9);
  // A subject running across a still background: the camera stays still, the subject is "inside".
  const subject = fitGlobalMotion(grid({ inside: [12, 0] }), W, H);
  assert.ok(Math.abs(subject.tx) < 0.5, `pan ${subject.tx}`);
  assert.ok(subject.residual > 0.8, `residual ${subject.residual}`);
});

test("a frame pair's motion is named: still, push-in, pull-back, pan, rotate, or inside", () => {
  const dt = 1 / 12;
  assert.equal(pairMotion(grid(), W, H, dt).kind, "still");
  assert.equal(pairMotion(grid({ s: 0.01 }), W, H, dt).kind, "zoom-in");
  assert.equal(pairMotion(grid({ s: -0.01 }), W, H, dt).kind, "zoom-out");
  assert.equal(pairMotion(grid({ tx: 3 }), W, H, dt).kind, "pan");
  assert.equal(pairMotion(grid({ r: 0.006 }), W, H, dt).kind, "rotate");
  assert.equal(pairMotion(grid({ inside: [20, 4] }), W, H, dt).kind, "inside");
  // Speeds are in frame diagonals a second: a 4 px pan at 12 a second on a 734 px diagonal.
  const pan = pairMotion(grid({ tx: 4 }), W, H, dt);
  assert.ok(Math.abs(pan.pan - (4 * 12) / Math.hypot(W, H)) < 1e-9);
});

const line = (s, box) => ({ s, box, c: 0.5 });
const samples = (lists, step = 0.25, start = 0) => lists.map((text, index) => ({ t: start + index * step, text }));

test("text lines are followed in place, and a different word in the same place is a new line", () => {
  assert.ok(sameLine("hello wor", "hello world"));
  assert.ok(sameLine("access to...", "acces to..."), "an OCR slip is the same line");
  assert.ok(!sameLine("hi", "so"));
  const tracks = trackText(samples([
    [line("hi", [0.45, 0.9, 0.1, 0.04])],
    [line("so", [0.45, 0.9, 0.1, 0.04])],
    [line("gave", [0.44, 0.9, 0.12, 0.04])],
    [line("claude", [0.43, 0.9, 0.14, 0.04])],
  ]));
  assert.equal(tracks.length, 4);
  const reveals = classifyReveals(tracks);
  assert.equal(reveals.counts.words, 4, "captions swapping a word at a time");
  assert.equal(reveals.dominant, "words");
  assert.equal(reveals.lowercase, 1);
});

test("how a line appears: growing by words or letters, sliding, growing, or all at once", () => {
  const box = (x = 0.3, h = 0.06) => [x, 0.4, 0.4, h];
  const reveal = (lists) => revealOf(trackText(samples(lists))[0]);
  assert.equal(reveal([[line("make", box())], [line("make it", box())], [line("make it move", box())]]), "words");
  assert.equal(reveal([[line("mov", box())], [line("movin", box())], [line("moving", box())]]), "letters");
  assert.equal(reveal([[line("launch day", box(0.1))], [line("launch day", box(0.2))], [line("launch day", box(0.3))]]), "slides");
  assert.equal(reveal([[line("launch day", box(0.3, 0.05))], [line("launch day", box(0.3, 0.07))], [line("launch day", box(0.3, 0.08))]]), "grows");
  assert.equal(reveal([[line("launch day", box())], [line("launch day", box())], [line("launch day", box())]]), "whole");
  // Text that keeps moving after its first second rides on the footage: not a reveal.
  assert.equal(reveal(Array.from({ length: 10 }, (_, index) => [line("78.9", box(0.1 + index * 0.03))])), null);
  // A counter changing in place is not words appearing one at a time.
  const counter = classifyReveals(trackText(samples(["76.1", "75.4", "74.9", "73.2"].map((s) => [line(s, box())]))));
  assert.equal(counter.counts.words, 0);
});

const stats = (luma, sharp, hist = null, cells = null) => ({ luma, sharp, hist: hist ?? Float32Array.from({ length: 64 }, (_, index) => (index === 0 ? 1 : 0)), cells, pixels: [] });

test("gradual transitions: a blur dip, a fade through black and a dissolve are found; a hard cut is not a dissolve", () => {
  const blur = Array.from({ length: 36 }, (_, index) => ({ t: index / 12, stats: stats(0.4, index === 18 ? 5 : index === 17 || index === 19 ? 30 : 100) }));
  assert.deepEqual(gradualTransitions(blur).blurDips, [1.5]);
  const fade = Array.from({ length: 36 }, (_, index) => ({ t: index / 12, stats: stats(Math.abs(index - 18) < 1 ? 0.01 : Math.min(0.5, Math.abs(index - 18) * 0.05), 100) }));
  assert.deepEqual(gradualTransitions(fade).fades, [1.5]);
  // A dissolve: the histogram moves from bin 0 to bin 63 over a second.
  const mix = (k) => Float32Array.from({ length: 64 }, (_, index) => (index === 0 ? 1 - k : index === 63 ? k : 0));
  const dissolve = Array.from({ length: 48 }, (_, index) => ({ t: index / 12, stats: stats(0.4, 100, mix(Math.max(0, Math.min(1, (index - 18) / 12)))) }));
  assert.ok(gradualTransitions(dissolve).dissolves.length >= 1);
  const cut = Array.from({ length: 48 }, (_, index) => ({ t: index / 12, stats: stats(0.4, 100, mix(index >= 24 ? 1 : 0)) }));
  assert.deepEqual(gradualTransitions(cut, [2]).dissolves, []);
});

test("a patch with detail that stays put across cuts is found (a corner logo); a plain background is not", () => {
  const cells = (logo, background) => {
    const values = new Float32Array(CELL_COLS * CELL_ROWS * 2);
    for (let cell = 0; cell < CELL_COLS * CELL_ROWS; cell += 1) { values[cell * 2] = background; values[cell * 2 + 1] = 0.01; }
    values[0] = 0.8; values[1] = logo; // the top-left patch: a logo with detail
    return values;
  };
  const records = Array.from({ length: 12 * 10 }, (_, index) => {
    const shot = Math.floor(index / 24);
    const hist = Float32Array.from({ length: 64 }, (_, bin) => (bin === shot * 10 ? 1 : 0));
    return { t: index / 12, stats: stats(0.4, 100, hist, cells(0.2, 0.1 + shot * 0.15)) };
  });
  const found = persistentElements(records, [2, 4, 6, 8]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "patch");
  assert.deepEqual(found[0].box.slice(0, 2), [0, 0]);
});

test("the palette is the same every time for the same pixels, biggest color first", () => {
  const pixels = [...Array(60).fill([10, 10, 12]), ...Array(30).fill([240, 230, 220]), ...Array(10).fill([200, 40, 60])];
  const first = palette(pixels), second = palette(pixels);
  assert.deepEqual(first, second);
  assert.equal(first[0].hex, "#0a0a0c");
  assert.equal(first[0].share, 0.6);
});

test("feature prints pack to one byte a number and keep their distances", () => {
  const a = Float32Array.from({ length: 768 }, (_, index) => Math.sin(index) * 0.05);
  const b = Float32Array.from({ length: 768 }, (_, index) => Math.cos(index) * 0.05);
  const packed = unpackPrint(packPrint(a));
  assert.ok(printDistance(a, packed) < 0.01);
  assert.ok(Math.abs(printDistance(unpackPrint(packPrint(a)), unpackPrint(packPrint(b))) - printDistance(a, b)) < 0.02);
});

// A fingerprint as the measure would make it, with only the numbers a test needs.
const fp = (over = {}) => ({
  motion: { median: 0.1, stillShare: 0.2, longestStill: { seconds: 1.2, at: 31 }, peaks: [3.1, 12.4] },
  camera: { moving: 0.8, zoomIn: 0.6, zoomOut: 0.05, pan: 0.1, rotate: 0.05, shaky: 0.1, zoomSpeed: 0.1, panSpeed: 0.1, examples: { "zoom-in": [12.4, 31] } },
  handoff: { cuts: 10, inMotion: 7, hard: 3 },
  transitions: { blurDips: [5.9, 18.8], dissolves: [], fades: [] },
  text: { share: 0.3, bigShare: 0.25, lowercase: 0.9, counts: { whole: 1, words: 6, letters: 0, slides: 0, grows: 0 }, examples: { whole: [3], words: [44.2], letters: [], slides: [], grows: [] }, dominant: "words" },
  look: { brightness: 0.08, palette: [{ hex: "#050505", share: 0.8 }] },
  persistent: [],
  ...over,
});

test("suggested style lines say the number and the time, carry technique tags, and are guesses", () => {
  const lines = suggestStyleLines(fp(), { cuts: [1, 2, 3, 4], cutsPerSecond: 0.5, onBeat: [true, true, true, false], onBeatCount: 3 }, "yt:G9wj1YA0DYI");
  assert.ok(lines.length >= 3 && lines.length <= 6);
  assert.ok(lines.every((entry) => entry.guess === true && entry.ref === "yt:G9wj1YA0DYI"));
  assert.equal(lines[0].text, "camera moves 80% of the time; mostly slow push-ins (12.4 s, 31.0 s)");
  assert.deepEqual(lines[0].tags, ["slow-push"]);
  assert.equal(lines[0].at, 12.4);
  const words = lines.find((entry) => entry.tags.includes("type-words"));
  assert.match(words.text, /^lowercase \(90%\) text on screen 30% of the time; words appear one or a few at a time \(44\.2 s\)$/);
  assert.ok(lines.some((entry) => entry.tags.includes("blur-through")));
  assert.ok(lines.some((entry) => entry.tags.includes("beat-cut")), "3 of 4 cuts on the beat");
  // A still reference gets a hold line, not a camera line.
  const still = suggestStyleLines(fp({ camera: { ...fp().camera, moving: 0.1 }, motion: { ...fp().motion, stillShare: 0.6 } }));
  assert.ok(still.some((entry) => entry.tags.includes("hold")));
  assert.match(suggestionText(lines, "yt:G9wj1YA0DYI"), /^suggested style lines \(guesses/);
  // A reference with text also asks for its type: family class (seen, not measured), size, case, reveal, with a time.
  assert.match(typeNote(fp(), "yt:G9wj1YA0DYI"), /^type to note \(the family class is not measured\): look at the text strips \(3\.0 s, 44\.2 s\), then save a style line "type: <family class .*big type 25% of the time\), case \(mostly lowercase\), how it appears>" with ref "yt:G9wj1YA0DYI"/);
  assert.equal(typeNote(fp({ text: { ...fp().text, share: 0.05, bigShare: 0.02 } }), "yt:a"), null);
});

test("the render is compared with the references; text drives the warning, motion and closeness only advise", () => {
  const references = [{ id: "yt:a", fingerprint: fp() }, { id: "yt:b", fingerprint: fp({ text: { ...fp().text, share: 0.4 } }) }];
  const near = compareFingerprints(fp({ text: { ...fp().text, share: 0.35 } }), references);
  assert.ok(!drifted(near));
  const wordy = compareFingerprints(fp({ text: { ...fp().text, share: 0.71 } }), references);
  const textRow = wordy.find((row) => row.key === "text");
  assert.equal(textRow.line, "text on screen 71% (references 30% to 40%)");
  assert.ok(textRow.off && textRow.drives && drifted(wordy));
  // One advice row off is not enough; two are.
  const still = compareFingerprints(fp({ motion: { ...fp().motion, stillShare: 0.6 } }), references);
  assert.ok(still.find((row) => row.key === "still").off && !drifted(still));
  const stillAndFlat = compareFingerprints(fp({ motion: { ...fp().motion, stillShare: 0.6 }, camera: { ...fp().camera, moving: 0.3 } }), references);
  assert.ok(drifted(stillAndFlat));
  // A hold much longer than the references' longest is off (advice).
  const held = compareFingerprints(fp({ motion: { ...fp().motion, longestStill: { seconds: 4.5, at: 2 } } }), references).find((row) => row.key === "hold");
  assert.deepEqual([held.line, held.off, held.drives], ["longest still hold 4.5 s (reference 1.2 s)", true, false]);
  assert.equal(near.find((row) => row.key === "hold").off, false);
  // Text alone on a plain frame: off at over twice the references' share, never a fixed number
  // (an older fingerprint gives it as onPlain x share: 0.5 x 0.3 = 15%).
  const alone = (share) => compareFingerprints(fp({ text: { ...fp().text, onlyShare: share } }), [{ id: "yt:a", fingerprint: fp({ text: { ...fp().text, onlyShare: 0.1 } }) }, { id: "yt:b", fingerprint: fp({ text: { ...fp().text, onPlain: 0.5 } }) }]).find((row) => row.key === "textOnly");
  assert.deepEqual([alone(0.28).off, alone(0.31).off, alone(0.31).drives], [false, true, true]);
  assert.equal(alone(0.31).line, "text alone on a plain frame 31% (references 10% to 15%; twice is off)");
});

test("the render check measures pairs every half second, at most 120", () => {
  assert.deepEqual(pairTimes(1.2), [[0.25, 0.333], [0.75, 0.833]]);
  assert.equal(pairTimes(600).length, 120);
});

test("strips are kept around cuts, motion peaks and every time a suggested line names", () => {
  const moments = stripMoments(fp(), [1, 2, 2.2, 40]);
  const times = moments.map((moment) => moment.at);
  for (const time of [12.4, 31, 5.9, 18.8, 44.2, 3]) assert.ok(times.includes(time), `a strip at ${time}`);
  assert.deepEqual(moments.find((moment) => moment.at === 2).kinds, ["cut"], "cuts 0.2 s apart share a strip");
  const many = stripMoments(fp(), Array.from({ length: 200 }, (_, index) => index * 0.45 + 0.1));
  assert.ok(many.length <= MAX_STRIPS);
  assert.deepEqual(stripArgs("/clip.mp4", 0.1, "/out.jpg").slice(5, 7), ["-ss", "0"], "a strip never starts before the clip");
});

test("a fingerprint without Vision has no motion, camera or text numbers, and says why", () => {
  const records = Array.from({ length: 24 }, (_, index) => ({ t: index / 12, ...(index ? { dt: 1 / 12 } : {}), stats: { ...stats(0.3, 100), pixels: [[20, 20, 20]] } }));
  const why = "Apple Vision is only on macOS";
  const result = fingerprint(records, { width: W, height: H, seconds: 2, vision: { flow: why, text: why, print: why, saliency: why } });
  assert.equal(result.motion, null);
  assert.equal(result.camera, null);
  assert.equal(result.text, null);
  assert.equal(result.vision.flow, why);
  assert.equal(result.look.brightness, 0.3);
  assert.equal("contrast" in result.look, false, "no cells, no contrast");
});

test("look.contrast is the median of 2 x the spread of the cell brightness; a record without cells is ignored", () => {
  const cellsOf = (value) => Float32Array.from({ length: CELL_COLS * CELL_ROWS * 2 }, (_, index) => (index % 2 ? 0 : value(index / 2)));
  const half = cellsOf((cell) => (cell < (CELL_COLS * CELL_ROWS) / 2 ? 0 : 1));
  const why = "Apple Vision is only on macOS";
  const lookOf = (cells) => fingerprint(
    [...cells.map((one, index) => ({ t: index / 12, stats: stats(0.5, 100, null, one) })), { t: cells.length / 12, stats: stats(0.5, 100) }],
    { width: W, height: H, seconds: 2, vision: { flow: why, text: why, print: why, saliency: why } },
  ).look;
  assert.equal(lookOf([half, half]).contrast, 1, "half black and half white is the most contrast");
  assert.equal(lookOf([cellsOf(() => 0.5), cellsOf(() => 0.5)]).contrast, 0, "flat gray has none");
});
