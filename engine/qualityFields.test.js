import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, parseDocument } from "./model.js";

test("cues: named moments are kept, defaulted to marker and sorted by time", () => {
  const document = parseDocument({
    ...createDocument(),
    cues: [
      { name: "drop", time: 4.5, kind: "beat" },
      { name: "intro", time: 0.25 },
      { name: "song-drop-1", time: 2, kind: "marker", fitted: true },
    ],
  });
  assert.deepEqual(document.cues, [
    { name: "intro", time: 0.25, kind: "marker" },
    { name: "song-drop-1", time: 2, kind: "marker", fitted: true },
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
  // A music hit keeps its weight, band, rank and downbeat; bad ones are refused.
  const accent = { name: "accent-1", time: 1, kind: "accent", weight: 0.9, band: "low", rank: 1 };
  assert.deepEqual(withCues([accent])().cues, [accent]);
  assert.throws(withCues([{ ...accent, weight: 2 }]), /cues\[0\]\.weight/);
  assert.throws(withCues([{ ...accent, band: "sub" }]), /cues\[0\]\.band/);
});
