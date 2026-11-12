import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { coveredShare, cutoutOnScene, letterBoxes, placeAroundSubject, subjectRoom } from "./subjectRoom.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { typeCovered } from "./quality/rules/typeCovered.js";

// A 1920×1080 frame, the subject box in the center (a head and shoulders), the safe area inside.
const SUBJECT = { x0: 760, y0: 200, x1: 1160, y1: 1080 };
const BOUNDS = { x0: 96, y0: 54, x1: 1824, y1: 1026 };
const word = (text, fontSize) => createLayer("text", { id: "word", name: "word", text, fontFamily: "Inter", fontWeight: 700, fontSize, textResize: "width-height", textAlign: "center", x: 560, y: 420, width: 800, height: 200 });
const sceneOf = (...layers) => createScene({ id: "s", width: 1920, height: 1080, duration: 2, layers });
const copyOf = (scene) => (layer) => {
  const copy = { ...structuredClone(layer), id: `${layer.id}-2`, name: `${layer.name} 2` };
  scene.layers.splice(scene.layers.indexOf(layer) + 1, 0, copy);
  return copy;
};

test("check's type_covered and place {around} measure one subject box for a scaled, cropped cut-out whose subject moves", () => {
  // A fill crop (the clip's box past the frame, as frame_shot sets it) inside a group punched in
  // 1.2x and turned 3 degrees, the subject moving right over 2 s, a word behind it.
  const group = createLayer("group", { id: "punch", name: "punch", x: 0, y: 0, width: 1920, height: 1080, scaleX: 1.2, scaleY: 1.2, rotation: 3 });
  const cut = createLayer("video", { id: "clip-cut", name: "clip-cut", parentId: "punch", src: "/api/media/cut.webm", x: -83, y: -47, width: 2087, height: 1174, mediaStart: 0, mediaDuration: 2, mediaSourceDuration: 2 });
  Object.assign(cut, { cutoutOf: "clip", subjectBox: [0.1, 0.1, 0.7, 1], subjectPath: [[0, 0.1, 0.1, 0.4, 1], [2, 0.4, 0.1, 0.7, 1]], allowOverlap: true });
  const behind = createLayer("text", { id: "word", name: "word", text: "KILL", fontFamily: "Inter", fontWeight: 700, fontSize: 200, textResize: "width-height", x: 600, y: 420 });
  const scene = sceneOf(behind, group, cut);
  const model = kinoTimeline(createDocument({ scenes: [scene] }), "s", { fps: 10 });
  const item = model.items.find((entry) => entry.id === "clip-cut");
  const round = (box) => [box.x0, box.y0, box.x1, box.y1].map((value) => Math.round(value));
  for (const index of [0, 5, 10, 20]) {
    const t = model.times[index];
    const sampled = { x0: item.samples.subject.x0[index], y0: item.samples.subject.y0[index], x1: item.samples.subject.x1[index], y1: item.samples.subject.y1[index] };
    assert.deepEqual(round(sampled), round(cutoutOnScene(scene, cut, t)), `the same box at ${t} s`);
  }
  // The box follows the path (not the box around every frame) and the punch-in (wider than the layer's own share).
  const at0 = cutoutOnScene(scene, cut, 0), at2 = cutoutOnScene(scene, cut, 2);
  assert.ok(at2.x0 - at0.x0 > 0.29 * 2087 * 1.2 * 0.99, `moved ${at2.x0 - at0.x0} px`);
  const [finding] = typeCovered(model, { name: (entry) => entry.name });
  assert.ok(finding, "the word behind is covered");
  const shown = cutoutOnScene(scene, cut, finding.at);
  assert.match(finding.message, new RegExp(`subject box at ${finding.at} s x ${Math.round(shown.x0)} to ${Math.round(shown.x1)}, y ${Math.round(shown.y0)} to ${Math.round(shown.y1)}`));
});

test("subjectRoom gives the free room on each side of the subject, none where it reaches the edge", () => {
  const room = subjectRoom(BOUNDS, SUBJECT, 24);
  assert.deepEqual(room.left, { x0: 96, y0: 54, x1: 736, y1: 1026 });
  assert.deepEqual(room.right, { x0: 1184, y0: 54, x1: 1824, y1: 1026 });
  assert.deepEqual(room.above, { x0: 96, y0: 54, x1: 1824, y1: 176 });
  assert.equal(room.below, null);
});

test("place around a subject: a word moves beside it with no letter inside; a line too wide for a side splits at its word gap", () => {
  const one = sceneOf(word("KILL", 200));
  const placed = placeAroundSubject(one, [one.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(one) });
  assert.ok(placed.before.share > 0.4, `the word started inside the subject (${placed.before.share})`);
  assert.ok(["left", "right"].includes(placed.side));
  assert.equal(placed.after.share, 0);
  assert.equal(placed.scale, 1, "it fits beside the subject at its size");

  // A word already clear of the subject is not pulled up against it: the shortest move is none.
  const clear = sceneOf(word("HI", 100));
  Object.assign(clear.layers[0], { textAlign: "left", x: 200, y: 440 });
  const kept = placeAroundSubject(clear, [clear.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(clear) });
  assert.deepEqual([kept.side, kept.after.share, clear.layers[0].x, clear.layers[0].y], ["left", 0, 200, 440]);

  // Two words at 260 px are wider than either side's 640 px: split keeps them larger than one shrunk line.
  const two = sceneOf(word("KILL YOU", 260));
  const split = placeAroundSubject(two, [two.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(two) });
  assert.equal(split.side, "split");
  assert.deepEqual(two.layers.map((layer) => layer.text), ["KILL", "YOU"]);
  assert.equal(split.after.share, 0);
  const [left, right] = two.layers.map((layer) => letterBoxes(layer, two.layers));
  assert.ok(Math.max(...left.map((box) => box.x1)) <= SUBJECT.x0 && Math.min(...right.map((box) => box.x0)) >= SUBJECT.x1, "one part on each side");
  assert.equal(two.layers[0].y, two.layers[1].y, "on one baseline");
  assert.equal(coveredShare([...left, ...right], SUBJECT), 0);

  // A fixed-width line split in two: each part's box fits its own letters, not the line's 1200 px.
  const wide = sceneOf(Object.assign(word("KILL YOU", 260), { textResize: "height", width: 1200, x: 360 }));
  placeAroundSubject(wide, [wide.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, split: copyOf(wide), side: "split" });
  for (const part of wide.layers) {
    const ink = letterBoxes(part, wide.layers);
    assert.ok(part.width < 700 && part.width >= Math.max(...ink.map((box) => box.x1)) - Math.min(...ink.map((box) => box.x0)), `${part.text} is ${part.width} px wide`);
  }
});

test("place around a moving subject: clear of it for the whole hold, or following it; keyed text is measured where it is at `time`", () => {
  // The subject sways 300 px right over the second the word is on screen.
  const moments = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, box: { x0: 700 + 300 * t, y0: 200, x1: 1100 + 300 * t, y1: 1080 } }));
  const at = (scene, t) => coveredShare(letterBoxes(scene.layers[0], scene.layers, [], undefined, t), moments.find((moment) => moment.t === t).box);
  // Placed for its first moment only, the word is covered once the subject has moved.
  const once = sceneOf(word("KILL", 160));
  placeAroundSubject(once, [once.layers[0]], moments[0].box, { gap: 24, bounds: BOUNDS, least: 36, time: 0 });
  assert.ok(at(once, 1) > 0.2, `covered at 1 s (${at(once, 1)})`);
  // Measured over the hold: clear at every moment, the worst moment in the receipt.
  const hold = sceneOf(word("KILL", 160));
  const placed = placeAroundSubject(hold, [hold.layers[0]], moments[0].box, { gap: 24, bounds: BOUNDS, least: 36, time: 0, moments });
  assert.ok(placed.before.share > 0.2 && placed.after.share === 0 && placed.keys === 0, JSON.stringify(placed));
  assert.deepEqual(moments.map((moment) => at(hold, moment.t)), [0, 0, 0, 0, 0]);
  // follow: a pin path keeps it a gap from the subject at every moment (it moves with it), with
  // no eased keys for linear_motion to flag.
  const follow = sceneOf(word("KILL", 160));
  const followed = placeAroundSubject(follow, [follow.layers[0]], moments[0].box, { gap: 24, bounds: BOUNDS, least: 36, time: 0, moments, follow: true, side: "right" });
  assert.deepEqual([followed.follow, followed.keys, followed.after.share, follow.layers[0].pin.path.length, follow.layers[0].animations.length], [true, 5, 0, 5, 0]);
  const left = (t) => Math.min(...letterBoxes(follow.layers[0], follow.layers, [], undefined, t).map((box) => box.x0));
  assert.deepEqual([Math.round(left(0)), Math.round(left(0.5) - left(0)), Math.round(left(1) - left(0))], [1124, 150, 300]);
  assert.deepEqual(moments.map((moment) => at(follow, moment.t)), [0, 0, 0, 0, 0]);
  // A subject that sweeps the whole width from the top leaves no spot clear for the hold: the word
  // is placed clear of its box at `time` (as for one moment) and the worst moment is measured.
  const sweep = [0, 0.5, 1].map((t) => ({ t, box: { x0: 100 + 1200 * t, y0: 40, x1: 600 + 1200 * t, y1: 1080 } }));
  const swept = sceneOf(word("KILL", 160));
  const placedSwept = placeAroundSubject(swept, [swept.layers[0]], sweep[0].box, { gap: 24, bounds: BOUNDS, least: 36, time: 0, moments: sweep });
  assert.deepEqual([placedSwept.whole, placedSwept.side, coveredShare(letterBoxes(swept.layers[0], swept.layers, [], undefined, 0), sweep[0].box)], [false, "right", 0]);
  assert.ok(placedSwept.after.share > 0 && placedSwept.after.t > 0, JSON.stringify(placedSwept.after));

  // A word keyed over the subject is measured where its keys have it at `time`, not at rest.
  const keyed = sceneOf(word("KILL", 160));
  Object.assign(keyed.layers[0], { textAlign: "left", x: 120, y: 440, animations: [{ id: "word.in", name: "Move", kind: "custom", start: 0, duration: 0.1, easing: "linear", unit: "layer", stagger: 0, order: "forward", from: { x: 120 }, to: { x: 760 } }] });
  const was = placeAroundSubject(keyed, [keyed.layers[0]], SUBJECT, { gap: 24, bounds: BOUNDS, least: 36, time: 0.5 });
  assert.ok(was.before.share > 0.5 && was.after.share === 0, JSON.stringify(was));
  assert.equal(coveredShare(letterBoxes(keyed.layers[0], keyed.layers, [], undefined, 0.5), SUBJECT), 0);
});
