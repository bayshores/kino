// set_cues and the cue list helpers (cues.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { cueSlug, withCues } from "./cues.js";

const doc = () => createDocument({ scenes: [createScene({ id: "s1", duration: 10 })] });
const names = (document) => (document.cues ?? []).map((cue) => `${cue.name}@${cue.time}:${cue.kind}`);

test("cue names are short lowercase slugs", () => {
  assert.equal(cueSlug("Ship faster!"), "ship-faster");
  assert.equal(cueSlug("Café déjà vu"), "cafe-deja-vu");
  assert.equal(cueSlug("a very long name that goes on and on", 10), "a-very-lon");
  assert.equal(cueSlug("!!!"), "");
});

test("withCues replaces by name and by kind, and keeps time order", () => {
  const existing = [{ name: "a", time: 3, kind: "marker" }, { name: "beat-1", time: 1, kind: "beat" }, { name: "x-1", time: 2, kind: "line" }];
  assert.deepEqual(withCues(existing, [{ name: "a", time: 0.5, kind: "marker" }], { kinds: ["beat"] }).map((cue) => cue.name), ["a", "x-1"]);
  assert.deepEqual(withCues(existing, [], { kinds: ["line"], prefix: "y-" }).length, 3);
});

test("set_cues adds markers, replaces a kind, removes by name, and the document still parses", () => {
  let document = applyOperations(doc(), [{ type: "set_cues", cues: [{ name: "drop", time: 4 }, { name: "intro", time: 0.5 }] }]);
  assert.deepEqual(names(document), ["intro@0.5:marker", "drop@4:marker"]);
  document = applyOperations(document, [{ type: "set_cues", cues: [{ name: "beat-1", time: 1, kind: "beat" }] }]);
  document = applyOperations(document, [{ type: "set_cues", replace: "marker", cues: [{ name: "outro", time: 9 }] }]);
  assert.deepEqual(names(document), ["beat-1@1:beat", "outro@9:marker"]);
  document = applyOperations(document, [{ type: "set_cues", remove: ["beat-1", "outro"] }]);
  assert.equal(document.cues, undefined);
  const saved = parseDocument(JSON.parse(JSON.stringify(applyOperations(document, [{ type: "set_cues", cues: [{ name: "a", time: 1 }] }]))));
  assert.deepEqual(saved.cues, [{ name: "a", time: 1, kind: "marker" }]);
});

test("set_cues refuses unknown names to remove and bad replace values", () => {
  assert.throws(() => applyOperations(doc(), [{ type: "set_cues", remove: ["nope"] }]), /No cue named nope/);
  assert.throws(() => applyOperations(doc(), [{ type: "set_cues", replace: "everything" }]), /replace must be true/);
  assert.throws(() => applyOperations(doc(), [{ type: "set_cues", cues: ["drop"] }]), /must be \{name, time, kind\?\}/);
});
