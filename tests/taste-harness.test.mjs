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
import { htmlText, pickMp4, projectIdFor, projectIdFromStatus, promptFor, seedHouse, summarize } from "../evals/taste/firstpass.mjs";
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
