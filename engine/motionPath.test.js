import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MOTION_PATH_POINTS,
  isMoveAnimation,
  mapMotionPath,
  motionEndpoints,
  motionPathAt,
  motionPathSegments,
  normalizeMotionPath,
} from "./motionPath.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

test("normalization clones strict path data, applies defaults, and preserves optional alignment offset", () => {
  assert.equal(normalizeMotionPath(undefined), undefined);
  assert.equal(normalizeMotionPath(null), undefined);
  assert.deepEqual(normalizeMotionPath({}), { points: [], bezierControls: true, alignToPath: false });

  const source = { points: [{ x: 12, y: -8, in: { x: 2 }, out: { y: -3 } }], alignToPath: true, alignmentOffset: -45 };
  const normalized = normalizeMotionPath(source);
  assert.deepEqual(normalized, {
    points: [{ x: 12, y: -8, in: { x: 2, y: 0 }, out: { x: 0, y: -3 } }],
    bezierControls: true,
    alignToPath: true,
    alignmentOffset: -45,
  });
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.points, source.points);
  assert.notEqual(normalized.points[0].in, source.points[0].in);
  assert.equal(Object.hasOwn(normalizeMotionPath({ points: [] }), "alignmentOffset"), false);
});

test("normalization rejects unknown keys, invalid flags, excess points, and non-finite or oversized values", () => {
  assert.throws(() => normalizeMotionPath({ extra: true }), /unsupported field/);
  assert.throws(() => normalizeMotionPath({ bezierControls: 1 }), /bezierControls.*boolean/);
  assert.throws(() => normalizeMotionPath({ alignToPath: "yes" }), /alignToPath.*boolean/);
  assert.throws(() => normalizeMotionPath({ alignmentOffset: 360001 }), /supported range/);
  assert.throws(() => normalizeMotionPath({ alignmentOffset: Infinity }), /finite number/);
  assert.throws(() => normalizeMotionPath({ points: [{ x: 1, y: NaN }] }), /finite number/);
  assert.throws(() => normalizeMotionPath({ points: [{ x: 1_000_001, y: 0 }] }), /supported range/);
  assert.throws(() => normalizeMotionPath({ points: [{ x: 0, y: 0, out: { x: -1_000_001, y: 0 } }] }), /supported range/);
  assert.throws(() => normalizeMotionPath({ points: [{ x: 0, y: 0, unexpected: 1 }] }), /unsupported field/);
  assert.throws(() => normalizeMotionPath({ points: new Array(1) }), /missing/);
  assert.throws(() => normalizeMotionPath({ points: Array.from({ length: MAX_MOTION_PATH_POINTS + 1 }, () => ({ x: 0, y: 0 })) }), /at most 64/);
});

test("Move detection accepts one or both position axes and rejects mixed-property operations", () => {
  assert.equal(isMoveAnimation({ kind: "custom", name: "anything", from: { x: 0 }, to: { x: 5 } }), true);
  assert.equal(isMoveAnimation({ kind: "custom", from: {}, to: { y: 5 } }), true);
  assert.equal(isMoveAnimation({ kind: "custom", from: { x: 0 }, to: { y: 5 } }), true);
  assert.equal(isMoveAnimation({ kind: "custom", from: { x: 0, y: 0 }, to: { x: 5, y: 10 } }), true);
  assert.equal(isMoveAnimation({ kind: "custom", from: { x: 0, opacity: 1 }, to: { x: 5 } }), false);
  assert.equal(isMoveAnimation({ kind: "custom", from: { x: 0 }, to: { x: 5, scale: 2 } }), false);
  assert.equal(isMoveAnimation({ kind: "move", from: { x: 0 }, to: { x: 5 } }), false);
  assert.equal(isMoveAnimation({ kind: "custom", from: {}, to: {} }), false);
});

test("axis-only Move endpoints fill their missing axis from the layer design position", () => {
  assert.deepEqual(motionEndpoints({ x: 8, y: 20 }, { from: { x: -12 }, to: { x: 40 } }), {
    start: { x: -12, y: 20 }, end: { x: 40, y: 20 },
  });
  assert.deepEqual(motionEndpoints({ x: 8, y: 20 }, { from: { y: 5 }, to: { y: 30 } }), {
    start: { x: 8, y: 5 }, end: { x: 8, y: 30 },
  });
  assert.deepEqual(motionEndpoints({}, { from: {}, to: {} }), {
    start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
  });
});

test("segments use one-third endpoint controls and node-relative handle vectors", () => {
  assert.deepEqual(motionPathSegments({ x: 0, y: 0 }, { x: 30, y: 0 }), [
    { start: { x: 0, y: 0 }, c1: { x: 10, y: 0 }, c2: { x: 20, y: 0 }, end: { x: 30, y: 0 } },
  ]);
  const [first, second] = motionPathSegments({ x: 0, y: 0 }, { x: 30, y: 0 }, {
    points: [{ x: 10, y: 20, in: { x: 1, y: 2 }, out: { x: 3, y: 4 } }],
  });
  assert.deepEqual(first.start, { x: 0, y: 0 });
  close(first.c1.x, 10 / 3);
  close(first.c1.y, 20 / 3);
  assert.deepEqual(first.c2, { x: 11, y: 22 });
  assert.deepEqual(first.end, { x: 10, y: 20 });
  assert.deepEqual(second.start, { x: 10, y: 20 });
  assert.deepEqual(second.c1, { x: 13, y: 24 });
  close(second.c2.x, 70 / 3);
  close(second.c2.y, 20 / 3);
  assert.deepEqual(second.end, { x: 30, y: 0 });
  const [straight] = motionPathSegments({ x: 0, y: 0 }, { x: 30, y: 0 }, {
    points: [{ x: 10, y: 20, in: { x: 1, y: 2 }, out: { x: 3, y: 4 } }], bezierControls: false,
  });
  close(straight.c1.x, 10 / 3);
  close(straight.c1.y, 20 / 3);
  close(straight.c2.x, 20 / 3);
  close(straight.c2.y, 40 / 3);
});

test("arc-length evaluation follows curved geometry, returns exact endpoints, and keeps linear segments straight", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 100, y: 0 };
  const curve = { points: [{ x: 50, y: 100, in: { x: -30, y: 0 }, out: { x: 30, y: 0 } }] };
  const middle = motionPathAt(start, end, curve, 0.5);
  assert.ok(middle.y > 50, `curved midpoint should rise above the straight chord: ${middle.y}`);
  const first = motionPathSegments(start, end, curve)[0];
  const cubicHalf = {
    x: 0.125 * first.start.x + 0.375 * first.c1.x + 0.375 * first.c2.x + 0.125 * first.end.x,
    y: 0.125 * first.start.y + 0.375 * first.c1.y + 0.375 * first.c2.y + 0.125 * first.end.y,
  };
  const arcQuarter = motionPathAt(start, end, curve, 0.25);
  assert.ok(Math.abs(arcQuarter.x - cubicHalf.x) > 0.1,
    "arc-length progress differs from the cubic parameter at one half");
  assert.deepEqual(motionPathAt(start, end, curve, 0), { ...start, angle: 63.43494882292201 });
  const last = motionPathAt(start, end, curve, 1);
  assert.equal(last.x, end.x);
  assert.equal(last.y, end.y);

  const line = motionPathAt(start, end, { points: [{ x: 50, y: 0 }], bezierControls: false }, 0.25);
  close(line.x, 25);
  close(line.y, 0);
  assert.equal(line.angle, 0);
  close(motionPathAt(start, end, undefined, 0.5).x, 50);
});

test("arc-length evaluation keeps speed on collinear cubics with unequal controls, including large coordinates", () => {
  const path = { points: [{ x: 100, y: 0, in: { x: -10, y: 0 }, out: { x: 10, y: 0 } }] };
  close(motionPathAt({ x: 0, y: 0 }, { x: 200, y: 0 }, path, 0.25).x, 50, 0.02);
  close(motionPathAt({ x: 0, y: 0 }, { x: 200, y: 0 }, path, 0.75).x, 150, 0.02);

  const largePath = { points: [{ x: 0, y: 0, in: { x: -100, y: 0 } }] };
  const largeStart = { x: -1_000_000, y: 0 };
  const largeEnd = { x: 1_000_000, y: 0 };
  let maximumError = 0;
  for (let index = 0; index <= 100; index += 1) {
    const progress = index / 100;
    const expected = largeStart.x + (largeEnd.x - largeStart.x) * progress;
    const actual = motionPathAt(largeStart, largeEnd, largePath, progress).x;
    maximumError = Math.max(maximumError, Math.abs(actual - expected));
  }
  assert.ok(maximumError <= 0.1, `large-coordinate line has at most 0.1 px speed error, got ${maximumError}`);
});

test("overshooting progress extrapolates along endpoint tangents and zero-length paths stay finite", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 100, y: 0 };
  assert.deepEqual(motionPathAt(start, end, undefined, -0.5), { x: -50, y: 0, angle: 0 });
  assert.deepEqual(motionPathAt(start, end, undefined, 1.5), { x: 150, y: 0, angle: 0 });
  assert.deepEqual(motionPathAt(start, start, { points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }, 0.4), {
    x: 0, y: 0, angle: 0,
  });
});

test("tangent angles unwrap across the -180/180 boundary without adding alignment offset", () => {
  const start = { x: 10, y: 0.1 };
  const end = { x: -10, y: 0.1 };
  const path = { points: [{ x: 0, y: 0 }], alignToPath: true, alignmentOffset: 90 };
  const initial = motionPathAt(start, end, path, 0).angle;
  const final = motionPathAt(start, end, path, 1).angle;
  assert.ok(initial < -170);
  assert.ok(final < -180, `unwrapped final tangent should continue through -180: ${final}`);
  assert.ok(Math.abs(final - initial) < 10, `${initial} to ${final} should avoid a full-turn jump`);
});

test("mapping transforms positions and vectors separately while preserving absence and flags", () => {
  assert.equal(mapMotionPath(undefined, (value) => value, (value) => value), undefined);
  assert.equal(mapMotionPath(null, (value) => value, (value) => value), null);
  const source = {
    points: [{ x: 3, y: 4, in: { x: 1, y: 2 }, out: { x: -2, y: 5 } }],
    bezierControls: false,
    alignToPath: true,
    alignmentOffset: 17,
  };
  const mapped = mapMotionPath(
    source,
    ({ x, y }) => ({ x: x + 100, y: y - 50 }),
    ({ x, y }) => ({ x: 2 * x, y: 3 * y }),
  );
  assert.deepEqual(mapped, {
    points: [{ x: 103, y: -46, in: { x: 2, y: 6 }, out: { x: -4, y: 15 } }],
    bezierControls: false,
    alignToPath: true,
    alignmentOffset: 17,
  });
  assert.notEqual(mapped.points[0], source.points[0]);
});
