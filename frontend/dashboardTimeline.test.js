// The timeline pane's facts (frontend/dashboard/timeline.js): when a layer is on screen, which layers
// are new since you looked and where their ▾ marks go, who changed a layer last, the hover
// card's lines, and the story row's parts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agoWords, hoverLines, lastChanges, newLayerIds, newMarks, onScreenRanges, partAt, readSeenRev, reviewLayerIds,
  saveSeenRev, spanText, storyParts, turnAuthor, turnsToReview,
} from "./dashboard/timeline.js";

const NOW = Date.parse("2026-10-26T06:00:00.000Z");

test("a layer is on screen while it plays, minus what its Hide and Show operations hide", () => {
  assert.deepEqual(onScreenRanges({ type: "text", animations: [] }, 10), [[0, 10]]);
  assert.deepEqual(onScreenRanges({ type: "text", animations: [{ id: "a", kind: "show", start: 2 }, { id: "b", kind: "hide", start: 4.5 }] }, 10), [[2, 4.5]]);
  // Hidden in the middle: two pieces.
  assert.deepEqual(onScreenRanges({ type: "rectangle", animations: [{ id: "a", kind: "hide", start: 3 }, { id: "b", kind: "show", start: 6 }] }, 10), [[0, 3], [6, 10]]);
  // Audio plays from its Play start for its Play length, not the whole scene.
  assert.deepEqual(onScreenRanges({ type: "audio", mediaStart: 2.6, mediaDuration: 18.282, animations: [] }, 170), [[2.6, 20.882]]);
  // The eye button hides it everywhere.
  assert.deepEqual(onScreenRanges({ type: "text", visible: false, animations: [] }, 10), []);
});

test("time ranges read as m:ss in a long scene and seconds in a short one", () => {
  assert.equal(spanText([48.2, 51.4], 170), "0:48–0:51");
  assert.equal(spanText([61, 125], 170), "1:01–2:05");
  assert.equal(spanText([1.25, 3.5], 20), "1.3–3.5 s");
});

test("the revision you last looked at is kept per project, and a broken store is no error", () => {
  const kept = new Map();
  globalThis.localStorage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  try {
    assert.equal(readSeenRev("p1"), null);
    saveSeenRev("p1", 247);
    assert.equal(readSeenRev("p1"), 247);
    assert.equal(readSeenRev("p2"), null);
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.equal(readSeenRev("p1"), null);
    assert.doesNotThrow(() => saveSeenRev("p1", 3));
  } finally { delete globalThis.localStorage; }
});

const turn = (id, before, after, extra = {}) => ({ id, edits: [{ before, after, at: `2026-10-26T05:${String(after % 60).padStart(2, "0")}:00.000Z` }], ...extra });

test("the turns reviewed: the recent ones with edits and every one after the revision you saw", () => {
  const turns = [turn("T1", 1, 2), { id: "T2", edits: [] }, turn("T3", 2, 5), turn("T4", 5, 6, { reverted: true }), turn("T5", 6, 9)];
  assert.deepEqual(turnsToReview(turns, null, 1).map((entry) => entry.id), ["T5"]);
  assert.deepEqual(turnsToReview(turns, 3, 1).map((entry) => entry.id), ["T3", "T5"], "T3 ended after rev 3; T4 was reverted");
  assert.deepEqual(turnsToReview(turns, 1, 12).map((entry) => entry.id), ["T1", "T3", "T5"]);
});

test("a turn review's names become layer ids: readable ids, codes, and a changed animation's layer", () => {
  const scene = {
    layers: [
      { id: "title", animations: [{ id: "title-in", kind: "in", start: 0, duration: 1 }] },
      { id: "0f3c9a2e-1b2c-4d5e-8f90-123456789abc", animations: [{ id: "c1d2e3f4-aaaa-bbbb-cccc-123456789abc", kind: "out", start: 2, duration: 1 }] },
      { id: "music", animations: [] },
    ],
  };
  const codes = { "0f3c9a2e-1b2c-4d5e-8f90-123456789abc": "L7", "c1d2e3f4-aaaa-bbbb-cccc-123456789abc": "A9" };
  assert.deepEqual(reviewLayerIds({ created: ["title"], changed: ["L7"], removed: ["gone"] }, scene, codes), ["title", "0f3c9a2e-1b2c-4d5e-8f90-123456789abc"]);
  assert.deepEqual(reviewLayerIds({ created: [], changed: ["A9", "title-in", "other-scene-layer"] }, scene, codes), ["0f3c9a2e-1b2c-4d5e-8f90-123456789abc", "title"]);
  assert.deepEqual(reviewLayerIds({ created: [], changed: ["L7"] }, scene, { byId: codes }), ["0f3c9a2e-1b2c-4d5e-8f90-123456789abc"], "codes as {byId}");
  assert.deepEqual(reviewLayerIds(null, scene, codes), []);
});

test("who made a turn's edits, who changed each layer last, and what is new since a revision", () => {
  const calls = [
    { turn: "T3", verb: "look", agent: { name: "Juno" } },
    { turn: "T3", verb: "edit", agent: { name: "Nova" } },
    { turn: "T3", verb: "edit", isError: true, agent: { name: "Juno" } },
    { turn: "T5", verb: "edit", by: "you" },
  ];
  assert.equal(turnAuthor("T3", calls), "Nova");
  assert.equal(turnAuthor("T5", calls), "you");
  assert.equal(turnAuthor("T9", calls), null);
  // A call with no agent name is named by its client, as the rest of the dashboard names it.
  assert.equal(turnAuthor("T7", [{ turn: "T7", verb: "edit", client: "codex" }]), "codex");
  const entries = [
    { turn: "T3", at: "2026-10-26T05:00:00.000Z", after: 5, who: "Nova", layerIds: ["title", "music"] },
    { turn: "T5", at: "2026-10-26T05:30:00.000Z", after: 9, who: null, layerIds: ["music"] },
  ];
  const building = [{ layerId: "title", agentId: "a2", at: "2026-10-26T05:50:00.000Z" }, { layerId: "music", agentId: "a2", at: "2026-10-26T04:00:00.000Z" }];
  assert.deepEqual(lastChanges(entries, building, [{ id: "a2", name: "Juno" }]), {
    title: { who: "Juno", at: "2026-10-26T05:50:00.000Z", turn: "T3" },
    music: { who: null, at: "2026-10-26T05:30:00.000Z", turn: "T5" },
  });
  assert.deepEqual([...newLayerIds(entries, 5)], ["music"]);
  assert.deepEqual([...newLayerIds(entries, 4)].sort(), ["music", "title"]);
  assert.equal(newLayerIds(entries, null).size, 0, "nothing is new before a first look is saved");
});

test("▾ marks closer than the gap become one, at the first", () => {
  assert.deepEqual(newMarks([12, 2, 2.3, null, 2.1, 30], 0.5), [{ at: 2, count: 3 }, { at: 12, count: 1 }, { at: 30, count: 1 }]);
  assert.deepEqual(newMarks([], 1), []);
});

test("the hover card says the name, when it is on screen, who changed it and whether it is new, in 3 lines at most", () => {
  assert.equal(agoWords("2026-10-26T05:59:30.000Z", NOW), "just now");
  assert.equal(agoWords("2026-10-26T05:58:00.000Z", NOW), "2 min ago");
  assert.equal(agoWords("2026-10-26T03:00:00.000Z", NOW), "3 h ago");
  assert.equal(agoWords("2026-10-25T06:00:00.000Z", NOW), "1 day ago");
  assert.deepEqual(hoverLines({ name: "hero-1-who", span: [48, 51], duration: 170, change: { who: "Nova", at: "2026-10-26T05:58:00.000Z", turn: "T19" }, isNew: true, now: NOW }),
    ["hero-1-who  0:48–0:51", "Nova changed it 2 min ago · T19", "▾ new since you looked"]);
  assert.deepEqual(hoverLines({ name: "music", span: [0, 170], duration: 170, change: { who: null, at: "2026-10-26T05:00:00.000Z", turn: "T17" }, now: NOW }),
    ["music  0:00–2:50", "changed 1 h ago · T17"]);
  assert.deepEqual(hoverLines({ name: "hidden", span: null, duration: 10, now: NOW }), ["hidden  not on screen"]);
});

test("the story row's parts come from the storyboard's shots, else from named cues", () => {
  const shot = (id, cue, dur, subject, text = "none") => ({ id, cue, dur, subject: subject === "none" ? "none" : { what: subject, boxes: [[0, 0, 10, 10]] }, text: text === "none" ? "none" : { text }, sound: "none" });
  const boarded = { scenes: [{ id: "s1", layers: [] }, { id: "s2", layers: [] }], cues: [{ name: "drop", time: 4 }],
    board: { shots: [shot("S1", 0, 8, "the smoke plume"), shot("S2", 8, 6, "none", "Possible wildfire"), shot("S3", 14, 10, "none")] } };
  assert.deepEqual(storyParts(boarded, "s1", 20), [
    { start: 0, end: 8, name: "the smoke plume", id: "S1" }, { start: 8, end: 14, name: "Possible wildfire", id: "S2" }, { start: 14, end: 20, name: "S3", id: "S3" },
  ]);
  // The board's times are on the main scene only; another scene uses its named cues.
  assert.deepEqual(storyParts(boarded, "s2", 10), [{ start: 4, end: 10, name: "drop" }]);
  const cued = { scenes: [{ id: "s1", layers: [] }], cues: [{ name: "beat-1", time: 0.2, kind: "beat" }, { name: "outro", time: 9 }, { name: "hook", time: 0 }, { name: "onset-1", time: 1, kind: "onset" }] };
  assert.deepEqual(storyParts(cued, "s1", 12), [{ start: 0, end: 9, name: "hook" }, { start: 9, end: 12, name: "outro" }]);
  assert.deepEqual(storyParts({ scenes: [{ id: "s1", layers: [] }], cues: [{ name: "beat-1", time: 1, kind: "beat" }] }, "s1", 10), [], "beats alone name no parts");
  // Captions make a line cue per page and a word cue per word: those are not parts either.
  assert.deepEqual(storyParts({ scenes: [{ id: "s1", layers: [] }], cues: [{ name: "hook", time: 0 }, { name: "captions-1", time: 2, kind: "line" }, { name: "captions-w1", time: 2, kind: "word" }] }, "s1", 10),
    [{ start: 0, end: 10, name: "hook" }]);
  const parts = storyParts(cued, "s1", 12);
  assert.equal(partAt(parts, 0), 0);
  assert.equal(partAt(parts, 9), 1);
  assert.equal(partAt(parts, 12), 1, "the end of the video is in the last part");
  assert.equal(partAt([], 3), -1);
});
