// The storyboard eval (B4b, evals/board.mjs): the checker on a hand-written transcript and on
// copies that each break one rule, kino's own ask read by the checker, the board brief in
// --brief all, and one run of evals/run.mjs on board-01 end to end with a stub `claude` that
// talks to a real kino server. No model, API key or network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkBoard, freshClaim, isBoardAsk } from "../evals/board.mjs";
import { checkDirection, pickReply } from "../evals/direction.mjs";
import { parseArgs } from "../evals/run.mjs";
import { YOUR_CALL } from "../backend/agent/board.mjs";
import { boardAsk } from "../backend/agent/board-text.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(root, "evals/fixtures/board-01.hand-written.json"), "utf8"));
const brief = JSON.parse(readFileSync(path.join(root, "evals/briefs.json"), "utf8")).briefs.find((entry) => entry.id === "board-01");
const CHECKS = ["board_asked", "sent_as_written", "my_calls_listed", "fresh_said", "fresh_true", "checkpoint_fresh", "questions_once"];
const REPLY_LINE = "Reply: approve · approve with notes: ... · redo: ...";
const failing = (transcript) => checkBoard(transcript, brief).checks.filter((check) => !check.ok).map((check) => check.id);
const detail = (transcript, id) => checkBoard(transcript, brief).checks.find((check) => check.id === id).detail;
const askEvent = (transcript) => transcript.events.find((event) => event.type === "agent" && event.text.includes("The storyboard is ready (C"));
const checkpointCall = (transcript) => transcript.events.find((event) => event.type === "call" && event.input?.action === "checkpoint");
// The ask's fresh-eyes line set to `line`, and the checkpoint's `fresh` to `fresh` (undefined: left out).
function setFresh(transcript, line, fresh) {
  const ask = askEvent(transcript);
  ask.text = ask.text.replace(/^Fresh-eyes check: .*$/m, line).replace(/^This app cannot start a second agent.*\n\n/, "");
  const call = checkpointCall(transcript);
  if (fresh === undefined) delete call.input.fresh;
  else call.input.fresh = fresh;
}

test("the hand-written board transcript passes every board rule and every brief rule, and says it is no model run", () => {
  const result = checkBoard(fixture, brief);
  assert.deepEqual(result.checks.map((check) => check.id), CHECKS);
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  for (const check of result.checks) assert.match(check.detail, /\d/, `${check.id} says its numbers`);
  const direction = checkDirection(fixture, brief);
  assert.equal(direction.passed, true, JSON.stringify(direction.checks.filter((check) => !check.ok)));
  assert.equal(fixture.source, "hand-written");
  assert.match(fixture.note, /Not a model run/);
  assert.equal(detail(fixture, "fresh_true"), "The board ask (event 16) says skipped, with 0 Task or Agent calls before it.");
  assert.equal(detail(fixture, "my_calls_listed"), 'The board ask (event 16) lists 3 calls under "My calls (say no to any)".');
});

test("a copy that breaks one board rule fails exactly that check", () => {
  const broken = {
    sent_as_written(transcript) { const ask = askEvent(transcript); ask.text = ask.text.replace(`\n${REPLY_LINE}`, "\nTell me what you think."); },
    my_calls_listed(transcript) { const ask = askEvent(transcript); ask.text = ask.text.replace(/^My calls \(say no to any\): .*\n/m, ""); },
    // The first ask without fresh: kino says "not reported".
    fresh_said(transcript) { setFresh(transcript, "Fresh-eyes check: not reported.", undefined); },
    // "ran", but no second agent was started (this eval's Claude has no Task tool).
    fresh_true(transcript) { setFresh(transcript, "Fresh-eyes check: ran.", "ran"); },
    // The call said ran; the message sent says skipped.
    checkpoint_fresh(transcript) { checkpointCall(transcript).input.fresh = "ran"; },
    // Two question messages between the playback's answer and the ask.
    questions_once(transcript) {
      const at = transcript.events.indexOf(askEvent(transcript)) - 4;
      transcript.events.splice(at, 0,
        { type: "agent", text: "Should the date sit at the top or the bottom?" }, { type: "person", text: "Your call." },
        { type: "agent", text: "And should the text be white?" }, { type: "person", text: "Your call." });
    },
  };
  for (const [check, breakIt] of Object.entries(broken)) {
    const transcript = structuredClone(fixture);
    breakIt(transcript);
    assert.deepEqual(failing(transcript), [check], check);
  }
  const twice = structuredClone(fixture);
  broken.questions_once(twice);
  assert.equal(detail(twice, "questions_once"), "2 messages asked a question between the playback (event 9) and the board ask (event 20); the limit is 1.");
  const unreported = structuredClone(fixture);
  broken.fresh_said(unreported);
  assert.equal(detail(unreported, "fresh_said"), 'The board ask (event 16) says "Fresh-eyes check: not reported." (0 of 2 allowed answers): ask with fresh "ran" or "skipped".');
});

// Review round 1 of B4b: kino keeps a waiting round's fresh when the agent asks again without
// it ("all shots"), so the check reads the last fresh sent, not the last call.
test("asked again while the board waits, without fresh: the ask keeps what was sent, and the check passes", () => {
  const again = structuredClone(fixture);
  const call = checkpointCall(again);
  again.events.splice(again.events.indexOf(call) + 1, 0, { type: "call", tool: "notes", input: { project: call.input.project, action: "checkpoint", id: "board", all: true } });
  assert.deepEqual(failing(again), []);
  assert.equal(detail(again, "checkpoint_fresh"), 'The checkpoint at event 15 sent fresh "skipped" and the board ask (event 17) says "skipped".');
  // No checkpoint sent fresh at all: counted, and failed.
  delete call.input.fresh;
  assert.equal(detail(again, "checkpoint_fresh"), '2 board checkpoints before it sent fresh (none) and the board ask (event 17) says "skipped": they must agree.');
});

// Review round 2 of B4b: after the brief, the board's open items got "Stop there for today"
// (a question that says board or sound) or the audience line (one that matches nothing), so a
// run that followed storyboard.md never reached the board ask, or asked twice.
test("board-01's person answers the board's open items with 'your call' after the playback, and the board ask ends the run", () => {
  const reply = (question, used, played) => pickReply(brief, question, { used, count: used.length + (played ? 1 : 0), played });
  for (const question of ["On the board, should shot 2 show the gate or the playground?", "Which sound should the board use?", "Should the date be big?",
    "Two things before the storyboard: should shot 2 show the gate? And which sound?"])
    assert.deepEqual(reply(question, [0, 1], true), { kind: "question", text: brief.boardReply, index: null }, question);
  assert.match(brief.boardReply, YOUR_CALL, "kino reads it as leaving the open items to the agent");
  // Before the playback, the brief's questions get the brief's replies, as in every direction brief.
  assert.equal(reply("What should it look and sound like?", [], false).text, brief.replies[0].text);
  assert.equal(reply("Who is it for, and how should they feel?", [0, 1], false).text, brief.replies[2].text);
  assert.equal(reply("Anything else I should know?", [0, 1], false).text, brief.replies[2].text, "no match: the first unused reply");
  // kino's ask ends the run, even when the agent adds a question of its own.
  const ask = askEvent(fixture).text;
  assert.equal(reply(ask, [0, 1], true), null);
  assert.equal(reply(`${ask}\n\nWant me to change anything first?`, [0, 1], true), null);
  assert.ok(!brief.replies.some((entry) => /board|storyboard|stop there/i.test(entry.text)), "no brief reply talks about the board");
});

test("a check that ran needs a second agent before the ask; a skipped one needs none", () => {
  const ran = structuredClone(fixture);
  setFresh(ran, "Fresh-eyes check: ran.", "ran");
  const call = checkpointCall(ran);
  ran.events.splice(ran.events.indexOf(call), 0, { type: "call", tool: "Task", input: { description: "fresh eyes on the board", prompt: "Read the storyboard with look {project, mode:\"board\", page}" }, isError: false });
  assert.deepEqual(failing(ran), []);
  assert.equal(detail(ran, "fresh_true"), "The board ask (event 17) says ran, with 1 Task call (event 15) before it.");
  // A Task call that failed started no second agent.
  const failed = structuredClone(ran);
  failed.events[14].isError = true;
  assert.deepEqual(failing(failed), ["fresh_true"]);
  assert.equal(detail(failed, "fresh_true"), "The board ask (event 17) says ran, with 0 Task or Agent calls before it: a check that ran needs a second agent.");

  // Claude Code's newer name for the tool counts too, and a second agent makes "skipped" untrue.
  const skipped = structuredClone(fixture);
  skipped.events.splice(skipped.events.indexOf(checkpointCall(skipped)), 0, { type: "call", tool: "Agent", input: {}, isError: false });
  assert.deepEqual(failing(skipped), ["fresh_true"]);
  assert.match(detail(skipped, "fresh_true"), /says skipped, with 1 Agent call \(event 15\) before it: a second agent was started/);
});

test("without a board ask that worked, every board check fails and says so", () => {
  const refused = structuredClone(fixture);
  checkpointCall(refused).isError = true;
  assert.deepEqual(failing(refused), CHECKS);
  assert.match(detail(refused, "board_asked"), /^0 notes checkpoint calls with id "board" worked, in 16 events\.$/);
  // The call worked, but the agent sent its own summary instead of kino's ask.
  const retold = structuredClone(fixture);
  askEvent(retold).text = "I made a 3-shot storyboard. Have a look and tell me.";
  assert.deepEqual(failing(retold), CHECKS);
  assert.match(detail(retold, "board_asked"), /worked at event 15, but 0 agent messages after it say "The storyboard is ready \(C…"\./);
});

// kino's own words, so a change to the ask cannot leave the checker reading old text.
test("the checker reads kino's own ask: the header, My calls, the Reply line and each fresh-eyes line", () => {
  const media = "/api/media/park.mp4";
  const board = { music: "none", calls: ["Inter 700 for both lines"], open: [], shots: [
    { id: "S1", cue: 0, dur: 6, pacing: "free", media, in: 0, crop: [34.2, 0, 31.6, 100], subject: { what: "the bars", box: [38, 10, 24, 50] }, follow: "steady", text: { text: "The park reopens", family: "Inter", weight: 700, size: 96, y: 30 }, sound: "none", why: "the news" },
    { id: "S2", cue: 6, dur: 6, pacing: "free", media, in: 6, crop: [50, 0, 31.6, 100], subject: { what: "the counter", box: [56, 20, 20, 40] }, follow: "steady", text: { text: "Saturday", family: "Inter", weight: 700, size: 120, y: 30 }, sound: "none", why: "the day" },
  ] };
  const ask = (fresh) => boardAsk({ id: "C1", board, frame: { width: 1080, height: 1920 }, seconds: 12, message: "the park reopens Saturday", offerSound: true, fresh }).text;
  for (const fresh of ["ran", "skipped", "not reported"]) {
    const text = ask(fresh);
    assert.equal(isBoardAsk(text), true);
    assert.equal(freshClaim(text), fresh, `${fresh}: ${text}`);
    assert.ok(text.includes(`\n${REPLY_LINE}`), text);
    assert.ok(text.includes("\nMy calls (say no to any): Inter 700 for both lines\n"), text);
    const transcript = structuredClone(fixture);
    const sent = askEvent(transcript);
    sent.text = text;
    if (fresh === "not reported") delete checkpointCall(transcript).input.fresh;
    else checkpointCall(transcript).input.fresh = fresh;
    assert.deepEqual(failing(transcript), { ran: ["fresh_true"], skipped: [], "not reported": ["fresh_said"] }[fresh], fresh);
  }
  assert.equal(freshClaim(ask(null)), null, "no fresh: no line (a later ask)");
});

test("--brief all runs board-01 with Claude, and leaves it out with Codex", () => {
  assert.ok(parseArgs(["--brief", "all"]).briefs.includes("board-01"));
  const { briefs } = parseArgs(["--brief", "all", "--agent", "codex"]);
  assert.ok(!briefs.includes("board-01"));
  assert.ok(briefs.includes("promo-01"), "Codex keeps the other briefs");
  assert.equal(brief.direction, true, "a board brief is a direction brief: the harness plays the person");
  assert.deepEqual(brief.media.map((file) => file.name), ["park.mp4"]);
  assert.ok(!brief.media[0].ffmpeg.some((arg) => /anoisesrc|sine|-c:a/.test(arg)), "the clip is silent: nothing to hear, nothing played");
});

// A stand-in for Claude Code that follows the brief guide and the storyboard reference. It
// reads stream-json messages on stdin, prints stream-json turns, and makes its kino calls
// through POST /api/agent/<verb> (the address comes from the file --mcp-config names). Its
// board has one open item, asked in one message; the person's "your call" goes to kino as their
// words, the stub decides it and lists it in its calls. It has no second agent, so it asks with
// fresh:"skipped" and sends kino's ask as written.
const STUB = String.raw`
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
const configPath = args[args.indexOf("--mcp-config") + 1];
const url = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.kino.env.MOTION_API_URL;
const heard = [];
let id = 0;
const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 };
const print = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const say = (text) => print({ type: "assistant", message: { id: "msg_" + (++id), role: "assistant", content: [{ type: "text", text }], usage } });
async function call(tool, input) {
  const reply = await (await fetch(url + "/api/agent/" + tool, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: "claude-code", ...input }) })).json();
  const useId = "toolu_" + (++id);
  print({ type: "assistant", message: { id: "msg_" + id, role: "assistant", content: [{ type: "tool_use", id: useId, name: "mcp__kino__" + tool, input }], usage } });
  print({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: [{ type: "text", text: reply.text }], is_error: Boolean(reply.isError) }] } });
  if (reply.isError) throw new Error(tool + " failed: " + reply.text);
  return reply;
}
// As kino's MCP client imports (backend/agent/client.mjs importFile): the service checks the
// file, then the file goes to POST /api/media. The transcript shows one project import call.
async function importFile(file) {
  const check = await (await fetch(url + "/api/agent/project", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: "claude-code", action: "import", name: path.basename(file), size: statSync(file).size }) })).json();
  if (!check.data?.ok) throw new Error("import refused: " + check.text);
  const response = await fetch(url + "/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": path.basename(file), "x-kino-agent": "1" }, body: readFileSync(file) });
  const media = await response.json();
  const src = media.src ?? media.media?.src;
  const useId = "toolu_" + (++id);
  print({ type: "assistant", message: { id: "msg_" + id, role: "assistant", content: [{ type: "tool_use", id: useId, name: "mcp__kino__project", input: { action: "import", file } }], usage } });
  print({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: [{ type: "text", text: "imported " + src }], is_error: !response.ok } ] } });
  if (!response.ok || !src) throw new Error("import failed: " + JSON.stringify(media));
  return src;
}
const project = "park-reopens";
const asked = ["If we don't set the look, I'll fall back on generic choices. What should it look and sound like?", "What would make you wince if I got it wrong?"];
let playedRev = null;
let media = null;
const shot = (cue, crop, what, box, text) => ({ cue, dur: 4, pacing: "free", media, in: cue, crop, subject: { what, box }, follow: "steady",
  text: text ? { text, family: "Inter", weight: 700, size: 96, y: 30 } : "none", sound: "none", why: "one beat of the news", move: { kind: "transition", name: "zoom-through", ref: "launch-film@7.27" } });
const shots = () => [shot(0, [34.2, 0, 31.6, 100], "the color bars", [38, 10, 24, 50], "The park reopens"),
  shot(4, [10, 0, 31.6, 100], "the moving circle", [14, 30, 22, 35], null), shot(8, [50, 0, 31.6, 100], "the counter", [56, 20, 20, 40], "Saturday")];
const calls = ["Inter 700 for both lines", "the clip's own sound only"];
const openItem = "Should shot 2 show the moving circle or the color bars?";
const turns = [
  async () => {
    await call("project", { action: "create", id: project, name: "Park reopens TikTok", width: 1080, height: 1920, duration: 12 });
    say("Up to 2 quick questions, then I play the brief back and make the storyboard. Say \"just start\" to skip the questions.");
    say(asked[0]);
  },
  async (reply) => {
    await call("notes", { project, action: "brief", fields: {
      message: { text: "the park reopens Saturday", by: "you", quote: "it says the park reopens Saturday" },
      plays_on: { text: "TikTok, 9:16, 12 s", by: "you", quote: "12 second TikTok" },
      made_from: { text: "park.mp4", by: "you", quote: "park.mp4" },
      look_sound: { text: "bright and plain; the park's own sound", by: "you", quote: reply } }, log: [{ q: asked[0], a: reply }] });
    say(asked[1]);
  },
  async (reply) => {
    const saved = await call("notes", { project, action: "brief", fields: { never: { text: "no meme text", by: "you", quote: reply },
      key_moment: { text: "the date, Saturday, at the end", by: "guessed" } }, log: [{ q: asked[1], a: reply }] });
    playedRev = saved.data.brief.rev;
    say(["Here's the brief. Quotes are yours; \"guess\" is mine.", "- message: you said \"it says the park reopens Saturday\"",
      "- plays on: you said \"12 second TikTok\" (so 9:16)", "- made from: you said \"park.mp4\"", "- look and sound: you said \"" + heard[1] + "\"",
      "- never: you said \"" + reply + "\"", "- key moment: guess: the date, Saturday, at the end", "What's wrong or missing?"].join("\n"));
  },
  async (reply) => {
    await call("notes", { project, action: "brief", log: [{ q: "What's wrong or missing?", a: reply, kind: "playback", rev: playedRev, confirmed: true }] });
    const file = /from (\S+\.mp4)/.exec(heard[0])[1];
    media = await importFile(file);
    await call("edit", { project, ops: [{ op: "add_layer", layerType: "video", name: "park", properties: { src: media } }] });
    await call("edit", { project, ops: [{ op: "board", music: "none", calls, open: [openItem], shots: shots() }] });
    say("One thing before I show you the storyboard. " + openItem);
  },
  async (reply) => {
    const left = await call("notes", { project, action: "checkpoint", id: "board", words: reply });
    if (left.data?.status !== "your_call") throw new Error("not left to me: " + left.text);
    await call("edit", { project, ops: [{ op: "board", music: "none", calls: [...calls, "shot 2 shows the moving circle (you left it to me)"], open: [], shots: shots() }] });
    const ask = await call("notes", { project, action: "checkpoint", id: "board", fresh: "skipped" });
    say("This app cannot start a second agent, so the fresh-eyes check was skipped.\n\n" + ask.data.ask);
  },
];
print({ type: "system", subtype: "init", model: "stub-model", claude_code_version: "0.0.0-stub", tools: [] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content.map((part) => part.text).join("");
  heard.push(text);
  writeFileSync(path.join(path.dirname(configPath), "stub-heard.json"), JSON.stringify(heard));
  try { await (turns[heard.length - 1] ?? (async () => say("Nothing more to do.")))(text); }
  catch (error) { say("Stopped: " + error.message); }
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

// The harness makes park.mp4 with FFmpeg (12 s, silent), starts its own kino server, and plays the person.
test("evals/run.mjs plays the person past the playback to the storyboard ask and scores both rule sets", { timeout: 180_000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-board-eval-"));
  try {
    const bin = path.join(folder, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "stub-claude.mjs"), STUB);
    await writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "stub-claude.mjs")}" "$@"\n`);
    await chmod(path.join(bin, "claude"), 0o755);
    const out = path.join(folder, "batch");
    const started = performance.now();
    const { code, output } = await runNode(["evals/run.mjs", "--brief", "board-01", "--out", out],
      { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: "stub" });
    const runFolder = path.join(out, "board-01-claude-1");
    const read = async (name) => JSON.parse(await readFile(path.join(runFolder, name), "utf8"));
    assert.equal(code, 0, output);
    const heard = await read("stub-heard.json");
    const transcript = await read("transcript.json");
    const result = await read("result.json");

    // The request, the two scripted answers, the playback's answer and "your call" to the open
    // item (review round 2 of B4b); nothing after the board ask.
    assert.match(heard[0], /^Make me a 12 second TikTok with kino from \/.+\/media\/park\.mp4: it says the park reopens Saturday\. Show me the storyboard before you build\.$/);
    assert.deepEqual(heard.slice(1), [brief.replies[0].text, brief.replies[1].text, brief.playbackReply, brief.boardReply]);
    const ask = transcript.events.findLast((event) => event.type === "agent");
    assert.ok(!ask.text.startsWith("Stopped:"), ask.text);
    assert.match(ask.text, /\nThe storyboard is ready \(C1\): 3 shots, 12 s, 1080×1920, no music\.\n/);
    assert.match(ask.text, /\nFresh-eyes check: skipped \(no second agent in this app\)\.\n/);
    assert.equal(result.agentReport.ended, "board asked");
    assert.equal(result.direction.passed, true, JSON.stringify(result.direction.checks.filter((check) => !check.ok)));
    assert.deepEqual(result.board.checks.map((check) => check.id), CHECKS);
    assert.equal(result.board.passed, true, JSON.stringify(result.board.checks.filter((check) => !check.ok)));
    assert.equal(result.passed, true);
    assert.match(output, /PASS · 10 of 10 brief rules · ended: board asked/);
    assert.match(output, /storyboard: 7 of 7 board rules/);
    assert.match(output, /ok {3}fresh_true: The board ask \(event \d+\) says skipped, with 0 Task or Agent calls before it\./);

    // The same run with the check broken: its ask is scored as failed, and so is the run.
    const brokenAsk = structuredClone(transcript);
    brokenAsk.events.findLast((event) => event.type === "agent").text = ask.text.replace(/^My calls .*\n/m, "");
    assert.deepEqual(checkBoard(brokenAsk, brief).checks.filter((check) => !check.ok).map((check) => check.id), ["my_calls_listed"]);
    console.log(`board-01 with the stub claude: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
