import test from "node:test";
import assert from "node:assert/strict";
import {
  EASINGS,
  PRESETS,
  easingAt,
  evaluateLayer,
  evaluateScene,
  presetAnimation,
} from "./animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import {pathBounds} from "./vectorPath.js";
import { wiggleOffset } from "./behavior.js";

test("morph operations produce continuous intermediate curve geometry", () => {
  const from = "M0 0 L20 0 L0 20 Z", to = "M0 0 L60 0 L0 44 Z";
  const layer = createLayer("path", {path:from, animations:[operation({from:{path:from},to:{path:to}})]});
  assert.equal(evaluateLayer(layer, 0).path, from);
  assert.equal(evaluateLayer(layer, 1).path, to);
  const middle = pathBounds(evaluateLayer(layer, 0.5).path);
  assert.equal(middle.width, 40);
  assert.equal(middle.height, 32);
  assert.equal(layer.path, from);
});

function operation(overrides = {}) {
  return {
    id: "op-1",
    name: "Test",
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { opacity: 0 },
    to: { opacity: 1 },
    unit: "layer",
    stagger: 0,
    order: "forward",
    ...overrides,
  };
}

test("easing catalog has stable endpoints and custom cubic bezier works", () => {
  assert.ok(EASINGS.some((easing) => easing.id === "elastic"));
  for (const { id } of EASINGS) {
    assert.equal(easingAt(id, 0), 0, `${id} begins at zero`);
    assert.equal(easingAt(id, 1), 1, `${id} ends at one`);
  }
  assert.ok(Math.abs(easingAt([0, 0, 1, 1], 0.37) - 0.37) < 1e-6);
  assert.ok(Math.abs(easingAt([0.42, 0, 0.58, 1], 0.5) - 0.5) < 1e-5);
  assert.throws(() => easingAt("missing", 0.5), /unsupported easing/);
  assert.throws(() => easingAt([2, 0, 0, 1], 0.5), /supported range/);
});

test("in operations apply their from state before start; custom and out operations leave prior values", () => {
  const layer = createLayer("rectangle", {
    id: "layer-1",
    animations: [
      operation({
        id: "in",
        kind: "in",
        from: { opacity: 0 },
        to: { opacity: 0.5 },
      }),
      operation({
        id: "custom",
        kind: "custom",
        start: 2,
        from: { opacity: 0.2 },
        to: { opacity: 0.8 },
      }),
      operation({
        id: "out",
        kind: "out",
        start: 3,
        from: { opacity: 0.1 },
        to: { opacity: 0 },
      }),
    ],
  });
  assert.equal(evaluateLayer(layer, -1).opacity, 0);
  assert.equal(evaluateLayer(layer, 1).opacity, 0.5);
  assert.equal(evaluateLayer(layer, 2).opacity, 0.2);
  assert.equal(evaluateLayer(layer, 2.5).opacity, 0.5);
  assert.equal(evaluateLayer(layer, 3).opacity, 0.1);
});

test("a Move holds its From before it starts; fill chooses for any operation, and the first on a key wins", () => {
  const move = operation({ id: "move", start: 2, from: { x: 2000 }, to: { x: 700 } });
  const slide = createLayer("rectangle", { id: "slide", x: 0, animations: [move] });
  assert.equal(evaluateLayer(slide, 1).x, 2000, "the panel waits off screen instead of covering the frame");
  assert.equal(evaluateLayer(createLayer("rectangle", { x: 0, animations: [{ ...move, fill: "forwards" }] }), 1).x, 0);
  // Other operations keep the layer's own value unless fill asks.
  const pulse = operation({ id: "pulse", start: 2, from: { opacity: 0.2 }, to: { opacity: 1 } });
  assert.equal(evaluateLayer(createLayer("rectangle", { animations: [pulse] }), 1).opacity, 1);
  assert.equal(evaluateLayer(createLayer("rectangle", { animations: [{ ...pulse, fill: "both" }] }), 1).opacity, 0.2);
  // A later Move never freezes an earlier one that is still playing.
  const first = operation({ id: "first", start: 0, from: { x: 0 }, to: { x: 100 } });
  const chained = createLayer("rectangle", { x: 0, animations: [first, operation({ id: "second", start: 2, from: { x: 500 }, to: { x: 900 } })] });
  assert.equal(evaluateLayer(chained, 0.5).x, 50);
});

test("operations sort by start and original order, overlap by property, and persist endpoints", () => {
  const layer = createLayer("rectangle", {
    id: "layer-2",
    opacity: 1,
    x: 0,
    animations: [
      operation({
        id: "move",
        start: 0,
        duration: 2,
        from: { x: 0 },
        to: { x: 100 },
      }),
      operation({
        id: "fade",
        start: 0.5,
        duration: 1,
        from: { opacity: 1 },
        to: { opacity: 0 },
      }),
      operation({
        id: "replace",
        start: 1,
        duration: 1,
        from: { x: 20 },
        to: { x: 40 },
      }),
    ],
  });

  const middle = evaluateLayer(layer, 0.75);
  assert.equal(middle.x, 37.5);
  assert.equal(middle.opacity, 0.75);
  const overlap = evaluateLayer(layer, 1.5);
  assert.equal(overlap.x, 30);
  assert.equal(overlap.opacity, 0);
  const finished = evaluateLayer(layer, 4);
  assert.equal(finished.x, 40);
  assert.equal(finished.opacity, 0);
});

test("reverse text-unit stagger shifts each unit's local operation start", () => {
  const layer = createLayer("text", {
    id: "text-1",
    animations: [
      operation({
        id: "staggered",
        kind: "in",
        from: { opacity: 0 },
        to: { opacity: 1 },
        unit: "letters",
        stagger: 0.2,
        order: "reverse",
      }),
    ],
  });
  const lastLetter = evaluateLayer(layer, 0.2, { unitIndex: 0, unitCount: 3 });
  const firstLetter = evaluateLayer(layer, 0.2, { unitIndex: 2, unitCount: 3 });
  assert.equal(lastLetter.opacity, 0);
  assert.ok(Math.abs(firstLetter.opacity - 0.2) < 1e-9);
  assert.ok(
    Math.abs(
      evaluateLayer(layer, 0.7, { unitIndex: 0, unitCount: 3 }).opacity - 0.3,
    ) < 1e-9,
  );
});

test("presets create endpoint-based operations and scene evaluation preserves input", () => {
  assert.ok(
    PRESETS.every(
      ({ id, name, kind }) =>
        id && name && ["in", "out", "custom", "hide", "show"].includes(kind),
    ),
  );
  const layer = createLayer("rectangle", {
    id: "preset-layer",
    x: 30,
    y: 40,
    opacity: 0.8,
  });
  const before = JSON.stringify(layer);
  const move = presetAnimation("move", layer, 1, { width: 640, height: 360 });
  assert.equal(move.kind, "custom");
  assert.deepEqual(move.from, { x: 130, y: 100 });
  assert.deepEqual(move.to, { x: 30, y: 40 });
  // A Move waits at its From before it starts (holdsFromBeforeStart), so it does not jump there.
  assert.equal(evaluateLayer({ ...layer, animations: [move] }, 0).x, 130);
  assert.equal(evaluateLayer({ ...layer, animations: [move] }, 1).x, 130);
  assert.equal(JSON.stringify(layer), before);

  const scene = createScene({
    layers: [{ ...layer, animations: [presetAnimation("fade-in", layer)] }],
  });
  const original = JSON.stringify(scene);
  const evaluated = evaluateScene(scene, 0.3);
  assert.notEqual(evaluated, scene);
  assert.notEqual(evaluated.layers[0], scene.layers[0]);
  assert.ok(evaluated.layers[0].opacity < layer.opacity);
  assert.equal(JSON.stringify(scene), original);
});

test("fill values interpolate without changing unrelated properties", () => {
  const layer = createLayer("rectangle", {
    id: "fill-layer",
    fill: "#000000",
    animations: [
      operation({
        id: "color",
        from: { fill: "#000000", x: 10 },
        to: { fill: "#ffffff", x: 30 },
      }),
    ],
  });
  const middle = evaluateLayer(layer, 0.5);
  assert.equal(middle.fill, "#808080");
  assert.equal(middle.x, 20);
  assert.equal(middle.y, layer.y);
});

test("shape presets are real editable custom operations with stable typed targets", () => {
  const ellipse = createLayer("ellipse", {
    id: "arc-preset-layer",
    donut: 0.2,
    sweep: 0.75,
    startAngle: 30,
  });
  const arc = presetAnimation("arc", ellipse, 0.4);
  assert.equal(arc.name, "Arc");
  assert.equal(arc.kind, "custom");
  assert.equal(arc.duration, 0.8);
  assert.deepEqual(arc.from, { donut: 0.2, sweep: 0.75, startAngle: 30 });
  assert.deepEqual(arc.to, arc.from);

  const roundedRectangle = createLayer("rectangle", {
    id: "corners-preset-layer",
    radius: 12,
    cornerRadii: [1, 2, 3, 4],
  });
  const corners = presetAnimation("corners", roundedRectangle);
  assert.equal(corners.duration, 0.8);
  assert.deepEqual(corners.from, { cornerRadii: [1, 2, 3, 4] });
  assert.deepEqual(corners.to, corners.from);
  const uniformCorners = presetAnimation("corners", createLayer("rectangle", { radius: 9 }));
  assert.deepEqual(uniformCorners.from.cornerRadii, [9, 9, 9, 9]);

  const star = presetAnimation("star-shape", createLayer("star", {
    id: "star-preset-layer",
    spikes: 7,
    starThickness: 0.25,
  }));
  assert.equal(star.name, "Star");
  assert.equal(star.duration, 0.8);
  assert.deepEqual(star.from, { spikes: 7, starThickness: 0.25 });
  assert.deepEqual(star.to, star.from);

  assert.throws(() => presetAnimation("arc", createLayer("rectangle")), /requires an ellipse/);
  assert.throws(() => presetAnimation("corners", createLayer("ellipse")), /requires a rectangle/);
  assert.throws(() => presetAnimation("star-shape", createLayer("ellipse")), /requires a star/);
});

test("shape properties interpolate continuously, including fractional spike counts", () => {
  const layer = createLayer("star", {
    id: "shape-animation",
    spikes: 5,
    starThickness: 0.2,
    animations: [operation({
      from: { spikes: 5, starThickness: 0.2 },
      to: { spikes: 6, starThickness: 0.8 },
    })],
  });
  const middle = evaluateLayer(layer, 0.5);
  assert.equal(middle.spikes, 5.5);
  assert.equal(middle.starThickness, 0.5);
  assert.equal(evaluateLayer(layer, 1).spikes, 6);

  const rounded = createLayer("rectangle", {
    id: "corner-animation",
    animations: [operation({
      from: { cornerRadii: [0, 10, 20, 30] },
      to: { cornerRadii: [100, 110, 120, 130] },
    })],
  });
  assert.deepEqual(evaluateLayer(rounded, 0.5).cornerRadii, [50, 60, 70, 80]);
});

test("stroke preset preserves the current appearance and stroke endpoints animate", () => {
  const strokePresets = ["rectangle", "ellipse", "star", "path", "text", "group", "image", "video"];
  const layer = createLayer("rectangle", {
    id: "stroke-preset-layer",
    stroke: "#12345680",
    strokeWidth: 2,
  });
  const strokePreset = presetAnimation("stroke", layer, 0.25);

  assert.ok(PRESETS.some(({ id, kind }) => id === "stroke" && kind === "custom"));
  assert.equal(strokePreset.name, "Stroke");
  assert.equal(strokePreset.kind, "custom");
  assert.equal(strokePreset.start, 0.25);
  assert.equal(strokePreset.duration, 0.8);
  assert.deepEqual(strokePreset.from, {
    strokeWidth: 2,
    stroke: "#12345680",
  });
  assert.deepEqual(strokePreset.to, strokePreset.from);

  const gradient = {
    type: "linear",
    angle: 25,
    stops: [
      { offset: 0, color: "#11223380" },
      { offset: 1, color: "#aabbcc" },
    ],
  };
  const gradientLayer = createLayer("ellipse", {
    id: "stroke-gradient-preset-layer",
    stroke: gradient,
    strokeWidth: 3,
  });
  const originalGradientLayer = JSON.stringify(gradientLayer);
  const gradientPreset = presetAnimation("stroke", gradientLayer);
  assert.deepEqual(gradientPreset.from.stroke, gradient);
  assert.deepEqual(gradientPreset.to.stroke, gradient);
  assert.notEqual(gradientPreset.from.stroke, gradientLayer.stroke);
  assert.notEqual(gradientPreset.from.stroke.stops, gradientLayer.stroke.stops);
  assert.notEqual(gradientPreset.from.stroke, gradientPreset.to.stroke);
  assert.notEqual(gradientPreset.from.stroke.stops, gradientPreset.to.stroke.stops);
  assert.equal(JSON.stringify(gradientLayer), originalGradientLayer);

  for (const type of strokePresets) {
    assert.doesNotThrow(() => presetAnimation("stroke", createLayer(type)));
  }
  assert.throws(
    () => presetAnimation("stroke", createLayer("audio")),
    /requires a rectangle, ellipse, star, path, text, group, image, or video layer/,
  );

  const animated = createLayer("rectangle", {
    id: "animated-stroke-layer",
    stroke: "#ff000000",
    strokeWidth: 0,
    animations: [operation({
      duration: 0.8,
      from: { stroke: "#ff000000", strokeWidth: 0 },
      to: { stroke: "#0000ff80", strokeWidth: 4 },
    })],
  });
  const middle = evaluateLayer(animated, 0.4);
  assert.equal(middle.strokeWidth, 2);
  assert.equal(middle.stroke, "#80008040");
  assert.equal(evaluateLayer(animated, 0).strokeWidth, 0);
  assert.equal(evaluateLayer(animated, 0).stroke, "#ff000000");
});

test("same-type stroke gradients interpolate their angle, stop offsets, and alpha colors without mutation", () => {
  const fromStroke = {
    type: "linear",
    angle: 0,
    stops: [
      { offset: 0.1, color: "#00000080" },
      { offset: 0.9, color: "#ff0000" },
    ],
  };
  const toStroke = {
    type: "linear",
    angle: 180,
    stops: [
      { offset: 0.3, color: "#ffffff00" },
      { offset: 0.7, color: "#0000ff80" },
    ],
  };
  const layer = createLayer("rectangle", {
    id: "gradient-stroke-animation",
    stroke: fromStroke,
    animations: [operation({
      duration: 0.8,
      from: { stroke: fromStroke },
      to: { stroke: toStroke },
    })],
  });
  const originalLayer = JSON.stringify(layer);
  const middle = evaluateLayer(layer, 0.4);

  assert.deepEqual(middle.stroke, {
    type: "linear",
    angle: 90,
    stops: [
      { offset: 0.2, color: "#80808040" },
      { offset: 0.8, color: "#800080c0" },
    ],
  });
  assert.equal(JSON.stringify(layer), originalLayer);
  assert.notEqual(middle.stroke, fromStroke);
  assert.notEqual(middle.stroke.stops, fromStroke.stops);
  assert.notEqual(middle.stroke.stops[0], fromStroke.stops[0]);
});

test("retained corner operations do not alter converted paths or replace compatible Move and Stroke tracks", () => {
  const bakedPath = "M0 0 C80 0 80 60 0 60 Z";
  const layer = createLayer("path", {
    id: "converted-rounded-rectangle",
    path: bakedPath,
    convertedFrom: "rectangle",
    x: 100,
    stroke: "#000000",
    strokeWidth: 1,
    animations: [
      operation({
        id: "retained-corners",
        name: "Corners",
        kind: "in",
        start: 0.2,
        duration: 0.8,
        from: { cornerRadii: [0, 0, 0, 0], x: 700 },
        to: { cornerRadii: [20, 20, 20, 20], x: 900 },
      }),
      operation({
        id: "compatible-move",
        name: "Move",
        start: 0,
        duration: 0.8,
        from: { x: 10 },
        to: { x: 50 },
      }),
      operation({
        id: "compatible-stroke",
        name: "Stroke",
        start: 0,
        duration: 0.8,
        from: { strokeWidth: 0, stroke: "#000000" },
        to: { strokeWidth: 8, stroke: "#ffffff" },
      }),
    ],
  });
  const original = JSON.stringify(layer);
  const expected = [
    { time: 0, x: 10, strokeWidth: 0, stroke: "#000000" },
    { time: 0.4, x: 30, strokeWidth: 4, stroke: "#808080" },
    { time: 0.8, x: 50, strokeWidth: 8, stroke: "#ffffff" },
  ];

  for (const state of expected) {
    const evaluated = evaluateLayer(layer, state.time);
    assert.equal(evaluated.path, bakedPath);
    assert.equal(evaluated.cornerRadii, null);
    assert.equal(evaluated.x, state.x);
    assert.equal(evaluated.strokeWidth, state.strokeWidth);
    assert.equal(evaluated.stroke, state.stroke);
    assert.equal(JSON.stringify(layer), original);
  }
});

test("each frame's checked copy of a layer still names the field that is not plain data", () => {
  const broken = (change) => { const layer = createLayer("rectangle", {}); change(layer); return () => evaluateLayer(layer, 0.5); };
  assert.throws(broken((layer) => { layer.animations = [{ id: "a", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: Number.NaN } }]; }),
    /^TypeError: layer\.animations\[0\]\.to\.x must be finite$/);
  assert.throws(broken((layer) => { layer.self = layer; }), /layer\.self cannot be cyclic/);
  assert.throws(broken((layer) => { Object.defineProperty(layer, "x", { get: () => 1, enumerable: true }); }), /layer\.x must be a data value/);
  assert.throws(broken((layer) => { layer.extra = new Date(0); }), /layer\.extra must be a plain object/);
  assert.throws(broken((layer) => { layer[Symbol("tag")] = 1; }), /layer cannot contain symbol fields/);
  assert.throws(broken((layer) => { Object.defineProperty(layer, "__proto__", { value: {}, enumerable: true }); }), /layer\.__proto__ is unsafe/);
  // The same object twice (not a cycle) is copied twice, and the copy shares nothing with the layer.
  const shared = { x: 1 };
  const layer = createLayer("rectangle", { x: 5 });
  layer.extra = [shared, shared];
  const copy = evaluateLayer(layer, 0);
  assert.deepEqual(copy.extra, [{ x: 1 }, { x: 1 }]);
  assert.notEqual(copy.extra[0], shared);
});

// A layer whose animations went through the document checks (model.js normalizeAnimation).
function checkedLayer(animations) {
  const layer = createLayer("rectangle", { id: "box", x: 100, y: 50, animations });
  const document = parseDocument(createDocument({ scenes: [createScene({ duration: 6, layers: [layer] })] }));
  return document.scenes[0].layers[0];
}

test("loop behavior replays a pass: cycle starts over, pingpong plays back", () => {
  const spin = (mode) => checkedLayer([operation({ from: { rotation: 0 }, to: { rotation: 90 }, behavior: { loop: mode } })]);
  const cycle = spin("cycle"), pingpong = spin({ mode: "pingpong" });
  assert.deepEqual(cycle.animations[0].behavior, { loop: { mode: "cycle" } }, "a mode name is saved as {mode}");
  assert.deepEqual([0.25, 1.25, 3.5].map((t) => evaluateLayer(cycle, t).rotation), [22.5, 22.5, 45]);
  assert.deepEqual([0.25, 1.25, 1.75, 2.5].map((t) => evaluateLayer(pingpong, t).rotation), [22.5, 67.5, 22.5, 45]);
  assert.throws(() => spin({ mode: "bounce" }), /behavior: loop must be/);
});

test("wiggle behavior drifts in place, repeats for a seed and settles at the pass's ends", () => {
  const wiggle = (seed) => checkedLayer([operation({ start: 1, duration: 2, from: {}, to: {}, behavior: { wiggle: { amount: { x: 10 }, rate: 3, seed } } })]);
  const layer = wiggle(7);
  assert.deepEqual([layer.animations[0].from, layer.animations[0].to], [{ x: 100 }, { x: 100 }], "a wiggled key joins from and to at the layer's value");
  const xs = [0.5, 1, 1.4, 1.9, 2.6, 3, 4].map((t) => evaluateLayer(layer, t).x);
  assert.deepEqual([xs[0], xs[1], xs[5], xs[6]], [100, 100, 100, 100], "no drift before, at the start and end, or after");
  for (const x of xs) assert.ok(Math.abs(x - 100) <= 10, `${x} stays within the amount`);
  assert.ok(xs.slice(2, 5).some((x) => Math.abs(x - 100) > 1), "it drifts in between");
  assert.deepEqual(wiggle(7).animations, layer.animations);
  assert.equal(evaluateLayer(wiggle(7), 1.9).x, xs[3], "the same seed draws the same frame");
  assert.notEqual(evaluateLayer(wiggle(8), 1.9).x, xs[3], "another seed draws another drift");
  // Octaves with a quintic fade (ArtCraft noise.rs): it keeps moving where the old one-layer
  // smoothstep stopped at every knot (every 1/rate seconds), and it starts with no speed.
  const drift = { amount: 10, rate: 3, seed: 7 };
  const speed = (t) => (wiggleOffset(drift, "x", t + 1e-4, 2) - wiggleOffset(drift, "x", t - 1e-4, 2)) / 2e-4;
  const knots = [1, 2, 3, 4].map((k) => Math.abs(speed(k / 3)));
  assert.ok(knots.filter((value) => value > 1).length >= 3, `moving at the old knots: ${knots}`);
  assert.ok(Math.abs(speed(1e-4)) < 0.01 && Math.abs(speed(2 - 1e-4)) < 0.01, "no speed at the pass's ends");
  for (let t = 0; t <= 2; t += 1 / 240) assert.ok(Math.abs(wiggleOffset(drift, "x", t, 2)) <= 10);
  assert.throws(() => checkedLayer([operation({ behavior: { wiggle: { amount: { fill: 3 } } } })]), /only number properties/);
  assert.throws(() => checkedLayer([operation({ from: { x: 0, scaleX: 1 }, to: { x: 10, scaleX: 1 }, behavior: { wiggle: { amount: 8 } } })]),
    /scaleX is a fraction: give one per key/, "one number for pixels and scale is refused");
});

test("loop and wiggle are refused on a clip's speed, volume and lowpass", () => {
  const clip = createLayer("video", { id: "clip", src: "clip.mp4", mediaSourceDuration: 10, animations: [operation({ from: { volume: 1 }, to: { volume: 0 }, behavior: { loop: "cycle" } })] });
  assert.throws(() => parseDocument(createDocument({ scenes: [createScene({ duration: 6, layers: [clip] })] })), /can't loop or wiggle volume/);
});
