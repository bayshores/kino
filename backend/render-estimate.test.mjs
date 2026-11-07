// The render estimate learns from the last finished renders on this computer.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RATES, drawnSeconds, estimateWords, jobRate, renderEstimate } from "./agent/render-estimate.mjs";

const job = (quality, drawn, wall, extra = {}) => ({ status: "done", quality, startedAt: 1_000, finishedAt: 1_000 + wall * 1000, drawnSeconds: drawn, ...extra });

test("before any render the default is used; then the median of the last renders of that quality", () => {
  assert.deepEqual(renderEstimate([], "final", 25), { seconds: 25 * DEFAULT_RATES.final, measured: false });
  // A 25 s video that took 2 minutes: the next 25 s final render says about 2 minutes.
  const jobs = [job("final", 25, 120), job("final", 10, 50), job("final", 20, 90), job("draft", 25, 10)];
  assert.deepEqual(renderEstimate(jobs, "final", 25), { seconds: 120, measured: true });
  assert.deepEqual(renderEstimate(jobs, "draft", 25), { seconds: 10, measured: true });
});

test("failed, cached or unfinished jobs teach nothing", () => {
  assert.equal(jobRate(job("final", 25, 120, { status: "failed" })), null);
  assert.equal(jobRate(job("final", 0, 3)), null, "a cached render drew nothing");
  assert.equal(jobRate({ status: "done", quality: "final", startedAt: 1_000, drawnSeconds: 5 }), null, "no finish time");
  assert.equal(drawnSeconds([{ fps: 30, renderedFrames: 453 }, { fps: 30, renderedFrames: 0, cached: true }]), 15.1);
});

test("the estimate reads in seconds, then minutes", () => {
  assert.deepEqual([45, 113, 2280, 4000].map(estimateWords), ["about 45s", "about 2 min", "about 38 min", "about 1 h 7 min"]);
});
