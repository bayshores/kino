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
import { aboutWords, applyBrief, aspectLabel, BRIEF_FIELDS, BRIEF_LIMITS, briefChanges, briefData, briefText, isSaid, directionLines, emptyBrief, guessedBans, nextMove, orderStep, orderSteps, namedThings, PLAN_CALL, realEdit, referenceSearches, shapeLine, songTitleOf, REPLY_LIMIT, replyCount, savedText } from "./agent/brief.mjs";
import { namedShape, shapeGuess } from "../engine/quality/rules/shape.js";
import { createAgentStateStore } from "./agent/state.mjs";
import { styleContext } from "../engine/styleSpec.js";
import { originLine, pickLines, wordsOnly } from "./agent/treatments.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { hasMediaTools, makeToneAfterSilence, nextCallOf, startTestServer, withoutNext } from "./media.test.support.mjs";
import { ASK_TEXT, serviceFor, withAsk } from "./agent-ask.test.support.mjs";
import { skipBoardOn } from "./stops.test.support.mjs";
import { createDocument, createLayer, createScene } from "../engine/model.js";

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
// A project's first brief save with lines carries the person's message and what the video is about
// (kino checks every quote against the message, and wants both before the brief is complete);
// `ask: false` on newProject leaves them out for the tests about their absence.
const askSent = new Set();
const askKey = (project, on = server) => `${on.dataDirectory}/${project}`;
async function newProject(id, on = server, duration = 24, { references = false, ask = true } = {}) {
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration }, on);
  assert.equal(made.isError, undefined, made.text);
  if (!references) await agent("edit", { project: id, ops: ORDER_WAIVERS }, on);
  if (ask) askSent.delete(askKey(id, on)); else askSent.add(askKey(id, on));
}

function withMessage(project, body = {}, on) {
  if (!body.fields || askSent.has(askKey(project, on))) return body;
  askSent.add(askKey(project, on));
  return { ...body, fields: { ask: ASK_TEXT, about: ABOUT, ...body.fields } };
}
const brief = (project, body, on) => agent("notes", { project, action: "brief", ...withMessage(project, body, on) }, on);
const statusLines = async (project, on) => (await agent("status", { project }, on)).text.split("\n");
// The project's agent-state file, where the reply log is kept (answers leave it out).
const savedState = async (project, on = server) => JSON.parse(await readFile(path.join(on.dataDirectory, "agent", "projects", `${project}.json`), "utf8"));

const MESSAGE = { text: "skate crew; make them want to skate now", by: "you", quote: "my skate crew, they should feel like going out to skate" };
const ABOUT = { text: "the skate crew", by: "you", quote: "my skate crew" };
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
  assert.equal(withoutNext(empty.text), 'No brief yet · replies 0 of 10. Ask in the chat (library guide direction), then save: notes {action:"brief", fields:{ask:"<their message, pasted whole>", message:{text, by:"you", quote}}, log:[{q, a}]}.\nmissing: ask, message, plays_on, made_from, look_sound, never');
  assert.deepEqual(empty.data, { brief: null, missing: ["ask", "message", "plays_on", "made_from", "look_sound", "never"],
    replies: { count: 0, limit: 10, questions: 0, playbacks: 0, stops: 0 }, next: "new video? brief first (library guide direction)" });
  const before = await statusLines("brief-read");
  assert.deepEqual(before.slice(1, 3), ["direction: no brief · replies 0/10", "step: new video? brief first (library guide direction)"]);

  const saved = await brief("brief-read", { fields: { message: MESSAGE, plays_on: PLAYS_ON }, log: [FIRST_QUESTION] });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal(withoutNext(saved.text), [
    "brief r1 saved: message (you said), plays_on (guessed), about (you said) · ask saved (1 message as typed) · 1 reply logged (question) · replies 1 of 10",
    "missing: made_from, look_sound, never",
    "step: ask about look_sound, or guess it",
  ].join("\n"));
  assert.ok(estimateTextTokens(withoutNext(saved.text)) <= 95, `the save answer is about ${estimateTextTokens(withoutNext(saved.text))} tokens`);

  const read = await brief("brief-read");
  assert.equal(withoutNext(read.text), [
    "brief r1, unconfirmed · replies 1 of 10 (1 question, 0 playbacks)",
    'message: you said "my skate crew, they should feel like going out to skate"',
    "plays_on: guessed → TikTok, 9:16, 24 s",
    'about: you said "my skate crew"',
    "ask: 1 message saved as typed",
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
  assert.deepEqual(Object.keys(read.data.brief.fields), ["message", "about"]);
  assert.equal(read.data.replies.count, 0);
});

test("the person's line is never replaced by a guess or removed; their correction replaces it", async () => {
  await newProject("brief-yours");
  await brief("brief-yours", { fields: { never: { text: "no meme text", by: "you", quote: "no meme text" } } });
  for (const never of [{ text: "no captions", by: "guessed" }, null]) {
    const refused = await brief("brief-yours", { fields: { never } });
    assert.equal(refused.data.error, "yours");
    assert.equal(refused.data.reason, 'never is the person\'s ("no meme text"). Ask them in the chat, then save their new words with by:"you".');
  }
  const corrected = await brief("brief-yours", { fields: { never: { text: "no meme text, no emoji", by: "you", quote: "no meme text and don't crop our faces out" } } });
  assert.equal(corrected.isError, undefined, corrected.text);
  assert.match(withoutNext(corrected.text), /^brief r2 saved: never \(you said\)/);
  // A guessed line may be guessed again or removed.
  await brief("brief-yours", { fields: { plays_on: PLAYS_ON } });
  const removed = await brief("brief-yours", { fields: { plays_on: null } });
  assert.match(withoutNext(removed.text), /^brief r4 saved: plays_on \(removed\)/);
  const same = await brief("brief-yours", { fields: { never: { text: "no meme text, no emoji", by: "you", quote: "no meme text and don't crop our faces out" } } });
  assert.match(withoutNext(same.text), /^brief r4: no line changed · replies 0 of 10/, "a line sent again as it is changes nothing");
});

test("a yes to the playback confirms the brief; a later line change needs a new playback", async () => {
  await newProject("brief-playback", server, 24, { references: true });
  const full = await brief("brief-playback", { fields: { ...FULL, ask: ASK_TEXT } });
  assert.match(withoutNext(full.text), /\nmissing: none\nstep: play the brief back \(5–8 lines\)$/);
  const playback = await brief("brief-playback", { log: [PLAYBACK_YES(1)] });
  assert.equal(playback.text.split("\n")[0], "brief r1: 1 reply logged (playback) · confirmed · replies 1 of 10");
  assert.equal(playback.data.brief.confirmedRev, 1);
  // Settled, with no saved reference: find 2 before the plan (the step's call is the search).
  const before = await agent("status", { project: "brief-playback" });
  assert.equal(before.text.split("\n")[2], "step: find 2 references (inspire)");
  assert.match(before.text, /\nnext: library \{"topic":"inspire","search":"my skate crew edit"\}$/);
  await agent("edit", { project: "brief-playback", ops: [{ op: "waive_check", code: "reference", target: "*", reason: "a brief test" }, { op: "waive_check", code: "treatments", target: "*", reason: "a brief test" }] });
  // status also names the first stop this 24 s video asks once it is built (B2a).
  assert.deepEqual((await statusLines("brief-playback")).slice(1, 3), ["direction: brief r1 (2 guessed), confirmed · replies 1/10", 'step: notes set_plan, board a move per shot (library {topic:"moves"}), ask board, then build']);
  await agent("notes", { project: "brief-playback", action: "set_plan", steps: ["Build", "Render"] });
  assert.equal((await statusLines("brief-playback"))[2], "step: ask board, then follow the plan");

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
  await skipBoardOn(server);
  await agent("edit", { project: "brief-hint", ops: [{ op: "add_layer", layerType: "text", name: "headline", properties: { text: "Skate now" },
    animations: [{ preset: "preset-fade", start: 0, duration: 0.5 }] }] });
  await skipBoardOn(server, 8);
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
  // A graphics-only video of 8 s or more shows its storyboard before the build.
  assert.equal(status.text.split("\n")[2], "step: ask board, then build on; play the brief back then");
  assert.notEqual(playback(status), "playback");
});

// Review round 1: "just start", or no one to answer, is a brief settled with no playback.
test("no_playback settles the brief without a playback for the rest of the video", async () => {
  await newProject("brief-just-start");
  const guessed = Object.fromEntries(Object.entries(FULL).filter(([name]) => name !== "key_moment").map(([name, line]) => [name, { text: line.text, by: "guessed" }]));
  const saved = await brief("brief-just-start", { fields: guessed, log: [{ ...FIRST_QUESTION, a: "just start" }], no_playback: "just start" });
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal(withoutNext(saved.text), [
    "brief r1 saved: message (guessed), plays_on (guessed), made_from (guessed), look_sound (guessed), never (guessed), about (you said) · ask saved (1 message as typed) · 1 reply logged (question) · no playback (just start) · replies 1 of 10",
    "missing: none",
    "step: notes set_plan, then build",
  ].join("\n"));
  assert.deepEqual((await statusLines("brief-just-start")).slice(1, 3), ["direction: brief r1 (5 guessed), no playback · replies 1/10", 'step: notes set_plan, board a move per shot (library {topic:"moves"}), ask board, then build']);
  // The step log: the calls up to the brief save arrived in the brief step (create, the waivers
  // edit, the save); the status call after it found the storyboard open. history prints the table.
  const stepLog = (await savedState("brief-just-start")).stepLog;
  assert.deepEqual(stepLog.order, ["brief", "board"]);
  assert.deepEqual([stepLog.steps.brief.calls, stepLog.steps.board.calls], [3, 1]);
  assert.match((await agent("history", { project: "brief-just-start" })).text, /\nsteps \(kino's time and calls[^\n]*\n  brief +<1 min +3 calls\n  board +<1 min +\d+ calls?\n  total /);
  await agent("notes", { project: "brief-just-start", action: "set_plan", steps: ["Build", "Render"] });
  assert.equal((await statusLines("brief-just-start"))[2], "step: ask board, then follow the plan");
  // A later change is saved, and still needs no playback.
  await brief("brief-just-start", { fields: { plays_on: { text: "TikTok, 9:16, 20 s", by: "guessed" } } });
  assert.deepEqual((await statusLines("brief-just-start")).slice(1, 3), ["direction: brief r2 (5 guessed), no playback · replies 1/10", "step: ask board, then follow the plan"]);
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
  assert.match(saved.text, /^brief r1 saved: about \(you said\), length \(30 s\)/);
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
  assert.deepEqual((await statusLines("brief-count")).slice(1, 3), ["direction: no brief lines · replies 3/10", "step: save ask and about"]);
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
  assert.deepEqual((await statusLines("brief-count")).slice(1, 3), ["direction: brief r2 (2 guessed), unconfirmed · replies 10/10", 'step: out of replies: set_plan, board a move per shot (library {topic:"moves"}), ask board, then build']);
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

  await skipBoardOn(server);
  const again = await agent("edit", { project: "brief-revert", ops: [...ORDER_WAIVERS, { op: "add_layer", layerType: "rectangle", name: "card2", properties: { x: 10, y: 10, width: 100, height: 100 } }] });
  await skipBoardOn(server, 8);
  assert.equal(again.data.error, undefined, JSON.stringify(again.data));
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
    const held = await brief("brief-you", { fields: { message: MESSAGE, ask: ASK_TEXT } });
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
    assert.deepEqual(lines, ["direction: brief r1 (2 guessed), confirmed · replies 2/10", 'step: notes set_plan, board a move per shot (library {topic:"moves"}), ask board, then build']);
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
      for (const steps of [[], [{ text: "Build", done: false }]]) for (const video of [{ seconds: 24, layers: 0 }, { seconds: 6, layers: 0 }, { seconds: 24, layers: 3 }, { seconds: 24, layers: 0, references: 0 }, { seconds: 24, layers: 0, references: 1 }, { seconds: 24, layers: 0, references: 2, needs: { checked: false } },
        { seconds: 24, layers: 0, references: 2, saved: ["yt:dQw4w9WgXcQ", "yt:9bZkp7q19f0"], studied: [] }, { seconds: 24, layers: 0, references: 1, saved: ["yt:dQw4w9WgXcQ"], studied: ["yt:9bZkp7q19f0"], songTitle: "Glass Harbor" }]) {
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
  const state = { brief: { ...emptyBrief(), rev: 1, fields: withAsk({ ...FULL, about: ABOUT }), log: [PLAYBACK_YES(1)], confirmedRev: 1 } };
  const step = (video) => nextMove(state, { seconds: 24, layers: 0, treatmentsWaived: true, ...video }).step;
  assert.equal(step({ references: 1 }), "find 1 more reference (inspire)");
  for (const video of [{ references: 2 }, { references: 0, referenceWaived: true }, { references: 0, seconds: 3 }, {}]) assert.equal(step(video), "notes set_plan, then build", JSON.stringify(video));
  // Then the material against the story (notes needs), when the video has footage or speech.
  assert.equal(step({ references: 1, needs: { checked: false } }), "find 1 more reference (inspire)");
  const needs = nextMove({ ...state, plan: { steps: [{ text: "Build" }] } }, { seconds: 24, layers: 3, references: 2, needs: { checked: false }, treatmentsWaived: true });
  assert.deepEqual([needs.step, needs.call.input.action], ["check material: notes needs", "needs"]);
  // The call is drafted from the picked treatment saved in the brief: footage of its who.
  const treatments = { picked: { index: 0 }, list: [{ idea: "the app finds the lost dog", who: "the app", tension: "will it find the dog before dark?" }] };
  const fromPick = nextMove({ ...state, brief: { ...state.brief, treatments }, plan: { steps: [{ text: "Build" }] } }, { seconds: 24, layers: 3, references: 2, needs: { checked: false }, treatmentsWaived: true });
  assert.deepEqual([fromPick.step, fromPick.call.input.items[0].what], ["check material: notes needs", "footage of the app"]);
  // With web search on (directionFacts sets needs.search), finding that footage is an option.
  const searched = nextMove({ ...state, brief: { ...state.brief, treatments }, plan: { steps: [{ text: "Build" }] } }, { seconds: 24, layers: 3, references: 2, needs: { checked: false, search: true }, treatmentsWaived: true });
  assert.match(searched.call.input.items[0].options[1].do, /^library \{topic:"footage"/);
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
  applyBrief(remake, briefChanges(remake.brief, { fields: { ask: "approve as written. no flashes, ever.", style: { ...bible, wants: ["dissolve"], avoids: ["beat-kick", "flash", "fade-black"], sources: { avoids: "copied", moves: "dealt" }, moves: [{ tag: "parallax", where: "every walk" }] } } }));
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

test("the first reference search is filled from what the person named; each wanted reference must be studied", () => {
  const line = (text) => ({ text, by: "guessed" });
  const brief = { rev: 1, fields: { message: line("A fast edit of Mara Voss on the lighthouse stairs. Make it hit."), made_from: line('footage from "The Long Climb" and Lighthouse Keepers of Norway'), look_sound: line("dark, grainy") } };
  // Only quoted text is a name: kino does not guess names from capital letters.
  assert.deepEqual(namedThings(brief), ["The Long Climb"]);
  assert.deepEqual(namedThings({ fields: { message: line("make the most INTENSE mara voss edit ever") } }), []);
  // The song's title: a link or an id never reaches the search; a sound effect or an ambience is never the song.
  assert.deepEqual(referenceSearches({ fields: { message: line('a "Brightloop" launch') } }, "https://youtu.be/dQw4w9WgXcQ"), { search: "Brightloop edit", withoutSong: null });
  const candidates = [{ id: "yt:aaaaaaaaaaa", title: "Glass Harbor (Official Audio)", picked: true, named: "https://youtu.be/aaaaaaaaaaa" }];
  assert.equal(songTitleOf(candidates, []), "Glass Harbor (Official Audio)");
  assert.equal(songTitleOf([{ ...candidates[0], named: "Glass Harbor by Mara" }], []), "Glass Harbor by Mara");
  const audio = (id, title, duration) => ({ duration, credit: { id, title } });
  assert.equal(songTitleOf([{ id: "yt:aaaaaaaaaaa" }], [audio("yt:sfxsfxsfxsf", "heavy rain ambience", 58), audio("openverse:9", "rain", 40), audio("yt:aaaaaaaaaaa", "Glass Harbor", 150), audio("yt:aaaaaaaaaaa", "Glass Harbor short", 12)]), "Glass Harbor");
  assert.equal(songTitleOf([], [audio("yt:sfxsfxsfxsf", "heavy rain ambience", 58)]), "");
  // Quoted names, the song's title (noise words cut) and "edit"; the same without the song is offered too.
  assert.deepEqual(referenceSearches(brief, "Glass Harbor (Official Audio)"), { search: "The Long Climb Glass Harbor edit", withoutSong: "The Long Climb edit" });
  // No quoted name: a slot the agent fills with who or what the video is about (an unfilled slot is refused).
  assert.deepEqual(referenceSearches({ fields: { message: line("make the most INTENSE mara voss edit ever") } }, "Glass Harbor"), { search: "<who or what it is about> Glass Harbor edit", withoutSong: "<who or what it is about> edit" });
  assert.equal(referenceSearches({ fields: { message: line("a calm edit") } }, ""), null, "nothing named keeps the placeholder");
  const video = { seconds: 15, references: 0, saved: [], studied: [], treatmentsWaived: true };
  const [find] = orderSteps({ brief }, { ...video, songTitle: "Glass Harbor" });
  assert.equal(find.call.input.search, "The Long Climb Glass Harbor edit");
  assert.equal(find.alt.input.search, "The Long Climb edit");
  assert.equal(orderSteps({ brief: { rev: 1, fields: {} } }, video)[0].call.input.search, "<an edit like yours>");
  // Studying: each of the 2 wanted saved references, named in the step; none left when both are studied.
  const saved = { ...video, references: 2, saved: ["yt:a", "yt:b", "yt:c"] };
  assert.deepEqual(orderSteps({ brief }, { ...saved, studied: ["yt:a"] }).map((entry) => [entry.step, entry.call.input.ref]), [["study yt:b (look)", "yt:b"]]);
  assert.deepEqual(orderSteps({ brief }, { ...saved, studied: ["yt:b", "yt:c"] }), []);
  assert.deepEqual(orderSteps({ brief }, { ...saved, seconds: 4, studied: [] }), [], "under 5 s: no references step");
});

test("the ask is saved as typed and only added to; next names it until it is saved, and a build does not wait for it", async () => {
  const id = "brief-ask";
  await newProject(id, server, 24, { references: true });
  askSent.add(askKey(id));
  const guessedFull = Object.fromEntries(Object.entries(FULL).map(([name, line]) => [name, { text: line.text, by: "guessed" }]));
  await brief(id, { fields: guessedFull, no_playback: "just start" });
  assert.ok((await statusLines(id)).includes("step: save ask and about"), "the ask comes first");
  assert.match((await agent("notes", { project: id, action: "brief" })).data.next, /ask/);
  // Not a gate: the build refusal names the references, not the ask.
  const build = await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "rectangle", name: "card" }] });
  assert.equal(build.data.error, "order_needed", build.text);
  assert.doesNotMatch(build.data.reason, /ask|message/);
  const rev = (await savedState(id)).brief.rev;
  const typed = "Make a clip for my SKATE crew.\nThey should feel like going out to skate!";
  const saved = await brief(id, { fields: { ask: `  ${typed}  ` } });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /ask saved \(1 message as typed\)/);
  const stored = (await savedState(id)).brief;
  assert.deepEqual([stored.fields.ask.map((entry) => entry.text), stored.rev], [[typed], rev], "outer spaces off, inner text as typed, the revision stays");
  assert.match(stored.fields.ask[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.ok((await statusLines(id)).includes("step: save about"), "then what it is about");
  await brief(id, { fields: { about: ABOUT } });
  assert.ok((await statusLines(id)).includes("step: find 2 references (inspire)"), "then the order goes on");
  // The same message again adds nothing; a second message is added after it.
  await brief(id, { fields: { ask: [typed, "and keep it under 20 seconds"] } });
  assert.deepEqual((await savedState(id)).brief.fields.ask.map((entry) => entry.text), [typed, "and keep it under 20 seconds"]);
  // Nothing removes it, and a placeholder is not a message.
  const removed = await brief(id, { fields: { ask: null } });
  assert.equal(removed.data.error, "yours");
  const slot = await brief(id, { fields: { ask: "<their message, pasted whole>" } });
  assert.equal(slot.data.error, "bad_input");
  assert.equal((await savedState(id)).brief.fields.ask.length, 2);
});

test("without a stored ask, missing names it and next carries the placeholders; ask:\"none\" clears it and the playback says so", () => {
  const guessed = Object.fromEntries(Object.entries(FULL).map(([name, line]) => [name, { text: line.text, by: "guessed" }]));
  const draft = { brief: emptyBrief() };
  applyBrief(draft, briefChanges(draft.brief, { fields: guessed }));
  // (a) every line guessed, no ask: missing says ask, and the next call carries both placeholders.
  const none = nextMove(draft, { seconds: 24, layers: 0 });
  assert.deepEqual(briefData(draft).missing, ["ask"]);
  assert.match(briefText(draft), /\nmissing: ask\n/);
  assert.deepEqual([none.step, none.call.input.fields.ask, none.call.input.fields.about], ["save ask and about", "<their message, pasted whole>", { text: "<the subject>", by: "you", quote: "<their words for it>" }]);
  // With the ask stored, the about line is what is missing.
  applyBrief(draft, briefChanges(draft.brief, { fields: { ask: ASK_TEXT } }));
  assert.deepEqual(briefData(draft).missing, ["about"]);
  assert.equal(nextMove(draft, { seconds: 24, layers: 0 }).call.input.fields.ask, undefined);
  // An ask alone saves no revision (no brief yet): the first call of a new video still stops asking for it.
  const alone = { brief: emptyBrief() };
  applyBrief(alone, briefChanges(alone.brief, { fields: { ask: ASK_TEXT } }));
  assert.equal(nextMove(alone, { seconds: 24, layers: 0 }).call.input.fields.ask, undefined);
  assert.equal(nextMove(alone, { seconds: 24, layers: 0 }).call.input.fields.about.by, "you");
  const aloneNone = { brief: emptyBrief() };
  applyBrief(aloneNone, briefChanges(aloneNone.brief, { fields: { ask: "none" } }));
  const noneCall = nextMove(aloneNone, { seconds: 24, layers: 0 }).call.input.fields;
  assert.deepEqual([noneCall.ask, noneCall.about], [undefined, { text: "<the subject>", by: "guessed" }]);
  // (b) ask:"none" counts as given, shows in the playback, and lets about be a guess.
  const quiet = { brief: emptyBrief() };
  applyBrief(quiet, briefChanges(quiet.brief, { fields: { ...guessed, ask: "none" } }));
  assert.deepEqual(briefData(quiet).missing, ["about"]);
  assert.equal(briefData(quiet).brief.askNone, true);
  assert.match(briefText(quiet), /\nask: none \(no person's words; quotes not checked\)\n/);
  assert.deepEqual(nextMove(quiet, { seconds: 24, layers: 0 }).call.input.fields.about, { text: "<the subject>", by: "guessed" });
  applyBrief(quiet, briefChanges(quiet.brief, { fields: { about: { text: "the skate crew", by: "guessed" } } }));
  assert.deepEqual(briefData(quiet).missing, []);
  // Under "none" a by:"you" quote has nothing to be checked against: refused unless a logged reply holds it.
  const crew = { text: "vertical", by: "you", quote: "vertical on TikTok" };
  assert.throws(() => briefChanges(quiet.brief, { fields: { plays_on: crew } }), (error) => error.code === "quote_not_said" && /ask is "none"/.test(error.message));
  assert.equal(briefChanges(quiet.brief, { fields: { plays_on: crew }, log: [{ q: "Where?", a: "vertical on TikTok please" }] }).lines.length, 1);
  // A real ask stored later replaces the marker.
  applyBrief(quiet, briefChanges(quiet.brief, { fields: { ask: "vertical on TikTok please" } }));
  assert.deepEqual([briefData(quiet).brief.askNone, briefData(quiet).brief.asks], [undefined, 1]);
});

test("with an ask stored, a quote by you must be in it or in a reply; with no ask a quote by you is refused", () => {
  const ask = "Make a clip for my skate crew. I want them to feel like going out to skate. Keep it vertical.";
  const vertical = { text: "vertical for TikTok", by: "you", quote: "vertical on TikTok" };
  const empty = emptyBrief();
  // (c) no ask stored: the quote is refused, and the refusal says to store their message first.
  assert.throws(() => briefChanges(empty, { fields: { plays_on: vertical } }), (error) => error.code === "quote_not_said" && /store it first \(ask:"<their message, pasted whole>"/.test(error.message));
  // (d) the same words pass once the ask that holds them is stored (sent in the same call, or before).
  assert.equal(briefChanges(empty, { fields: { ask: "Please make it vertical on TikTok", plays_on: vertical } }).lines.length, 1);
  // The ask sent in the same call counts; the refusal names the closest sentence they said.
  assert.throws(() => briefChanges(empty, { fields: { ask, plays_on: vertical } }),
    (error) => error.code === "quote_not_said" && error.details.closest === "Keep it vertical." && /plays_on\.quote is not in anything they said \(closest: "Keep it vertical\."\)/.test(error.message));
  const draft = { brief: empty };
  applyBrief(draft, briefChanges(draft.brief, { fields: { ask } }));
  assert.throws(() => briefChanges(draft.brief, { fields: { plays_on: vertical } }), { code: "quote_not_said" });
  // Whole words, any case; punctuation does not count; half a word does not.
  const said = (quote) => briefChanges(draft.brief, { fields: { never: { text: "x", by: "you", quote } } }).lines.length;
  assert.equal(said("MY SKATE CREW, i want them"), 1);
  assert.throws(() => said("my skat crew"), { code: "quote_not_said" });
  assert.throws(() => said("my skate crew and a dog"), { code: "quote_not_said" });
  // A guessed line is not checked, and a logged reply counts as said.
  assert.equal(briefChanges(draft.brief, { fields: { plays_on: { text: "vertical", by: "guessed" } } }).lines.length, 1);
  const reply = { q: "Where does it play?", a: "vertical on TikTok please" };
  assert.equal(briefChanges(draft.brief, { fields: { plays_on: vertical }, log: [reply] }).lines.length, 1, "a reply in this call");
  applyBrief(draft, briefChanges(draft.brief, { fields: {}, log: [reply] }));
  assert.equal(briefChanges(draft.brief, { fields: { plays_on: vertical } }).lines.length, 1, "a reply logged before");
  // The treatment pick's quote is the person's words too; a pick of your own has none to check.
  const idea = (index) => ({ idea: `idea ${index}`, who: `who ${index % 3}`, tension: "can one kid land it?", turn: "the board lands clean", move: `move ${index}`, ending: `ending ${index}`, type: `type ${index}`, p: [0.6, 0.3, 0.2, 0.1, 0.05][index], source: "the tagline" });
  applyBrief(draft, briefChanges(draft.brief, { fields: { treatments: [0, 1, 2, 3, 4].map(idea) } }));
  assert.throws(() => briefChanges(draft.brief, { fields: { treatments: { pick: "A", quote: "the fourth one, please" } } }), { code: "quote_not_said" });
  assert.equal(briefChanges(draft.brief, { fields: { treatments: { pick: "A", quote: "keep it vertical" } } }).lines[0].line.by, "you");
  assert.equal(briefChanges(draft.brief, { fields: { treatments: { pick: "A", why: "a viewer would retell it" } } }).lines[0].line.by, "guessed");
  // (c) and (d) for a pick: with no ask stored its quote is refused; the same quote passes once the ask holds it.
  const unasked = { brief: emptyBrief() };
  applyBrief(unasked, briefChanges(unasked.brief, { fields: { treatments: [0, 1, 2, 3, 4].map(idea) } }));
  const pick = { fields: { treatments: { pick: "A", quote: "keep it vertical" } } };
  assert.throws(() => briefChanges(unasked.brief, pick), (error) => error.code === "quote_not_said" && /store it first \(ask:/.test(error.message));
  applyBrief(unasked, briefChanges(unasked.brief, { fields: { ask } }));
  assert.equal(briefChanges(unasked.brief, pick).lines[0].line.by, "you");
  // A style by you is their words too (it approves the direction lock): refused with no ask, with "none" and with an ask that lacks it.
  const style = (quote) => ({ fields: { style: { wants: ["cut"], avoids: ["flash"], lines: [{ text: "the title type", ref: "yt:dQw4w9WgXcQ" }], by: "you", quote } } });
  assert.throws(() => briefChanges(empty, style("keep it vertical")), (error) => error.code === "quote_not_said" && /store it first/.test(error.message));
  assert.throws(() => briefChanges(empty, { fields: { ask: "none", ...style("keep it vertical").fields } }), (error) => error.code === "quote_not_said" && /ask is "none"/.test(error.message));
  assert.throws(() => briefChanges(unasked.brief, style("words nobody typed")), { code: "quote_not_said" });
  assert.equal(briefChanges(unasked.brief, style("keep it vertical")).style.quote, "keep it vertical");
});

test("the service counts the person's answer to a stop as said: a quote from it passes the quote check, an invented one does not", async (t) => {
  const { call, agentState } = await serviceFor(t, {
    document: createDocument({ id: "said", name: "said", scenes: [createScene({ id: "s1", duration: 6 })] }),
  });
  await agentState.update("said", (draft) => {
    draft.brief = { rev: 1, fields: withAsk(), log: [] };
    draft.stops = [{ id: "C1", kind: "rough", rev: 1, status: "answered", answer: { words: "keep it narrow for the feed", read_as: "approve" } }];
  });
  const playsOn = (quote) => ({ action: "brief", fields: { plays_on: { text: "a narrow feed", by: "you", quote } } });
  const refused = await call("notes", playsOn("an invented sentence"));
  assert.match(refused.text, /quote_not_said|not in anything they said/, refused.text);
  const saved = await call("notes", playsOn("narrow for the feed"));
  assert.equal(saved.isError, undefined, saved.text);
  assert.equal((await agentState.read("said")).brief.fields.plays_on.quote, "narrow for the feed");
});

test("check hands the brief's plays_on to shape_guess: portrait over landscape footage is a guess until the person said where it plays", async (t) => {
  const fileId = "11111111-2222-3333-4444-555555555555.mp4";
  const clip = { id: fileId, name: "keeper", width: 1920, height: 1080, duration: 4 };
  const layer = createLayer("video", { id: "v", name: "clip", src: `/api/media/${fileId}`, x: 0, y: 0, width: 3413, height: 1920 });
  const { call, agentState } = await serviceFor(t, {
    document: createDocument({ id: "shape", name: "shape", scenes: [createScene({ id: "s1", name: "main", width: 1080, height: 1920, duration: 4, layers: [layer] })] }),
    media: [clip],
  });
  const said = (by) => (draft) => { draft.brief = { rev: 1, fields: withAsk({ plays_on: { text: "a phone", by } }), log: [] }; };
  await agentState.update("shape", said("guessed"));
  assert.match((await call("check")).text, /shape_guess/, "a guessed plays_on is still a guess");
  // The person left the shape to the agent: the line is saved (not refused), and kino follows the footage.
  await agentState.update("shape", said("guessed"));
  const left = await call("notes", { action: "brief", fields: { plays_on: { text: "up to you", by: "you", quote: "your call" } }, log: [{ q: "Where does it play?", a: "your call" }] });
  assert.equal(left.isError, undefined, left.text);
  assert.equal((await agentState.read("shape")).brief.fields.plays_on.named, false);
  const checked = await call("check");
  assert.match(checked.text, /shape_guess/);
  assert.match(checked.text, /left the shape to you \("your call"\) and 1 of 1 footage files are landscape \(1920x1080\): kino follows the footage/);
  // They named a shape in their own words: it clears the guess.
  const vertical = await call("notes", { action: "brief", fields: { ask: "make it vertical for phones", plays_on: { text: "phones", by: "you", quote: "make it vertical for phones" } } });
  assert.equal(vertical.isError, undefined, vertical.text);
  assert.equal((await agentState.read("shape")).brief.fields.plays_on.named, "portrait");
  assert.doesNotMatch((await call("check")).text, /shape_guess/, "a named shape equal to the scene's clears it");
  // namedShape: whole words, any case, two shapes name none.
  assert.deepEqual(["Make it VERTICAL", "for a 9 x 16 feed", "a 16:9 TV", "square please", "your call", "vertical or horizontal", "verticality"].map(namedShape),
    ["portrait", "portrait", "landscape", "square", null, null, null]);
  // A free reply to a stop: a place word counts only in a place phrase ("for my phone"), a shape word always.
  assert.deepEqual(["love the story, keep going", "the phone shot is great", "make it for my phone", "on TV please", "vertical"].map((words) => namedShape(words, { reply: true })),
    [null, null, "portrait", "landscape", "portrait"]);
  // A line of theirs saved before `named` existed, naming no shape, reads as left to the agent.
  const legacy = shapeGuess({ width: 1080, height: 1920, duration: 4 }, { scene: { layers: [{ type: "video", src: "a.mp4", name: "clip" }] }, sceneName: "s1",
    mediaSizes: { "a.mp4": { width: 1920, height: 1080 } }, playsOn: { text: "the feed", by: "you", quote: "for the feed" }, quote: (words) => words });
  assert.match(legacy[0].message, /the person left the shape to you \("for the feed"\)/);
  // The board stop comes before the build in the plan; other stops keep the old order.
  assert.ok(PLAN_CALL("board").input.steps[0].startsWith("Board") && PLAN_CALL("board").input.steps[1].startsWith("Ask board"));
  assert.match(PLAN_CALL("rough").input.steps[0], /^Build/);
});

test("the ask step is named only while the order has an open part and the video is not built; briefData sends a count, not the messages", () => {
  const brief = { ...emptyBrief(), rev: 2, fields: withAsk({ ...FULL, about: ABOUT }), log: [PLAYBACK_YES(2)], confirmedRev: 2 };
  const noAsk = { ...brief, fields: { ...FULL, about: ABOUT } };
  // A finished order on a built video: no message to save; the plan and stop steps lead.
  const done = { seconds: 20, layers: 10, references: 2, referenceWaived: false, treatmentsWaived: true };
  assert.equal(nextMove({ brief, checked: { rev: 5 }, lastLook: "s1" }, done, "rough").step, "build on, then ask rough");
  assert.equal(nextMove({ brief, plan: { steps: [{ text: "Build" }] } }, done, "rough").step, "follow the plan, then ask rough");
  assert.deepEqual(orderSteps({ brief: noAsk }, { ...done, references: 0 }, { ask: true }).map((part) => part.step), ["save their message (ask)", "find 2 references (inspire)"]);
  assert.deepEqual(orderSteps({ brief: noAsk, checked: { rev: 5 }, lastLook: "s1" }, { ...done, references: 0 }, { ask: true }).map((part) => part.step), ["find 2 references (inspire)"], "built: not held for the message");
  assert.deepEqual(orderSteps({ brief }, done, { ask: true }), [], "nothing open: nothing to name");
  // 30 messages of 2,000 characters stay out of the data of a read or a save.
  const asks = Array.from({ length: 30 }, (_, index) => ({ text: `${index} `.padEnd(BRIEF_LIMITS.ask, "x"), at: "2026-01-01T00:00:00.000Z" }));
  const data = briefData({ brief: { ...brief, fields: { ...FULL, ask: asks } } }, done);
  assert.deepEqual([data.brief.asks, data.brief.fields.ask, data.brief.fields.message.by], [30, undefined, FULL.message.by]);
  assert.ok(JSON.stringify(data).length < 6000, "about 1,500 tokens at most");
  assert.equal(asks.length, 30, "the state itself keeps them");
});

test("a quote in a script without spaces, or only emoji, is found as plain text; whole words still count for spaced text", () => {
  assert.equal(isSaid("竖屏", ["我想要一个关于塔的视频 请用竖屏"]), true);
  assert.equal(isSaid("竖版", ["我想要一个关于塔的视频 请用竖屏"]), false);
  assert.equal(isSaid("🔥🔥", ["make it fire 🔥🔥 please now"]), true);
  assert.equal(isSaid("🔥🔥🔥", ["make it fire 🔥🔥 please now"]), false);
  assert.equal(isSaid("skate", ["my skateboard crew"]), false, "half a word is still not said");
  assert.equal(isSaid("", ["anything"]), false);
});

test("a real edit (the critic's gate): a brief, and over 30 layers, or 10 to 30 layers in 15 s or more", () => {
  const briefed = { brief: { rev: 1 } };
  assert.equal(realEdit(briefed, { seconds: 15, layers: 10 }), true, "15 s with 10 layers is the shortest real edit");
  assert.equal(realEdit(briefed, { seconds: 15, layers: 30 }), true);
  assert.equal(realEdit(briefed, { seconds: 14.9, layers: 30 }), false, "under 15 s, 30 layers is still rough");
  assert.equal(realEdit(briefed, { seconds: 15, layers: 9 }), false);
  assert.equal(realEdit(briefed, { seconds: 5, layers: 31 }), true, "over 30 layers at any length");
  assert.equal(realEdit({}, { seconds: 15, layers: 10 }), false, "no brief, no real edit");
});

test("controls.quote that lets a stop pass must be said; a line or pick sent again as stored is not checked again", () => {
  const ask = "Make a promo for my skate crew please.";
  const draft = { brief: emptyBrief() };
  applyBrief(draft, briefChanges(draft.brief, { fields: { ask } }));
  const go = (quote) => ({ fields: { controls: { questions: "go", board: "go", quote } } });
  assert.throws(() => briefChanges(draft.brief, go("never ask me anything again, I trust you")), (error) => error.code === "quote_not_said" && /controls\.quote/.test(error.message));
  assert.ok(briefChanges(draft.brief, go("a promo for my skate crew")).controls.quote, "their words pass");
  // An old line quoted from earlier chat, then an ask saved later: the same line again is accepted.
  const later = { brief: emptyBrief() };
  applyBrief(later, briefChanges(later.brief, { fields: { ask: "none", message: { text: "a message", by: "you", quote: "old words from earlier chat" } } }, { said: ["old words from earlier chat"] }));
  applyBrief(later, briefChanges(later.brief, { fields: { ask: "totally different message here" } }));
  const again = { text: "a message", by: "you", quote: "old words from earlier chat" };
  assert.doesNotThrow(() => briefChanges(later.brief, { fields: { message: again } }));
  assert.throws(() => briefChanges(later.brief, { fields: { message: { ...again, quote: "other old words" } } }), { code: "quote_not_said" });
  // A reply recorded by a stop answer (the service passes it) counts as said.
  assert.equal(briefChanges(later.brief, { fields: { plays_on: { text: "vertical", by: "you", quote: "make it vertical" } } }, { said: ["make it vertical"] }).lines.length, 1);
});

test("about is who or what the video is about, in their words; the first reference search uses it before the slot", () => {
  const ask = "Make a fast edit of Mara Voss on the lighthouse stairs.";
  const about = { text: "Mara Voss on the stairs", by: "you", quote: "Mara Voss on the lighthouse stairs" };
  const draft = { brief: emptyBrief() };
  assert.throws(() => briefChanges(draft.brief, { fields: { about: { text: "Mara Voss", by: "guessed" } } }), { code: "bad_input" }, "about is theirs or left out");
  assert.throws(() => briefChanges(draft.brief, { fields: { ask, about: { ...about, quote: "Mara Voss on the beach" } } }), { code: "quote_not_said" });
  applyBrief(draft, briefChanges(draft.brief, { fields: { ask, about } }));
  assert.deepEqual([draft.brief.fields.about.quote, draft.brief.rev], [about.quote, 1]);
  assert.match(briefText(draft), /about: you said "Mara Voss on the lighthouse stairs"/);
  assert.equal(aboutWords(draft.brief), "Mara Voss on the lighthouse stairs");
  assert.equal(aboutWords({ fields: { about: { quote: "a long quote that runs on past forty characters for certain" } } }), "a long quote that runs on past forty");
  // No quoted name in the lines: the about words stand in for the slot; a quoted name still wins.
  assert.deepEqual(referenceSearches(draft.brief, "Glass Harbor"), { search: "Mara Voss on the lighthouse stairs Glass Harbor edit", withoutSong: "Mara Voss on the lighthouse stairs edit" });
  const named = { fields: { ...draft.brief.fields, made_from: { text: 'footage from "The Long Climb"', by: "guessed" } } };
  assert.equal(referenceSearches(named, "").search, "The Long Climb edit");
  assert.equal(referenceSearches({ fields: {} }, ""), null);
});

test("playback shows the origin line (200 characters at most) and what the pick does with its word; the agent cannot save the line", () => {
  const top = { id: "a1", title: "The Keeper Climbs The Tower (Fan Edit)", views: 5000000, seconds: 188 };
  const origin = { query: "keeper", words: [{ word: "tower", count: 11, of: 15 }], top: [top] };
  assert.equal(originLine(origin), 'origin: "tower" in 11 of 15 titles about "keeper"; top: The Keeper Climbs The Tower (Fan Edit) 5.0M 188 s');
  // A long title is cut to fit, still with its numbers; a skipped search or no word gives no line.
  const long = originLine({ ...origin, top: [{ ...top, title: "tower ".repeat(80) }] });
  assert.ok(long.length <= 200 && long.endsWith("... 5.0M 188 s"), long);
  assert.equal(originLine({ skipped: "offline" }), "");
  assert.equal(originLine({ query: "keeper", words: [], top: [top] }), "");
  // It reads back in the brief playback, once, and the stop's pick lines show it before the 3 shown.
  const treatment = (idea, turn) => ({ idea, who: "the keeper", tension: "can she reach the top?", turn, move: "slow push", ending: "the door", type: "serif", p: 0.2, source: "stairs.mp4" });
  const list = [treatment("the keeper climbs the tower", "the door opens"), treatment("a lamp at dawn", "the light turns on")];
  const treatments = { list, dropped: 1, shown: [0, 1], picked: null };
  const draft = { brief: { ...emptyBrief(), rev: 1, fields: { message: MESSAGE }, treatments }, origin };
  const lines = briefText(draft).split("\n");
  assert.equal(lines.filter((line) => line.startsWith("origin:")).length, 1);
  assert.equal(briefText({ brief: draft.brief }).includes("origin:"), false, "no origin, no line");
  assert.deepEqual(pickLines(draft.brief, origin).slice(0, 2), ["Pick a direction (or say your own):", originLine(origin)]);
  assert.equal(pickLines(draft.brief)[1].startsWith("A. "), true, "without an origin the pick lines are as before");
  // The pick line says whether the picked treatment names the word (idea, turn, move or source).
  const picked = (index) => ({ ...draft.brief, treatments: { ...treatments, picked: { label: "A", index, by: "guessed", why: "retold" } } });
  assert.match(briefText({ brief: picked(0), origin }), /\norigin word "tower": the pick names it \(idea\)\n/);
  assert.match(briefText({ brief: picked(1), origin }), /\norigin word "tower": the pick does not name it/);
  assert.doesNotMatch(briefText({ brief: picked(1) }), /origin word/);
  // The agent has no field for it, and a save leaves state.origin alone.
  assert.throws(() => briefChanges(draft.brief, { fields: { origin: 'origin: "stairs" in 15 of 15 titles' } }), { code: "bad_input" });
  assert.throws(() => briefChanges(draft.brief, { fields: { origin: { text: "x", by: "you", quote: "x" } } }), { code: "bad_input" });
  applyBrief(draft, briefChanges(draft.brief, { fields: { plays_on: PLAYS_ON } }));
  assert.deepEqual(draft.origin, origin);
});

test("the brief read compares the frame's shape with the footage's: 9:16 (guessed), footage 16:9 (4 of 4)", () => {
  const wide = { width: 1920, height: 1080 };
  const video = { seconds: 24, layers: 2, width: 1080, height: 1920, footageSizes: [wide, wide, wide, wide] };
  const guessed = { ...emptyBrief(), rev: 1, fields: { plays_on: PLAYS_ON } };
  assert.equal(shapeLine(guessed, video), "shape: 9:16 (guessed), footage 16:9 (4 of 4)");
  assert.ok(briefText({ brief: guessed }, video).split("\n").includes("shape: 9:16 (guessed), footage 16:9 (4 of 4)"));
  assert.equal(shapeLine({ ...guessed, fields: { plays_on: { text: "vertical", by: "you", quote: "vertical" } } }, video), "shape: 9:16 (you said), footage 16:9 (4 of 4)");
  assert.equal(shapeLine(guessed, { ...video, footageSizes: [wide, wide, { width: 1080, height: 1920 }] }), "shape: 9:16 (guessed), footage 16:9 (2 of 3)");
  // No footage or no frame size: nothing to compare, no line.
  assert.equal(shapeLine(guessed, { ...video, footageSizes: [] }), "");
  assert.equal(shapeLine(guessed, { seconds: 24, layers: 0 }), "");
  assert.equal(aspectLabel(1000, 750), "4:3");
  assert.equal(aspectLabel(1000, 333), "3.00:1");
});

test("idea first: a briefed video builds only after 2 references (each studied), 5 treatments, a pick, its signature and a spine with a turn", async () => {
  const id = "order-walk";
  const made = await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 12 });
  assert.doesNotMatch(made.text, /Building blocks|logo-sting/, "create offers no template menu");
  assert.match(made.text, /\nnext: notes \{"action":"brief"/, "its next is the brief");
  await brief(id, { fields: { ...FULL, ask: ASK_TEXT }, no_playback: "just start" });
  const compose = { project: id, ops: [{ op: "compose", duration: 12, beats: [{ recipe: "headline-reveal", text: "Skate now" }, { recipe: "cta-end", text: "Go skate" }] }] };
  const refused = async (step, call) => {
    const reply = await agent("edit", compose);
    assert.equal(reply.data.error, "order_needed", reply.text);
    assert.match(reply.data.reason, new RegExp(`Next: ${step}`));
    if (call) assert.deepEqual(nextCallOf(reply), call);
    return nextCallOf(reply);
  };
  await refused("find 2 references", { tool: "library", input: { topic: "inspire", search: "my skate crew edit" } });
  // The first refusal names every gate still open, not only the next.
  assert.match((await agent("edit", compose)).data.reason, /Then: study a reference \(look\); write 5 treatments\.$/);
  // One picture layer is building too.
  const picture = await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "rectangle", name: "card" }] });
  assert.equal(picture.data.error, "order_needed", picture.text);
  await savedReference(id, "kinoOrder01");
  await savedReference(id, "kinoOrder02", "order-two");
  await refused("study yt:kinoOrder01 \\+1", { tool: "look", input: { mode: "reference", ref: "yt:kinoOrder01" } });
  const studied = await agent("look", { project: id, mode: "reference", ref: "yt:kinoOrder01" });
  assert.equal(studied.isError, undefined, studied.text);
  // One studied is not enough: the refusal names the other saved reference and its call.
  await refused("study yt:kinoOrder02", { tool: "look", input: { mode: "reference", ref: "yt:kinoOrder02" } });
  assert.match((await agent("edit", compose)).data.next, /still to study: look \{"mode":"reference","ref":"yt:kinoOrder02"\}/);
  assert.equal((await agent("look", { project: id, mode: "reference", ref: "yt:kinoOrder02" })).isError, undefined);
  await refused("write 5 treatments");
  const treatments = ["the kickflip seen from the board", "one trick, five streets", "the crew's group chat lights up", "dawn to dusk in one line", "the wheels' sound leads"]
    .map((idea, index) => ({ idea, who: ["the kid", "the kid", "the crew", "the city", "a viewer"][index], tension: "can one kid land it?", turn: "the board lands clean", move: `move ${index}`, ending: `the board at rest, ending ${index}`, type: `type ${index}, cut on`, p: [0.6, 0.3, 0.2, 0.1, 0.05][index], source: "the tagline" }));
  // Each treatment carries its story: without a turn all 5 are refused in one answer.
  const noTurn = await brief(id, { fields: { treatments: treatments.map(({ turn, ...rest }) => rest) } });
  assert.equal(noTurn.isError, true);
  assert.match(noTurn.text, /treatments\[0\]\.turn is 1 to 60 characters: the on-screen moment it flips\..*\(5 problems\)/);
  // 5 stories driven by one who ("Kid" is "the kid") are one story told 5 ways: refused, naming who.
  const oneWho = await brief(id, { fields: { treatments: treatments.map((entry, index) => ({ ...entry, who: index ? "the kid" : "Kid" })) } });
  assert.match(oneWho.data.reason, /^treatments: 5 of 5 share who "Kid"; give at least 3 different whos\./);
  assert.equal((await brief(id, { fields: { treatments } })).isError, undefined);
  // Under "just start" the pick is the agent's own, and says why.
  await refused("pick a treatment, with why", { tool: "notes", input: { action: "brief", fields: { treatments: { pick: "<A, B or C>", why: "<why a viewer would retell it>" } } } });
  // The pick's idea becomes style.idea; its move is offered as the first signature.
  const picked = await brief(id, { fields: { treatments: { pick: "A", why: "the sound is what a skater retells" } } });
  assert.equal(picked.data.brief.style.idea, "the wheels' sound leads");
  assert.equal(picked.data.brief.style.type, "type 4, cut on", "the pick saves its type into the style spec");
  // The service drafts its needs call from the saved pick (the same state the needs gates read).
  assert.equal(nextCallOf(await agent("notes", { project: id, action: "needs" })).input.items[0].what, "footage of a viewer");
  const offer = await refused("save the signature and spine");
  assert.deepEqual(offer.input.fields.style.signatures[0].what, "move 4");
  // The same call drafts the spine from the pick, so it keeps the pick's story: the hook opens on
  // its who, the problem is its tension, the turn its turn and the end its ending.
  const drafted = offer.input.fields.style.spine;
  assert.deepEqual([drafted.map((beat) => beat.role), drafted[1].purpose, drafted[2].purpose, offer.input.fields.style.signatures[0].beat], [["hook", "problem", "turn", "signature", "payoff", "end"], "can one kid land it?", "the board lands clean", 3]);
  assert.deepEqual([drafted[0].purpose, drafted[5].purpose], ["<the first image of a viewer's story>", "the board at rest, ending 4"]);
  // A pick whose source names no picture asks for one, and the draft offers the project's own.
  assert.match(picked.text, /source is words only: build the signature from the product's own picture/);
  assert.equal(offer.input.fields.style.signatures[0].source, "<a screenshot or clip of the product, and the moment>");
  assert.deepEqual(["the tagline", "the founder's voice memo", "app.png"].map(wordsOnly), [true, false, false]);
  const state = { brief: (await savedState(id)).brief };
  assert.equal(orderStep(state, { seconds: 24, treatmentsWaived: false, picture: "inbox.png" }).call.input.fields.style.signatures[0].source, "inbox.png, <the moment>");
  // The beats are timed over the brief's length, not create's 5 s default scene.
  const timed = orderStep({ ...state, defaultLength: 5, brief: { ...state.brief, length: { seconds: 30 } } }, { seconds: 5, treatmentsWaived: false }).call.input.fields.style.spine;
  assert.deepEqual([timed[4].role, timed[4].from, timed[4].to], ["payoff", 21, 27]);
  const signature = { beat: 0, what: "move 4", source: "skate.mp4, the wheels at 0:03", why: "only this crew's sound" };
  const confirmed = await brief(id, { fields: { style: { signatures: [signature] } } });
  assert.equal(confirmed.isError, undefined, confirmed.text);
  // Pick and signature saved, the spine without a turn: the build waits for the turn.
  const turnless = drafted.filter((beat) => beat.role !== "turn").map((beat) => ({ ...beat, purpose: beat.purpose.replace(/[<>]/g, "") }));
  assert.equal((await brief(id, { fields: { style: { spine: turnless } } })).isError, undefined);
  const turnCall = await refused("add the spine's turn \\(notes brief style\\.spine\\)");
  assert.deepEqual(turnCall.input.fields.style.spine.map((beat) => beat.role), ["hook", "problem", "turn", "signature", "payoff", "end"]);
  assert.equal((await brief(id, turnCall.input)).isError, undefined);
  await skipBoardOn(server);
  const built = await agent("edit", compose);
  await skipBoardOn(server, 8);
  assert.equal(built.isError, undefined, built.text);
  assert.equal(built.data.rev, 2, "the refused edits saved nothing");
  // The check carries the picked ending (service findingsFor): the video's scene (the longest,
  // quality.mjs videoScene) ending on a centered name and tagline card is told to end on the
  // payoff and the ending the agent picked.
  const line = (name, text, fontSize, y) => ({ type: "text", id: name, name, text, fontSize, fontFamily: "Inter", fill: "#f2f2f2", textAlign: "center", textResize: "height", x: 0, y, width: 1920 });
  const card = await agent("edit", { project: id, ops: [{ op: "add_scene", properties: { id: "endcard", name: "End card", width: 1920, height: 1080, duration: 20, background: "#111111", layers: [line("name", "Skate now", 180, 380), line("tagline", "the crew is out tonight", 48, 620)] } }] });
  assert.equal(card.isError, undefined, card.text);
  const checked = await agent("check", { project: id, scene: "endcard", rules: ["template_end"], pixels: false });
  assert.match(checked.text, /the ending you picked "the board at rest, ending 4"/, checked.text);
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

test("controls: a bad value names the accepted ones; asking less needs the person's quote; the save keeps the revision, its receipt names the skipped steps, and questions go asks none", () => {
  const draft = { brief: emptyBrief() };
  applyBrief(draft, briefChanges(draft.brief, { fields: { message: "the park reopens", ask: "The park reopens. No storyboard or rough cut, just make it." } }));
  const video = { seconds: 24, layers: 0 };
  assert.match(nextMove(draft, video).step, /about/, "before: the agent saves what it is about");
  assert.throws(() => briefChanges(draft.brief, { fields: { controls: { rough: "skip" } } }), (error) => error.code === "bad_input" && /"wait" or "go"/.test(error.message) && error.details.example.controls.rough === "go");
  assert.throws(() => briefChanges(draft.brief, { fields: { controls: { pace: 2 } } }), { code: "bad_input" }, "a control kino does not act on yet is refused, not saved");
  assert.throws(() => briefChanges(draft.brief, { fields: { controls: { rough: "go" } } }), (error) => error.code === "quote_needed" && error.details.example.controls.quote === "<their exact words>");
  assert.throws(() => briefChanges(draft.brief, { fields: { controls: { skip_under: { board: 30 } } } }), { code: "quote_needed" });
  // Asking the person more needs no quote.
  assert.equal(briefChanges(draft.brief, { fields: { controls: { color: "wait", skip_under: { rough: 10 } } } }).controls.stops.color, "wait");
  const changes = briefChanges(draft.brief, { fields: { controls: { rough: "go", questions: "go", skip_under: { board: 30 }, quote: "no storyboard or rough cut, just make it" } } });
  applyBrief(draft, changes);
  assert.equal(draft.brief.rev, 1, "controls keep the brief's revision");
  const receipt = savedText(draft, changes, video).split("\n");
  assert.ok(receipt.includes("controls (you): questions go · rough go · skip board under 30 s"), receipt.join(" | "));
  assert.ok(receipt.includes("skipped for this video: questions (go on), rough (go on), board (under 30 s)"), receipt.join(" | "));
  assert.ok(briefText(draft, video).split("\n").includes("controls (you): questions go · rough go · skip board under 30 s"));
  assert.doesNotMatch(nextMove(draft, video).step, /^ask/, "questions go: no questions, the agent guesses");
  const removed = briefChanges(draft.brief, { fields: { controls: null } });
  applyBrief(draft, removed);
  assert.equal(draft.brief.controls, undefined);
  assert.match(savedText(draft, removed, video), /controls removed/);
});
