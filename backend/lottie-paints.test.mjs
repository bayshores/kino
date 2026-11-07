// Sampled paints made ready for one Lottie gradient item: one stop count, one type per track.
import test from "node:test";
import assert from "node:assert/strict";
import { lottieGradientTracks, trackSwitchFrames } from "./lottie-paints.mjs";

const linear = (angle, ...stops) => ({ type: "linear", angle, stops: stops.map(([offset, color]) => ({ offset, color })) });
const radial = (...stops) => ({ type: "radial", angle: 0, stops: stops.map(([offset, color]) => ({ offset, color })) });
const offsets = (gradient) => gradient.stops.map((stop) => stop.offset);
const colors = (gradient) => gradient.stops.map((stop) => stop.color);

test("samples with no gradient need no gradient track", () => {
  assert.equal(lottieGradientTracks(["#ff0000", "#00ff00", null]), null);
});

test("a solid frame becomes a one-color gradient with the nearest gradient's geometry", () => {
  const gradient = linear(30, [0, "#000000"], [0.4, "#ff0000"], [1, "#ffffff"]);
  const { count, tracks } = lottieGradientTracks(["#00ff00", gradient]);
  assert.equal(count, 3);
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0].gradients[0], linear(30, [0, "#00ff00"], [0.4, "#00ff00"], [1, "#00ff00"]));
  assert.deepEqual(tracks[0].gradients[1], gradient);
  assert.deepEqual(tracks[0].active, [true, true]);
});

test("a frame with no paint becomes a clear gradient", () => {
  const gradient = radial([0, "#ffffff"], [1, "#000000"]);
  const { tracks } = lottieGradientTracks([gradient, null, "none"]);
  assert.deepEqual(colors(tracks[0].gradients[1]), ["#00000000", "#00000000"]);
  assert.deepEqual(colors(tracks[0].gradients[2]), ["#00000000", "#00000000"]);
  assert.equal(tracks[0].gradients[2].type, "radial");
});

test("fewer stops are resampled at the offsets of the nearest frame that has them all", () => {
  // A Color animation's middle frames use the union of From's and To's offsets.
  const from = linear(0, [0, "#000000"], [1, "#ffffff"]);
  const middle = linear(0, [0, "#400000"], [0.5, "#606060"], [1, "#c0c0ff"]);
  const to = linear(0, [0, "#ff0000"], [0.5, "#00ff00"], [1, "#0000ff"]);
  const { count, tracks } = lottieGradientTracks([from, middle, to]);
  assert.equal(count, 3);
  assert.deepEqual(tracks[0].gradients[0], linear(0, [0, "#000000"], [0.5, "#808080"], [1, "#ffffff"]),
    "the two-stop frame looks the same with a stop added where it is already gray");
  assert.deepEqual(tracks[0].gradients[1], middle);
  assert.deepEqual(tracks[0].gradients[2], to);
});

test("when no full frame has a frame's offsets, the widest gaps are split", () => {
  const short = linear(0, [0.25, "#000000"], [0.75, "#ffffff"]);
  const long = linear(0, [0, "#ff0000"], [0.5, "#00ff00"], [0.9, "#0000ff"], [1, "#ffffff"]);
  const { count, tracks } = lottieGradientTracks([short, long]);
  assert.equal(count, 4);
  assert.deepEqual(offsets(tracks[0].gradients[0]), [0.25, 0.375, 0.5, 0.75]);
  assert.deepEqual(colors(tracks[0].gradients[0]), ["#000000", "#404040", "#808080", "#ffffff"]);
});

test("a paint that switches between linear and radial becomes two tracks that take turns", () => {
  const from = linear(45, [0, "#ff0000"], [1, "#0000ff"]);
  const halfway = radial([0, "#ff8080"], [1, "#000080"]);
  const to = radial([0, "#ffffff"], [1, "#000000"]);
  const { count, tracks } = lottieGradientTracks([from, { ...from, stops: halfway.stops }, halfway, to]);
  assert.equal(count, 2);
  assert.deepEqual(tracks.map((track) => track.type), ["linear", "radial"]);
  assert.deepEqual(tracks[0].active, [true, true, false, false]);
  assert.deepEqual(tracks[1].active, [false, false, true, true]);
  assert.ok(tracks.every((track) => track.gradients.every((gradient) => gradient.type === track.type)));
  assert.deepEqual(colors(tracks[1].gradients[2]), ["#ff8080", "#000080"], "the radial track shows the radial frames' own stops");
  assert.deepEqual([...trackSwitchFrames(tracks[0].active)], [1]);
  assert.deepEqual([...trackSwitchFrames([true, false, true])], [0, 1]);
});
