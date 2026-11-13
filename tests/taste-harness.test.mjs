// The pure parts of the taste harness (evals/taste): cut list to strip times, ffmpeg loudness
// parsing, and the Bradley-Terry ladder with owner agreement.
import assert from "node:assert/strict";
import test from "node:test";
import { agreement, allCutsFrom, bradleyTerry, cutsFrom, eventsFrom, lineLevels, outsideFlashes, parseEbur128, shortTermCurve, splitPicks, stripTimes } from "../evals/taste/lib.mjs";
import { beatFit, beatFitLine } from "../backend/measure/beat-fit.mjs";
import { answerJson, combine, factsText } from "../evals/taste/judge.mjs";
import { fromAppPick, fromJudged, ladder } from "../evals/taste/ladder.mjs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentArgs, agentStateFile, APPROVAL, appCommand,askedAfter, callsTool, checkReplies, htmlText, nextMessage, pendingPick, personStep, pickMp4, PICK_REPLY, pollUntil, roundStatus, projectIdFor, mcpConfig, projectIdFromStatus, promptFor, REPLY, replyFor, seedHouse, stopEntry, summarize, waitEntry, watchOver, WATCH_REPLY } from "../evals/taste/firstpass.mjs";
import { commandsFrom, nextOf, report, summarize as summarizeCalls } from "../scripts/harness-report.mjs";
import { stopsSummary } from "../backend/agent/stops.mjs";
import { triesView } from "../backend/agent/tries.mjs";
import { projectSeed } from "../engine/deck.js";
import { createHouseMemory, familyOf } from "../backend/house-memory.mjs";

test("cuts become 12 fps strips 0.5 s each side, joined where they overlap", () => {
  const frames = [0.5, 1, 1.04, 3].map((t, i) => ({ t, score: [30, 40, 12, 50][i] }));
  const cuts = cutsFrom(frames, { threshold: 10, gap: 0.1 });
  assert.deepEqual(cuts.map((cut) => cut.t), [0.5, 1, 3]);
  const strips = stripTimes(cuts, 3.2);
  assert.deepEqual(strips.map((strip) => [strip.from, strip.to, strip.cuts]), [[0, 1.5, [0.5, 1]], [2.5, 3.2, [3]]]);
  assert.equal(strips[0].times.length, 18);
  assert.equal(strips[1].times[0], 2.5);
});

test("a reference read: every 2-frame cut, a flash counted once, black and hold events, and the cuts against the beat", () => {
  // 3 s at 24 fps: one shot for 1 s, twelve 2-frame shots, shot B at frame 48, a white flash on
  // frames 50-51, B held still from 53, black from 68.
  const frames = Array.from({ length: 72 }, (_, n) => ({ t: n / 24, score: 0, yavg: 100, ydif: 3 }));
  for (let n = 24; n <= 48; n += 2) Object.assign(frames[n], { score: 40, yavg: n % 4 ? 90 : 110 });
  frames[49].yavg = frames[48].yavg;
  Object.assign(frames[50], { score: 60, yavg: 230, ydif: 60 });
  Object.assign(frames[51], { yavg: 230, ydif: 0 });
  Object.assign(frames[52], { score: 60, ydif: 60 });
  for (let n = 53; n < 72; n += 1) frames[n].ydif = 0;
  for (let n = 68; n < 72; n += 1) Object.assign(frames[n], { yavg: 16, score: n === 68 ? 40 : 0 });
  const events = eventsFrom(frames);
  assert.deepEqual(events, { flashes: [{ t: 2.08, end: 2.17, rise: 0.47 }], blacks: [{ t: 2.83, end: 2.96 }], holds: [{ t: 2.21, end: 2.83 }] });
  assert.equal(cutsFrom(frames).length, 3, "the strips' list (0.1 s apart) stays on the strongest");
  const cuts = outsideFlashes(allCutsFrom(frames), events.flashes);
  assert.equal(cuts.length, 15, "13 picture cuts, the flash once, the black");
  assert.deepEqual(cuts.filter((cut) => cut.flash).map((cut) => cut.t), [2.08]);
  const fit = beatFit(cuts.map((cut) => cut.t), Array.from({ length: 7 }, (_, n) => n / 2), { fps: 24 });
  assert.deepEqual([fit.cuts, fit.onBeat, fit.offsets, fit.further], [15, 0.2, { "-3": 0, "-2": 2, "-1": 0, 0: 3, 1: 0, 2: 3, 3: 0 }, 7]);
  assert.match(beatFitLine(fit), /^cuts 15 · 20% within 1 frame of a beat \(random \d+%\) · frames off the beat \(- early\) -2:2 0:3 \+2:3 more:7$/);
  // Bright shots between dark ones are shots, not flashes: dark 60, three 2-frame shots (110, 120,
  // 115), dark 60, a 6-frame shot at 130, dark 55.
  const runs = [[60, 24], [110, 2], [120, 2], [115, 2], [60, 12], [130, 6], [55, 24]];
  const bright = runs.flatMap(([yavg, count]) => Array(count).fill(yavg)).map((yavg, n, all) => ({ t: n / 24, score: n && yavg !== all[n - 1] ? 40 : 0, yavg, ydif: 3 }));
  const brightEvents = eventsFrom(bright);
  assert.deepEqual(brightEvents.flashes, []);
  assert.deepEqual(outsideFlashes(allCutsFrom(bright), brightEvents.flashes).map((cut) => cut.t), [1, 1.08, 1.17, 1.25, 1.75, 2]);
});

test("ebur128 output becomes a loudness curve and a summary", () => {
  const text = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.4  TARGET:-23 LUFS    M: -20.0 S:-120.7     I: -20.0 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 0.5  TARGET:-23 LUFS    M: -18.0 S: -19.0     I: -19.0 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS    M: -12.0 S: -14.0     I: -16.0 LUFS       LRA:   1.0 LU",
    "[Parsed_ebur128_0 @ 0x1] Summary:", "  Integrated loudness:", "    I:         -15.5 LUFS", "  Loudness range:", "    LRA:         9.3 LU",
    "  True peak:", "    Peak:       -1.2 dBFS",
  ].join("\n");
  const parsed = parseEbur128(text);
  assert.deepEqual([parsed.integrated, parsed.range, parsed.truePeak], [-15.5, 9.3, -1.2]);
  assert.deepEqual(shortTermCurve(parsed.curve, 1, 0.5), [[0.5, -19, -18], [1, -14, -12]]);
  const levels = lineLevels([{ t: 0.3, m: -30 }, { t: 0.6, m: -30 }, { t: 1.3, m: -20 }, { t: 1.6, m: -20 }], [{ start: 1.0, end: 1.5, text: "hi" }], { before: 1 });
  assert.deepEqual(levels.map((entry) => [entry.line, entry.before, entry.over]), [[-20, -30, 10]]);
});

test("the ladder ranks by wins, owner picks split in halves, a win must hold in both orders, and the judge sees no paths", () => {
  const results = [
    { a: "x", b: "y", winner: "a" }, { a: "x", b: "y", winner: "a" }, { a: "y", b: "z", winner: "a" },
    { a: "x", b: "z", winner: "same" },
  ];
  const ratings = bradleyTerry(results);
  assert.deepEqual(Object.keys(ratings), ["x", "y", "z"]);
  assert.ok(ratings.x > 0 && ratings.z < 0);
  const picks = [1, 2, 3, 4].map((n) => ({ at: `2026-10-29T0${n}`, left: "x", right: "y", pick: n === 4 ? "right" : "left" }));
  const { examples, heldOut } = splitPicks(picks);
  assert.deepEqual([examples.length, heldOut.length], [2, 2]);
  assert.deepEqual(agreement(heldOut, [{ left: "y", right: "x", pick: "right" }]), { matched: 1, compared: 2, missing: 0 });
  const answer = (post) => ({ post, A: { scores: { quality: { score: 1 } } }, B: { scores: { quality: { score: -1 } } } });
  const twice = (order, post) => [{ order, answer: answer(post) }, { order, answer: answer(post) }];
  assert.equal(combine([...twice("xy", "A"), ...twice("yx", "B")]).winner, "x");
  const split = combine([...twice("xy", "A"), ...twice("yx", "A")]);
  assert.equal(split.winner, "same");
  assert.deepEqual([split.scores.x.quality, split.scores.y.quality], [0, 0]);
  const facts = { duration: 1, size: "1x1", sourceFps: 30, cuts: [], motion: { shotLengths: {}, freezes: [], brightnessJumps: [] }, notes: ["failed on /Users/x/v1-packet/video.mp4"] };
  assert.ok(!factsText(facts).includes("v1-packet"), "no folder name reaches the blind judge");
});

test("the judge mends double quotes inside its answer's strings, and fewer than 2 answers in an order name no winner", () => {
  const slipped = `Sure:\n{"A":{"pitch":"a diary: "i asked an ai", "and it forgot me" lands","scores":{"quality":{"score":2,"times":"10"}}},
"B":{"pitch":"cards ("Introducing", "Review")","generic_moves":["boxed "captions""],"scores":{"quality":{"score":-1,"times":"3"}}},"post":"A","why":"A's "forgot me" turn",}`;
  const answer = answerJson(slipped);
  assert.equal(answer.post, "A");
  assert.equal(answer.A.pitch, 'a diary: "i asked an ai", "and it forgot me" lands');
  assert.deepEqual([answer.A.scores.quality.score, answer.B.scores.quality.score], [2, -1]);
  const dropped = answerJson('{"A":{"scores":{}},"B":{"scores":{"quality":{"score":1,"times":"2"}},"post":"B","why":"w"}');
  assert.deepEqual([dropped.post, dropped.why, dropped.B.scores.quality.score], ["B", "w", 1], "a } left off the end is closed and post lifted to the top");
  const lastDropped = answerJson('```json\n{"A":{"memorable":[{"t":1,"why":"m"}]},"B":{"memorable":[{"t":2,"why":"m"}]},"post":"A","why":"w"\n```');
  assert.deepEqual([lastDropped.post, lastDropped.why], ["A", "w"], "the very last } left off still keeps post and why, not a memorable why");
  assert.throws(() => answerJson('{"A":{},"B":{},"post":"maybe"}'), /no post/);
  const call = (order, post) => ({ order, answer: { post, A: { scores: {} }, B: { scores: {} } } });
  const few = combine([call("xy", "A"), call("xy", "A"), call("yx", "B")]);
  assert.deepEqual([few.winner, few.used], ["too_few", { xy: 2, yx: 1 }]);
  assert.deepEqual(fromJudged([{ a: "x", b: "y", winner: "too_few" }]), [], "a too-few verdict stays off the ladder");
});

test("a pick from the app's pick box becomes a ladder pick by packet id", () => {
  const ids = { "/v/one.mp4": "aaa", "/v/two.mp4": "bbb" };
  const line = { pair_id: "P1", a: "/v/one.mp4", b: "/v/two.mp4", shown_left: "b", pick: "b", words: ["story"], at: "t", mode: "video" };
  assert.deepEqual(fromAppPick(line, (file) => ids[file]), { at: "t", left: "aaa", right: "bbb", pick: "right", part: "all", words: ["story"], blind: true });
  assert.equal(fromAppPick({ ...line, pick: "same", mode: "audio" }, (file) => ids[file]).part, "sound");
  // Both bad is no win for either side: a tie on the ladder, never decisive, and counted.
  const bothBad = fromAppPick({ ...line, pick: "neither" }, (file) => ids[file]);
  assert.deepEqual([bothBad.pick, bothBad.bothBad], ["same", true]);
  const summary = ladder([], [bothBad, { ...bothBad, at: "u" }]);
  assert.deepEqual([summary.ratings.aaa, summary.ratings.bbb, summary.ownerPicks.bothBad, summary.ownerPicks.decisiveHeldOut], [0, 0, 2, 0]);
});

test("a first pass sends only the ask and the files, and keeps the final MP4 over a draft", () => {
  assert.equal(promptFor({ ask: "make a 30 s launch video ", notes: "" }, ["/r/01-home.png"]), "make a 30 s launch video\n\nFiles:\n- /r/01-home.png");
  assert.equal(htmlText("<style>a{}</style><h1>Hi &amp; bye</h1><p>one</p><p>one</p>"), "Hi & bye\none");
  const files = [{ path: "/o/work/08-clip.mp4", mtimeMs: 40 }, { path: "/o/v-r3-draft-R1.mp4", mtimeMs: 30 }, { path: "/o/v-r2-final-R1.mp4", mtimeMs: 20 }, { path: "/o/old-r1-final-R1.mp4", mtimeMs: 1 }];
  assert.deepEqual(pickMp4(files, 10), { path: "/o/v-r2-final-R1.mp4", final: true });
  assert.equal(pickMp4(files.slice(0, 1), 10), null, "an agent's own copy of a clip is not a render");
  assert.deepEqual(pickMp4(files.slice(0, 2), 10), { path: "/o/v-r3-draft-R1.mp4", final: false });
  const run = summarize([{ type: "system", subtype: "init", session_id: "s1" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "result", total_cost_usd: 1.5, num_turns: 4, result: "Rendered.", modelUsage: { m: {} } }]);
  assert.deepEqual([run.sessionId, run.cost, run.toolCalls.Bash, run.finalMessage], ["s1", 1.5, 1, "Rendered."]);
});

test("each first pass names its own project from the run id: its own deal seed and house-memory family", () => {
  const ids = ["kino-fp-8", "kino-fp-9", "kino-fp-9b", "kino-trailer-20261109-101500"].map(projectIdFor);
  assert.deepEqual(ids, ["kino-fp8", "kino-fp9", "kino-fp9b", "kino-trailer20261109101500"]);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,62}$/, "a valid kino project id");
  assert.deepEqual(ids.map(familyOf), ids, "a trailing run number does not merge runs into one family");
  assert.equal(new Set(ids.map((id) => projectSeed(id))).size, ids.length, "no two runs share a deal seed");
  assert.equal(projectIdFor("Fp 10 (retry)!"), "fp-10-retry");
  assert.equal(projectIdFor("x".repeat(80) + "-12").length, 63);
  assert.equal(promptFor({ ask: "make a video" }, ["/r/a.mp4"], "kino-fp9"), "make a video\n\nFiles:\n- /r/a.mp4\n\nUse kino-fp9 as the project id.");
  assert.equal(promptFor({ ask: "make an edit of the series" }, [], "kino-fp9"), "make an edit of the series\n\nUse kino-fp9 as the project id.", "no files: no Files list");
  assert.equal(projectIdFromStatus("kino launch (v2) trailer (kino-launch) rev 47 · 1 scene"), "kino-launch", "the id the agent really made");
  assert.equal(projectIdFromStatus("No project open."), null);
});

test("a first pass starts with the launch-v1 house memory, so seen_before can fire; none leaves it empty", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "kino-house-seed-"));
  try {
    const seeded = await seedHouse(dataDir, "launch-v1");
    assert.equal(seeded.snapshot, "launch-v1");
    assert.match(seeded.sha256, /^[0-9a-f]{64}$/);
    const others = await createHouseMemory(path.join(dataDir, "house")).others("kino-fp12", "Kino launch trailer");
    assert.deepEqual(others.map((entry) => entry.name).sort(), Array.from({ length: 10 }, (_, i) => `earlier project ${String(i + 1).padStart(2, "0")}`));
    assert.ok(others.every((entry) => !("savedAt" in entry) && entry.moments.length && entry.moments.every((moment) => moment.sig && !("print" in moment))));
    assert.deepEqual(await seedHouse(dataDir, "launch-v1"), seeded, "one snapshot, one sha256");
    assert.equal(await seedHouse(path.join(dataDir, "empty"), "none"), null);
    assert.deepEqual(await readdir(dataDir), ["house"], "none writes nothing");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a waiting kino stop gets a person's reply in order, anything else gets your call, and each stop is recorded", () => {
  // The snapshot's agent.stops is what kino's own stopsSummary gives for a project with a waiting stop.
  const waitingState = (id, kind) => ({ agent: { stops: stopsSummary({ stops: [{ id, kind, rev: 4, status: "waiting", askedAt: "2026-11-11T10:00:00Z", ask: "Here is the board." }] }) } });
  const brief = { replies: { board: ["make the opening slower", "approved"], rough: "approved" } };
  const none = nextMessage({ agent: { stops: stopsSummary({ stops: [] }) }, waitingStops: {} }, brief, []);
  assert.deepEqual(none, { message: REPLY, stop: null }, "no stop waiting: your call");
  assert.equal(nextMessage(null, brief, []).message, REPLY, "an unreadable snapshot: your call");

  const stops = [];
  const ask = (snapshot) => { const next = nextMessage(snapshot, brief, stops); stops.push(stopEntry(next.stop, 12.5, next.message)); return next.message; };
  assert.equal(ask(waitingState("C1", "board")), "make the opening slower", "the first board ask gets the first reply");
  assert.equal(nextMessage(waitingState("C1", "board"), brief, stops).message, "make the opening slower", "the same stop still waiting: the same reply, not the next");
  assert.equal(ask(waitingState("C2", "board")), "approved", "the redone board gets the second");
  assert.equal(ask(waitingState("C3", "board")), APPROVAL, "past the list: a plain approval");
  assert.equal(ask(waitingState("C4", "rough")), "approved", "a string reply is used every time");
  assert.equal(ask(waitingState("C5", "sound")), APPROVAL, "no reply given for the kind: a plain approval");
  assert.equal(replyFor({ id: "C6", kind: "rough" }, brief, stops), "approved");
  assert.deepEqual(stops[0], { kind: "board", id: "C1", askedAfter: 12.5, reply: "make the opening slower", nextToolAfter: null });
  // A stop of another project's agent still shows in waitingStops.
  assert.equal(nextMessage({ agent: null, waitingStops: { other: { id: "C9", kind: "color" } } }, {}, []).stop.kind, "color");

  assert.deepEqual(checkReplies(brief.replies), brief.replies);
  assert.deepEqual(checkReplies(undefined), {});
  for (const bad of [[], "ok", { board: [] }, { board: [1] }, { rough: " " }]) assert.throws(() => checkReplies(bad), /replies/);
  for (const kind of ["storyboard", "Board"]) assert.throws(() => checkReplies({ [kind]: "ok" }), /not a stop kind: use board, rough, color, sound, critique/, "a kind kino never asks is refused, not dropped");
  assert.deepEqual(checkReplies({ critique: "ok" }), { critique: "ok" });
  // askedAfter is the stored askedAt against the run's start; a missing or out-of-run time falls back to the turn's end.
  const t0 = Date.parse("2026-11-11T10:00:00Z");
  assert.deepEqual([askedAfter({ askedAt: "2026-11-11T10:00:07.4Z" }, t0, t0 + 12_500), askedAfter({ askedAt: null }, t0, t0 + 12_500), askedAfter({ askedAt: "nope" }, t0, t0 + 12_500), askedAfter({ askedAt: "2026-11-11T09:00:00Z" }, t0, t0 + 12_500)], [7.4, 12.5, 12.5, 12.5]);
  const tool = { type: "assistant", message: { content: [{ type: "text" }, { type: "tool_use", name: "Bash" }] } };
  assert.deepEqual([callsTool(tool), callsTool({ ...tool, parent_tool_use_id: "t1" }), callsTool({ type: "result" })], [true, false, false], "the agent's own tool calls only");
});

test("person mode: a stop is answered as before, a waiting try round makes the runner wait for the pick, the first MP4 makes it wait for a watch", () => {
  // The snapshot's agent.tries is what triesView gives for the project's saved rounds.
  const round = (id, status) => ({ id, rev: 3, question: "Which opening?", topic: "opening", status, sceneId: "s1", at: 2, from: 1, to: 3, options: [{ letter: "A", name: "slow", ready: true, ops: [] }, { letter: "B", name: "fast", ready: true, ops: [] }] });
  const snap = (rounds, extra = {}) => ({ projectId: "demo", agent: { stops: stopsSummary({ stops: [] }), tries: triesView({ tries: rounds }) }, waitingStops: {}, ...extra });
  const brief = { replies: { board: "approved" } };
  const ask = (snapshot, more = {}) => personStep(snapshot, { brief, stops: [], hasMp4: false, watchStarted: false, ...more });

  assert.deepEqual(pendingPick(snap([round("T1", "picked")])), null, "a picked round is not waiting");
  assert.deepEqual(pendingPick(snap([round("T1", "picked"), round("T2", "waiting")])), { id: "T2", question: "Which opening?", status: "waiting" });
  assert.equal(pendingPick(snap([round("T3", "rendering")])).id, "T3", "clips still rendering: the person picks soon, so the runner waits too");
  assert.equal(pendingPick(snap([round("T2", "waiting")]), "T9"), null, "a poll for one round ignores the others");
  assert.equal(pendingPick(null), null);
  assert.equal(roundStatus(snap([round("T1", "picked"), round("T2", "skipped")]), "T2"), "skipped", "a skipped round is not answered as a pick");
  assert.equal(roundStatus(snap([]), "T2"), null);

  assert.deepEqual(ask(snap([round("T2", "waiting")])), { action: "pick", round: { id: "T2", question: "Which opening?", status: "waiting" }, message: PICK_REPLY, line: "waiting for your pick in the app: Which opening?" });
  assert.equal(PICK_REPLY, "I picked in the app.");
  assert.equal(ask(snap([])).action, "reply", "nothing waits and no MP4: your call");
  assert.equal(ask(snap([])).message, REPLY);
  assert.equal(ask(null).action, "reply", "an unreadable snapshot: your call");
  // A waiting stop comes before a pick, and gets the brief's reply or the plain approval.
  const stopSnapshot = snap([round("T2", "waiting")], { agent: { stops: stopsSummary({ stops: [{ id: "C1", kind: "board", rev: 4, status: "waiting", askedAt: "2026-11-11T10:00:00Z", ask: "Board." }] }), tries: triesView({ tries: [round("T2", "waiting")] }) } });
  assert.deepEqual([ask(stopSnapshot).action, ask(stopSnapshot).message], ["stop", "approved"]);
  assert.equal(ask(snap([]), { hasMp4: true }).action, "watch", "the first MP4: the person watches");
  assert.equal(ask(snap([]), { hasMp4: true }).message, WATCH_REPLY);
  assert.equal(ask(snap([]), { hasMp4: true }).projectId, "demo");
  assert.equal(ask(snap([]), { hasMp4: true, watchStarted: true }).action, "reply", "the watch happens once");
  assert.equal(ask(snap([round("T4", "waiting")]), { hasMp4: true }).action, "pick", "a pick comes before the watch");
  assert.equal(ask({ ...snap([]), projectId: null }, { hasMp4: true }).action, "reply", "no project in the snapshot: no watch to read");
});

test("person mode: the watch is over once a reaction newer than the turn end is 20 s old; a poll stops at its limit", async () => {
  const turnEnd = Date.parse("2026-11-12T10:00:00Z");
  const at = (seconds) => new Date(turnEnd + seconds * 1000).toISOString();
  const entry = (seconds, kind = "played") => ({ id: "R1", kind, at: at(seconds) });
  assert.equal(watchOver([], turnEnd, turnEnd + 60_000), false, "no reactions: still waiting");
  assert.equal(watchOver([entry(-30), entry(-1)], turnEnd, turnEnd + 60_000), false, "reactions from before the turn end are an earlier viewing");
  assert.equal(watchOver([entry(5)], turnEnd, turnEnd + 24_000), false, "the newest is 19 s old");
  assert.equal(watchOver([entry(5)], turnEnd, turnEnd + 25_000), true, "the newest is 20 s old");
  assert.equal(watchOver([entry(5), entry(30, "good")], turnEnd, turnEnd + 49_000), false, "a new entry restarts the quiet time");
  assert.equal(watchOver([entry(5), entry(30, "good")], turnEnd, turnEnd + 50_000), true);
  assert.equal(watchOver([{ kind: "good", at: "nope" }, { kind: "good" }], turnEnd, turnEnd + 99_000), false, "an entry without a readable time counts for nothing");
  assert.equal(watchOver(undefined, turnEnd, turnEnd + 99_000), false);

  // pollUntil with a fake clock: the wait is measured, and stops at the limit (timedOut) or when check says stop.
  let clock = 0;
  const clockOptions = (limitMs) => ({ limitMs, everyMs: 2000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  let calls = 0;
  assert.deepEqual(await pollUntil(async () => ++calls >= 4, clockOptions(60_000)), { seconds: 6, timedOut: false }, "done on the 4th look, 3 sleeps of 2 s");
  clock = 0;
  assert.deepEqual(await pollUntil(async () => false, clockOptions(7_000)), { seconds: 7, timedOut: true }, "never done: out of time at the limit");
  clock = 0;
  assert.deepEqual(await pollUntil(async () => "stop", clockOptions(60_000)), { seconds: 0, timedOut: true }, "a server that cannot be read gives up");
  assert.deepEqual(waitEntry("pick", { seconds: 6, timedOut: false }), { kind: "pick", seconds: 6, timedOut: false });
});

test("a first pass gives its agent kino's MCP server like `kino setup` (private server or the app's runtime file), or none for the CLI path", () => {
  const base = { repoRoot: "/repo", nodePath: "/bin/node", session: "firstpass-a" };
  assert.deepEqual(mcpConfig({ ...base, url: "http://127.0.0.1:5000" }), { mcpServers: { kino: { command: "/bin/node", args: ["/repo/bin/kino.mjs", "mcp"], env: { MOTION_API_URL: "http://127.0.0.1:5000", KINO_AGENT_SESSION: "firstpass-a" } } } });
  assert.deepEqual(mcpConfig({ ...base, runtimeFile: "/p/runtime.json" }).mcpServers.kino.env, { KINO_RUNTIME_FILE: "/p/runtime.json", KINO_AGENT_SESSION: "firstpass-a" });
  const call = { message: "make it", system: "S", addDirs: ["/m"], model: "m1", sessionId: "sid" };
  const mcp = agentArgs({ ...call, mcpFile: "/run/mcp.json" });
  assert.equal(mcp[mcp.indexOf("--mcp-config") + 1], "/run/mcp.json");
  assert.ok(mcp.includes("--strict-mcp-config"), "only kino's server, none of the person's");
  assert.equal(mcp[mcp.indexOf("--allowedTools") + 1], "Bash,Read,Agent,mcp__kino");
  assert.deepEqual(mcp.slice(-4), ["--model", "m1", "--resume", "sid"]);
  const cli = agentArgs(call);
  assert.ok(!cli.includes("--mcp-config") && cli.includes("--strict-mcp-config"), "the CLI path loads no MCP server");
  assert.equal(cli[cli.indexOf("--allowedTools") + 1], "Bash,Read,Agent");
});

test("person mode starts the kino app from this checkout on the run's data folder, with a profile of its own", () => {
  const spec = appCommand({ repoRoot: "/repo", dataDir: "/runs/a/data", profileDir: "/tmp/profile-1", electronPath: "/repo/node_modules/electron/dist/Electron" });
  assert.deepEqual(spec, { command: "/repo/node_modules/electron/dist/Electron", args: ["/repo", "--user-data-dir=/tmp/profile-1"], env: { MOTION_DATA_DIR: "/runs/a/data", KINO_CONTINUE: "0" } });
  assert.equal(agentStateFile("/runs/a/data", "kino fp9"), path.join("/runs/a/data", "agent", "projects", "kino%20fp9.json"), "the project's agent state, where the app keeps the person's reactions");
});

test("the harness report counts kino calls, cut output, next lines, follows, waivers and ops from a tiny transcript", () => {
  const use = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, content) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const lines = [
    use("a", "Bash", { command: "cd /tmp; kino status 2>&1 | head -5; ls | tail -1" }),
    result("a", [{ type: "text", text: 'rev 1\nnext: check {"fix":"auto"}' }]),
    use("b", "Bash", { command: 'kino check fix=auto | grep warn' }),
    result("b", "2 warn"),
    use("c", "mcp__kino__edit", { ops: [{ op: "add_layer" }, { op: "waive_check" }, { op: "add_layer" }] }),
    result("c", '{"rev":2,"next":"look {\\"mode\\":\\"review\\"}"}'),
    use("d", "Bash", { command: "kino look mode=sheet" }),
    result("d", "sheet"),
  ];
  assert.deepEqual(nextOf('x\nnext: look {"mode":"review"}'), { tool: "look", key: "review" });
  const s = summarizeCalls(commandsFrom(lines));
  assert.deepEqual(s.calls, { status: 1, check: 1, edit: 1, look: 1 });
  assert.deepEqual([s.commands, s.piped, s.cut], [4, 2, { head: 1, tail: 0, grep: 1 }], "ls | tail is not kino's pipeline");
  assert.deepEqual([s.answers, s.withNext, s.asked, s.followed], [4, 2, 2, 1], "status->check followed; edit->look sheet is the same tool but another mode");
  assert.deepEqual([s.waived, s.ops, s.largest], [1, { add_layer: 2, waive_check: 1 }, 45]);
  assert.match(report([{ name: "t", text: lines.join("\n") }]).at(-1), /^TOTAL \(1 runs\)  kino calls 4 /);
});
