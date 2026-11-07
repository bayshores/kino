import test from "node:test";
import assert from "node:assert/strict";
import { filterKinds } from "./filterPrewarm.js";

test("filter kinds ignore ids and areas and group blurs of a similar size", () => {
  const blur = (id, size, x) => `<filter id="${id}" x="${x}" y="0" width="9" height="9"><feGaussianBlur in="SourceGraphic" stdDeviation="${size}" result="blurred"/></filter>`;
  const a = filterKinds(`<svg>${blur("p-filter-1", 24, 0)}<g style="mix-blend-mode:screen"/></svg>`);
  const b = filterKinds(`<svg>${blur("p-filter-7", 26, 300)}</svg>`);
  const c = filterKinds(`<svg>${blur("p-filter-1", 3, 0)}<mask id="m"/></svg>`);
  assert.deepEqual([...b], [...a].filter((kind) => kind.startsWith("<filter")));
  assert.ok(a.has("mix-blend-mode:screen"));
  assert.ok(![...c].some((kind) => a.has(kind) && kind.startsWith("<filter")), "a small blur is its own kind");
  assert.ok(c.has("mask"));
});
