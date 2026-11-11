// Every answer ends with one exact next call (backend/agent/next-call.mjs): a text answer's last
// line is `next: <tool> <JSON>`, a JSON answer's last key is "next". Unit tests of the answer
// builder and of the calls the direction steps name; backend/agent-edit-repair.test.mjs follows
// a refusal's call on a live server.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { openStore } from "./store.mjs";
import { createDocument, createScene } from "../engine/model.js";
import { answerText, callText, opWithName, originFootage, originFootageNext, unfilledSlot, withSuggestion } from "./agent/next-call.mjs";
import { originReferenceLine } from "./agent/seen-names.mjs";
import { statusMove } from "./stops.test.support.mjs";
import { withAsk } from "./agent-ask.test.support.mjs";

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
  assert.deepEqual(Object.keys(fresh.input.fields), ["ask", "about", "message", "look_sound", "never", "plays_on", "made_from"]);
  assert.equal(statusMove({}, video).call, null, "a change to a video with layers: the build steps");
  const line = (text) => ({ text, by: "guessed" });
  const brief = { rev: 1, fields: withAsk({ about: line("a"), message: line("m"), plays_on: line("p"), made_from: line("f"), look_sound: line("l"), never: line("n") }), log: [], noPlayback: { reason: "just start", rev: 1 } };
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

test("origin word, no person footage: next is the footage search for the quote and the word, then a scan wanting it; with person footage or a titled find: unchanged", () => {
  const origin = { words: [{ word: "tower", count: 11, of: 15 }] };
  const about = { text: "the keeper", by: "you", quote: "the keeper" };
  const found = originFootage({ origin, about, footage: { candidates: [{ title: "Keeper at rest" }] }, personClips: 0 });
  assert.deepEqual(found, { word: "tower", query: "the keeper tower" });
  const search = { tool: "library", input: { topic: "footage", search: "the keeper tower" } };
  // After a footage search for other words, a footage scan or an inspire search: the origin search.
  assert.deepEqual(originFootageNext({ found, topic: "footage", input: { search: "keeper fight" } }), search);
  assert.deepEqual(originFootageNext({ found, topic: "footage", input: { scan: "F1" } }), search);
  assert.deepEqual(originFootageNext({ found, topic: "inspire", input: { search: "keeper edit" } }), search);
  assert.equal(originFootageNext({ found, topic: "inspire", input: { name: "yt:abc" } }), null);
  assert.equal(originFootageNext({ found, topic: "inspire", input: { search: "whoosh", kind: "sounds" } }), null);
  // The origin search itself: a scan wanting the word when it found something, else the answer's own call.
  assert.deepEqual(originFootageNext({ found, topic: "footage", input: { search: "The keeper tower" }, reply: { data: { candidates: [{ code: "F1" }] } } }),
    { tool: "library", input: { topic: "footage", scan: "top", want: "tower" } });
  assert.equal(originFootageNext({ found, topic: "footage", input: { search: "the keeper tower" }, reply: { data: { candidates: [] } } }), null);
  // A scan that wants the word is left alone: its next call is the import.
  assert.equal(originFootageNext({ found, topic: "footage", input: { scan: "top", want: "the tower" } }), null);
  // The person's own footage, or a found video whose title has the word: nothing changes.
  assert.equal(originFootage({ origin, about, footage: null, personClips: 1 }), null);
  assert.equal(originFootage({ origin, about, footage: { candidates: [{ title: "Keeper climbs the Tower" }] }, personClips: 0 }), null);
  assert.equal(originFootage({ origin: { skipped: "offline" }, about, personClips: 0 }), null);
  assert.equal(originFootageNext({ found: null, topic: "footage", input: { scan: "F1" } }), null);
  // A studied reference with the word in its title gets the lookup line.
  assert.equal(originReferenceLine(found, "Keeper tower edit"), 'to find the footage it shows: library {topic:"footage", search:"the keeper tower"}');
  assert.equal(originReferenceLine(found, "Keeper edit"), "");
});

// The first compose: the shape the person named, else the shape most listed clips share, else the
// scene's own ratio (a 1080x1920 scene is a guess until someone says it plays on a phone).
test("an empty portrait video with two landscape clips and no plays_on gets a 16:9 compose next", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-next-compose-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = await openStore(dataRoot);
  const agentState = createAgentStateStore(dataRoot);
  await store.createProject(createDocument({ id: "p", name: "p", scenes: [createScene({ id: "s1", name: "main", width: 1080, height: 1920, duration: 24, layers: [] })] }));
  const clip = (name, width, height) => ({ id: `${name}.mp4`, projectId: "p", name: `${name}.mp4`, mime: "video/mp4", kind: "video", width, height, duration: 4 });
  const clips = [clip("a", 1920, 1080), clip("b", 1920, 1080)];
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot: path.join(dataRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => [], listMedia: async () => clips });
  await service.call("edit", { project: "p", ops: ["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a next-call test" })) });
  await service.call("notes", { project: "p", action: "brief", fields: { message: { text: "The keeper is back", by: "guessed" } } });
  const next = async () => (await service.call("check", { project: "p", pixels: false, rules: ["assertions"] })).text.match(/^next: (.*)$/m)?.[1];
  assert.equal(await next(), 'edit {"ops":[{"op":"compose","footage":["a.mp4","b.mp4"],"format":"16:9"}]}');
  // A split that is no majority, and one clip alone, keep the scene's shape.
  clips.push(clip("c", 1080, 1920), clip("d", 1080, 1920));
  assert.match(await next(), /"format":"9:16"/);
  clips.splice(1, 3);
  assert.match(await next(), /"format":"9:16"/);
});
