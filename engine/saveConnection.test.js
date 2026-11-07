import assert from "node:assert/strict";
import test from "node:test";
import { connectionIndicator, isRetryable, retryDelay, sameDocument } from "./saveConnection.js";

test("connection indicator prioritizes conflict and permanent errors before offline", () => {
  assert.deepEqual(connectionIndicator({ saveState: "conflict", socketState: "disconnected", online: false }), {
    state: "conflict", label: "Conflict",
    description: "This file changed elsewhere. Choose which version to keep before continuing.",
  });
  assert.equal(connectionIndicator({ saveState: "saved", socketState: "connected", errorKind: "access", online: false }).state, "error");
  assert.equal(connectionIndicator({ saveState: "error", socketState: "connected", errorKind: "network" }).state, "offline");
  assert.equal(connectionIndicator({ saveState: "error", socketState: "connected" }).state, "error");
  assert.equal(connectionIndicator({ saveState: "saved", socketState: "connected", errorKind: { status: 409 }, online: false }).state, "conflict");
});

test("connection indicator maps pending, offline, synced, reconnecting, and read-only states honestly", () => {
  for (const saveState of ["dirty", "saving", "editing"])
    assert.deepEqual(connectionIndicator({ saveState, socketState: "connected" }).label, "Syncing");
  assert.equal(connectionIndicator({ saveState: "saved", socketState: "connected" }).label, "Synced");
  assert.equal(connectionIndicator({ saveState: "saved", socketState: "connecting" }).label, "Reconnecting");

  const offline = connectionIndicator({ saveState: "dirty", socketState: "connected", online: false });
  assert.equal(offline.label, "Offline");
  assert.match(offline.description, /on this device/);
  assert.match(offline.description, /retry when the connection returns/);
  assert.equal(connectionIndicator({ saveState: "read-only", socketState: "connected" }).description,
    "This read-only file is up to date.");
  assert.equal(connectionIndicator({ saveState: "read-only", socketState: "disconnected" }).state, "reconnecting");
  assert.equal(connectionIndicator({ saveState: "read-only", socketState: "connected", online: false }).description,
    "The service is unavailable. This file stays visible and will refresh when the connection returns.");
  assert.equal(connectionIndicator({ saveState: "loading", socketState: "connected" }).state, "syncing");
});

test("retry delay uses exponential backoff, bounded jitter, a cap, and defensive inputs", () => {
  assert.equal(retryDelay(0, () => 0), 800);
  assert.equal(retryDelay(0, () => 1), 1200);
  assert.equal(retryDelay(1, () => 0.5), 2000);
  assert.equal(retryDelay(5, () => 0), 25_600);
  assert.equal(retryDelay(6, () => 0), 30_000);
  assert.equal(retryDelay(100_000, () => 0.5), 30_000);
  assert.equal(retryDelay(-3, () => 0.5), 1000);
  assert.equal(retryDelay(Number.NaN, () => 0.5), 1000);
  assert.equal(retryDelay(0, () => Number.NaN), 1000);
  assert.equal(retryDelay(0, () => { throw new Error("random unavailable"); }), 1000);
  assert.equal(retryDelay(0, () => -5), 800);
  assert.equal(retryDelay(0, () => 5), 1200);
});

test("only network, timeout, and selected gateway failures are retryable", () => {
  assert.equal(isRetryable({ kind: "network" }), true);
  assert.equal(isRetryable({ errorKind: "timeout" }), true);
  for (const status of [502, 503, 504]) assert.equal(isRetryable({ status }), true);
  for (const status of [400, 403, 409, 413]) assert.equal(isRetryable({ status }), false);
  assert.equal(isRetryable({ name: "AbortError", kind: "network" }), false);
  assert.equal(isRetryable({ userAborted: true, kind: "timeout" }), false);
  assert.equal(isRetryable({ kind: "validation" }), false);
  assert.equal(isRetryable(new Error("unknown")), false);
  assert.equal(isRetryable(null), false);
});

test("sameDocument ignores object key order, preserves array order, and never mutates inputs", () => {
  const left = { version: 4, scenes: [{ id: "first", layers: [{ id: "box", x: 10, y: 20 }] }, { id: "second", layers: [] }] };
  const reordered = { scenes: [{ layers: [{ y: 20, id: "box", x: 10 }], id: "first" }, { layers: [], id: "second" }], version: 4 };
  const beforeLeft = JSON.stringify(left), beforeRight = JSON.stringify(reordered);
  assert.equal(sameDocument(left, reordered), true);
  assert.equal(JSON.stringify(left), beforeLeft);
  assert.equal(JSON.stringify(reordered), beforeRight);
  assert.equal(sameDocument(left, { ...reordered, scenes: [...reordered.scenes].reverse() }), false);
  assert.equal(sameDocument(left, { ...reordered, version: 3 }), false);
  assert.equal(sameDocument([, 1], [null, 1]), true, "JSON encodes array holes as null");
  assert.equal(sameDocument([undefined, 1], [null, 1]), true, "JSON encodes array undefined as null");
  assert.equal(sameDocument([1, null], [null, 1]), false, "array order remains significant");
});

test("sameDocument compares shared values by JSON content and ignores omitted undefined properties", () => {
  const sharedPaint = { type: "solid", color: "#3157a5" };
  const documentWithSharedPaint = { layers: [{ fill: sharedPaint, stroke: sharedPaint }] };
  const roundTripped = JSON.parse(JSON.stringify(documentWithSharedPaint));
  assert.notEqual(roundTripped.layers[0].fill, roundTripped.layers[0].stroke);
  assert.equal(sameDocument(documentWithSharedPaint, roundTripped), true);

  assert.equal(sameDocument({ layer: { fill: "#fff", optional: undefined } }, { layer: { fill: "#fff" } }), true);
  const cycle = {};
  cycle.self = cycle;
  assert.equal(sameDocument(cycle, cycle), false, "cyclic values are outside the JSON document domain");
});
