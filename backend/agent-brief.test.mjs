// The brief from the chat (plan decision D9, direction milestone B1): notes {action:"brief"}
// reads and saves it, a "you" line needs the person's quote and is never replaced by a guess,
// each logged reply counts toward 10, and status shows the direction and next lines. Only the
// agent's confirmed:true for the revision it played back confirms the brief; no_playback
// settles it without one. The brief survives a restart, is left alone by turn reverts and
// dashboard undo, takes two agents' saves at once, works during a hold, cannot be saved from
// the dashboard or kino --you, and is deleted with its project.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyBrief, BRIEF_FIELDS, BRIEF_LIMITS, briefChanges, briefText, directionLines, emptyBrief, guessedBans, nextMove, orderStep, REPLY_LIMIT, replyCount, savedText } from "./agent/brief.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { styleContext } from "../engine/styleSpec.js";
import { wordsOnly } from "./agent/treatments.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { hasMediaTools, makeToneAfterSilence, nextCallOf, startTestServer, withoutNext } from "./media.test.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let key;
before(async () => {
  server = await startTestServer();
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  key = (await response.json()).key;
});
after(() => server?.stop());

async function agent(verb, body = {}, on = server) {
  const response = await on.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function dashboard(route, { method = "POST", body } = {}, on = server) {
  const response = await on.api(`/api/dashboard/${route}`, { method, body, headers: method === "GET" ? {} : { "x-kino-review": key } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// The order steps before building (2 references, 5 treatments: brief.mjs orderStep) are waived
// unless a test asks for them.
const ORDER_WAIVERS = ["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a brief test" }));
async function newProject(id, on = server, duration = 24, { references = false } = {}) {
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration }, on);
  assert.equal(made.isError, undefined, made.text);
  if (!references) await agent("edit", { project: id, ops: ORDER_WAIVERS }, on);
}

const brief = (project, body, on) => agent("notes", { project, action: "brief", ...body }, on);
const statusLines = async (project, on) => (await agent("status", { project }, on)).text.split("\n");
// The project's agent-state file, where the reply log is kept (answers leave it out).
const savedState = async (project, on = server) => JSON.parse(await readFile(path.join(on.dataDirectory, "agent", "projects", `${project}.json`), "utf8"));

const MESSAGE = { text: "skate crew; make them want to skate now", by: "you", quote: "my skate crew, they should feel like going out to skate" };
const PLAYS_ON = { text: "TikTok, 9:16, 24 s", by: "guessed" };
const FIRST_QUESTION = { q: "Who's it for, and what should they feel after watching?", a: "my skate crew, they should feel like going out to skate" };
// The person's answer to a playback of revision `rev`: a yes confirms it, anything else does not.
const PLAYBACK_YES = (rev) => ({ q: "What's wrong or missing?", a: "looks right", kind: "playback", rev, confirmed: true });
// The fixture brief: a 24 s TikTok with all six lines and real-length quotes.
const FULL = {
  message: MESSAGE,
  plays_on: PLAYS_ON,
  made_from: { text: "skate.mp4 (24 s) and its own street sound", by: "guessed" },
  look_sound: { text: "raw and bright; real street sound; no synth", by: "you", quote: "raw and bright, real street sound, no synth dings" },
  never: { text: "no meme text; keep faces in frame", by: "you", quote: "no meme text and don't crop our faces out" },
  key_moment: { text: "the kickflip at the end", by: "you", quote: "the kickflip at the end" },
};

test("a brief with a you line and a guessed line reads back, and status shows direction and next", async () => {
  await newProject("brief-read");
  const empty = await brief("brief-read");
  assert.equal(empty.isError, undefined, empty.text);
  assert.equal(withoutNext(empty.text), 'No brief yet · replies 0 of 10. Ask in the chat (library guide direction), then save: notes {action:"brief", fields:{message:{text, by:"you", quote}}, log:[{q, a}]}.');
  assert.deepEqual(empty.data, { brief: null, missing: ["message", "plays_on", "made_from", "look_sound", "never"],
    replies: { count: 0, limit: 10, questions: 0, playbacks: 0, stops: 0 }, next: "new video? brief first (library guide direction)" });
  const before = await statusLines("brief-read");
  assert.deepEqual(before.slice(1, 3), ["direction: no brief · replies 0/10", "step: new video? brief first (library guide direction)"]);

  const saved = await brief("brief-read", { fields: { message: MESSAGE, plays_on: PLAYS_ON }, log: [FIRST_QUESTION] });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal(withoutNext(saved.text), [
    "brief r1 saved: message (you said), plays_on (guessed) · 1 reply logged (question) · replies 1 of 10",
    "missing: made_from, look_sound, never",
    "step: ask about look_sound, or guess it",
  ].join("\n"));
  assert.ok(estimateTextTokens(withoutNext(saved.text)) <= 80, `the save answer is about ${estimateTextTokens(withoutNext(saved.text))} tokens`);

  const read = await brief("brief-read");
  assert.equal(withoutNext(read.text), [
    "brief r1, unconfirmed · replies 1 of 10 (1 question, 0 playbacks)",
    'message: you said "my skate crew, they should feel like going out to skate"',
    "plays_on: guessed → TikTok, 9:16, 24 s",
    "missing: made_from, look_sound, never",
    "step: ask about look_sound, or guess it",
  ].join("\n"));
  const { brief: stored, ...rest } = read.data;
  assert.deepEqual(rest, { missing: ["made_from", "look_sound", "never"], replies: { count: 1, limit: 10, questions: 1, playbacks: 0, stops: 0 }, next: "ask about look_sound, or guess it" });
  assert.equal(stored.rev, 1);
  assert.equal(stored.confirmedRev, null);
  assert.match(stored.savedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual({ ...stored.fields.message, at: "…" }, { ...MESSAGE, rev: 1, client: "claude-code", at: "…" });
  assert.deepEqual({ ...stored.fields.plays_on, at: "…" }, { ...PLAYS_ON, rev: 1, client: "claude-code", at: "…" });
  assert.equal(Object.hasOwn(stored, "log"), false, "the reply log stays out of the answer");
  assert.deepEqual({ ...(await savedState("brief-read")).brief.log[0], at: "…" }, { ...FIRST_QUESTION, kind: "question", rev: 0, client: "claude-code", at: "…" }, "a reply is logged at the revision it answered");

  // The two lines come right after the header, before the plan.
  await agent("notes", { project: "brief-read", action: "set_plan", steps: ["Brief", "Build", "Render"] });
  const lines = await statusLines("brief-read");
  assert.deepEqual(lines.slice(1, 4), ["direction: brief r1 (1 guessed), unconfirmed · replies 1/10", "step: ask about look_sound, or guess it", "plan ▸ Brief (0/3)"]);
});

test("a you line needs a quote, a guessed line has none, and a refused save keeps nothing", async () => {
  await newProject("brief-quotes");
  await brief("brief-quotes", { fields: { message: MESSAGE } });
  for (const never of [{ text: "no meme text", by: "you" }, { text: "no meme text", by: "you", quote: "" }, { text: "no meme text", by: "you", quote: "   " }]) {
    const refused = await brief("brief-quotes", { fields: { never, plays_on: PLAYS_ON } });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error, "quote_needed");
    assert.ok(refused.data.reason.startsWith('never is by:"you", so it needs quote: the person\'s exact words from the chat, copied, not retold. If they did not say it, send by:"guessed".'), refused.data.reason);
    assert.deepEqual(refused.data.example, { never: { text: "no meme text", by: "you", quote: "<their exact words>" } });
  }
  const guessedQuote = await brief("brief-quotes", { fields: { plays_on: { ...PLAYS_ON, quote: "tiktok" } } });
  assert.equal(guessedQuote.data.error, "bad_input");
  assert.match(guessedQuote.data.reason, /^plays_on is by:"guessed", so it has no quote/);
  const typo = await brief("brief-quotes", { fields: { nevr: { text: "no meme text", by: "guessed" } } });
  assert.equal(typo.data.error, "bad_input");
  assert.deepEqual(typo.data.didYouMean.slice(0, 1), ["never"]);
  const several = await brief("brief-quotes", { fields: { never: { text: "no meme text", by: "you" }, nevr: { text: "x", by: "guessed" }, plays_on: PLAYS_ON } });
  assert.equal(several.data.error, "quote_needed");
  assert.deepEqual(several.data.lines, { never: "quote_needed", nevr: "bad_input" });
  for (const [body, pattern] of [
    [{ fields: { plays_on: { text: "x".repeat(BRIEF_LIMITS.text + 1), by: "guessed" } } }, /^plays_on\.text is 1–80 characters \(it has 81\)/],
    [{ fields: { never: { text: "no meme text", by: "you", quote: "q".repeat(BRIEF_LIMITS.quote + 1) } } }, /^never\.quote is 1–120 characters \(it has 121\)/],
    [{ fields: { never: { text: "no meme text", by: "person", quote: "no meme text" } } }, /^never\.by is "you"/],
    [{ fields: { never: { text: "no meme text", by: "guessed", reason: "x" } } }, /^never takes text, by and quote, not reason/],
    [{ fields: { never: 42 } }, /^never is text \(your guess\), \{text, by:"you"\|"guessed", quote\?\}, or null to remove it/],
    [{ fields: [] }, /^fields is an object of lines/],
    [{ fields: {} }, /^A brief save needs a line in fields, a reply in log or no_playback; send none of them to read the brief\.$/],
    [{ log: [{ q: "Who is it for?" }] }, /^log\[0\]\.a is text of 1–2000 characters/],
    // A reply too long even for a dictated answer: the refusal says what to log.
    [{ log: [{ q: "Who is it for?", a: "a".repeat(2001) }] }, /^log\[0\]\.a is 1–2000 characters \(it has 2001\)\. Log the part of their reply that answers your question, word for word\.$/],
    // A yes to a playback names the revision played back, and only a playback carries one.
    [{ log: [{ q: "What's wrong or missing?", a: "yes", kind: "playback", confirmed: true }] }, /^log\[0\] confirms a playback, so it needs rev: the brief revision you played back \(the brief is r1\)\.$/],
    [{ log: [PLAYBACK_YES(2)] }, /^log\[0\]\.rev is the brief revision you played back: 1 \(it has 2\)\.$/],
    [{ log: [{ ...PLAYBACK_YES(1), confirmed: "yes" }] }, /^log\[0\]\.confirmed is true \(they said the playback is right\) or false\.$/],
    [{ log: [{ q: "Who is it for?", a: "us", rev: 1 }] }, /^log\[0\]: rev and confirmed go with kind:"playback"/],
    [{ no_playback: " " }, /^no_playback is text of 1–80 characters\. Say why there is no playback: "just start" or "no one can answer"\.$/],
    [{ log: [{ q: "Who is it for?", a: "us", kind: "stop" }] }, /^log\[0\]\.kind is "question"/],
    [{ log: Array.from({ length: 5 }, () => ({ q: "q?", a: "a" })) }, /^log takes at most 4 replies in one call \(it has 5\)/],
  ]) {
    const refused = await brief("brief-quotes", body);
    assert.equal(refused.data.error, "bad_input", JSON.stringify(body));
    assert.match(refused.data.reason, pattern);
  }
  const read = await brief("brief-quotes");
  assert.equal(read.data.brief.rev, 1, "no refused save changed the brief");
  assert.deepEqual(Object.keys(read.data.brief.fields), ["message"]);
  assert.equal(read.data.replies.count, 0);
});

test("the person's line is never replaced by a guess or removed; their correction replaces it", async () => {
  await newProject("brief-yours");
  await brief("brief-yours", { fields: { never: { text: "no meme text", by: "you", quote: "no meme text please" } } });
  for (const never of [{ text: "no captions", by: "guessed" }, null]) {
    const refused = await brief("brief-yours", { fields: { never } });
    assert.equal(refused.data.error, "yours");
    assert.equal(refused.data.reason, 'never is the person\'s ("no meme text please"). Ask them in the chat, then save their new words with by:"you".');
  }
  const corrected = await brief("brief-yours", { fields: { never: { text: "no meme text, no emoji", by: "you", quote: "no meme text and no emoji either" } } });
  assert.equal(corrected.isError, undefined, corrected.text);
  assert.match(withoutNext(corrected.text), /^brief r2 saved: never \(you said\)/);
  // A guessed line may be guessed again or removed.
  await brief("brief-yours", { fields: { plays_on: PLAYS_ON } });
  const removed = await brief("brief-yours", { fields: { plays_on: null } });
  assert.match(withoutNext(removed.text), /^brief r4 saved: plays_on \(removed\)/);
  const same = await brief("brief-yours", { fields: { never: { text: "no meme text, no emoji", by: "you", quote: "no meme text and no emoji either" } } });
  assert.match(withoutNext(same.text), /^brief r4: no line changed · replies 0 of 10/, "a line sent again as it is changes nothing");
});

test("a yes to the playback confirms the brief; a later line change needs a new playback", async () => {
  await newProject("brief-playback", server, 24, { references: true });
  const full = await brief("brief-playback", { fields: FULL });
  assert.match(withoutNext(full.text), /\nmissing: none\nstep: play the brief back \(5–8 lines\)$/);
  const playback = await brief("brief-playback", { log: [PLAYBACK_YES(1)] });
  assert.equal(playback.text.split("\n")[0], "brief r1: 1 reply logged (playback) · confirmed · replies 1 of 10");
  assert.equal(playback.data.brief.confirmedRev, 1);
  // Settled, with no saved reference: find 2 before the plan (the step's call is the search).
  const before = await agent("status", { project: "brief-playback" });
  assert.equal(before.text.split("\n")[2], "step: find 2 references (inspire)");
  assert.match(before.text, /\nnext: library \{"topic":"inspire","search":"<an edit like yours>"\}$/);
  await agent("edit", { project: "brief-playback", ops: [{ op: "waive_check", code: "reference", target: "*", reason: "a brief test" }, { op: "waive_check", code: "treatments", target: "*", reason: "a brief test" }] });
  // status also names the first stop this 24 s video asks once it is built (B2a).
  assert.deepEqual((await statusLines("brief-playback")).slice(1, 3), ["direction: brief r1 (2 guessed), confirmed · replies 1/10", "step: notes set_plan, build, then ask rough"]);
  await agent("notes", { project: "brief-playback", action: "set_plan", steps: ["Build", "Render"] });
  assert.equal((await statusLines("brief-playback"))[2], "step: follow the plan, then ask rough");

  const change = await brief("brief-playback", { fields: { plays_on: { text: "TikTok, 9:16, 20 s", by: "guessed" } }, log: [{ q: "What's wrong or missing?", a: "make it 20 seconds", kind: "playback", rev: 1 }] });
  assert.match(withoutNext(change.text), /^brief r2 saved: plays_on \(guessed\) · 1 reply logged \(playback\) · replies 2 of 10\nmissing: none\nstep: play the brief back \(5–8 lines\)$/,
    "a correction is a new revision, so it is not confirmed");
  assert.deepEqual((await statusLines("brief-playback")).slice(1, 3), ["direction: brief r2 (2 guessed), unconfirmed · replies 2/10", "step: play the brief back (5–8 lines)"]);
  // A yes in the same call as a line change is to a revision the person has not seen.
  const sameCall = await brief("brief-playback", { fields: { plays_on: { text: "TikTok, 9:16, 18 s", by: "guessed" } }, log: [PLAYBACK_YES(2)] });
  assert.equal(sameCall.data.brief.confirmedRev, 1);
  assert.match(withoutNext(sameCall.text), /\nnot confirmed: they answered r2, and the brief is r3 now; play it back again\.\n/);
});

// Review round 1: kino cannot tell a yes from a correction, so a playback answer confirms only
// with the agent's confirmed:true.
test("a playback answer that is not a yes leaves the brief unconfirmed and asks for the fix", async () => {
  await newProject("brief-rejected");
  await brief("brief-rejected", { fields: FULL });
  for (const answer of [{ a: "No, that's all wrong. It's for my mom, not the crew." }, { a: "the vibe is off", confirmed: false }]) {
    const rejected = await brief("brief-rejected", { log: [{ q: "What's wrong or missing?", kind: "playback", rev: 1, ...answer }] });
    assert.equal(rejected.isError, undefined, rejected.text);
    assert.equal(rejected.text.split("\n")[0], "brief r1: 1 reply logged (playback) · unconfirmed · " + `replies ${rejected.data.replies.count} of 10`);
    assert.equal(rejected.data.brief.confirmedRev, null);
    assert.deepEqual((await statusLines("brief-rejected")).slice(1, 3), [`direction: brief r1 (2 guessed), unconfirmed · replies ${rejected.data.replies.count}/10`, "step: save their fix, then play it back"]);
  }
  const panel = (await dashboard("snapshot?project=brief-rejected", { method: "GET" })).body.agent.brief;
  assert.equal(panel.confirmed, false, "the dashboard does not say confirmed in chat");
  // Their fix, played back again and answered yes.
  await brief("brief-rejected", { fields: { message: { text: "my mom; make her proud", by: "you", quote: "It's for my mom, not the crew" } } });
  assert.equal((await statusLines("brief-rejected"))[2], "step: play the brief back (5–8 lines)");
  assert.equal((await brief("brief-rejected", { log: [PLAYBACK_YES(2)] })).data.brief.confirmedRev, 2);
});

// Review round 1: another agent (or the same one) saved a line after the playback and before
// the person's yes, so the yes is to a revision that is no longer the latest.
test("a yes to an older revision confirms nothing, and says to play it back again", async () => {
  await newProject("brief-stale");
  const first = await brief("brief-stale", { client: "claude-a", fields: FULL });
  assert.equal(first.data.brief.rev, 1);
  const other = await brief("brief-stale", { client: "codex-b", fields: { made_from: { text: "skate.mp4 and a synth track", by: "guessed" } } });
  assert.equal(other.isError, undefined, other.text);
  const yes = await brief("brief-stale", { client: "claude-a", log: [PLAYBACK_YES(1)] });
  assert.equal(yes.isError, undefined, yes.text);
  assert.deepEqual(yes.text.split("\n").slice(0, 2), ["brief r2: 1 reply logged (playback) · unconfirmed · replies 1 of 10", "not confirmed: they answered r1, and the brief is r2 now; play it back again."]);
  assert.equal(yes.data.brief.confirmedRev, null);
  assert.equal((await savedState("brief-stale")).brief.log.at(-1).rev, 1, "the reply is logged at the revision played back");
  assert.deepEqual((await statusLines("brief-stale")).slice(1, 3), ["direction: brief r2 (2 guessed), unconfirmed · replies 1/10", "step: play the brief back (5–8 lines)"]);
  assert.equal((await dashboard("snapshot?project=brief-stale", { method: "GET" })).body.agent.brief.confirmed, false);
});

// Night 2026-10-28: every answer on a 370-revision project said to play the brief back. Only
// status and notes say so; a read names its own call; built, checked and looked at, the
// playback no longer holds the video.
test("an unconfirmed brief: status and notes say play it back, other answers name their own next call", async () => {
  await newProject("brief-hint");
  // Nothing on screen and no brief: a read still says brief first.
  assert.equal(nextCallOf(await agent("inspect", { project: "brief-hint", targets: ["s1"] })).input.action, "brief");
  assert.equal(nextCallOf(await agent("look", { project: "brief-hint", mode: "frame", t: 1, width: 160 })).input.action, "brief");
  await brief("brief-hint", { fields: FULL });
  await agent("edit", { project: "brief-hint", ops: [{ op: "add_layer", layerType: "text", name: "headline", properties: { text: "Skate now" },
    animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }] }] });
  const playback = (reply) => nextCallOf(reply).input.log?.[0]?.kind;
  const inspected = async (targets, fields) => nextCallOf(await agent("inspect", { project: "brief-hint", targets, fields })).input.ops[0];
  // Not a field an edit sets, a scene, an animation: no refused edit, no guessed layer.
  assert.deepEqual(await inspected(["headline"], ["animations"]), { op: "update_layer", layer: "headline", properties: { "<field>": "<new value>" } });
  assert.equal((await inspected(["s1"])).layer, "<the layer to change>");
  const animation = await inspected(["animation"], ["duration"]);
  assert.equal(animation.op, "update_animation");
  assert.ok(!animation.animation.startsWith("<"));
  assert.deepEqual(animation.properties, { duration: "<new value>" });
  assert.equal(playback(await agent("status", { project: "brief-hint" })), "playback");
  assert.equal(playback(await brief("brief-hint")), "playback");
  assert.deepEqual(nextCallOf(await agent("inspect", { project: "brief-hint", targets: ["text"], fields: ["fontSize"] })).input,
    { ops: [{ op: "update_layer", layer: "headline", properties: { fontSize: "<new value>" } }] }, "an edit of the layer it read");
  assert.equal(nextCallOf(await agent("library", { project: "brief-hint", topic: "op", name: "move" })).tool, "edit");
  assert.deepEqual(nextCallOf(await agent("look", { project: "brief-hint", mode: "frame", t: 1, width: 160 })), { tool: "check", input: { fix: "auto" } });
  assert.notEqual(playback(await agent("check", { project: "brief-hint" })), "playback", "a check leads to the build steps");
  assert.equal(nextCallOf(await agent("look", { project: "brief-hint", mode: "frame", t: 1, width: 160 })).input.ops[0].op, "update_layer", "checked: an edit of what it showed");
  // Built, checked and looked at: status still names the playback, but the build steps lead.
  const status = await agent("status", { project: "brief-hint" });
  assert.equal(status.text.split("\n")[2], "step: build on, then ask rough; play the brief back at your next ask");
  assert.notEqual(playback(status), "playback");
});

// Review round 1: "just start", or no one to answer, is a brief settled with no playback.
test("no_playback settles the brief without a playback for the rest of the video", async () => {
  await newProject("brief-just-start");
  const guessed = Object.fromEntries(Object.entries(FULL).filter(([name]) => name !== "key_moment").map(([name, line]) => [name, { text: line.text, by: "guessed" }]));
  const saved = await brief("brief-just-start", { fields: guessed, log: [{ ...FIRST_QUESTION, a: "just start" }], no_playback: "just start" });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal(withoutNext(saved.text), [
    "brief r1 saved: message (guessed), plays_on (guessed), made_from (guessed), look_sound (guessed), never (guessed) · 1 reply logged (question) · no playback (just start) · replies 1 of 10",
    "missing: none",
    "step: notes set_plan, then build",
  ].join("\n"));
  assert.deepEqual((await statusLines("brief-just-start")).slice(1, 3), ["direction: brief r1 (5 guessed), no playback · replies 1/10", "step: notes set_plan, build, then ask rough"]);
  await agent("notes", { project: "brief-just-start", action: "set_plan", steps: ["Build", "Render"] });
  assert.equal((await statusLines("brief-just-start"))[2], "step: follow the plan, then ask rough");
  // A later change is saved, and still needs no playback.
  await brief("brief-just-start", { fields: { plays_on: { text: "TikTok, 9:16, 20 s", by: "guessed" } } });
  assert.deepEqual((await statusLines("brief-just-start")).slice(1, 3), ["direction: brief r2 (5 guessed), no playback · replies 1/10", "step: follow the plan, then ask rough"]);
  assert.match(withoutNext((await brief("brief-just-start")).text), /\nno playback: just start\nmissing: none\nstep: follow the plan$/);
  const panel = (await dashboard("snapshot?project=brief-just-start", { method: "GET" })).body.agent.brief;
  assert.deepEqual([panel.confirmed, panel.noPlayback], [false, "just start"]);

  // A run no one answers (the one-shot evals): the brief from the request in one call.
  await newProject("brief-one-shot");
  const oneShot = await brief("brief-one-shot", { fields: guessed, no_playback: "no one can answer" });
  assert.match(withoutNext(oneShot.text), /^brief r1 saved: .* · no playback \(no one can answer\) · replies 0 of 10\nmissing: none\nstep: notes set_plan, then build$/);
  assert.equal((await statusLines("brief-one-shot"))[1], "direction: brief r1 (5 guessed), no playback · replies 0/10");
});

test("the brief's length is a gate: check holds the video to it until it is retimed; inspect cuts lists the cuts", async () => {
  await newProject("brief-length", server, 24);
  // A 60 s component scene is not the video: the video is still measured as 24 s.
  await agent("edit", { project: "brief-length", ops: [{ op: "add_scene", properties: { id: "badge", name: "Badge", duration: 60 } }, { op: "create_component", scene: "badge" }] });
  const saved = await brief("brief-length", { fields: { length: 30 } });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /^brief r1 saved: length \(30 s\)/);
  assert.match(saved.text, /\nlength: 30 s \(within 0.6 s\); check holds the video to it\n/);
  assert.match((await brief("brief-length", { fields: { length: "long" } })).text, /length is the video's length in seconds/);
  await brief("brief-length", { fields: { message: { text: "Skate now", by: "guessed" } } });
  // An error, so it blocks a final render like every gate.
  const checked = await agent("check", { project: "brief-length", pixels: false, rules: ["assertions"] });
  assert.match(checked.text, /^next: edit {"ops":\[{"op":"compose","format":"9:16","duration":30,/m, "the first compose takes the brief's length");
  assert.doesNotMatch(checked.text, /^next: .*(headline-reveal|Skate now)/m, "never the message as a text slide");
  assert.doesNotMatch(checked.text, /^next: .*cta-end/m, "no fixed closing recipe");
  assert.match(checked.text, /1 err.*E assertions s1: The video is 24 s, but the brief asks for 30 s \(within 0.6 s\): 6 s too short/s);
  const sceneId = (await agent("status", { project: "brief-length" })).text.match(/\b(s\d+)\b/)[1];
  await agent("edit", { project: "brief-length", ops: [{ op: "retime", scene: sceneId, duration: 30.4 }] });
  const passed = await agent("check", { project: "brief-length", pixels: false, rules: ["assertions"] });
  assert.doesNotMatch(passed.text, /brief asks for/);
  const cuts = await agent("inspect", { project: "brief-length", targets: ["cuts"] });
  assert.match(cuts.text, /\ncuts in s1 \(30.4 s\): 0\nno cuts: the scene has no video or audio clips/);
  if (!hasMediaTools) return;
  // Two real clips of a 0.6 s file back to back from 1 s: three cuts, read from the saved files.
  const file = await makeToneAfterSilence(path.join(server.dataDirectory, "length-tone.wav"), { silence: 0.2, tone: 0.4 });
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": "tone.wav" }, body: await readFile(file) });
  const media = await uploaded.json();
  const { src } = media.media ?? media;
  const clip = (name, mediaStart) => ({ op: "add_layer", scene: sceneId, layerType: "audio", name, properties: { src, mediaStart, mediaSourceDuration: 0.6 } });
  const added = await agent("edit", { project: "brief-length", ops: [clip("voice", 1), clip("fx", 1.6)] });
  assert.equal(added.isError, undefined, added.text);
  const listed = await agent("inspect", { project: "brief-length", targets: ["cuts"] });
  assert.equal(listed.data.cuts, 3, listed.text);
  assert.match(listed.text, /\n1\.6s voice > fx · before not transcribed yet \(check \{pixels:true\} transcribes it\) · after not transcribed yet .* · (dB unknown|[+-]\d+ dB)\n/);
});

// Review round 1: next: reads the plan and the video, not only the brief.
test("next follows the plan and the video: no brief questions on a video begun without one, and only the open question under 8 s", async () => {
  const card = (name) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 10, y: 10, width: 100, height: 100 } });
  // Review round 2: a plan set right after create is still a new video, so the brief comes first.
  await newProject("brief-planned");
  await agent("notes", { project: "brief-planned", action: "set_plan", steps: ["Build", "Check", "Render"] });
  assert.deepEqual((await statusLines("brief-planned")).slice(1, 3), ["direction: no brief · replies 0/10", "step: new video? brief first (library guide direction)"]);
  assert.equal((await brief("brief-planned")).data.next, "new video? brief first (library guide direction)");
  // Layers and a plan, no brief: a video begun before briefs.
  assert.equal((await agent("edit", { project: "brief-planned", ops: [card("title")] })).isError, undefined);
  assert.equal((await statusLines("brief-planned"))[2], "step: follow the plan");
  await newProject("brief-layers");
  const edited = await agent("edit", { project: "brief-layers", ops: [card("card")] });
  assert.equal(edited.isError, undefined, edited.text);
  assert.equal((await statusLines("brief-layers"))[2], "step: a change to this video needs no brief");
  assert.equal((await brief("brief-layers")).data.next, "a change to this video needs no brief");

  await newProject("brief-short", server, 6);
  assert.equal((await statusLines("brief-short"))[2], "step: new video? brief first (library guide direction)", "an empty project is a new video");
  const open = await brief("brief-short", { fields: { message: MESSAGE }, log: [FIRST_QUESTION] });
  assert.match(withoutNext(open.text), /\nstep: guess 4 missing lines$/, "under 8 s only the open question is asked");
  assert.equal((await statusLines("brief-short"))[2], "step: guess 4 missing lines");
  const second = await brief("brief-short", { log: [{ q: "Where does it play?", a: "tiktok" }] });
  assert.match(withoutNext(second.text), /\nquestions: 2 so far; the guide asks at most 1 under 8 s\.$/);
  // The same brief on a 24 s video goes on asking.
  await newProject("brief-long");
  assert.match(withoutNext((await brief("brief-long", { fields: { message: MESSAGE }, log: [FIRST_QUESTION] })).text), /\nstep: ask about look_sound, or guess it$/);
});

// Review round 2: project create without a duration gives the scene 5 s, and the brief comes
// before the length is known, so that 5 s does not make it a short video.
test("a project made without a duration is not an under-8 s video until the agent sets a length", async () => {
  const made = await agent("project", { action: "create", id: "brief-no-length", name: "Brief test" });
  assert.match(withoutNext(made.text), / 1920×1080 5s /, "kino gave the scene its 5 s");
  const open = await brief("brief-no-length", { fields: { message: MESSAGE }, log: [FIRST_QUESTION] });
  assert.match(withoutNext(open.text), /\nstep: ask about look_sound, or guess it$/);
  const where = { q: "Where does it play, and how long?", a: "tiktok, about 24 seconds" };
  const second = await brief("brief-no-length", { fields: { plays_on: { text: "TikTok, 9:16, 24 s", by: "you", quote: where.a } }, log: [where] });
  assert.match(withoutNext(second.text), /\nstep: ask about look_sound, or guess it$/);
  assert.doesNotMatch(withoutNext(second.text), /under 8 s/, "two questions are within the guide's 3");
  assert.equal((await statusLines("brief-no-length"))[2], "step: ask about look_sound, or guess it");
  // A length the agent chose counts, even one under 8 s.
  const retimed = await agent("edit", { project: "brief-no-length", ops: [{ op: "update_scene", properties: { duration: 6 } }] });
  assert.equal(retimed.isError, undefined, retimed.text);
  assert.equal((await statusLines("brief-no-length"))[2], "step: guess 3 missing lines");
  // A project made with a 5 s duration is a 5 s video from the start.
  await newProject("brief-five", server, 5);
  assert.match(withoutNext((await brief("brief-five", { fields: { message: MESSAGE }, log: [FIRST_QUESTION] })).text), /\nstep: guess 4 missing lines$/);
});

// Review round 2: next: names the lines only the person can answer before the ones the request
// often names, so the last question is not spent on footage the request already named.
test("next asks about look and sound and never before where it plays and what it is made from", async () => {
  await newProject("brief-order");
  const steps = [];
  const save = async (body) => {
    const saved = await brief("brief-order", body);
    assert.equal(saved.isError, undefined, saved.text);
    steps.push(saved.data.next);
  };
  await save({ fields: { message: MESSAGE, plays_on: PLAYS_ON }, log: [FIRST_QUESTION] });
  await save({ fields: { look_sound: FULL.look_sound }, log: [{ q: "What should it look and sound like?", a: FULL.look_sound.quote }] });
  await save({ fields: { never: FULL.never }, log: [{ q: "What would make you wince if I got it wrong?", a: FULL.never.quote }] });
  assert.deepEqual(steps, ["ask about look_sound, or guess it", "ask about never, or guess it", "guess 1 missing line"]);
  await newProject("brief-order-2");
  assert.equal((await brief("brief-order-2", { fields: { message: MESSAGE, look_sound: FULL.look_sound, never: FULL.never }, log: [FIRST_QUESTION] })).data.next,
    "ask about plays_on, or guess it", "then where it plays, then what it is made from");
});

// Review round 2: the brief call takes fields, log and no_playback; a misspelled key used to be
// dropped, so the save turned into a read that looked like success.
test("a brief call with a key it does not take is refused over HTTP, the command line and MCP, and saves nothing", async () => {
  await newProject("brief-typo");
  for (const body of [{ field: { never: { text: "x", by: "guessed" } } }, { feilds: { never: { text: "x", by: "guessed" } } }, { text: "no meme text" }]) {
    const refused = await brief("brief-typo", body);
    assert.equal(refused.isError, true, JSON.stringify(body));
    assert.equal(refused.data.error, "bad_input");
    assert.equal(refused.data.reason, `brief takes fields, log and no_playback, not ${Object.keys(body)[0]}; nothing was saved.`);
  }
  assert.deepEqual((await brief("brief-typo", { field: {} })).data.didYouMean.slice(0, 1), ["fields"]);
  assert.equal((await brief("brief-typo")).data.brief, null, "nothing was saved");

  const home = await mkdtemp(path.join(tmpdir(), "kino-brief-typo-"));
  const env = { ...process.env, MOTION_API_URL: server.baseUrl, KINO_OWNER_TOKEN: server.ownerToken, KINO_RUNTIME_FILE: "/nonexistent", HOME: home };
  delete env.KINO_SHARE_TOKEN;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "backend", "mcp.mjs")], env, stderr: "ignore" });
  const client = new Client({ name: "kino-brief-typo-test", version: "1.0.0" });
  try {
    const typed = await runKino(["--project", "brief-typo", "notes", "brief", `feilds=${JSON.stringify({ never: { text: "x", by: "guessed" } })}`], env);
    assert.notEqual(typed.code, 0, `the command line refuses it: ${typed.stdout}`);
    assert.match(`${typed.stdout}${typed.stderr}`, /fields/);
    await client.connect(transport);
    const result = await client.callTool({ name: "notes", arguments: { project: "brief-typo", action: "brief", field: { never: { text: "x", by: "guessed" } } } });
    assert.equal(result.isError, true, `MCP passes the key on and kino refuses it: ${result.content[0].text}`);
    assert.match(result.content[0].text, /not field; nothing was saved/);
    const read = await client.callTool({ name: "notes", arguments: { project: "brief-typo", action: "brief" } });
    assert.match(read.content[0].text, /^No brief yet/);
  } finally {
    await client.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
  assert.equal((await brief("brief-typo")).data.brief, null, "nothing was saved");
});

// Review round 2: the answer's data carried the whole reply log (100 replies of up to 2,000
// characters), so a --json answer could pass the 8k-token limit.
test("the JSON answer of a brief save or read stays small with 10 long replies and with 100 logged", async () => {
  await newProject("brief-json");
  const long = (index) => `reply ${index}: ${"we skate every evening by the river and the light is gold ".repeat(40)}`.slice(0, BRIEF_LIMITS.a);
  let saved;
  for (let index = 0; index < 10; index += 1) saved = await brief("brief-json", { log: [{ q: "Tell me more?", a: long(index) }] });
  assert.equal(saved.data.replies.count, 10);
  const size = (answer) => estimateTextTokens(JSON.stringify(answer));
  assert.ok(size(saved) < 1000, `the 10th save is about ${size(saved)} tokens as JSON`);
  for (let index = 10; index < BRIEF_LIMITS.logKept; index += 4) await brief("brief-json", { log: Array.from({ length: 4 }, (_, offset) => ({ q: "More?", a: long(index + offset) })) });
  const read = await brief("brief-json");
  assert.equal(read.data.replies.count, BRIEF_LIMITS.logKept);
  assert.ok(size(read) < 1000, `a read with ${BRIEF_LIMITS.logKept} long replies logged is about ${size(read)} tokens as JSON`);
  assert.equal((await savedState("brief-json")).brief.log.length, BRIEF_LIMITS.logKept, "the log is kept in the file");
});

// Review round 2: a read that landed while remove() deleted the files put the old state back in
// memory, and the next update wrote the deleted brief to disk again.
test("a read while a project's agent state is deleted keeps nothing of it, so no update writes it back", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-brief-remove-"));
  const file = path.join(folder, "agent", "projects", "p.json");
  try {
    for (let round = 0; round < 40; round += 1) {
      // Even rounds: the state is in memory when the delete starts; odd rounds: a new store that
      // reads it from the file.
      let store = createAgentStateStore(folder);
      await store.update("p", (state) => { state.brief = { ...emptyBrief(), rev: 1, fields: { never: { text: "x", by: "you", quote: "secret words" } } }; });
      if (round % 2) store = createAgentStateStore(folder);
      const reads = [];
      let reading = true;
      const read = () => { if (!reading) return; reads.push(store.read("p")); setImmediate(read); };
      read();
      await store.remove("p");
      reading = false;
      await Promise.all(reads);
      await assert.rejects(access(file), { code: "ENOENT" });
      assert.equal((await store.read("p")).brief, null, `round ${round}: the deleted brief is not in memory`);
      await store.update("p", (state) => { state.inbox.push({ kind: "approval", text: "Q1 allowed" }); });
      assert.doesNotMatch(await readFile(file, "utf8"), /secret words/, `round ${round}: no update wrote it back`);
      await store.remove("p");
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// Review round 1: a long reply dictated on a phone is logged whole, so the count stays right.
test("a long dictated reply is logged word for word and counted", async () => {
  await newProject("brief-long-reply");
  const reply = `${"my skate crew, they should feel like going out to skate, and honestly ".repeat(8)}that's it`.trim();
  assert.ok(reply.length > 500, `${reply.length} characters`);
  const saved = await brief("brief-long-reply", { log: [{ q: FIRST_QUESTION.q, a: reply }] });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal((await savedState("brief-long-reply")).brief.log[0].a, reply);
  assert.equal(saved.data.replies.count, 1);
});

// Review round 1: a project deleted forever takes its agent state with it.
test("deleting a project forever deletes its brief; a new project with the same id starts with none", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-brief-delete-"));
  let local;
  try {
    local = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    await newProject("dz", local);
    await brief("dz", { fields: { never: { text: "no meme text", by: "you", quote: "no meme text please, my mum watches" } }, log: [{ q: "What would make you wince?", a: "no meme text please, my mum watches" }] }, local);
    const file = path.join(folder, "agent", "projects", "dz.json");
    await access(file);
    assert.equal((await local.api("/api/projects/dz", { method: "DELETE" })).status, 200);
    const gone = await local.api("/api/projects/dz/permanent", { method: "DELETE", body: { confirm: true } });
    assert.equal(gone.status, 200, await gone.text());
    await assert.rejects(access(file), { code: "ENOENT" }, "the agent state file is deleted");
    await assert.rejects(access(path.join(folder, "agent", "projects", "dz.events.jsonl")), { code: "ENOENT" }, "and its event log");

    await newProject("dz", local);
    assert.equal((await statusLines("dz", local))[1], "direction: no brief · replies 0/10");
    const read = await brief("dz", {}, local);
    assert.equal(read.data.brief, null);
    assert.doesNotMatch(withoutNext(read.text), /mum/);
    const guess = await brief("dz", { fields: { never: { text: "no captions", by: "guessed" } } }, local);
    assert.equal(guess.isError, undefined, "the old person's line no longer blocks a guess");

    // The agent's own way: project archive, then project manage trash delete, each allowed by
    // the person in the dashboard.
    await access(file);
    const { key: localKey } = await (await local.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: local.baseUrl } })).json();
    const allowed = async (reply) => {
      if (reply.data?.status !== "awaiting_approval") return reply;
      const answer = await local.api(`/api/dashboard/approvals/${reply.data.id}`, { method: "POST", headers: { "x-kino-review": localKey }, body: { decision: "allow" } });
      return (await answer.json()).approval.result;
    };
    const archived = await allowed(await agent("project", { action: "archive", id: "dz" }, local));
    assert.ok(!archived.isError, archived.text);
    const deleted = await allowed(await agent("project", { action: "manage", options: { resource: "trash", action: "delete", id: "dz", confirm: true } }, local));
    assert.ok(!deleted.isError, deleted.text);
    assert.equal((await local.api("/api/projects/dz")).status, 404, "the project is gone");
    // The approval's answer is still told to the asking agent (an inbox line about the delete),
    // so a file may be written again after the delete; none of the brief is in it.
    const left = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
    assert.equal(left.brief ?? null, null, "the brief is deleted with the project");
    assert.doesNotMatch(JSON.stringify(left), /mum|meme/, "none of the person's words are left");
  } finally {
    await local?.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("each logged reply counts; past 3 questions and at 10 replies the answers say so, and nothing is refused", async () => {
  await newProject("brief-count");
  const asked = [
    { q: "Who's it for, and what should they feel after watching?", a: "my skate crew" },
    { q: "What should it look and sound like?", a: "raw and bright" },
    { q: "What would make you wince if I got it wrong?", a: "meme text" },
  ];
  await brief("brief-count", { log: asked });
  assert.deepEqual((await statusLines("brief-count")).slice(1, 3), ["direction: no brief lines · replies 3/10", "step: guess 5 missing lines"]);
  await brief("brief-count", { fields: FULL });
  const four = await brief("brief-count", { log: [PLAYBACK_YES(1)] });
  assert.match(withoutNext(four.text), /replies 4 of 10/);
  assert.equal((await statusLines("brief-count"))[1], "direction: brief r1 (2 guessed), confirmed · replies 4/10");
  const fifth = await brief("brief-count", { log: [{ q: "Anything else?", a: "no" }] });
  assert.match(withoutNext(fifth.text), /\nquestions: 4 so far; the guide asks at most 3\.$/);
  await brief("brief-count", { fields: { plays_on: { text: "TikTok, 9:16, 20 s", by: "guessed" } }, log: [{ q: "a?", a: "b" }, { q: "c?", a: "d" }, { q: "e?", a: "f" }, { q: "g?", a: "h" }] });
  const tenth = await brief("brief-count", { log: [{ q: "i?", a: "j" }] });
  assert.equal(tenth.isError, undefined, "B1 refuses nothing at the limit");
  assert.equal(tenth.data.replies.count, REPLY_LIMIT);
  assert.match(withoutNext(tenth.text), /\nreplies: 10 of 10; make the remaining calls yourself and say "my call"\.$/);
  assert.deepEqual((await statusLines("brief-count")).slice(1, 3), ["direction: brief r2 (2 guessed), unconfirmed · replies 10/10", "step: out of replies: set_plan, build"]);
  const eleventh = await brief("brief-count", { log: [{ q: "k?", a: "l" }] });
  assert.equal(eleventh.isError, undefined);
  assert.equal(eleventh.data.replies.count, 11);
});

test("turn revert and dashboard undo leave the brief as it was", async () => {
  await newProject("brief-revert");
  const edited = await agent("edit", { project: "brief-revert", ops: [{ op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 10, y: 10, width: 100, height: 100 } }] });
  assert.equal(edited.isError, undefined, edited.text);
  await brief("brief-revert", { fields: { message: MESSAGE }, log: [FIRST_QUESTION] });
  const before = (await brief("brief-revert")).data.brief;
  const reverted = await agent("history", { project: "brief-revert", action: "revert", turn: edited.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.deepEqual((await brief("brief-revert")).data.brief, before, "history revert left the brief alone");

  const again = await agent("edit", { project: "brief-revert", ops: [...ORDER_WAIVERS, { op: "add_layer", layerType: "rectangle", name: "card2", properties: { x: 10, y: 10, width: 100, height: 100 } }] });
  assert.notEqual(again.data.turn, edited.data.turn);
  await brief("brief-revert", { fields: { plays_on: PLAYS_ON } });
  const saved = (await brief("brief-revert")).data.brief;
  assert.equal(saved.rev, 2);
  const undone = await dashboard("undo", { body: { project: "brief-revert", turn: again.data.turn } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.reverted.length, 1);
  assert.deepEqual((await brief("brief-revert")).data.brief, saved, "dashboard undo left the brief alone");
});

test("two agents saving at once keep both lines and both replies; one cannot guess over the other's you line", async () => {
  await newProject("brief-two");
  const [first, second] = await Promise.all([
    brief("brief-two", { client: "claude-a", fields: { message: MESSAGE }, log: [FIRST_QUESTION] }),
    brief("brief-two", { client: "codex-b", fields: { plays_on: PLAYS_ON }, log: [{ q: "Where does it play?", a: "tiktok" }] }),
  ]);
  assert.equal(first.isError, undefined, first.text);
  assert.equal(second.isError, undefined, second.text);
  const read = (await brief("brief-two")).data;
  assert.equal(read.brief.rev, 2);
  assert.equal(read.brief.fields.message.client, "claude-a");
  assert.equal(read.brief.fields.plays_on.client, "codex-b");
  assert.deepEqual((await savedState("brief-two")).brief.log.map((entry) => entry.client).sort(), ["claude-a", "codex-b"]);
  const guess = await brief("brief-two", { client: "codex-b", fields: { message: { text: "skaters", by: "guessed" } } });
  assert.equal(guess.data.error, "yours");
});

test("the dashboard and kino --you read the brief but cannot save it; a hold does not stop a save", async () => {
  await newProject("brief-you");
  const chatOnly = "The brief comes from the person's chat with their agent; the dashboard shows it read only. Tell your agent what to change.";
  const fromYou = await brief("brief-you", { by: "you", fields: { message: MESSAGE } });
  assert.equal(fromYou.data.error, "chat_only");
  assert.equal(fromYou.data.reason, chatOnly);
  const act = await dashboard("act/notes", { body: { project: "brief-you", action: "brief", log: [FIRST_QUESTION] } });
  assert.equal(act.status, 200);
  assert.equal(act.body.data.error, "chat_only");
  assert.equal((await brief("brief-you", { by: "you" })).isError, undefined, "a read by you works");
  assert.equal((await dashboard("act/notes", { body: { project: "brief-you", action: "brief" } })).body.data.brief, null);

  await dashboard("hold", { body: { on: true } });
  try {
    const held = await brief("brief-you", { fields: { message: MESSAGE } });
    assert.equal(held.isError, undefined, held.text);
    assert.equal(held.data.brief.rev, 1, "a brief save changes no frame, so a hold lets it through");
  } finally {
    await dashboard("hold", { body: { on: false } });
  }

  // The command line: kino notes brief reads, fields='{…}' saves, --you is refused.
  const home = await mkdtemp(path.join(tmpdir(), "kino-brief-home-"));
  try {
    const env = { ...process.env, MOTION_API_URL: server.baseUrl, KINO_OWNER_TOKEN: server.ownerToken, KINO_RUNTIME_FILE: "/nonexistent", HOME: home };
    delete env.KINO_SHARE_TOKEN;
    const read = await runKino(["--project", "brief-you", "notes", "brief"], env);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /^brief r1, unconfirmed · replies 0 of 10/);
    const save = await runKino(["--project", "brief-you", "notes", "brief", `fields=${JSON.stringify({ plays_on: PLAYS_ON })}`, `log=${JSON.stringify([{ q: "Where?", a: "tiktok" }])}`], env);
    assert.equal(save.code, 0, save.stderr);
    assert.match(save.stdout, /^brief r2 saved: plays_on \(guessed\) · 1 reply logged \(question\) · replies 1 of 10/);
    const yours = await runKino(["--you", "--project", "brief-you", "notes", "brief", `fields=${JSON.stringify({ plays_on: null })}`], env);
    assert.equal(yours.code, 1);
    assert.match(`${yours.stdout}${yours.stderr}`, /chat_only/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function runKino(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "bin", "kino.mjs"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Reads the dashboard's event stream from `since` until an event matches, or the time runs out.
async function firstEvent(query, wanted, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await server.api(`/api/dashboard/stream${query}`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data:"));
        buffer = buffer.slice(end + 2);
        if (data && wanted(JSON.parse(data.slice(5)))) return JSON.parse(data.slice(5));
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return null;
}

test("the dashboard snapshot and each call event carry the brief, read only", async () => {
  await newProject("brief-panel");
  assert.equal((await dashboard("snapshot?project=brief-panel", { method: "GET" })).body.agent.brief, null);
  const { boot, seq } = (await dashboard("snapshot?project=brief-panel", { method: "GET" })).body;
  await brief("brief-panel", { fields: { message: MESSAGE, plays_on: PLAYS_ON }, log: [FIRST_QUESTION] });
  const expected = {
    rev: 1, confirmed: false, noPlayback: null,
    lines: [{ name: "message", text: MESSAGE.text, by: "you", quote: MESSAGE.quote }, { name: "plays_on", text: PLAYS_ON.text, by: "guessed" }],
    missing: ["made_from", "look_sound", "never"],
    replies: { count: 1, limit: 10 },
  };
  const { savedAt, ...summary } = (await dashboard("snapshot?project=brief-panel", { method: "GET" })).body.agent.brief;
  assert.match(savedAt, /^\d{4}-/);
  assert.deepEqual(summary, expected);
  const event = await firstEvent(`?since=${seq}&boot=${boot}`, (entry) => entry.type === "call" && entry.projectId === "brief-panel" && entry.event?.verb === "notes");
  assert.ok(event, "a call event followed the save");
  const { savedAt: eventSavedAt, ...live } = event.agent.brief;
  assert.equal(eventSavedAt, savedAt);
  assert.deepEqual(live, expected, "the call event's agent data has the saved brief");
});

test("a restart keeps the brief, the status lines and the dashboard's brief", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-brief-restart-"));
  let first;
  let second;
  try {
    first = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    await newProject("brief-restart", first);
    await brief("brief-restart", { fields: FULL, log: [FIRST_QUESTION] }, first);
    await brief("brief-restart", { log: [PLAYBACK_YES(1)] }, first);
    const read = await brief("brief-restart", {}, first);
    const lines = (await statusLines("brief-restart", first)).slice(1, 3);
    const snapshot = (await (await first.api("/api/dashboard/snapshot?project=brief-restart")).json()).agent.brief;
    await first.stop();
    first = null;
    second = await startTestServer({ env: { MOTION_DATA_DIR: folder } });
    const again = await brief("brief-restart", {}, second);
    assert.equal(withoutNext(again.text), withoutNext(read.text));
    assert.deepEqual(again.data, read.data);
    assert.deepEqual((await statusLines("brief-restart", second)).slice(1, 3), lines);
    assert.deepEqual(lines, ["direction: brief r1 (2 guessed), confirmed · replies 2/10", "step: notes set_plan, build, then ask rough"]);
    assert.deepEqual((await (await second.api("/api/dashboard/snapshot?project=brief-restart")).json()).agent.brief, snapshot);
  } finally {
    await first?.stop();
    await second?.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

// Plan §4 and §12: the direction and next lines are at most 40 tokens (kino's estimate,
// backend/meter.mjs) in every state. The plan also sets the notes brief read at 300 tokens, 120 of
// them kept for the style part B10a adds. Since B2c a line the person said reads back as their
// quote only (it was about 250 tokens typical, 630 at the limits). Quotes
// copied word for word still do not always fit: the read below is measured against the plan's
// 300 and its overrun is flagged in COMPATIBILITY.md ("Brief from the chat"), not hidden behind
// a looser limit.
test("the two status lines fit in 40 tokens in every state; the brief read is measured against the plan's 300", async () => {
  await newProject("brief-size");
  await brief("brief-size", { fields: FULL, log: [FIRST_QUESTION, { q: "What should it look and sound like?", a: FULL.look_sound.quote }, { q: "What would make you wince if I got it wrong?", a: FULL.never.quote }] });
  const fixture = await brief("brief-size");
  const typical = estimateTextTokens(fixture.text);
  assert.ok(typical <= 300, `the read of a 24 s TikTok brief is about ${typical} tokens (the plan's limit is 300)`);

  // Every line at its longest: over the plan's 300 (flagged); this bound only stops it growing.
  // The optional idea line (2026-10-25) added one line of about 52 tokens.
  const longest = { ...emptyBrief(), rev: 99, noPlayback: { reason: "r".repeat(BRIEF_LIMITS.reason) },
    fields: Object.fromEntries(BRIEF_FIELDS.map((name) => [name, { text: "t".repeat(BRIEF_LIMITS.text), by: "you", quote: "q".repeat(BRIEF_LIMITS.quote) }])),
    log: Array.from({ length: BRIEF_LIMITS.logKept }, () => ({ q: "q?", a: "a", kind: "question" })) };
  const most = estimateTextTokens(briefText({ brief: longest }));
  assert.ok(most <= 490, `the read with every line at its limit is about ${most} tokens (the plan's limit is 300; flagged)`);
  console.log(`brief read: about ${typical} tokens for the 24 s TikTok brief, ${most} with every line at its limit (plan: 300, style part 120)`);

  // The direction and next lines, over every kind of state: revisions to 99, every mix of
  // saved and guessed lines, 0 to 100 replies (the log keeps 100), unconfirmed, confirmed, no
  // playback or a playback answered with a correction, with a plan or not, on an empty 24 s
  // video, a 6 s one and one with layers.
  let widest = "";
  for (const rev of [0, 1, 9, 10, 99]) for (let mask = 0; mask < 2 ** BRIEF_FIELDS.length; mask += 1) for (const guessed of [false, true])
    for (const count of [0, 1, 2, 3, 9, 10, 11, 99, 100]) for (const playbacks of [0, 1]) for (const settled of ["no", "confirmed", "no playback", "corrected"])
      for (const steps of [[], [{ text: "Build", done: false }]]) for (const video of [{ seconds: 24, layers: 0 }, { seconds: 6, layers: 0 }, { seconds: 24, layers: 3 }, { seconds: 24, layers: 0, references: 0 }, { seconds: 24, layers: 0, references: 1 }, { seconds: 24, layers: 0, references: 2, needs: { checked: false } }]) {
        if (playbacks > count) continue;
        const fields = rev ? Object.fromEntries(BRIEF_FIELDS.filter((name, index) => mask & (1 << index)).map((name) => [name, { text: "t", by: guessed ? "guessed" : "you", quote: guessed ? undefined : "q" }])) : {};
        const log = Array.from({ length: count }, (_, index) => ({ q: "q?", a: "a", kind: index >= count - playbacks ? "playback" : "question", rev, confirmed: false }));
        const state = { brief: { ...emptyBrief(), rev, fields, log, confirmedRev: settled === "confirmed" ? rev : null, noPlayback: settled === "no playback" ? { reason: "just start" } : null }, plan: { steps } };
        const text = directionLines(state, video).join("\n");
        if (text.length > widest.length) widest = text;
      }
  assert.ok(estimateTextTokens(widest) <= 40, `the widest direction and next lines are about ${estimateTextTokens(widest)} tokens (limit 40):\n${widest}`);
  for (const plan of [undefined, { steps: [{ text: "Build" }] }]) assert.ok(estimateTextTokens(directionLines({ brief: null, plan }).join("\n")) <= 40);
});

test("the reference step: before the plan, until 2 references are saved; not when waived or under 5 s; then the needs step", () => {
  const state = { brief: { ...emptyBrief(), rev: 1, fields: FULL, log: [PLAYBACK_YES(1)], confirmedRev: 1 } };
  const step = (video) => nextMove(state, { seconds: 24, layers: 0, treatmentsWaived: true, ...video }).step;
  assert.equal(step({ references: 1 }), "find 1 more reference (inspire)");
  for (const video of [{ references: 2 }, { references: 0, referenceWaived: true }, { references: 0, seconds: 3 }, {}]) assert.equal(step(video), "notes set_plan, then build", JSON.stringify(video));
  // Then the material against the story (notes needs), when the video has footage or speech.
  assert.equal(step({ references: 1, needs: { checked: false } }), "find 1 more reference (inspire)");
  const needs = nextMove({ ...state, plan: { steps: [{ text: "Build" }] } }, { seconds: 24, layers: 3, references: 2, needs: { checked: false }, treatmentsWaived: true });
  assert.deepEqual([needs.step, needs.call.input.action], ["check material: notes needs", "needs"]);
  assert.equal(step({ references: 2, needs: { checked: true } }), "notes set_plan, then build");
  // Past a rough first pass (30 layers), the direction is locked first. With no idea, the lock
  // asks for the idea and its signature from the material: no template spine stands in for it.
  const lock = nextMove(state, { seconds: 24, layers: 31, references: 2, treatmentsWaived: true });
  assert.match(lock.step, /^lock direction: idea \+ signature/);
  assert.deepEqual(Object.keys(lock.call.input.fields.style), ["idea", "signatures", "by"]);
  // With the idea, a spine around it and a style bible; deck cards are drafted as dealt moves.
  const withIdea = { ...state, brief: { ...state.brief, fields: { ...state.brief.fields, idea: { text: "the phone guides him by sound", by: "guessed" } } }, deck: { cards: [{ tag: "parallax" }] } };
  const drafted = nextMove(withIdea, { seconds: 24, layers: 31, references: 2, treatmentsWaived: true });
  assert.match(drafted.step, /^lock direction: spine \+ style bible/);
  assert.deepEqual(Object.keys(drafted.call.input.fields.style).filter((key) => ["spine", "fonts", "moves", "waived"].includes(key)), ["spine", "fonts", "moves"], "the draft asks the person: no drafted waiver");
  assert.deepEqual([drafted.call.input.fields.style.avoids, drafted.call.input.fields.style.sources], [undefined, { moves: "dealt" }], "no drafted bans; deck moves stay dealt");
  // Guessed bans go to the board stop as a question; the person's own are not asked again.
  const guessed = { fields: { never: { text: "an invented dashboard over the real UI", by: "guessed" } }, style: { avoids: ["flash"], by: "guessed" } };
  assert.deepEqual(guessedBans(guessed), ["never: an invented dashboard over the real UI", "avoids: flash"]);
  assert.deepEqual(guessedBans({ fields: { never: { text: "no meme text", by: "you", quote: "no meme text" } }, style: { avoids: ["flash"], by: "you", quote: "no flashes" } }), []);
  assert.deepEqual(guessedBans({ fields: { never: { text: "None said.", by: "guessed" } } }), [], "no ban said is not a ban to ask about");
  assert.equal(step({ layers: 30, references: 2, treatmentsWaived: true }), "notes set_plan, then build", "a rough pass goes ahead");
  const bible = { wants: [], avoids: ["flash"], lines: [], by: "guessed", spine: [{ role: "hook", from: 0, to: 3, purpose: "the verdict" }], fonts: { caption: { family: "Inter", size: 48 } } };
  const asked = nextMove({ ...state, brief: { ...state.brief, style: bible } }, { seconds: 24, layers: 31, references: 2, treatmentsWaived: true });
  assert.deepEqual([asked.step, asked.call.input.fields.style.by], ["play spine + style bible back; save their approval (no one watching: style {waived:\"<why>\"} instead)", "you"]);
  for (const approved of [{ by: "you", quote: "yes, that story" }, { waived: "no one is watching: a batch render" }])
    assert.equal(nextMove({ ...state, brief: { ...state.brief, style: { ...bible, ...approved } } }, { seconds: 24, layers: 31, references: 2, treatmentsWaived: true }).step, "notes set_plan, then build");
  // The approval backs the guessed wants the person was shown, but avoids copied from another
  // project's brief and dealt moves keep their source, so they stay questions and never block.
  const remake = { brief: emptyBrief() };
  applyBrief(remake, briefChanges(remake.brief, { fields: { style: { ...bible, wants: ["dissolve"], avoids: ["beat-kick", "flash", "fade-black"], sources: { avoids: "copied", moves: "dealt" }, moves: [{ tag: "parallax", where: "every walk" }] } } }));
  applyBrief(remake, briefChanges(remake.brief, { fields: { style: { ...asked.call.input.fields.style, quote: "approve as written" } } }));
  const approvedStyle = styleContext(remake.brief.style);
  assert.deepEqual([remake.brief.style.by, remake.brief.style.sources, approvedStyle.avoidsBacked, approvedStyle.backed], ["you", { avoids: "copied", moves: "dealt" }, false, ["dissolve"]]);
  assert.deepEqual(guessedBans(remake.brief), ["avoids: beat-kick, flash, fade-black"]);
  // The person's own answer about the avoids makes them theirs.
  applyBrief(remake, briefChanges(remake.brief, { fields: { style: { by: "you", quote: "no flashes, ever", sources: { avoids: "you" } } } }));
  assert.equal(styleContext(remake.brief.style).avoidsBacked, true);
});

// A measured reference with one frame strip, kept where kino keeps them (no download), saved.
async function savedReference(project, name, key = null) {
  const folder = path.join(server.dataDirectory, "inspire");
  await mkdir(path.join(folder, "strips", name), { recursive: true });
  const strip = createCanvas(240, 135);
  strip.getContext("2d").fillRect(0, 0, 240, 135);
  await writeFile(path.join(folder, "strips", name, "1.jpg"), strip.toBuffer("image/jpeg"));
  await writeFile(path.join(folder, `${name}.json`), JSON.stringify({ id: `yt:${name}`, title: name, state: "measured", version: 2, seconds: 9, strips: [{ at: 1, file: "1.jpg", kinds: ["cut"] }] }));
  const saved = await agent("library", { project, topic: "inspire", name: `save yt:${name}${key ? ` as ${key}` : ""}` });
  assert.equal(saved.isError, undefined, saved.text);
  if (key) assert.equal(saved.data.key, key, "save ... as <key> names it for a board move.ref");
}

test("idea first: a briefed video builds only after 2 references (one studied), 5 treatments, a pick and its signature", async () => {
  const id = "order-walk";
  const made = await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 12 });
  assert.doesNotMatch(made.text, /Building blocks|logo-sting/, "create offers no template menu");
  assert.match(made.text, /\nnext: notes \{"action":"brief"/, "its next is the brief");
  await brief(id, { fields: FULL, no_playback: "just start" });
  const compose = { project: id, ops: [{ op: "compose", duration: 12, beats: [{ recipe: "headline-reveal", text: "Skate now" }, { recipe: "cta-end", text: "Go skate" }] }] };
  const refused = async (step, call) => {
    const reply = await agent("edit", compose);
    assert.equal(reply.data.error, "order_needed", reply.text);
    assert.match(reply.data.reason, new RegExp(`Next: ${step}`));
    if (call) assert.deepEqual(nextCallOf(reply), call);
    return nextCallOf(reply);
  };
  await refused("find 2 references", { tool: "library", input: { topic: "inspire", search: "<an edit like yours>" } });
  // The first refusal names every gate still open, not only the next.
  assert.match((await agent("edit", compose)).data.reason, /Then: study a reference \(look\); write 5 treatments\.$/);
  // One picture layer is building too.
  const picture = await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "rectangle", name: "card" }] });
  assert.equal(picture.data.error, "order_needed", picture.text);
  await savedReference(id, "kinoOrder01");
  await savedReference(id, "kinoOrder02", "order-two");
  await refused("study a reference", { tool: "look", input: { mode: "reference", ref: "yt:kinoOrder01" } });
  const studied = await agent("look", { project: id, mode: "reference", ref: "yt:kinoOrder01" });
  assert.equal(studied.isError, undefined, studied.text);
  await refused("write 5 treatments");
  const treatments = ["the kickflip seen from the board", "one trick, five streets", "the crew's group chat lights up", "dawn to dusk in one line", "the wheels' sound leads"]
    .map((idea, index) => ({ idea, move: `move ${index}`, rhythm: "slow build, fast end", p: [0.6, 0.3, 0.2, 0.1, 0.05][index] }));
  assert.equal((await brief(id, { fields: { treatments } })).isError, undefined);
  await refused("ask their treatment pick", { tool: "notes", input: { action: "brief", fields: { treatments: { pick: "<A, B or C>", quote: "<their words>" } } } });
  // The pick's idea becomes style.idea; its move is offered as the first signature.
  const picked = await brief(id, { fields: { treatments: { pick: "A", quote: "the wheels one" } } });
  assert.equal(picked.data.brief.style.idea, "the wheels' sound leads");
  const offer = await refused("save the signature");
  assert.deepEqual(offer.input.fields.style.signatures[0].what, "move 4");
  // A pick whose source names no picture asks for one, and the draft offers the project's own.
  assert.match(picked.text, /source is words only: build the signature from the product's own picture/);
  assert.equal(offer.input.fields.style.signatures[0].source, "<a screenshot or clip of the product, and the moment>");
  assert.deepEqual(["the tagline", "the founder's voice memo", "app.png"].map(wordsOnly), [true, false, false]);
  const state = { brief: (await brief(id, {})).data.brief };
  assert.equal(orderStep(state, { seconds: 24, treatmentsWaived: false, picture: "inbox.png" }).call.input.fields.style.signatures[0].source, "inbox.png, <the moment>");
  const signature = { beat: 0, what: "move 4", source: "skate.mp4, the wheels at 0:03", why: "only this crew's sound" };
  const confirmed = await brief(id, { fields: { style: { signatures: [signature] } } });
  assert.equal(confirmed.isError, undefined, confirmed.text);
  const built = await agent("edit", compose);
  assert.equal(built.isError, undefined, built.text);
  assert.equal(built.data.rev, 2, "the refused edits saved nothing");
});

test("a waived order builds at once, and references saved after the first build do not pass the final render", async () => {
  const id = "order-late";
  await agent("project", { action: "create", id, name: id, width: 640, height: 360, duration: 6 });
  await brief(id, { fields: FULL, no_playback: "just start" });
  const waivers = [{ op: "waive_check", code: "reference", target: "*", reason: "a test" }, { op: "waive_check", code: "treatments", target: "*", reason: "a test" }, { op: "waive_check", code: "review", target: "*", reason: "a test" }];
  const built = await agent("edit", { project: id, ops: [...waivers, { op: "add_layer", layerType: "rectangle", name: "card", properties: { width: 200, height: 100, fill: "#336699" } }] });
  assert.equal(built.isError, undefined, built.text);
  await agent("edit", { project: id, ops: [{ op: "unwaive_check", code: "reference", target: "*" }, { op: "unwaive_check", code: "treatments", target: "*" }] });
  // Only the first build waits: a built video (one made before this order, say) takes more.
  const more = await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "rectangle", name: "card2", properties: { width: 100, height: 50 } }] });
  assert.equal(more.isError, undefined, more.text);
  await savedReference(id, "kinoOrder03");
  const render = await agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  assert.equal(render.data.error, "reference_needed", render.text);
  assert.match(render.data.reason, /^References saved after building do not count/);
});

test("a brief save names every problem of the call at once: lines and log replies", () => {
  const long = "x".repeat(BRIEF_LIMITS.quote + 4);
  assert.throws(() => briefChanges(emptyBrief(), { fields: {
    made_from: { text: "y".repeat(BRIEF_LIMITS.text + 5), by: "guessed" },
    never: { text: "no meme text", by: "you", quote: long },
  }, log: [{ q: "ok?", a: "yes", quote: "yes", about: "end" }, { q: "ok?", a: "yes", confirmed: true }] }), (error) => {
    assert.match(error.message, /^made_from\.text is .* Also: never\.quote is .* log\[0\] takes q, a, kind, rev and confirmed, not quote, about\. log\[1\]: rev and confirmed go with kind:"playback".*\(5 problems; nothing was saved\.\)$/s);
    return true;
  });
});

test("words a lead passed on (kind passed_on) are logged but use no reply or question", () => {
  const state = { brief: emptyBrief() };
  applyBrief(state, briefChanges(state.brief, { log: [{ a: "It's for my mom", kind: "passed_on" }, { q: "Who is it for?", a: "skaters" }] }));
  assert.equal(state.brief.log.length, 2);
  assert.deepEqual([replyCount(state).count, replyCount(state).questions], [1, 1]);
});

test("a rejected reply joins style.rejected and is not counted as a question", () => {
  const state = { brief: emptyBrief() };
  const changes = briefChanges(state.brief, { log: [{ a: "Seven open-weight models.", kind: "rejected" }, { q: "Who is it for?", a: "skaters" }] });
  applyBrief(state, changes);
  assert.deepEqual(state.brief.style.rejected, ["Seven open-weight models."]);
  assert.deepEqual([replyCount(state).count, replyCount(state).questions], [2, 1]);
  // A style sent in the same call keeps it, and merges: the older rejected text stays too.
  applyBrief(state, briefChanges(state.brief, { fields: { style: { wants: ["flash"], by: "guessed" } }, log: [{ a: "Ten tools.", kind: "rejected" }] }));
  assert.deepEqual(state.brief.style.rejected, ["Seven open-weight models.", "Ten tools."]);
  // The list keeps the newest 12, and the answer names a text it pushed out.
  applyBrief(state, briefChanges(state.brief, { fields: { style: { rejected: Array.from({ length: 12 }, (unused, index) => `line ${index}`), by: "guessed" } } }));
  const more = briefChanges(state.brief, { log: [{ a: "One more.", kind: "rejected" }] });
  applyBrief(state, more);
  assert.equal(state.brief.style.rejected.length, 12);
  assert.match(savedText(state, more), /style\.rejected keeps the newest 12; dropped: "line 0"/);
});
