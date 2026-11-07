// The agent bots' moods (bot.js): each mood comes from the agent's row, its newest call and the
// hold, in a fixed order; plus the eye shapes (flat eyes still show at 14 px) and the motion curves.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DONE_MS, MOODS, SHAPE, SLEEP_MS, Z_STEP_MS, blinkEdges, blinkShut, botMood, moodTimes, zStep, eyeShape, glyphStroke, hop, moodOfRow, nextBlinkIn, shake, verbMood, wobble,
} from "./dashboard/bot.js";
import { WORKING_MS } from "./dashboard/state.js";

const T0 = Date.parse("2026-10-25T10:42:00.000Z");
const NOVA = { id: "a1", name: "Nova", color: "#42c0b6", kind: "claude-code" };
const iso = (ms) => new Date(ms).toISOString();

const row = (fields = {}) => ({ ...NOVA, lastAt: iso(T0), status: "working", isError: false, ...fields });
const call = (fields = {}) => ({ agent: NOVA, call: 7, phase: "done", verb: "edit", label: "move Title", write: true, turn: "T4", isError: false, running: 0, at: iso(T0), ...fields });

test("every mood has an eye shape; done and error close the eyes for their glyphs", () => {
  assert.deepEqual(Object.keys(SHAPE).sort(), [...MOODS].sort());
  assert.ok(SHAPE.done.h < 0.1 && SHAPE.error.h < 0.1);
  assert.ok(SHAPE.wait.h > SHAPE.idle.h, "waiting eyes are taller");
  assert.ok(SHAPE.work.h < SHAPE.idle.h, "working eyes are bars");
});

test("a call that runs: an edit, render or project call works; a look, inspect, check, status or library call looks", () => {
  for (const verb of ["edit", "render", "project"]) assert.equal(verbMood({ verb }), "work", verb);
  for (const verb of ["look", "inspect", "check", "status", "library"]) assert.equal(verbMood({ verb }), "look", verb);
  // Another verb goes by whether it writes.
  assert.equal(verbMood({ verb: "history", write: true }), "work");
  assert.equal(verbMood({ verb: "notes", write: false }), "look");
  assert.equal(botMood({ row: row({ lastAt: iso(T0 - 60_000), status: "idle" }), presence: call({ phase: "start", at: iso(T0 - 60_000) }), now: T0 }), "work", "still running after a minute");
  assert.equal(botMood({ row: row(), presence: call({ verb: "look", write: false, phase: "done", running: 1 }), now: T0 + 1000 }), "look", "another call still runs");
});

test("a call in the last 20 s: work or look by its verb; nothing from the call: work", () => {
  assert.equal(botMood({ row: row(), presence: call(), now: T0 + 5000 }), "work");
  assert.equal(botMood({ row: row(), presence: call({ verb: "check", write: false }), now: T0 + 5000 }), "look");
  assert.equal(botMood({ row: row(), presence: null, now: T0 + 5000 }), "work");
});

test("needs you comes first, then hold, then a running call, then a failed call", () => {
  assert.equal(botMood({ row: row({ status: "needs-you" }), presence: call({ phase: "start" }), hold: true, now: T0 }), "wait");
  assert.equal(botMood({ row: row(), presence: call({ phase: "start" }), hold: true, now: T0 }), "held");
  assert.equal(botMood({ row: row({ status: "failed", isError: true }), presence: call({ isError: true }), now: T0 + 1000 }), "error");
  // A failed agent that tries again works again.
  assert.equal(botMood({ row: row({ status: "failed", isError: true }), presence: call({ phase: "start", call: 8 }), now: T0 + 1000 }), "work");
});

test("done shows for 20 s after the work, only for this turn's call that went well", () => {
  const quiet = { row: row({ status: "idle" }), presence: call(), turn: "T4" };
  assert.equal(botMood({ ...quiet, now: T0 + WORKING_MS - 1 }), "work");
  assert.equal(botMood({ ...quiet, now: T0 + WORKING_MS + 1 }), "done");
  assert.equal(botMood({ ...quiet, now: T0 + WORKING_MS + DONE_MS - 1 }), "done");
  assert.equal(botMood({ ...quiet, now: T0 + WORKING_MS + DONE_MS + 1 }), "idle");
  assert.equal(botMood({ ...quiet, turn: "T5", now: T0 + WORKING_MS + 1 }), "idle", "an older turn's call");
  assert.equal(botMood({ ...quiet, presence: call({ isError: true }), now: T0 + WORKING_MS + 1 }), "idle", "a failed call is not done");
  assert.equal(botMood({ ...quiet, presence: null, now: T0 + WORKING_MS + 1 }), "idle", "no call seen: not done");
});

test("asleep after 2 min without a call; idle before", () => {
  assert.equal(botMood({ row: row({ status: "idle" }), presence: null, now: T0 + SLEEP_MS - 1 }), "idle");
  assert.equal(botMood({ row: row({ status: "idle" }), presence: null, now: T0 + SLEEP_MS + 1 }), "sleep");
  assert.equal(botMood({ row: row({ status: "idle", lastAt: undefined }), now: T0 }), "idle", "no time: idle, not asleep");
});

test("a tag on the stage has only the call: its age is on the server's clock", () => {
  assert.equal(botMood({ presence: call({ verb: "look", write: false }), now: T0 + 3000 }), "look");
  assert.equal(botMood({ presence: call({ isError: true }), now: T0 + 3000 }), "error");
  assert.equal(botMood({ presence: call({ approval: "ap-1" }), now: T0 + 3000 }), "wait");
  assert.equal(botMood({ presence: call({ phase: "start" }), hold: true, now: T0 }), "held");
  // This computer is 30 s ahead of the server: the call is 2 s old, not 32 s.
  assert.equal(botMood({ presence: call(), now: T0 + 32_000, skew: 30_000 }), "work");
});

test("moodOfRow reads an agent from the dashboard's data", () => {
  const juno = { id: "a2", name: "Juno", color: "#6cb6ff", kind: "codex" };
  const data = {
    agents: [{ ...NOVA, lastAt: iso(T0) }, { ...juno, lastAt: iso(T0 - 5 * 60_000) }],
    live: { latest: { a1: call({ verb: "inspect", write: false }) }, skew: 0 },
    hold: { on: false }, approvals: [], agent: { turns: [{ id: "T4" }] },
  };
  assert.equal(moodOfRow(data, { ...NOVA, lastAt: iso(T0) }, T0 + 2000), "look");
  assert.equal(moodOfRow(data, { ...juno, lastAt: iso(T0 - 5 * 60_000) }, T0 + 2000), "sleep");
  assert.equal(moodOfRow({ ...data, hold: { on: true } }, { ...NOVA, lastAt: iso(T0), status: "working" }, T0 + 2000), "held");
});

test("at 14 px a flat eye is at least 1.4 px tall and keeps its middle; at 96 px the shape is the design's", () => {
  for (const mood of ["work", "held", "sleep"]) {
    const eye = eyeShape(mood, 14);
    assert.ok(eye.h * (14 / 24) >= 1.4 - 1e-9, `${mood} ${eye.h} units`);
    assert.ok(Math.abs(eye.y + eye.h / 2 - (SHAPE[mood].y + SHAPE[mood].h / 2)) < 1e-9, `${mood} centered`);
  }
  assert.deepEqual(eyeShape("idle", 96), SHAPE.idle);
  assert.deepEqual(eyeShape("work", 96), SHAPE.work);
  assert.equal(eyeShape("done", 14).h, SHAPE.done.h, "closed stays closed");
  assert.ok(glyphStroke(14) * (14 / 24) >= 1.3 - 1e-9 && glyphStroke(96) === 1.9);
});

test("motion: the squash settles, a hop goes up and down, the shake fades, a blink shuts the eyes for 120 ms", () => {
  assert.equal(wobble(0), 1);
  assert.equal(wobble(700), 0);
  assert.ok(Math.abs(wobble(590)) < 0.01, "settled by 600 ms");
  assert.equal(hop(0), 0);
  assert.equal(hop(130), 1);
  assert.equal(hop(300), 0);
  assert.equal(shake(400), 0);
  assert.ok(Math.abs(shake(30)) > 0.5 && Math.abs(shake(330)) < 0.2);
  assert.equal(blinkShut(75), 1);
  assert.equal(blinkShut(119), 1);
  assert.equal(blinkShut(120), 0, "two steps, shut then open: a timer can draw it");
  assert.equal(blinkShut(160), 0);
  assert.equal(blinkShut(190 + 75, true), 1, "the second blink of a double");
  assert.equal(nextBlinkIn(true, 0.5), 10_000, "reduced motion blinks every 10 s");
  for (const random of [0, 0.5, 1]) assert.ok(nextBlinkIn(false, random) >= 3000 && nextBlinkIn(false, random) <= 6000);
});

test("a resting bot needs no frames: its blink and its sleeping z are steps a timer can wake for", () => {
  assert.deepEqual(blinkEdges(false), [120]);
  assert.deepEqual(blinkEdges(true), [120, 190, 310]);
  // The "z" rises in 4 steps of 650 ms and is gone at the last one.
  assert.equal(Z_STEP_MS, 650);
  const steps = [0, 1, 2, 3].map(zStep);
  assert.ok(steps[0].y > steps[1].y && steps[1].y > steps[2].y, "it rises");
  assert.equal(steps[3].opacity, 0);
  assert.deepEqual(zStep(4), steps[0], "and starts again");
  // The stage redraws its bots when their mood changes by itself: work or look ends, done ends, asleep.
  assert.deepEqual(moodTimes(T0), [T0 + WORKING_MS, T0 + WORKING_MS + DONE_MS, T0 + SLEEP_MS + 1]);
});
