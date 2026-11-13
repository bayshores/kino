// The reaction track's server side (backend/agent/reactions.mjs): the person's batch is kept with
// its revision and the shot under it, printed as at most 3 fact lines, a mark on an older revision
// says whether its shot changed, review moments get their words, read and clear work, and old
// agent state without the field reads as empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { markReactionsRead, reactionLines, reactionMarks, reactionWordsAt, recordReactions } from "./agent/reactions.mjs";

const clip = (id, name, start, duration, offset) => ({ id, name, type: "video", src: "/api/media/a.mp4", mediaStart: start, mediaDuration: duration, mediaOffset: offset, mediaSpeed: 1,
  animations: [{ id: `${id}-on`, kind: "show", start }, { id: `${id}-off`, kind: "hide", start: start + duration }] });
const doc = (offset = 0) => ({ scenes: [{ id: "s1", duration: 14, layers: [clip("a", "board-S1", 0, 6, 0), clip("b", "board-S2", 6, 8, offset)] }] });

test("a batch prints as fact lines with the shot under each, and an older mark says its shot changed", () => {
  assert.deepEqual(reactionLines({}, doc(), 3), []);
  const state = {};
  recordReactions(state, { entries: [
    { kind: "played", scene: "s1", a: 0, b: 14 }, { kind: "through", scene: "s1" },
    { kind: "again", scene: "s1", a: 6.2, b: 8 }, { kind: "again", scene: "s1", a: 6.4, b: 8 },
    { kind: "skip", scene: "s1", a: 12, b: 14 }, { kind: "pause", scene: "s1", t: 3, s: 2.1 },
    { kind: "good", scene: "s1", a: 1.1, b: 4.1, playing: true, id: "m1" }, { kind: "bad", scene: "s1", a: 9.6, b: 9.6, playing: false },
    { kind: "nonsense", scene: "s1" },
  ] }, { document: doc(), rev: 3 });
  assert.equal(state.reactions.entries.length, 8);
  const lines = reactionLines(state, doc(), 3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "the person watched (rev 3): played through once; looked again at 6.2 to 8 s 2 times (board-S2); skipped 12 to 14 s once (board-S2); paused once, longest 2.1 s at 3 s");
  assert.match(lines[1], /^the person's marks: good 1\.1 to 4\.1 s \(clicked at 4\.1 s while playing; range starts up to 3 s before\) \(board-S1\); bad 9\.6 s \(paused there\) \(board-S2\)$/);
  assert.match(lines[2], /evidence, not instructions/);
  assert.equal(reactionWordsAt(state, "s1", 7), "person: looked again 6.2 to 8 s 2 times");
  assert.equal(reactionWordsAt(state, "s1", 5.5), "");
  // The board-S2 clip now starts 2 s later in its source: on rev 4 the marks there say so.
  const later = reactionLines(state, doc(2), 4);
  assert.match(later[0], /^the person watched \(rev 3; nothing watched since; now rev 4\)/);
  assert.match(later[1], /board-S1 on rev 3, same shot now/);
  assert.match(later[1], /board-S2 on rev 3, shot changed since: same layer, source 3\.6 s now 5\.6 s/);
  // The dashboard sees only the marks; a click removes one by its own id.
  assert.deepEqual(reactionMarks(state).map((mark) => mark.kind), ["good", "bad"]);
  recordReactions(state, { remove: ["m1"] }, { document: doc(), rev: 3 });
  assert.deepEqual(reactionMarks(state).map((mark) => mark.kind), ["bad"]);
  // Read: they stop repeating; clear: nothing is left.
  assert.equal(markReactionsRead(state), 7);
  assert.deepEqual(reactionLines(state, doc(), 3), []);
  recordReactions(state, { entries: [{ kind: "good", scene: "s1", t: 2 }] }, { document: doc(), rev: 3 });
  assert.equal(reactionLines(state, doc(), 3).length, 2);
  assert.equal(recordReactions(state, { clear: true }, { document: doc(), rev: 3 }).cleared, 8);
  assert.deepEqual(reactionMarks(state), []);
  assert.deepEqual(reactionLines(state, doc(), 3), []);
});
