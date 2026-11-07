import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, parseDocument } from "./model.js";

test("cues: named moments are kept, defaulted to marker and sorted by time", () => {
  const document = parseDocument({
    ...createDocument(),
    cues: [
      { name: "drop", time: 4.5, kind: "beat" },
      { name: "intro", time: 0.25 },
    ],
  });
  assert.deepEqual(document.cues, [
    { name: "intro", time: 0.25, kind: "marker" },
    { name: "drop", time: 4.5, kind: "beat" },
  ]);
  assert.equal("cues" in parseDocument({ ...createDocument(), cues: [] }), false);
});

test("cues: bad names, repeated names, times and kinds are refused", () => {
  const withCues = (cues) => () => parseDocument({ ...createDocument(), cues });
  assert.throws(withCues([{ name: "has space", time: 1 }]), /cues\[0\]\.name/);
  assert.throws(withCues([{ name: "a", time: 1 }, { name: "a", time: 2 }]), /repeats the cue name a/);
  assert.throws(withCues([{ name: "a", time: -1 }]), /cues\[0\]\.time/);
  assert.throws(withCues([{ name: "a", time: 1, kind: "drum" }]), /cues\[0\]\.kind/);
  assert.throws(withCues({ name: "a" }), /document\.cues/);
});
