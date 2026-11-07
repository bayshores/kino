import assert from "node:assert/strict";
import test from "node:test";
import {
  interpolatePath,
  parsePath,
  pathBounds,
  serializePath,
} from "./vectorPath.js";

function closeTo(actual, expected, epsilon = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not near ${expected}`);
}

function assertSameGeometry(left, right, epsilon = 1e-8) {
  assert.equal(left.length, right.length);
  for (let contourIndex = 0; contourIndex < left.length; contourIndex += 1) {
    const a = left[contourIndex];
    const b = right[contourIndex];
    assert.equal(a.closed, b.closed);
    assert.deepEqual(a.start, b.start);
    assert.equal(a.segments.length, b.segments.length);
    for (let index = 0; index < a.segments.length; index += 1) {
      for (const key of ["c1", "c2", "end"]) {
        closeTo(a.segments[index][key][0], b.segments[index][key][0], epsilon);
        closeTo(a.segments[index][key][1], b.segments[index][key][1], epsilon);
      }
    }
  }
}

test("normalizes relative line commands and closes a contour", () => {
  const relative = parsePath("M10 20 h30 v10 H10 z");
  const absolute = parsePath("M10 20 L40 20 L40 30 L10 30 Z");
  assertSameGeometry(relative, absolute);
  assert.equal(relative[0].closed, true);
  assert.equal(relative[0].segments.length, 3);
});

test("starts a new contour at the close point when drawing continues after Z", () => {
  const contours = parsePath("M1 2 L3 4 Z l5 6");
  assert.equal(contours.length, 2);
  assert.equal(contours[0].closed, true);
  assert.equal(contours[1].closed, false);
  assert.deepEqual(contours[1].start, [1, 2]);
  assert.deepEqual(contours[1].segments.at(-1).end, [6, 8]);
});

test("reflects smooth cubic and quadratic controls", () => {
  const smoothCubic = parsePath("M0 0 C10 20 20 20 30 0 S50 -20 60 0");
  const explicitCubic = parsePath("M0 0 C10 20 20 20 30 0 C40 -20 50 -20 60 0");
  assertSameGeometry(smoothCubic, explicitCubic);

  const smoothQuadratic = parsePath("M0 0 Q10 20 20 0 T40 0");
  const explicitQuadratic = parsePath(
    "M0 0 C6.666666666666667 13.333333333333334 13.333333333333334 13.333333333333334 20 0 C26.666666666666668 -13.333333333333334 33.333333333333336 -13.333333333333334 40 0",
  );
  assertSameGeometry(smoothQuadratic, explicitQuadratic);
});

test("converts elliptical arcs to finite cubic segments with exact endpoints", () => {
  const absolute = parsePath("M0 0 A10 10 0 0 1 20 0");
  const relative = parsePath("M0 0 a10 10 0 0 1 20 0");
  assertSameGeometry(absolute, relative);
  assert.equal(absolute[0].segments.length, 2);
  assert.deepEqual(absolute[0].segments.at(-1).end, [20, 0]);
  assert.deepEqual(pathBounds("M0 0 A10 10 0 0 1 20 0"), {
    x: 0,
    y: -10,
    width: 20,
    height: 10,
  });

  const quarter = parsePath("M10 0 A10 10 0 0 1 0 10");
  closeTo(quarter[0].segments[0].c1[0], 10);
  closeTo(quarter[0].segments[0].c1[1], 5.522847498307934);
  closeTo(quarter[0].segments[0].c2[0], 5.522847498307934);
  closeTo(quarter[0].segments[0].c2[1], 10);
  assertSameGeometry(
    parsePath("M10 0 A10 10 0 0110 10"),
    parsePath("M10 0 A10 10 0 0 1 10 10"),
  );
  assert.equal(parsePath("M10 0 A10 10 0 1 1 0 10")[0].segments.length, 3);
});

test("calculates bounds from cubic derivative extrema, not control points", () => {
  const bounds = pathBounds("M0 0 C100 100 100 -100 0 0");
  closeTo(bounds.x, 0);
  closeTo(bounds.y, -28.867513459481287);
  closeTo(bounds.width, 75);
  closeTo(bounds.height, 57.735026918962575);
  assert.deepEqual(pathBounds("M2 3"), { x: 2, y: 3, width: 0, height: 0 });
});

test("morphs different point counts by splitting cubic curves and preserves endpoints", () => {
  const from = "M0 0 L20 0 L30 10";
  const to = "M10 10 C15 10 20 15 25 20";
  assert.equal(interpolatePath(from, to, 0), from);
  assert.equal(interpolatePath(from, to, 1), to);

  const middle = parsePath(interpolatePath(from, to, 0.5));
  assert.equal(middle.length, 1);
  assert.equal(middle[0].segments.length, 2);
  assert.deepEqual(middle[0].start, [5, 5]);
  assert.deepEqual(middle[0].segments.at(-1).end, [27.5, 15]);
  for (const segment of middle[0].segments) {
    for (const point of [segment.c1, segment.c2, segment.end]) {
      assert.ok(point.every(Number.isFinite));
    }
  }
  assert.ok(serializePath(middle).startsWith("M5 5 C"));
});

test("morphs matching closed contours and rejects incompatible contour topology", () => {
  const left = "M0 0 L20 0 L20 20 Z";
  const right = "M10 10 L30 10 L30 30 L10 30 Z";
  const middle = parsePath(interpolatePath(left, right, 0.5));
  assert.equal(middle[0].closed, true);
  assert.deepEqual(middle[0].start, [5, 5]);
  assert.equal(middle[0].segments.length, 3);

  assert.throws(() => interpolatePath("M0 0L1 1", "M0 0L1 1 M2 2L3 3", 0.5), /same number.*contours/);
  assert.throws(() => interpolatePath("M0 0L1 1", "M0 0L1 1Z", 0.5), /open in both.*closed in both/);
});

test("serializes normalized paths as valid cubic SVG path data", () => {
  const path = "m1 2 h3 v4 q2 2 4 0 t4 0 z";
  const serialized = serializePath(parsePath(path));
  assert.match(serialized, /^M1 2 C/);
  assert.match(serialized, /Z$/);
  assertSameGeometry(parsePath(serialized), parsePath(path));
});

test("rejects malformed commands, arc flags, coordinates, and excessive input", () => {
  assert.throws(() => parsePath("M0 0 R1 2"), /Unsupported path command/);
  assert.throws(() => parsePath("M0 0 A10 10 0 2 0 20 0"), /Arc flags must be 0 or 1/);
  assert.throws(() => parsePath("M0"), /Incomplete M command/);
  assert.throws(() => parsePath("M0 0 LNaN 2"), /coordinates|needs coordinates/i);
  assert.throws(() => parsePath(`M0 0${" ".repeat(1_000_001)}`), /too long/);
  assert.throws(() => interpolatePath("M0 0", "M0 0", Number.NaN), /must be finite/);
});
