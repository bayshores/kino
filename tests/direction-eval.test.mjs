// The direction eval (B1, evals/direction.mjs): the checker on a hand-written transcript and
// on copies that each break one rule, the scripted replies, and one run of evals/run.mjs end
// to end with a stub `claude`. No model, API key or network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDirection, normalizeQuote, pickReply, playbackLines } from "../evals/direction.mjs";
import { parseArgs, prepareSettings } from "../evals/run.mjs";
import { loadSettings } from "../backend/agent/dashboard.mjs";
import { stopRules } from "../backend/agent/stops.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(root, "evals/fixtures/direction-01.hand-written.json"), "utf8"));
const brief = JSON.parse(readFileSync(path.join(root, "evals/briefs.json"), "utf8")).briefs.find((entry) => entry.id === "direction-01");
const CHECKS = ["questions_at_most_3", "one_question_per_message", "path_then_open_question", "open_lines_asked", "quotes_exact",
  "playback_5_to_8_lines", "replies_at_most_10", "brief_saved_before_playback", "kino_counted_replies", "brief_confirmed"];
const failing = (transcript) => checkDirection(transcript, brief).checks.filter((check) => !check.ok).map((check) => check.id);
const detail = (transcript, id) => checkDirection(transcript, brief).checks.find((check) => check.id === id).detail;
const playbackIndex = (transcript) => transcript.events.findIndex((event) => event.type === "agent" && event.text.includes("What's wrong or missing?"));

test("the hand-written transcript passes every brief rule, and says it is no model run", () => {
  const result = checkDirection(fixture, brief);
  assert.deepEqual(result.checks.map((check) => check.id), CHECKS);
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  for (const check of result.checks) assert.match(check.detail, /\d/, `${check.id} says its numbers`);
  assert.equal(fixture.source, "hand-written");
  assert.match(fixture.note, /Not a model run/);
});

test("a copy that breaks one rule fails exactly that check", () => {
  const broken = {
    // A 4th question, with nothing else changed.
    questions_at_most_3(transcript) {
      transcript.events.splice(playbackIndex(transcript), 0, { type: "agent", text: "What's the one moment that should make someone stop scrolling?" });
    },
    one_question_per_message(transcript) {
      transcript.events.find((event) => event.type === "agent" && event.text.startsWith("What would make you wince")).text =
        "What would make you wince? Anything you've hated in other edits?";
    },
    // Retold, not copied: the person said "no meme text and don't crop our faces out".
    quotes_exact(transcript) { transcript.saved.brief.fields.never.quote = "no meme text please"; },
    // 11 replies, and kino counted all 11.
    replies_at_most_10(transcript) {
      for (let index = 0; index < 7; index += 1) transcript.events.push({ type: "person", text: `one more thing, number ${index + 1}` });
      transcript.saved.replies.count = 11;
    },
    // Every save moved after the playback.
    brief_saved_before_playback(transcript) {
      const saves = transcript.events.filter((event) => event.type === "call" && event.input.fields);
      transcript.events = transcript.events.filter((event) => !saves.includes(event));
      transcript.events.splice(playbackIndex(transcript) + 1, 0, ...saves);
    },
    kino_counted_replies(transcript) { transcript.saved.replies.count -= 1; },
    // The first message asks the open question but never offers to skip.
    path_then_open_question(transcript) {
      transcript.events.find((event) => event.type === "agent").text = "Who's it for, and what should they feel after watching?";
    },
    // The person's look and sound saved as the agent's guess.
    open_lines_asked(transcript) { transcript.saved.brief.fields.look_sound = { text: "raw and bright", by: "guessed", rev: 2 }; },
    // The playback answer logged without confirmed:true.
    brief_confirmed(transcript) { transcript.saved.brief.confirmedRev = null; },
  };
  for (const [check, breakIt] of Object.entries(broken)) {
    const transcript = structuredClone(fixture);
    breakIt(transcript);
    assert.deepEqual(failing(transcript), [check], check);
  }
  // A playback of 4 lines and one of 9.
  for (const [size, change] of [[4, (lines) => lines.filter((line) => !/made from|key moment/.test(line))],
    [9, (lines) => [...lines.slice(0, -1), "- music: guess: none, the clip's own sound", "- text: guess: none", "- captions: guess: none", lines.at(-1)]]]) {
    const transcript = structuredClone(fixture);
    const playback = transcript.events[playbackIndex(transcript)];
    playback.text = change(playback.text.split("\n")).join("\n");
    assert.equal(playbackLines(playback.text).length, size);
    assert.deepEqual(failing(transcript), ["playback_5_to_8_lines"], `${size}-line playback`);
  }
});

// Review round 2: a refused notes brief call saved nothing, so it is not the save before the
// playback, and a quote in it is not one the agent claims as the person's.
test("a refused brief call is no save and claims no quote", () => {
  // Every save before the playback was refused (say quote_needed); the agent saved only after it.
  const late = structuredClone(fixture);
  const saves = late.events.filter((event) => event.type === "call" && event.input.fields);
  late.events = late.events.map((event) => (saves.includes(event) ? { ...event, isError: true } : event));
  late.events.splice(playbackIndex(late) + 1, 0, ...structuredClone(saves));
  assert.deepEqual(failing(late), ["brief_saved_before_playback"]);
  assert.match(detail(late, "brief_saved_before_playback"), /^The first playback \(event \d+\) came before the first save \(event \d+\)\.$/);

  // A refused call with a retold quote: kino kept nothing of it, so quotes_exact ignores it.
  const refused = structuredClone(fixture);
  refused.events.splice(playbackIndex(refused), 0,
    { type: "call", tool: "notes", input: { action: "brief", fields: { never: { text: "no meme text", by: "you", quote: "no meme text please" } } }, isError: true });
  assert.deepEqual(failing(refused), []);
  assert.match(detail(refused, "quotes_exact"), /^All \d+ quotes are word for word in the person's messages\.$/);
});

// The finding from review round 1: an agent that asks nothing, saves all five lines as
// guessed, plays them back and logs the answer must not pass.
test("an agent that asks no questions fails the first-message and open-line checks", () => {
  const request = fixture.events[0];
  const guessed = { message: "skaters; make them want to skate", plays_on: "TikTok, 9:16, 24 s", made_from: "skate.mp4", look_sound: "bright, the clip's own sound", never: "no meme text" };
  const fields = Object.fromEntries(Object.entries(guessed).map(([name, text]) => [name, { text, by: "guessed" }]));
  const playback = ["Here's the brief. \"guess\" is mine.", ...Object.entries(guessed).map(([name, text]) => `- ${name}: guess: ${text}`), "What's wrong or missing?"].join("\n");
  const transcript = {
    version: 1, brief: "direction-01", source: "hand-written", events: [
      request,
      { type: "call", tool: "notes", input: { action: "brief", fields }, isError: false },
      { type: "agent", text: playback },
      { type: "person", text: brief.playbackReply },
      { type: "call", tool: "notes", input: { action: "brief", log: [{ q: "What's wrong or missing?", a: brief.playbackReply, kind: "playback", rev: 1, confirmed: true }] }, isError: false },
      { type: "agent", text: "The brief is confirmed." },
    ],
    saved: {
      brief: { rev: 1, confirmedRev: 1, noPlayback: null, fields, log: [] },
      missing: [], replies: { count: 1, limit: 10, questions: 0, playbacks: 1 }, next: "notes set_plan, then build",
    },
  };
  assert.deepEqual(failing(transcript), ["path_then_open_question", "open_lines_asked"]);
  assert.match(detail(transcript, "open_lines_asked"), /^3 lines the request left open are not the person's words in kino's brief: message, look_sound, never/);
  assert.match(detail(transcript, "path_then_open_question"), /first message \(event 3\) asks 0 questions/);
});

test("a playback answer logged as a question fails the count of playbacks and the confirmation", () => {
  const transcript = structuredClone(fixture);
  const call = transcript.events.findLast((event) => event.type === "call");
  call.input.log = [{ q: "What's wrong or missing?", a: brief.playbackReply }];
  Object.assign(transcript.saved.replies, { questions: 4, playbacks: 0 });
  transcript.saved.brief.confirmedRev = null;
  assert.deepEqual(failing(transcript), ["kino_counted_replies", "brief_confirmed"]);
  assert.equal(detail(transcript, "kino_counted_replies"), "kino counted 4 replies (0 playbacks); the transcript has 4 replies (1 playback).");
});

test("an 11th question fails the 10-reply rule even when the person never answers it", () => {
  const transcript = structuredClone(fixture);
  const asks = Array.from({ length: 7 }, (_, index) => [{ type: "agent", text: `One more: question ${index + 1}?` }, { type: "person", text: brief.fallbackReply }]).flat();
  // 3 questions, the playback, then 7 more asks: 11 asks and 10 replies (the harness stops at 10).
  transcript.events.splice(playbackIndex(transcript) + 2, 0, ...asks.slice(0, -1));
  assert.ok(failing(transcript).includes("replies_at_most_10"));
  assert.match(detail(transcript, "replies_at_most_10"), /^11 messages asked for a reply and the person sent 10 replies after the request; the limit is 10\.$/);
});

test("--brief all leaves the direction briefs out with Codex", () => {
  assert.ok(parseArgs(["--brief", "all"]).briefs.includes("direction-01"));
  const { briefs } = parseArgs(["--brief", "all", "--agent", "codex"]);
  assert.ok(!briefs.includes("direction-01"));
  assert.ok(briefs.includes("promo-01") && briefs.length > 20, "Codex keeps the other briefs");
});

// Review round 2 of B2a: an agent cannot let a stop pass by itself, so a one-shot run (no one to
// answer) starts with the four stops set to allow in the person's settings; a direction run,
// where the harness plays the person, keeps the defaults.
test("a one-shot eval run starts with every stop set to allow; a direction run keeps the defaults", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-eval-settings-"));
  try {
    const oneShot = path.join(folder, "one-shot");
    await prepareSettings(oneShot, { id: "promo-01" });
    const { settings, dropped } = loadSettings(JSON.parse(await readFile(path.join(oneShot, "agent", "dashboard.json"), "utf8")).settings);
    assert.deepEqual(dropped, []);
    assert.deepEqual(stopRules(settings.approvals, settings.limits).policy, { board: "allow", rough: "allow", color: "allow", sound: "allow" });
    assert.equal(settings.approvals["final-render"], "ask", "render approvals stay as they were");
    const direction = path.join(folder, "direction");
    await prepareSettings(direction, { id: "direction-01", direction: true });
    await assert.rejects(readFile(path.join(direction, "agent", "dashboard.json")), { code: "ENOENT" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("quotes are compared word for word; only quote marks, spacing, end marks and case are forgiven", () => {
  assert.equal(normalizeQuote("  No meme text  and\ndon’t crop our faces out. "), "no meme text and don't crop our faces out");
  const transcript = structuredClone(fixture);
  transcript.saved.brief.fields.never.quote = "No meme text, and don't crop our faces out!";
  assert.deepEqual(failing(transcript), ["quotes_exact"], "an added comma is a change of words");
  transcript.saved.brief.fields.never.quote = "NO MEME TEXT AND DON’T CROP OUR FACES OUT!";
  assert.deepEqual(failing(transcript), []);
});

test("the playback is the last list before \"What's wrong or missing?\"", () => {
  const text = "Saved. What I did:\n- made the project\n- read the clip\n\nHere's the brief.\n- a\n- b\n\n- c\n- d\n- e\nWhat's wrong or missing?";
  assert.deepEqual(playbackLines(text), ["- a", "- b", "- c", "- d", "- e"]);
});

test("the scripted person answers the playback, then each question with the reply it matches", () => {
  const playback = fixture.events[playbackIndex(fixture)].text;
  assert.deepEqual(pickReply(brief, playback), { kind: "playback", text: brief.playbackReply, index: null });
  assert.equal(pickReply(brief, "Got it. Who is it for?").text, brief.replies[0].text);
  // The question sentence is matched, not the rest of the turn ("before" holds "for").
  assert.equal(pickReply(brief, "I'll check before I build. What would make you wince if I got it wrong?", { used: [0] }).text, brief.replies[2].text);
  assert.equal(pickReply(brief, "Anything else I should know?", { used: [0] }).text, brief.replies[1].text, "no match: the first unused reply");
  assert.equal(pickReply(brief, "Anything else?", { used: [0, 1, 2, 3] }).text, brief.fallbackReply);
  assert.equal(pickReply(brief, "Saved the brief. Building now."), null, "a turn that asks nothing ends the run");
  assert.equal(pickReply(brief, "Who is it for?", { count: 10 }), null, "no 11th reply");
  assert.equal(pickReply(brief, playback, { count: 10 }), null, "not even to a playback");
});

// A stand-in for Claude Code. With MODE "follows" it behaves as the direction guide asks; with
// "asks-forever" it breaks the rules: it asks one more question every turn and never plays the
// brief back. It reads stream-json messages on stdin, prints stream-json turns, and makes its
// kino calls through POST /api/agent/<verb> (the address comes from the file --mcp-config
// names). It writes what it heard next to that file, so the test can check the replies it got.
const STUB = String.raw`
const MODE = "follows";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[args.indexOf("--input-format") + 1] !== "stream-json") { console.error("stub claude: no --input-format stream-json"); process.exit(3); }
const configPath = args[args.indexOf("--mcp-config") + 1];
const url = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.kino.env.MOTION_API_URL;
const heard = [];
let id = 0;
const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 };
const print = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const say = (text) => print({ type: "assistant", message: { id: "msg_" + (++id), role: "assistant", content: [{ type: "text", text }], usage } });
async function call(tool, input) {
  const reply = await (await fetch(url + "/api/agent/" + tool, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json();
  const useId = "toolu_" + (++id);
  print({ type: "assistant", message: { id: "msg_" + id, role: "assistant", content: [{ type: "tool_use", id: useId, name: "mcp__kino__" + tool, input }], usage } });
  print({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: [{ type: "text", text: reply.text }], is_error: Boolean(reply.isError) }] } });
  if (reply.isError) throw new Error(tool + " failed: " + reply.text);
  return reply;
}
const project = "skate-crew";
const asked = ["Who's it for, and what should they feel after watching?",
  "If we don't set the look, I'll fall back on generic choices. What should it look and sound like?",
  "What would make you wince if I got it wrong?"];
const said = [];
const save = (fields, q, a, extra = {}) => call("notes", { project, action: "brief", ...(fields ? { fields } : {}), log: [{ q, a, ...extra }] });
let playedRev = null;
const followTurns = [
  async () => {
    await call("project", { action: "create", id: project, name: "Skate crew TikTok", width: 1080, height: 1920, duration: 24 });
    say("Up to 3 quick questions, then I play the brief back before I build. Say \"just start\" to skip the questions.");
    say(asked[0]);
  },
  async (reply) => {
    await save({ ask: [said[0], reply], about: { text: "the skate crew", by: "you", quote: "my skate crew" },
      message: { text: "skate crew; make them want to go out and skate", by: "you", quote: reply },
      plays_on: { text: "TikTok, 9:16, 24 s", by: "you", quote: "24 second TikTok" },
      made_from: { text: "skate.mp4", by: "you", quote: "skate.mp4" } }, asked[0], reply);
    say(asked[1]);
  },
  // Each reply they typed is stored with the ask: a reply logged in the same call proves no quote.
  async (reply) => { await save({ ask: reply, look_sound: { text: "raw and bright; street sound; no synth dings", by: "you", quote: reply } }, asked[1], reply); say(asked[2]); },
  async (reply) => {
    const saved = await save({ ask: reply, never: { text: "no meme text; keep the faces in", by: "you", quote: reply },
      key_moment: { text: "the biggest trick, near the end", by: "guessed" } }, asked[2], reply);
    playedRev = saved.data.brief.rev;
    say(["Here's the brief. Quotes are yours; \"guess\" is mine.",
      "- message: you said \"" + said[1] + "\"", "- plays on: you said \"24 second TikTok\" (so 9:16)", "- made from: you said \"skate.mp4\"",
      "- look and sound: you said \"" + said[2] + "\"", "- never: you said \"" + reply + "\"", "- key moment: guess: the biggest trick, near the end",
      "What's wrong or missing?"].join("\n"));
  },
  async (reply) => { await save(null, "What's wrong or missing?", reply, { kind: "playback", rev: playedRev, confirmed: true }); say("The brief is confirmed. I'll stop here for today."); },
];
// Asks forever: the path and the open question, then one more question after every reply.
const askTurn = async (reply, index) => {
  if (index === 0) {
    await call("project", { action: "create", id: project, name: "Skate crew TikTok", width: 1080, height: 1920, duration: 24 });
    say('Up to 3 quick questions, then I play the brief back before I build. Say "just start" to skip the questions.');
    say(asked[0]);
    return;
  }
  await save(null, "question " + index + "?", reply);
  say("One more thing, question " + (index + 1) + "?");
};
print({ type: "system", subtype: "init", model: "stub-model", claude_code_version: "0.0.0-stub", tools: [] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content.map((part) => part.text).join("");
  heard.push(text);
  said.push(text);
  writeFileSync(path.join(path.dirname(configPath), "stub-heard.json"), JSON.stringify(heard));
  if (MODE === "asks-forever") await askTurn(text, heard.length - 1);
  else await (followTurns[heard.length - 1] ?? (async () => say("Nothing more to do.")))(text);
  print({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "", usage, total_cost_usd: 0.001 * heard.length, duration_ms: 5 });
}
`;

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

// Runs evals/run.mjs on direction-01 with the stub claude in `mode`, in a folder of its own.
async function runStub(mode, check) {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-direction-eval-"));
  try {
    const bin = path.join(folder, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "stub-claude.mjs"), STUB.replace('const MODE = "follows";', `const MODE = ${JSON.stringify(mode)};`));
    await writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "stub-claude.mjs")}" "$@"\n`);
    await chmod(path.join(bin, "claude"), 0o755);
    const out = path.join(folder, "batch");
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: "stub" };
    const started = Date.now();
    const { code, output } = await runNode(["evals/run.mjs", "--brief", "direction-01", "--out", out], env);
    const runFolder = path.join(out, "direction-01-claude-1");
    const read = async (name) => JSON.parse(await readFile(path.join(runFolder, name), "utf8"));
    await check({ code, output, out, read, seconds: (Date.now() - started) / 1000 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// The stub saves the brief with the real server's notes {action:"brief"} (backend/agent/brief.mjs).
test("evals/run.mjs plays the person to a stub claude and scores the transcript", { timeout: 120_000 }, () => runStub("follows", async ({ code, output, read, seconds }) => {
    assert.equal(code, 0, output);
    const runFolder = { transcript: "transcript.json", result: "result.json", heard: "stub-heard.json" };
    const transcript = await read(runFolder.transcript);
    const result = await read(runFolder.result);
    const heard = await read(runFolder.heard);

    // The stub got the request, then the scripted replies in order, and nothing after the playback reply.
    assert.match(heard[0], /^Make me a 24 second TikTok with kino from \/.+\/media\/skate\.mp4\.$/);
    assert.deepEqual(heard.slice(1), [...brief.replies.slice(0, 3).map((reply) => reply.text), brief.playbackReply]);
    assert.deepEqual(transcript.events.filter((event) => event.type === "person").map((event) => event.text), heard);

    assert.equal(transcript.version, 1);
    assert.equal(transcript.source, "claude 0.0.0-stub stub-model");
    assert.equal(transcript.project, "skate-crew");
    assert.deepEqual(transcript.saved.replies, { count: 4, limit: 10, questions: 3, playbacks: 1, stops: 0 });
    assert.equal(transcript.saved.brief.fields.never.quote, brief.replies[2].text);
    assert.equal(transcript.saved.brief.confirmedRev, 3, "the playback's yes confirmed the revision played back");
    assert.equal(checkDirection(transcript, brief).passed, true, JSON.stringify(checkDirection(transcript, brief).checks));
    assert.equal(result.passed, true);
    assert.equal(result.agentReport.ended, "playback answered");
    assert.equal(result.agentReport.finished, true);
    assert.equal(result.agentReport.costUsd, 0.005, "the last result's session total, not the sum");
    assert.equal(result.agentReport.outputTokens, 100, "each result's usage added up");
    assert.equal(result.export, undefined, "a direction run makes no video");
    assert.match(output, /PASS · 10 of 10 brief rules · ended: playback answered/);
    assert.match(output, /ok {3}quotes_exact: /);
    console.log(`direction-01 with the stub claude: ${seconds.toFixed(1)} s`);
}));

// A run that breaks the rules is reported as failed everywhere: result.json, summary.json and
// the printed lines. The person stops at 10 replies, and the 11th question still fails the rule.
test("evals/run.mjs reports a stub claude that keeps asking as failed", { timeout: 120_000 }, () => runStub("asks-forever", async ({ code, output, out, read }) => {
  assert.equal(code, 0, output);
  const result = await read("result.json");
  const transcript = await read("transcript.json");
  const heard = await read("stub-heard.json");
  assert.equal(heard.length, 11, "the request and 10 replies, never an 11th");
  assert.equal(result.agentReport.ended, "10 replies");
  assert.equal(result.passed, false);
  const failed = result.direction.checks.filter((check) => !check.ok).map((check) => check.id);
  assert.ok(failed.includes("replies_at_most_10") && failed.includes("questions_at_most_3") && failed.includes("playback_5_to_8_lines"), failed.join(", "));
  assert.equal(result.direction.checks.find((check) => check.id === "replies_at_most_10").detail,
    "11 messages asked for a reply and the person sent 10 replies after the request; the limit is 10.");
  assert.equal(transcript.saved.replies.count, 10, "kino counted the 10 replies the stub logged");
  const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
  assert.equal(summary.results[0].passed, false);
  assert.match(output, /\n {2}fail · \d+ of 10 brief rules · ended: 10 replies/);
  assert.match(output, /FAIL replies_at_most_10: 11 messages asked for a reply/);
  assert.match(output, /Passed 0 of 1\./);
}));
