// add_sequence: one scene that plays several scenes in order, with transitions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";
import { defaultFonts } from "./fonts.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { runDataQuality } from "./quality/index.js";

const FPS = 30;

// Three portrait scenes with one centred title each, inside the safe area.
function project(durations = [3, 4, 3]) {
  const scenes = durations.map((duration, index) => createScene({
    id: `p${index + 1}`, name: `Part ${index + 1}`, width: 1080, height: 1920, duration, background: "#101418",
    layers: [createLayer("text", { id: `t${index + 1}`, name: `title-${index + 1}`, text: `Part ${index + 1}`, x: 240, y: 800, width: 600, height: 120, fontSize: 96, fill: "#F2F2F2", textAlign: "center" })],
  }));
  return createDocument({ scenes });
}

function sequence(document, op) {
  const reports = new Map();
  const next = applyOperations(document, [{ type: "add_sequence", properties: { id: "seq", name: "Film" }, scenes: ["p1", "p2", "p3"], ...op }], { fonts: defaultFonts, reports });
  return { document: next, report: [...reports.values()][0], scene: next.scenes.find((scene) => scene.id === "seq") };
}

// When each part's title is visible (opacity over 0.01) in the sequence, in seconds.
function visibleSpans(document) {
  const model = kinoTimeline(document, "seq", { fonts: defaultFonts, fps: FPS });
  return model.items.filter((item) => item.kind === "text").map((item) => {
    const shown = Array.from(item.samples.opacity, (value) => value > 0.01);
    const last = shown.lastIndexOf(true);
    return { text: item.text, start: model.times[shown.indexOf(true)], end: last + 1 < model.times.length ? model.times[last + 1] : model.duration };
  }).sort((a, b) => a.start - b.start);
}

test("cuts place the parts back to back and show exactly one part at a time", () => {
  const { document, report, scene } = sequence(project(), {});
  assert.deepEqual(report, {
    name: "Film", duration: 10,
    parts: [{ scene: "Part 1", start: 0, end: 3 }, { scene: "Part 2", start: 3, end: 7 }, { scene: "Part 3", start: 7, end: 10 }],
    transitions: ["cut", "cut"], madeComponents: ["Part 1", "Part 2", "Part 3"],
  });
  assert.equal(scene.duration, 10);
  assert.equal(scene.width, 1080);
  assert.deepEqual(scene.layers.map((layer) => [layer.type, layer.componentSceneId, layer.componentStart]), [["component", "p1", 0], ["component", "p2", 3], ["component", "p3", 7]]);
  for (const id of ["p1", "p2", "p3"]) assert.equal(document.scenes.find((item) => item.id === id).isComponent, true);
  const spans = visibleSpans(document);
  assert.deepEqual(spans.map(({ text, start, end }) => [text, Math.round(start * FPS), Math.round(end * FPS)]), [["Part 1", 0, 90], ["Part 2", 90, 210], ["Part 3", 210, 300]]);
});

test("transitions overlap the parts by their length, and the sequence passes the quality checks", () => {
  for (const transition of ["crossfade", "push", "wipe", "zoom", "whip", "spin"]) {
    const { document, report, scene } = sequence(project(), { transition: { type: transition, duration: 0.5 } });
    assert.equal(report.duration, 9, transition);
    assert.deepEqual(report.parts.map((part) => part.start), [0, 2.5, 6], transition);
    assert.equal(scene.layers[1].animations.filter((animation) => animation.kind === "custom").length, 2, `${transition}: an in and an out on the middle part`);
    const spans = visibleSpans(document);
    // Fades start from 0 opacity with smooth easing, so the first visible frame can be 2 frames in.
    assert.ok(spans[1].start >= 2.5 - 1e-9 && spans[1].start <= 2.5 + 3 / FPS, `${transition}: part 2 comes in at 2.5 s (${spans[1].start})`);
    assert.ok(spans[0].end <= 3 + 1e-9 && spans[0].end >= 3 - 3 / FPS, `${transition}: part 1 is gone at 3 s (${spans[0].end})`);
    const model = kinoTimeline(document, "seq", { fonts: defaultFonts });
    const errors = runDataQuality(model, { context: { outputFps: FPS } }).findings.filter((finding) => finding.severity === "error");
    assert.deepEqual(errors.map((finding) => `${finding.rule}: ${finding.message}`), [], transition);
  }
});

test("each pair can have its own transition; push and wipe keep their direction", () => {
  const { report, scene } = sequence(project(), { transitions: [{ type: "push", direction: "up", duration: 0.6 }, "wipe"] });
  assert.deepEqual(report.transitions, ["push 0.6s up", "wipe 0.5s left"]);
  const push = scene.layers[1].animations.find((animation) => animation.name === "Push in");
  assert.deepEqual([push.from, push.to], [{ y: 1920 }, { y: 0 }]);
  const wipe = scene.layers[2].animations.find((animation) => animation.name === "Wipe in");
  assert.equal(wipe.to.reveal.direction, "left");
});

test("whip and spin blur the parts most at the middle of the transition and fill the frame's edges", async () => {
  const { effectsAt } = await import("./effects/animation.js");
  const { report, scene } = sequence(project(), { transitions: [{ type: "whip", direction: "up", duration: 0.4 }, { type: "spin", duration: 0.6 }] });
  assert.deepEqual(report.transitions, ["whip 0.4s up", "spin 0.6s"]);
  const [first, middle, last] = scene.layers;
  const whip = middle.animations.find((animation) => animation.name === "Whip in");
  assert.deepEqual([whip.from, whip.to, whip.easing], [{ y: 1920 }, { y: 0 }, "natural"]);
  // The parts change at 2.6 s (whip 2.6–3.0) and 6.0 s (spin 6.0–6.6). Effect stacks, in order:
  const stack = (layer, time) => effectsAt(layer, time).map((frame) => [frame.effect.key, frame.parameters]);
  assert.deepEqual(stack(first, 2.8), [["edge-fill", { mode: "mirror", extend: 0.1 }], ["directional-blur", { length: 384, angle: 90 }]]);
  assert.deepEqual(stack(middle, 2.8), stack(first, 2.8), "both parts are smeared alike");
  assert.ok(stack(middle, 2.7)[1][1].length > 0 && stack(middle, 2.7)[1][1].length < 384);
  assert.deepEqual(stack(middle, 3.0), [["directional-blur", { length: 0, angle: 90 }]], "the blur is gone and the fill is off when the part has arrived");
  assert.deepEqual(stack(last, 6.3), [["edge-fill", { mode: "mirror", extend: 1 }], ["spin-blur", { angle: 30, centerX: 0.5, centerY: 0.5 }]]);
  assert.deepEqual(stack(middle, 6.3), [["directional-blur", { length: 0, angle: 90 }], ...stack(last, 6.3)], "the finished whip blur stays at 0 (draws nothing)");
  assert.ok(stack(last, 6.1)[1][1].angle > 0 && stack(last, 6.1)[1][1].angle < 30);
  assert.deepEqual(stack(last, 6.6), [["spin-blur", { angle: 0, centerX: 0.5, centerY: 0.5 }]]);
  const spin = last.animations.find((animation) => animation.name === "Spin in");
  assert.deepEqual([spin.from, spin.to], [{ rotation: -90, opacity: 0 }, { rotation: 0, opacity: 1 }]);
});

test("a 1 ms whip or spin has no blur: it is too short to split into two halves", () => {
  const { report, scene } = sequence(project(), { transitions: [{ type: "whip", duration: 0.001 }, { type: "spin", duration: 0.001 }] });
  assert.deepEqual(report.transitions, ["whip 0.001s left", "spin 0.001s"]);
  const animations = scene.layers.flatMap((layer) => layer.animations);
  assert.ok(animations.every((animation) => animation.duration !== 0), JSON.stringify(animations.map((animation) => [animation.name, animation.duration])));
  assert.equal(animations.filter((animation) => animation.effect === "directional-blur" || animation.effect === "spin-blur").length, 0);
});

test("a sequence follows later changes to its parts", () => {
  const { document } = sequence(project(), {});
  const edited = applyOperations(document, [{ type: "update_layer", sceneId: "p2", layerId: "t2", properties: { text: "Changed" } }], { fonts: defaultFonts });
  assert.deepEqual(visibleSpans(edited).map((span) => span.text), ["Part 1", "Changed", "Part 3"]);
});

test("a sequence may last ten minutes: a whole song", () => {
  const { report, scene, document } = sequence(project([200, 200, 200]), {});
  assert.equal(report.duration, 600);
  assert.equal(scene.duration, 600);
  assert.deepEqual(report.parts.map((part) => [part.start, part.end]), [[0, 200], [200, 400], [400, 600]]);
  // The last part is on screen until the very end (sampled twice a second to stay quick).
  const model = kinoTimeline(document, "seq", { fonts: defaultFonts, fps: 2 });
  const last = model.items.find((item) => item.text === "Part 3");
  assert.ok(last.samples.opacity.at(-1) > 0.99, "Part 3 is shown in the last frame");
  // Five two-minute parts with crossfades: 600 − 4 × 0.5 s.
  assert.equal(sequence(fiveParts(), { scenes: ["p1", "p2", "p3", "p4", "p5"], transition: "crossfade" }).scene.duration, 598);
});

function fiveParts() {
  return project([120, 120, 120, 120, 120]);
}

test("impossible sequences are refused with a reason", () => {
  const refuse = (op, pattern, document = project()) => assert.throws(() => sequence(document, op), pattern);
  refuse({ scenes: ["p1"] }, /2 to 50 scenes/);
  refuse({ scenes: ["p1", "nope"] }, /scene nope was not found/);
  refuse({ transition: "spiral" }, /type must be one of cut, crossfade, push, wipe, zoom, whip, spin/);
  refuse({ transition: { type: "push", direction: "sideways" } }, /direction must be one of/);
  refuse({ transitions: ["crossfade"] }, /must list 2 transitions/);
  refuse({ transition: { type: "crossfade", duration: 2.5 } }, /"Part 2" lasts 4s, too short for transitions/);
  refuse({}, /would last 750s; a scene can last at most 600s \(10 minutes\)/, project([250, 250, 250]));
  const mixed = project();
  mixed.scenes[1].width = 1920;
  refuse({}, /every scene must be 1080×1920/, mixed);
});
