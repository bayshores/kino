// The pure parts of the taste harness (evals/taste): cut list to strip times, ffmpeg loudness
// parsing, and the Bradley-Terry ladder with owner agreement.
import assert from "node:assert/strict";
import test from "node:test";
import { agreement, bradleyTerry, cutsFrom, lineLevels, parseEbur128, shortTermCurve, splitPicks, stripTimes } from "../evals/taste/lib.mjs";
import { answerJson, combine, factsText } from "../evals/taste/judge.mjs";
import { fromAppPick, fromJudged, ladder } from "../evals/taste/ladder.mjs";
import { htmlText, pickMp4, projectIdFor, promptFor, summarize } from "../evals/taste/firstpass.mjs";
import { projectSeed } from "../engine/deck.js";
import { familyOf } from "../backend/house-memory.mjs";

test("cuts become 12 fps strips 0.5 s each side, joined where they overlap", () => {
  const frames = [0.5, 1, 1.04, 3].map((t, i) => ({ t, score: [30, 40, 12, 50][i] }));
  const cuts = cutsFrom(frames, { threshold: 10, gap: 0.1 });
  assert.deepEqual(cuts.map((cut) => cut.t), [0.5, 1, 3]);
  const strips = stripTimes(cuts, 3.2);
  assert.deepEqual(strips.map((strip) => [strip.from, strip.to, strip.cuts]), [[0, 1.5, [0.5, 1]], [2.5, 3.2, [3]]]);
  assert.equal(strips[0].times.length, 18);
  assert.equal(strips[1].times[0], 2.5);
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
  assert.equal(promptFor({ ask: "make a video" }, ["/r/a.mp4"], "kino-fp9"), "make a video\n\nFiles:\n- /r/a.mp4\n\nCall the project kino-fp9.");
});
