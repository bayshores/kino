import assert from "node:assert/strict";
import test from "node:test";
import { resolvedCornerRadii, shapeContours, shapePath } from "./shapes.js";
import { parsePath } from "./vectorPath.js";
import { createLayer } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { splatterPath } from "./splatter.js";

function closeTo(actual, expected, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not near ${expected}`);
}

function cubicPoint(from, segment, t) {
  const inverse = 1 - t;
  const pointAt = (axis) =>
    inverse ** 3 * from[axis] +
    3 * inverse ** 2 * t * segment.c1[axis] +
    3 * inverse * t ** 2 * segment.c2[axis] +
    t ** 3 * segment.end[axis];
  return [pointAt(0), pointAt(1)];
}

function assertDirection(actual, expected) {
  const cross = actual[0] * expected[1] - actual[1] * expected[0];
  const dot = actual[0] * expected[0] + actual[1] * expected[1];
  closeTo(cross, 0);
  assert.ok(dot > 0, `tangent ${actual} points opposite ${expected}`);
}

function signedArea(contour, samplesPerSegment = 32) {
  const points = [contour.start];
  let from = contour.start;
  for (const segment of contour.segments) {
    for (let step = 1; step <= samplesPerSegment; step += 1) {
      points.push(cubicPoint(from, segment, step / samplesPerSegment));
    }
    from = segment.end;
  }
  let doubleArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubleArea += current[0] * next[1] - next[0] * current[1];
  }
  return doubleArea / 2;
}

function assertFiniteContours(contours) {
  for (const contour of contours) {
    assert.ok(contour.start.every(Number.isFinite));
    assert.equal(contour.closed, true);
    for (const segment of contour.segments) {
      for (const point of [segment.c1, segment.c2, segment.end]) {
        assert.ok(point.every(Number.isFinite));
      }
    }
  }
}

test("rounded rectangles keep eight segments and scale only corners on crowded edges", () => {
  const state = { width: 100, height: 100, cornerRadii: [80, 40, 20, 0] };
  const radii = resolvedCornerRadii(state);
  closeTo(radii[0], 100 / 1.5);
  closeTo(radii[1], 100 / 3);
  assert.equal(radii[2], 20);
  assert.equal(radii[3], 0);

  const [contour] = shapeContours("rectangle", state);
  assert.equal(contour.segments.length, 8);
  assert.deepEqual(contour.start, [radii[0], 0]);
  assert.deepEqual(contour.segments[0].end, [100 - radii[1], 0]);
  assert.deepEqual(contour.segments[1].end, [100, radii[1]]);
  assert.deepEqual(contour.segments.at(-1).end, contour.start);
});

test("uniform rectangle radius limits each edge pair while square corners retain topology", () => {
  const [contour] = shapeContours("rectangle", { width: 100, height: 40, radius: 100 });
  assert.deepEqual(resolvedCornerRadii({ width: 100, height: 40, radius: 100 }), [20, 20, 20, 20]);
  assert.equal(contour.segments.length, 8);

  const [square] = shapeContours("rectangle", { width: 10, height: 20 });
  assert.equal(square.segments.length, 8);
  assert.deepEqual(square.start, [0, 0]);
  assert.deepEqual(square.segments[0].end, [10, 0]);
  assert.deepEqual(square.segments[1].end, [10, 0]);
});

test("rectangle corner cubics have the correct edge tangents and quarter-circle midpoints", () => {
  const [contour] = shapeContours("rectangle", {
    width: 300,
    height: 200,
    cornerRadii: [30, 40, 20, 10],
  });
  const corners = [
    { index: 1, radius: 40, start: [260, 0], center: [260, 40], startDirection: [1, 0], endDirection: [0, 1], quadrant: [1, -1] },
    { index: 3, radius: 20, start: [300, 180], center: [280, 180], startDirection: [0, 1], endDirection: [-1, 0], quadrant: [1, 1] },
    { index: 5, radius: 10, start: [10, 200], center: [10, 190], startDirection: [-1, 0], endDirection: [0, -1], quadrant: [-1, 1] },
    { index: 7, radius: 30, start: [0, 30], center: [30, 30], startDirection: [0, -1], endDirection: [1, 0], quadrant: [-1, -1] },
  ];

  const midpointRadiusFactor = Math.SQRT2 * (0.5 + 0.375 * ((4 / 3) * Math.tan(Math.PI / 8)));
  for (const corner of corners) {
    const segment = contour.segments[corner.index];
    assertDirection(
      [segment.c1[0] - corner.start[0], segment.c1[1] - corner.start[1]],
      corner.startDirection,
    );
    assertDirection(
      [segment.end[0] - segment.c2[0], segment.end[1] - segment.c2[1]],
      corner.endDirection,
    );

    const midpoint = cubicPoint(corner.start, segment, 0.5);
    const offsetX = midpoint[0] - corner.center[0];
    const offsetY = midpoint[1] - corner.center[1];
    const midpointRadius = Math.hypot(offsetX, offsetY);
    closeTo(midpointRadius, corner.radius * midpointRadiusFactor, 1e-8);
    closeTo(midpointRadius, corner.radius, 1e-8);
    assert.equal(Math.sign(offsetX), corner.quadrant[0]);
    assert.equal(Math.sign(offsetY), corner.quadrant[1]);
  }
});

test("ellipse quarter arcs follow clockwise screen coordinates and preserve non-square tangents", () => {
  const [contour] = shapeContours("ellipse", {
    width: 120,
    height: 60,
    sweep: 0.25,
  });
  assert.deepEqual(contour.start, [120, 30]);
  assert.equal(contour.segments.length, 2);
  assert.deepEqual(contour.segments[0].end, [60, 60]);
  closeTo(contour.segments[0].c1[0], 120);
  closeTo(contour.segments[0].c1[1], 30 + (4 / 3) * Math.tan(Math.PI / 8) * 30);
  closeTo(contour.segments[0].c2[0], 60 + (4 / 3) * Math.tan(Math.PI / 8) * 60);
  closeTo(contour.segments[0].c2[1], 60);
});

test("a full donut has two closed contours with opposite winding and the expected hole area", () => {
  const contours = shapeContours("ellipse", { width: 120, height: 80, donut: 0.5 });
  assert.equal(contours.length, 2);
  assert.ok(contours.every((contour) => contour.segments.length === 4));
  const outerArea = signedArea(contours[0]);
  const innerArea = signedArea(contours[1]);
  assert.ok(outerArea > 0);
  assert.ok(innerArea < 0);
  closeTo(Math.abs(innerArea / outerArea), 0.25, 1e-6);
  assert.deepEqual(contours[0].segments.at(-1).end, contours[0].start);
  assert.deepEqual(contours[1].segments.at(-1).end, contours[1].start);
});

test("a partial donut joins its arcs at the radial edges without adding a seam contour", () => {
  const [contour] = shapeContours("ellipse", {
    width: 120,
    height: 60,
    donut: 0.5,
    sweep: 0.25,
  });
  assert.equal(contour.segments.length, 3);
  assert.deepEqual(contour.start, [120, 30]);
  assert.deepEqual(contour.segments[0].end, [60, 60]);
  assert.deepEqual(contour.segments[1].end, [60, 45]);
  assert.deepEqual(contour.segments[2].end, [90, 30]);
  assert.equal(contour.closed, true);

  const [pie] = shapeContours("ellipse", { width: 120, height: 60, sweep: 0.25 });
  assert.deepEqual(pie.segments.at(-1).end, [60, 30]);
  assert.deepEqual(parsePath(shapePath("ellipse", { width: 120, height: 60, sweep: 0.25 }))[0].start, [120, 30]);
});

test("ellipse angle wraps and zero-area limits return no contour", () => {
  const angleZero = shapeContours("ellipse", { width: 100, height: 50, startAngle: 0, sweep: 0.25 });
  const wrapped = shapeContours("ellipse", { width: 100, height: 50, startAngle: 720, sweep: 0.25 });
  assert.deepEqual(wrapped, angleZero);
  assert.deepEqual(shapeContours("ellipse", { width: 100, height: 50, sweep: 0 }), []);
  assert.deepEqual(shapeContours("ellipse", { width: 100, height: 50, donut: 1 }), []);
  assert.equal(shapePath("ellipse", { width: 100, height: 50, donut: 1 }), "");
});

test("stars start at the top, use elliptical bounds, and emit rounded spike counts", () => {
  const [star] = shapeContours("star", {
    width: 200,
    height: 100,
    spikes: 5.4,
    starThickness: 0.382,
  });
  assert.equal(star.segments.length, 10);
  assert.deepEqual(star.start, [100, 0]);
  closeTo(star.segments[0].end[0], 100 + 100 * 0.382 * Math.cos(-Math.PI * 0.3));
  closeTo(star.segments[0].end[1], 50 + 50 * 0.382 * Math.sin(-Math.PI * 0.3));
  assert.deepEqual(parsePath(shapePath("star", { width: 100, height: 100 }))[0].start, [50, 0]);
});

test("zero, one, and maximum star spikes are safe and finite", () => {
  assert.deepEqual(shapeContours("star", { width: 100, height: 100, spikes: 0 }), []);
  const [oneSpike] = shapeContours("star", { width: 100, height: 100, spikes: 1 });
  assert.equal(oneSpike.segments.length, 2);
  assert.deepEqual(oneSpike.start, [50, 0]);

  const [maximum] = shapeContours("star", { width: 100, height: 100, spikes: 10_000 });
  assert.equal(maximum.segments.length, 2_000);
  assertFiniteContours([maximum]);
});

test("corner animations can overshoot through zero without producing invalid geometry", () => {
  const layer = createLayer("rectangle", {
    width: 100,
    height: 100,
    animations: [{
      id: "overshooting-corners",
      name: "Corners",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "overshoot",
      from: { cornerRadii: [20, 40, 10, 30] },
      to: { cornerRadii: [0, 0, 0, 0] },
    }],
  });
  const state = evaluateLayer(layer, 0.7);
  assert.ok(state.cornerRadii.every((radius) => radius < 0), "valid non-negative endpoints can overshoot below zero");
  assert.deepEqual(resolvedCornerRadii(state), [0, 0, 0, 0]);
  assert.deepEqual(shapeContours("rectangle", state), shapeContours("rectangle", { width: 100, height: 100 }));
  assert.deepEqual(layer.animations[0].from.cornerRadii, [20, 40, 10, 30]);
});

test("degenerate dimensions stay finite and invalid values fail clearly", () => {
  assertFiniteContours(shapeContours("rectangle", { width: 0, height: 10, radius: 5 }));
  assertFiniteContours(shapeContours("ellipse", { width: 0, height: 10, donut: 0.5 }));
  assertFiniteContours(shapeContours("star", { width: 0, height: 0, spikes: 5 }));
  assert.throws(() => shapeContours("rectangle", { width: -1, height: 10 }), /width/i);
  assert.throws(() => shapeContours("rectangle", { width: 10, height: 10, cornerRadii: [1, 2] }), /four/i);
  assert.throws(() => shapeContours("ellipse", { width: 10, height: 10, startAngle: Number.NaN }), /angle/i);
  assert.throws(() => shapeContours("star", { width: 10, height: 10, spikes: Number.POSITIVE_INFINITY }), /spikes/i);
  assert.throws(() => shapeContours("triangle", { width: 10, height: 10 }), /unsupported/i);
});

test("a splatter is a seeded path: a body, drops that shrink with distance, streaks, and a thrown splash", () => {
  const splat = parsePath(splatterPath({ seed: 3 }, 400, 400));
  assert.equal(splatterPath({ seed: 3 }, 400, 400), splatterPath({ seed: 3 }, 400, 400));
  assert.notEqual(splatterPath({ seed: 4 }, 400, 400), splatterPath({ seed: 3 }, 400, 400));
  const parts = splat.map((contour) => {
    const points = [contour.start, ...contour.segments.map(({ end }) => end)];
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return { size: Math.max(...xs) - Math.min(...xs), far: Math.hypot(cx - 200, cy - 200), xs, ys };
  });
  // The body first, then a drop past some arms, 12 drops and 2 streaks, all inside the box.
  assert.ok(parts.length >= 1 + 12 + 2 && parts[0].size > 140, String(parts.length));
  assert.ok(parts.every(({ xs, ys }) => Math.min(...xs, ...ys) >= -1 && Math.max(...xs, ...ys) <= 401));
  const drops = parts.slice(1).filter(({ size }) => size < 60).sort((a, b) => a.far - b.far);
  const half = Math.floor(drops.length / 2), mean = (list) => list.reduce((sum, { size }) => sum + size, 0) / list.length;
  assert.ok(mean(drops.slice(0, half)) > mean(drops.slice(half)), "near drops are bigger");
  // A splash thrown right puts most of its ink right of the middle.
  const ink = parsePath(splatterPath({ style: "splash", seed: 3 }, 400, 400)).flatMap((contour) => contour.segments.map(({ end }) => end[0]));
  assert.ok(ink.filter((x) => x > 200).length > ink.length * 0.6);
  assert.equal(parsePath(splatterPath({ style: "drip", seed: 1, drips: 3, count: 0 }, 400, 400)).length >= 4, true);
  assert.throws(() => splatterPath({ style: "blob" }), /splat/);
  assert.throws(() => splatterPath({ count: 500 }), /count/);
});
