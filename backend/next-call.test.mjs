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
import { answerText, callText, missingFieldCall, opWithName, originFootage, originFootageNext, unfilledSlot, withSuggestion } from "./agent/next-call.mjs";
import { originReferenceLine } from "./agent/seen-names.mjs";
import { lockCall } from "./agent/brief.mjs";
import { fromAppWindow } from "./dashboard-routes.mjs";
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

test("answerText early: the inbox and a short next sit at the early line; a long call is named, not printed twice", () => {
  const text = "rev 3\nadvice\ntail 1\ntail 2";
  assert.equal(answerText({ text, early: { at: 2, next: true } }, LOOK, ["N1 note"]),
    'rev 3\nadvice\ninbox ◆1\n  N1 note\nnext: look {"mode":"review"}\ntail 1\ntail 2\nnext: look {"mode":"review"}');
  const long = { tool: "edit", input: { ops: [{ op: "add_layer", layerType: "text", name: "a-very-long-layer-name", properties: { text: "a long headline that fills the call" } }] } };
  const lines = answerText({ text, early: { at: 2, next: true } }, long).split("\n");
  assert.equal(lines[2], "next: edit (the exact call is on the last line)");
  assert.equal(lines.at(-1), `next: ${callText(long)}`);
  // Without an early place, or for a JSON answer, nothing moves.
  assert.equal(answerText({ text, early: {} }, LOOK), `${text}\nnext: look {"mode":"review"}`);
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
  // A call refused for a field it lacks: the same call with the missing fields as slots; the
  // fields sent stay, and a call that lacks nothing gets none.
  assert.equal(callText(missingFieldCall("notes", { action: "reply", text: "fixed", why: "done" })), 'notes {"action":"reply","text":"fixed","id":"<the note\'s id, such as N2>"}');
  assert.ok(unfilledSlot(missingFieldCall("notes", { action: "set_plan" }).input), "its slots are ones kino refuses unfilled");
  assert.equal(missingFieldCall("notes", { action: "reply", id: "N2", text: "x" }), null);
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

test("the pick: someone at the app gets a filled sketch round (also under just start), asked once; the song and the picked font follow", () => {
  const line = (text) => ({ text, by: "guessed" });
  const list = ["a door opens", "a city wakes", "a phone lights the room up at night", "one long breath", "the last bus"].map((idea, index) => ({ idea, move: `move ${index}`, p: 0.1 * index, source: index === 3 ? "street.mp4 at 2.5 s" : "the screen" }));
  const treatments = { list, dropped: 2, shown: [3, 0, 1], picked: null };
  const brief = { rev: 1, fields: withAsk({ about: line("a"), message: line("m"), plays_on: line("p"), made_from: line("f"), look_sound: line(""), never: line("n") }), log: [], noPlayback: { reason: "just start", rev: 1 }, treatments };
  const video = { seconds: 40, layers: 0, width: 1920, height: 1080, files: ["street.mp4", "desk.mp4"] };
  assert.equal(statusMove({ brief }, video).step, "pick a treatment, with why", "no one at the app: the own pick, as before");
  const shown = statusMove({ brief }, { ...video, appSeen: true });
  assert.match(shown.step, /^show sketches: their pick in the app; songs: library \{topic:"soundtrack"/);
  assert.deepEqual(shown.call.input.options.map((option) => [option.treatment, option.clips[0].file, option.clips[0].in, option.line, option.song, option.font]), [
    ["A", "street.mp4", 2.5, "one long breath", "<title> by <artist>", "<family>"], ["B", "desk.mp4", 0, "a door opens", "<title> by <artist>", "<family>"], ["C", "street.mp4", 0, "a city wakes", "<title> by <artist>", "<family>"]]);
  assert.deepEqual([shown.call.input.action, shown.call.input.seconds], ["try", 6]);
  const round = (status) => ({ id: "T1", sketch: true, status, options: [{ letter: "A", treatment: "A", idea: "one long breath" }, { letter: "B", treatment: "B", idea: "a door opens" }] });
  assert.match(statusMove({ brief, tries: [round("waiting")] }, { ...video, appSeen: true }).step, /their sketch pick in the app \(T1\)/);
  for (const status of ["skipped", "none", "failed"]) assert.equal(statusMove({ brief, tries: [round(status)] }, { ...video, appSeen: true }).step, "pick a treatment, with why", `${status}: never a second round`);
  assert.equal(statusMove({ brief, tries: [round("waiting")] }, video).step, "pick a treatment, with why", "the app went away");
  const yourCall = { ...brief, log: [{ q: "Which treatment (A, B or C)?", a: "your call" }] };
  assert.equal(statusMove({ brief: yourCall }, { ...video, appSeen: true }).step, "pick a treatment, with why");
  // Picked, no song anywhere: the real-song finder before the plan, from the brief's sound line.
  const picked = { ...brief, treatments: { ...treatments, picked: { index: 3, label: "A", by: "you" } }, style: { idea: "x", signatures: [{ beat: 0 }], spine: ["problem", "turn", "payoff"].map((role) => ({ role, purpose: role })) } };
  assert.deepEqual(statusMove({ brief: picked }, { ...video, songNeeded: true }).call.input, { topic: "soundtrack", explore: true });
  const sound = { ...picked, fields: { ...picked.fields, look_sound: line("slow piano") } };
  assert.deepEqual(statusMove({ brief: sound }, { ...video, songNeeded: true }).call.input, { topic: "soundtrack", search: "slow piano" });
  assert.notEqual(statusMove({ brief: picked }, video).call?.input?.topic, "soundtrack", "a song chosen: no song step");
  // The picked sketch's font fills the fonts step (lockCall).
  const withSketch = { ...picked, treatments: { ...picked.treatments, picked: { ...picked.treatments.picked, sketch: { round: "T1", letter: "A", song: "/api/media/song.m4a", font: "Space Mono", line: null } } } };
  const font = lockCall({ brief: withSketch }).input.fields.style.fonts;
  assert.equal(font?.display?.family, "Space Mono");
  assert.deepEqual([fromAppWindow({ headers: { "sec-fetch-site": "same-origin" } }), fromAppWindow({ headers: {} })], [true, false], "agent calls (Node fetch) are not the app");
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
test("an empty portrait video with two landscape clips and no plays_on gets a 16:9 compose next; the shape the person named wins", async (t) => {
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
  // Two landscape clips again: a guessed phone keeps their shape; the person's own phone wins.
  clips.push(clip("b", 1920, 1080));
  const playsOn = (line, more = {}) => service.call("notes", { project: "p", action: "brief", fields: { plays_on: line, ...more } });
  assert.equal((await playsOn({ text: "a phone", by: "guessed" })).isError, undefined);
  assert.match(await next(), /"format":"16:9"/);
  const yours = await playsOn({ text: "a phone", by: "you", quote: "it plays on my phone" }, { ask: "The keeper is back, it plays on my phone" });
  assert.equal(yours.isError, undefined, yours.text);
  assert.match(await next(), /"format":"9:16"/);
});
