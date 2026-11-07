// The taste aids (2026-10-25): the person's material saved as sources, so check's own_words
// can name on-screen copy that is in none of it; the brief's optional idea line, shown at each
// stop; and the AI-tell warnings in check. Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyBrief, briefChanges, emptyBrief } from "./agent/brief.mjs";
import { boardAsk } from "./agent/board-text.mjs";
import { askText } from "./agent/stops.mjs";
import { contentWords, normalizeSources, sourceVocabulary } from "../engine/sources.js";
import { startTestServer } from "./media.test.support.mjs";

let server;
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "taste", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "taste", name: "Taste", width: 1920, height: 1080, duration: 4, background: "#f5f2ea" });
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Revolutionary vigilance tomorrow", x: 200, y: 200, width: 1400, height: 120, fontSize: 80, fontFamily: "Noto Serif", fill: "#1a1a1a" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
});

test("contentWords keeps numbers and meaning words; the vocabulary matches plurals and -ing", () => {
  assert.deepEqual(contentWords("11:21 \u2014 74% sure: texting the nearest station."), ["11:21", "74%", "sure", "texting", "nearest", "station"]);
  const known = sourceVocabulary([{ name: "a", text: "cameras watching" }]);
  assert.ok(known.has("camera") && known.has("watch"));
  const document = normalizeSources({ sources: [{ name: " a ", text: "one" }, { name: "A", text: "dup" }, { name: "b", text: " " }, "x"] });
  assert.deepEqual(document.sources, [{ name: "a", text: "one" }]);
  assert.equal("sources" in normalizeSources({ sources: [] }), false);
});

test("source saves, replaces and removes material; check's own_words reads it", async () => {
  const before = await agent("check", {});
  assert.match(before.text, /no source saved/, before.text);

  const saved = await agent("edit", { ops: [{ op: "source", name: "readme", text: "smokescreen watches wildfire cameras all night." }] });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /source \\?"readme\\?" saved: \d+ characters · 1 source/);
  const flagged = await agent("check", {});
  assert.match(flagged.text, /own_words/);
  assert.match(flagged.text, /revolutionary/);

  await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { text: "Watches wildfire cameras all night" } }] });
  const clean = await agent("check", {});
  assert.doesNotMatch(clean.text, /own_words/, clean.text);

  const replaced = await agent("edit", { ops: [{ op: "source", name: "readme", text: "Something else entirely." }] });
  assert.equal(replaced.isError, undefined, replaced.text);
  assert.match((await agent("check", {})).text, /own_words/);

  const removed = await agent("edit", { ops: [{ op: "source", name: "readme", text: null }] });
  assert.equal(removed.isError, undefined, removed.text);
  assert.match((await agent("check", {})).text, /no source saved/);

  const refused = await agent("edit", { ops: [{ op: "source", name: "", text: "x" }] });
  assert.equal(refused.isError, true, refused.text);
});

test("the idea line: optional, saved alone it keeps a confirmed brief confirmed, and each stop shows it", () => {
  const line = (text) => ({ text, by: "guessed" });
  let state = { brief: emptyBrief() };
  const save = (input) => applyBrief(state, briefChanges(state.brief, input));
  save({ fields: { message: line("smoke texts the station"), plays_on: line("X"), made_from: line("repo"), look_sound: line("silent"), never: line("no glow") } });
  save({ log: [{ q: "Right?", a: "yes", kind: "playback", rev: 1, confirmed: true }] });
  assert.equal(state.brief.confirmedRev, 1);
  save({ fields: { idea: line("the product's own lock screen tells it") } });
  assert.equal(state.brief.rev, 2);
  assert.equal(state.brief.confirmedRev, 2, "only the idea changed: still confirmed");
  save({ fields: { never: line("no meme font") } });
  assert.equal(state.brief.confirmedRev, 2, "another line changed: needs a new playback");

  const ask = askText({ id: "C3", kind: "rough", video: { seconds: 20 }, checked: { errors: 0, warnings: 0 }, idea: "the log is the narrator" });
  assert.match(ask, /^Idea: the log is the narrator$/m);
  assert.doesNotMatch(askText({ id: "C3", kind: "rough", video: { seconds: 20 }, checked: {} }), /Idea:/);
  const board = { rev: 1, music: "none", shots: [{ id: "S1", cue: 0, dur: 2, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text: "none", sound: "none", why: "the hook" }], calls: [], open: [] };
  const boardText = boardAsk({ id: "C2", board, frame: { width: 1920, height: 1080 }, seconds: 2, message: "smoke texts the station", idea: "the log is the narrator" }).text;
  assert.match(boardText, /^Brief: smoke texts the station\nIdea: the log is the narrator$/m);
});
