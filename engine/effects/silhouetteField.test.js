import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSilhouetteFieldCache,
  silhouetteField,
  silhouetteFieldCacheStats,
} from "./silhouetteField.js";

const bounds = { x: 0, y: 0, width: 10, height: 10 };

test("builds a bounded rectangle field with signed distance and inward normals", () => {
  const field = silhouetteField({
    path: "M2 2 H8 V8 H2 Z",
    fillRule: "nonzero",
    bounds,
  });

  assert.deepEqual([field.width, field.height], [10, 10]);
  assert.ok(field.sample(0.5, 0.5).distance > 2);
  assert.ok(field.sample(0.25, 0.55).distance > 0);
  assert.ok(field.sample(0.25, 0.55).nx > 0.9);

  const outsideCorner = field.sample(0.05, 0.05);
  assert.ok(outsideCorner.distance < 0);
  assert.ok(outsideCorner.nx > 0.5);
  assert.ok(outsideCorner.ny > 0.5);
  assert.ok(Math.abs(Math.hypot(outsideCorner.nx, outsideCorner.ny) - 1) < 1e-5);
});

test("flattens Bezier silhouettes and preserves compound holes for both fill rules", () => {
  const ellipse = silhouetteField({
    path: "M10 2 C14.418 2 18 5.582 18 10 C18 14.418 14.418 18 10 18 C5.582 18 2 14.418 2 10 C2 5.582 5.582 2 10 2 Z",
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  assert.ok(ellipse.sample(0.5, 0.5).distance > 7);
  const leftEdge = ellipse.sample(0.15, 0.5);
  assert.ok(leftEdge.distance > 0);
  assert.ok(leftEdge.nx > 0.8);

  const sameDirectionContours = "M1 1 H19 V19 H1 Z M7 7 H13 V13 H7 Z";
  const evenodd = silhouetteField({
    path: sameDirectionContours,
    fillRule: "evenodd",
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  const nonzero = silhouetteField({
    path: sameDirectionContours,
    fillRule: "nonzero",
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  assert.ok(evenodd.sample(0.5, 0.5).distance < 0);
  assert.ok(nonzero.sample(0.5, 0.5).distance > 8);

  const reversedInnerContour = "M1 1 H19 V19 H1 Z M7 7 V13 H13 V7 Z";
  const nonzeroHole = silhouetteField({
    path: reversedInnerContour,
    fillRule: "nonzero",
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  assert.ok(nonzeroHole.sample(0.5, 0.5).distance < 0);
});

test("handles empty and fully covered bounds without inventing a contour", () => {
  const empty = silhouetteField({ path: "", bounds });
  assert.ok(empty.sample(0.5, 0.5).distance < 0);
  const emptySample = empty.sample(0.5, 0.5);
  assert.ok(Math.abs(emptySample.distance + Math.hypot(bounds.width, bounds.height)) < 1e-5);
  assert.deepEqual([emptySample.nx, emptySample.ny], [0, 0]);

  const covered = silhouetteField({
    path: "M-100 -100 H100 V100 H-100 Z",
    bounds,
  });
  assert.ok(covered.sample(0.5, 0.5).distance > 0);
});

test("supports tiny positive bounds and rejects degenerate or malformed bounds", () => {
  const smallBounds = { x: 0, y: 0, width: 0.5, height: 0.25 };
  const small = silhouetteField({
    path: "M0 0 H0.5 V0.25 H0 Z",
    bounds: smallBounds,
  });
  assert.deepEqual([small.width, small.height], [2, 2]);
  assert.ok(small.sample(0.5, 0.5).distance > 0);

  assert.throws(
    () => silhouetteField({ path: "", bounds: { x: 0, y: 0, width: 0, height: 1 } }),
    /positive finite/,
  );
  assert.throws(
    () => silhouetteField({ path: "", bounds: { x: 0, y: 0, width: 1, height: Infinity } }),
    /finite x\/y/,
  );
  assert.throws(
    () => silhouetteField({ path: "", fillRule: "positive", bounds }),
    /fillRule/,
  );
  assert.throws(() => silhouetteField({ path: "M0 0 R1 2", bounds }), /Unsupported path command/);
});

test("is deterministic and caches by path, fill rule, and exact bounds", () => {
  clearSilhouetteFieldCache();
  const input = { path: "M1 1 H9 V9 H1 Z", fillRule: "nonzero", bounds };
  const first = silhouetteField(input);
  assert.equal(silhouetteField(input), first);

  const differentRule = silhouetteField({ ...input, fillRule: "evenodd" });
  const differentSize = silhouetteField({ ...input, bounds: { ...bounds, width: 9 } });
  const differentPath = silhouetteField({ ...input, path: "M2 2 H8 V8 H2 Z" });
  assert.notEqual(differentRule, first);
  assert.notEqual(differentSize, first);
  assert.notEqual(differentPath, first);

  clearSilhouetteFieldCache();
  const repeated = silhouetteField(input);
  assert.deepEqual([...repeated.distances], [...first.distances]);
  assert.deepEqual([...repeated.normalX], [...first.normalX]);
  assert.deepEqual([...repeated.normalY], [...first.normalY]);
});

test("evicts least recently used fields and keeps retained arrays within both cache caps", () => {
  clearSilhouetteFieldCache();
  const smallPath = "M0 0 H1 V1 H0 Z";
  const firstInput = { path: smallPath, bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const first = silhouetteField(firstInput);
  const secondInput = { path: smallPath, bounds: { x: 2, y: 0, width: 1, height: 1 } };
  const second = silhouetteField(secondInput);
  assert.equal(silhouetteField(firstInput), first);
  for (let index = 2; index <= 16; index += 1) {
    silhouetteField({ path: smallPath, bounds: { x: index * 2, y: 0, width: 1, height: 1 } });
  }
  const entryStats = silhouetteFieldCacheStats();
  assert.equal(entryStats.entries, entryStats.maxEntries);
  assert.ok(entryStats.bytes <= entryStats.maxBytes);
  assert.equal(silhouetteField(firstInput), first);
  const secondAgain = silhouetteField(secondInput);
  assert.notEqual(secondAgain, second);
  assert.equal(silhouetteField(secondInput), secondAgain);

  clearSilhouetteFieldCache();
  for (let index = 0; index < 11; index += 1) {
    const x = index * 1000;
    silhouetteField({
      path: `M${x + 10} 10 H${x + 990} V990 H${x + 10} Z`,
      bounds: { x, y: 0, width: 1000, height: 1000 },
    });
  }
  const byteStats = silhouetteFieldCacheStats();
  assert.ok(byteStats.bytes <= byteStats.maxBytes);
  assert.ok(byteStats.entries < 11);
});

test("refuses geometry whose measured work exceeds the explicit cap", () => {
  const pointCount = 800;
  const coordinates = [];
  for (let index = 0; index < pointCount; index += 1) {
    const angle = (Math.PI * 2 * index) / pointCount;
    coordinates.push(`${150 + Math.cos(angle) * 100} ${150 + Math.sin(angle) * 100}`);
  }
  const path = `M${coordinates.join(" L")} Z`;
  assert.throws(
    () => silhouetteField({ path, bounds: { x: 0, y: 0, width: 300, height: 300 } }),
    /distance tests exceed the .* work limit/,
  );
});

test("caps a 1920 by 1080 silhouette grid at the configured longest side", () => {
  const field = silhouetteField({
    path: "M100 100 H1820 V980 H100 Z",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.deepEqual([field.width, field.height], [256, 144]);
  assert.equal(field.distances.length, 256 * 144);
});
