// The edit receipt's line when a hand edit changes an animation a move made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveHandEdits } from "./agent/jumps.mjs";

test("an update_animation on a move's animation says to send the move again; others say nothing", () => {
  const document = { scenes: [{ id: "s1", moves: [{ id: "type-on", name: "type-on" }] }] };
  const lines = moveHandEdits(document, [
    { type: "update_animation", animationId: "type-on.text-letters", layerId: "prompt" },
    { type: "update_animation", animationId: "title.in", layerId: "title" },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /type-on\.text-letters is part of move type-on type-on/);
  assert.match(lines[0], /\{op:"move", name:"type-on", id:"type-on", <field>\}/);
});
