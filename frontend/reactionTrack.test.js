// The reaction track's browser side (frontend/dashboard/reactionTrack.js) with a made-up wall
// clock: a jump back is "again", a jump forward "skip", a chain of quick jumps is one jump, a loop
// wrap is a play-through and never a look-again, a pause of 1 s or more is kept, and a mark made
// while playing starts 3 s before the click.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReactionTrack } from "./dashboard/reactionTrack.js";

function track() {
  let now = 100;
  const made = createReactionTrack({ wall: () => now, rev: () => 7, makeId: (n) => `m${n}` });
  return { made, wait: (seconds) => { now += seconds; } };
}

test("a loop wrap after the whole scene counts one play-through and no look-again", () => {
  const { made } = track();
  made.play("s1", 0, 10);
  for (let time = 0.5; time < 10; time += 0.5) made.tick("s1", time);
  made.tick("s1", 0.2);
  made.tick("s1", 2);
  made.stop(2);
  const kinds = made.take().map((entry) => entry.kind);
  assert.deepEqual(kinds.filter((kind) => kind !== "played"), ["through"]);
  assert.ok(!kinds.includes("again"));
});

test("jumps back and forward, a chain of quick jumps, a pause and marks", () => {
  const { made, wait } = track();
  made.play("s1", 0, 14);
  made.tick("s1", 8);
  made.stop(8);
  // Back to 7 for 0.4 s, then on back to 6.2: one jump from 8 to 6.2.
  made.play("s1", 7, 14);
  made.tick("s1", 7.4);
  made.stop(7.4);
  made.play("s1", 6.2, 14);
  made.tick("s1", 9);
  made.stop(9);
  wait(1.5);
  made.play("s1", 9, 14);
  made.tick("s1", 12);
  made.stop(12);
  made.play("s1", 13.5, 14);
  const good = made.mark("good", "s1", 13.8, true);
  made.stop(13.8);
  const bad = made.mark("bad", "s1", 4.1, false);
  const entries = made.take({ final: true });
  const facts = entries.filter((entry) => entry.kind !== "played").map(({ kind, a, b, t, s }) => ({ kind, a, b, t, s }));
  assert.deepEqual(facts, [
    { kind: "again", a: 6.2, b: 8, t: undefined, s: undefined },
    { kind: "pause", a: undefined, b: undefined, t: 9, s: 1.5 },
    { kind: "good", a: 10.8, b: 13.8, t: undefined, s: undefined },
    { kind: "bad", a: 4.1, b: 4.1, t: undefined, s: undefined },
    // The last landing played under 1 s: its jump waits for a chain until the final take.
    { kind: "skip", a: 12, b: 13.5, t: undefined, s: undefined },
  ]);
  assert.ok(entries.every((entry) => entry.rev === 7));
  assert.equal(good.playing, true);
  assert.equal(bad.playing, false);
  // A mark not sent yet can be taken back.
  made.mark("bad", "s1", 2, false);
  assert.equal(made.unmark("m3"), true);
  assert.deepEqual(made.take(), []);
});
