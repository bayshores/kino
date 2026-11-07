import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer, presetAnimation } from "./animation.js";
import { createLayer } from "./model.js";
import { presetActionProblem, presetActions } from "./presetActions.js";

function rectangle(overrides = {}) {
  return createLayer("rectangle", {
    id: "box",
    x: 48,
    y: 72,
    width: 120,
    height: 80,
    opacity: 0.75,
    blur: 4,
    scaleX: 1.1,
    scaleY: 0.9,
    rotation: 12,
    fill: "#406080",
    shadow: { color: "#00000080", x: 2, y: 3, blur: 6 },
    animations: [],
    ...overrides,
  });
}

function flattened(source, members) {
  return members.map((member) => ({ ...member, start: source.start + member.start }));
}

function animatedValues(layer, animations, time, keys) {
  const evaluated = evaluateLayer({ ...layer, animations }, time);
  return Object.fromEntries(keys.map((key) => [key, evaluated[key]]));
}

function assertSameMotion(layer, source, members, keys, times) {
  const split = flattened(source, members);
  for (const time of times) {
    assert.deepEqual(
      animatedValues(layer, [source], time, keys),
      animatedValues(layer, split, time, keys),
      `converted pose at ${time}s`,
    );
  }
}

function sampledTimes(animation) {
  const start = animation.start;
  const duration = animation.duration;
  return [start - 0.01, start, start + duration * 0.25, start + duration * 0.7, start + duration, start + duration + 0.01];
}

test("only valid non-text preset operations are eligible for conversion", () => {
  const layer = rectangle();
  const valid = presetAnimation("blur-slide", layer, 0.4);
  assert.equal(presetActionProblem(layer, valid), null);
  assert.match(presetActionProblem(createLayer("text", { id: "text" }), valid), /Text animation presets/);
  assert.match(presetActionProblem(createLayer("audio", { id: "audio" }), valid), /Audio layers/);
  assert.match(presetActionProblem(layer, { ...valid, preset: undefined }), /Only preset animations/);
  assert.match(presetActionProblem(layer, { ...valid, kind: "hide" }), /Only timed/);
  assert.match(presetActionProblem(layer, { ...valid, kind: "custom" }), /mode and animation kind/);
  assert.match(presetActionProblem(layer, { ...valid, from: { ...valid.from, unsupportedTrack: 1 } }), /unsupportedTrack/);
  assert.match(presetActionProblem(layer, { ...valid, to: { ...valid.to, opacity: "opaque" } }), /opacity/);
  assert.throws(() => presetActions(layer, { ...valid, preset: null }), /Only preset animations/);
});

test("split families keep exact endpoints, animation settings, and imported metadata", () => {
  const layer = rectangle();
  const base = presetAnimation("blur-slide", layer, 1.25, null, {
    parameters: { direction: "left", distance: 35, blur: 29 },
  });
  const source = {
    ...base,
    intensity: 27,
    importedExtension: { sourceVersion: 8, keep: ["exact", 4] },
    from: { ...base.from, opacity: 0.12, stroke: "#123456" },
    to: { ...base.to, opacity: 0.91, stroke: "#654321" },
  };
  const before = structuredClone(source);
  const members = presetActions(layer, source);
  assert.deepEqual(source, before, "conversion does not mutate the saved animation");
  assert.deepEqual(members.map((member) => member.name), ["Opacity", "Layer Blur", "Move", "Stroke"]);
  assert.equal(new Set(members.map((member) => member.id)).size, members.length);

  for (const member of members) {
    const keys = Object.keys(member.from).concat(Object.keys(member.to));
    assert.notEqual(member.id, source.id);
    assert.equal(member.kind, source.kind);
    assert.equal(member.start, 0);
    assert.equal(member.duration, source.duration);
    assert.equal(member.easing, source.easing);
    assert.equal(member.intensity, source.intensity);
    assert.deepEqual(member.importedExtension, source.importedExtension);
    assert.equal(member.preset, undefined, "detached members do not regenerate from preset parameters");
    assert.deepEqual(member.from, Object.fromEntries(Object.keys(source.from).filter((key) => keys.includes(key)).map((key) => [key, source.from[key]])));
    assert.deepEqual(member.to, Object.fromEntries(Object.keys(source.to).filter((key) => keys.includes(key)).map((key) => [key, source.to[key]])));
  }

  assertSameMotion(layer, source, members,
    ["x", "y", "blur", "opacity", "stroke"], sampledTimes(source));
});

test("catalog parameter variants preserve in/out pre-start and completed poses", () => {
  const layer = rectangle();
  const cases = [
    ["slide-up", { parameters: { distance: 72 } }, ["x", "y"]],
    ["slide-right", { parameters: { distance: 22 } }, ["x", "y"]],
    ["grow-in", { parameters: { scale: 35 } }, ["scaleX", "scaleY"]],
    ["shrink-out", { parameters: { scale: 168 }, mode: "out" }, ["scaleX", "scaleY"]],
    ["rotate-in", { parameters: { angle: 135 } }, ["rotation"]],
    ["blur-in", { parameters: { blur: 42 } }, ["blur"]],
    ["wipe", { parameters: { direction: "left", softness: 63 } }, ["reveal"]],
    ["blink", { parameters: { count: 7 } }, ["opacity"]],
  ];
  for (const [id, options, keys] of cases) {
    const source = presetAnimation(id, layer, 0.75, null, options);
    const members = presetActions(layer, source);
    assert.equal(members.length, 1, id);
    assert.equal(members[0].kind, source.kind, id);
    assertSameMotion(layer, source, members, keys, sampledTimes(source));
  }
});

test("disabled presets remain disabled in every generated action", () => {
  const layer = rectangle();
  const source = { ...presetAnimation("blur-slide", layer, 0.2), enabled: false };
  const members = presetActions(layer, source);
  assert.ok(members.every((member) => member.enabled === false));
  assertSameMotion(layer, source, members, ["x", "y", "blur"], sampledTimes(source));
});

test("discrete opacity and Resize/Shadow metadata stay with their owning action", () => {
  const layer = rectangle();
  const blink = presetAnimation("blink", layer, 0.25, null, { parameters: { count: 4 } });
  const blinkMembers = presetActions(layer, blink);
  assert.equal(blinkMembers[0].name, "Opacity");
  assert.deepEqual(blinkMembers[0].discrete, blink.discrete);
  assertSameMotion(layer, blink, blinkMembers, ["opacity"], sampledTimes(blink));

  const source = {
    id: "resize-shadow",
    name: "Imported preset",
    kind: "in",
    start: 0.6,
    duration: 1.1,
    easing: "smooth",
    from: {
      width: 80,
      height: 50,
      shadow: { color: "#00000000", x: 0, y: 0, blur: 0 },
    },
    to: {
      width: 160,
      height: 100,
      shadow: { color: "#203040a0", x: 14, y: -8, blur: 21 },
    },
    anchor: "center",
    shadowChannels: ["x", "blur"],
    preset: { id: "fade", mode: "in", parameters: {} },
  };
  const members = presetActions(layer, source);
  const resize = members.find((member) => member.name === "Resize");
  const shadow = members.find((member) => member.name === "Shadow");
  assert.equal(resize.anchor, "center");
  assert.equal(resize.shadowChannels, undefined);
  assert.equal(shadow.anchor, undefined);
  assert.deepEqual(shadow.shadowChannels, ["x", "blur"]);
  assertSameMotion(layer, source, members, ["x", "y", "width", "height", "shadow"], sampledTimes(source));
});

test("shape property families are separated without changing geometry samples", () => {
  const layer = createLayer("star", { id: "star", width: 90, height: 90, spikes: 5, starThickness: 0.4 });
  const source = {
    id: "shape-preset",
    name: "Imported shape preset",
    kind: "in",
    start: 0.5,
    duration: 0.9,
    easing: "linear",
    from: { spikes: 4, starThickness: 0.2 },
    to: { spikes: 8, starThickness: 0.75 },
    preset: { id: "fade", mode: "in", parameters: {} },
  };
  const starMembers = presetActions(layer, source);
  assert.deepEqual(starMembers.map((member) => member.name), ["Star"]);
  assertSameMotion(layer, source, starMembers, ["spikes", "starThickness"], sampledTimes(source));

  const box = rectangle({ radius: 4, cornerRadii: [1, 2, 3, 4] });
  const cornerSource = {
    ...source,
    from: { radius: 0, cornerRadii: [0, 1, 2, 3] },
    to: { radius: 18, cornerRadii: [10, 12, 14, 16] },
  };
  const cornerMembers = presetActions(box, cornerSource);
  assert.equal(cornerMembers.length, 1);
  assert.equal(cornerMembers[0].name, "Corner Radius");
  assertSameMotion(box, cornerSource, cornerMembers, ["radius", "cornerRadii"], sampledTimes(cornerSource));
});
