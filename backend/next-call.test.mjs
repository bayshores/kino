// Every answer ends with one exact next call (backend/agent/next-call.mjs): a text answer's last
// line is `next: <tool> <JSON>`, a JSON answer's last key is "next". Unit tests of the answer
// builder and of the calls the direction steps name; backend/agent-edit-repair.test.mjs follows
// a refusal's call on a live server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerText, callText, opWithName, unfilledSlot, withSuggestion } from "./agent/next-call.mjs";
import { statusMove } from "./stops.test.support.mjs";

const LOOK = { tool: "look", input: { mode: "review" } };

test("answerText: a text answer ends with one next line after its inbox; a JSON one with a next key, prose moved to hint", () => {
  assert.equal(answerText({ text: "rev 3 · 0 err" }, LOOK), 'rev 3 · 0 err\nnext: look {"mode":"review"}');
  assert.equal(answerText({ text: "rev 3" }, LOOK, ["N1 note"]), 'rev 3\ninbox ◆1\n  N1 note\nnext: look {"mode":"review"}');
  const held = JSON.parse(answerText({ data: { waiting: "C1", next: "Nothing was changed." }, json: true }, LOOK, ["hold released"]));
  assert.deepEqual(held, { waiting: "C1", hint: "Nothing was changed.", inbox: ["hold released"], next: 'look {"mode":"review"}' });
  assert.deepEqual(Object.keys(held).at(-1), "next");
  // A refused edit: the fixed call carries the example, so the text does not repeat it.
  const example = { op: "add_animation", layer: "bar", preset: "preset-fade", start: 0, duration: 0.4 };
  const retry = { tool: "edit", input: { retry: "E1", fix: { 0: example } } };
  const refused = JSON.parse(answerText({ data: { error: "op_failed", reason: "no such preset", example, retry: "E1", next: "Nothing was saved. edit {retry…}" }, json: true }, retry));
  assert.deepEqual(refused, { error: "op_failed", reason: "no such preset", retry: "E1", hint: "Nothing was saved. The next call resends the edit with the fix.", next: callText(retry) });
});

test("the fixed call for a refusal: the suggestion in place of the misspelled field or name; unfilled slots are found", () => {
  assert.deepEqual(withSuggestion({ mode: "sheeet", t: 2, why: "see it" }, "sheet"), { mode: "sheet", t: 2, why: "see it" });
  assert.equal(withSuggestion({ t: 2 }, "sheet"), null);
  assert.deepEqual(opWithName({ op: "update_layer", layer: "titel", properties: { x: 4 } }, "titel", "title"), { op: "update_layer", layer: "title", properties: { x: 4 } });
  assert.deepEqual(opWithName({ op: "add_animation", layers: ["titel.in"] }, "titel", "title"), { op: "add_animation", layers: ["title.in"] });
  assert.equal(opWithName({ op: "delete_layer", layer: "box" }, "titel", "title"), null);
  assert.deepEqual(unfilledSlot({ ops: [{ op: "compose", beats: [{ text: "<your headline>" }] }] }), { path: "ops[0].beats[0].text", value: "<your headline>" });
  assert.deepEqual(unfilledSlot({ fields: { "<the line they corrected>": "x" } }), { path: "fields.<the line they corrected>", value: "<the line they corrected>" });
  assert.equal(unfilledSlot({ ops: [{ op: "add_layer", properties: { text: "<3 kino" } }] }), null, "text that only starts with < is the agent's own");
});

test("the direction's calls: a new video's brief with every line at once, the plan once it is settled, building is the service's, a waiting stop's answer", () => {
  const unwaived = { seconds: 20, layers: 3, width: 1920, height: 1080 };
  const video = { ...unwaived, treatmentsWaived: true };
  const fresh = statusMove({}, { ...video, layers: 0 }).call;
  assert.deepEqual(Object.keys(fresh.input.fields), ["message", "look_sound", "never", "plays_on", "made_from"]);
  assert.equal(statusMove({}, video).call, null, "a change to a video with layers: the build steps");
  const line = (text) => ({ text, by: "guessed" });
  const brief = { rev: 1, fields: { message: line("m"), plays_on: line("p"), made_from: line("f"), look_sound: line("l"), never: line("n") }, log: [], noPlayback: { reason: "just start", rev: 1 } };
  assert.equal(statusMove({ brief }, unwaived).step, "write 5 treatments", "the idea comes before the plan (T3)");
  const plan = statusMove({ brief }, video);
  assert.equal(plan.step, "notes set_plan, build, then ask rough");
  assert.equal(plan.call.input.action, "set_plan");
  assert.ok(plan.call.input.steps.includes("Ask rough (notes checkpoint)"));
  assert.equal(statusMove({ brief, plan: { steps: [{ text: "Build" }] } }, video).call, null);
  // Unconfirmed: play it back, until the video is built, checked and looked at without one.
  const unconfirmed = { ...brief, noPlayback: null };
  assert.equal(statusMove({ brief: unconfirmed }, video).call.input.log[0].kind, "playback");
  const built = statusMove({ brief: unconfirmed, checked: { rev: 370 }, lastLook: "s1" }, video);
  assert.deepEqual([built.step, built.call], ["build on, then ask rough; play the brief back at your next ask", null]);
  assert.deepEqual(statusMove({ brief, checked: { rev: 370 }, lastLook: "s1" }, video).call, null, "settled and built: no plan to set");
  const spent = { ...unconfirmed, log: Array.from({ length: 10 }, () => ({ q: "?", a: "!" })) };
  assert.equal(statusMove({ brief: spent, checked: { rev: 370 }, lastLook: "s1" }, video).step, "build on", "out of replies: no playback to name");
  const footage = statusMove({ brief: unconfirmed, checked: { rev: 370 }, lastLook: "s1" }, { ...video, footage: true });
  assert.deepEqual([footage.step, footage.call.input], ["ask board, then build on; play the brief back then", { action: "checkpoint", id: "board" }]);
  const waiting = statusMove({ brief, stops: [{ id: "C1", kind: "rough", rev: 4, status: "waiting", askedAt: "2026-10-26T14:00:00.000Z" }] }, video);
  assert.deepEqual(waiting.call, { tool: "notes", input: { action: "answer", id: "C1", rev: 4, words: "<their reply, word for word>", read_as: "approve" } });
});
