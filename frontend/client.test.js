import test from "node:test";
import assert from "node:assert/strict";
import { accessHeaders, shareToken } from "./client.js";

test("query and malformed file capabilities cannot fall through to a cached workspace owner key", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let ownerReads = 0;
  try {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: () => { ownerReads++; return "PRIVATE-TEST-OWNER"; }, setItem: () => {},
    } });
    for (const [query, hash, expected] of [
      ["?share=query-capability", "", "query-capability"],
      ["?share=query-capability", "#share=fragment-capability", "fragment-capability"],
      ["?share=", "", "invalid"],
      ["?share=query-capability", "#share=", "invalid"],
      ["", "#share=malformed&owner=PRIVATE-TEST-OWNER", "malformed"],
    ]) {
      Object.defineProperty(globalThis, "location", { configurable: true, value: { search: query, hash } });
      assert.equal(shareToken(), expected);
      assert.deepEqual(accessHeaders(), { "X-Kino-Share": expected });
    }
    assert.equal(ownerReads, 0);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else delete globalThis.location;
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage); else delete globalThis.sessionStorage;
  }
});
