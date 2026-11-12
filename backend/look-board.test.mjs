// The storyboard as the person and the agent see it (direction plan §5, B4a): look {mode:"board"}
// draws 4 shots a page (the source frame with the crop and the subject boxes, the cropped still
// with the real text, the phone app's covered areas, kino's numbers and the agent's reason), and
// the board stop's chat text (backend/agent/board-text.mjs) lists the shots with those numbers.
// The chat-text tests are pure; the look tests run on a real server with a temporary data folder
// and the Sintel test clip (tests/fixtures/footage/SOURCES.md). The storyboard reference's footage
// board (skills/kino/references/storyboard.md) runs as written.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { estimateImageTokens, estimateTextTokens, pngSize } from "./meter.mjs";
import { skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { ASK_SHOTS, ASK_TOKENS, boardAsk, FRESH_TOKENS, SENTENCE_MAX, SHOT_TOKENS, unheardLinesLine } from "./agent/board-text.mjs";
import { boardLook, PAGE_TOKENS, stillScene, styleFrameFacts } from "./agent/board-look.mjs";
import { shotMeasures } from "../engine/boardMeasure.js";
import { createLayer } from "../engine/model.js";

const CLIP = fileURLToPath(new URL("../tests/fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const PORTRAIT = { width: 1080, height: 1920 };
// Sound search is a dashboard switch from B8 on: until then kino does not point to it.
const SOUND_OFF = "No sound effects.";
const SOUND_OFFER = `${SOUND_OFF} Send me sound files, or say so and I add a few from kino's library.`;
const REPLY = "Reply: approve · approve with notes: ... · redo: ...";
const before0 = (text) => text.split("\nimage ")[0];

// ---- the board's chat text (F7), no server ---------------------------------------------------

// A board shot with every layer, "none" where empty, as the stored board keeps it.
const shot = (fields) => ({ pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text: "none", sound: "none", why: "w", alts: [], ...fields });
const face = { what: "Sintel's face", boxes: [[20, 15, 18, 37]], eyes: 29 };
const dragon = { what: "the red dragon", boxes: [[5, 40, 22, 23]] };
const title = (words, y = 20, size = 80) => ({ text: words, family: "Inter", weight: 700, size, y, fill: "#ffffff" });
// The storyboard reference's footage board (skills/kino/references/storyboard.md), stored.
const footage = () => ({ rev: 2, music: "none", calls: ["Inter 700 for every line"], open: [], shots: [
  shot({ id: "S1", cue: 0, dur: 1.25, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], subject: face, follow: "steady", text: title("The dragon is back", 60) }),
  shot({ id: "S2", cue: 1.25, dur: 2.083, media: "/api/media/a.mp4", in: 1.25, crop: [4, 12, 24, 76], subject: dragon, follow: "track" }),
  shot({ id: "S3", cue: 3.333, dur: 1.067, media: "/api/media/a.mp4", in: 3.333, crop: [13.5, 12, 24, 76], subject: { what: "the dragon's head", boxes: [[19, 34, 11, 18]] }, follow: "track", text: title("Look up", 20, 120) }),
] });
const ask = (fields = {}) => boardAsk({ id: "C1", board: footage(), frame: PORTRAIT, seconds: 4.4, ...fields });
// The agent's own words in an ask (its calls, the brief's message): plan §12's 120 + 35 a shot
// are on top of them. So are the fresh-eyes line and the lines after a redo (B4b), which have
// their own budgets (FRESH_TOKENS, CHANGED_TOKENS; backend/board-redo.test.mjs).
const APART = /^(Fresh-eyes check: |Changed since |Changed as you asked |Changed without being asked: |Named but not changed: |Nothing changed since |Also changed: )/;
const ownWords = (text) => text.split("\n").filter((line) => line.startsWith("My calls") || line.startsWith("Brief: ") || APART.test(line)).join("\n");
const kinoTokens = (text) => estimateTextTokens(text) - (ownWords(text) ? estimateTextTokens(ownWords(text)) : 0);

test("the board's ask: what is ready, the brief, the agent's calls, flagged shots first, the sound line and the reply", () => {
  const result = ask({ message: "Tell fans the dragon is back.", offerSound: true });
  assert.deepEqual(result.text.split("\n"), [
    "The storyboard is ready (C1): 3 shots, 4.4 s, 1080×1920, no music.",
    "Brief: Tell fans the dragon is back.",
    "My calls (say no to any): Inter 700 for every line",
    "Look at: shot 2 (subject 4% from the crop edge).",
    "Shot 2, 1.25–3.33 s: the red dragon, 100% in crop, 4% from edge; no text.",
    'Shot 1, 0–1.25 s: Sintel\'s face, 100% in crop, eyes 22% from top; "The dragon is back" in Inter 700.',
    'Shot 3, 3.33–4.4 s: the dragon\'s head, 100% in crop; "Look up" in Inter 700.',
    SOUND_OFFER,
    REPLY,
  ]);
  // The offer is made once, on the video's first storyboard ask; after a lapse it is not repeated.
  assert.equal(ask().text.split("\n").at(-2), SOUND_OFF);
  assert.equal(ask({ offerSound: true, changed: { why: ["shot 1 text changed"], ids: ["S1"] } }).text.split("\n").at(-2), SOUND_OFF);
  // The person sent sound files: an empty sound is just none, and nothing is asked for.
  assert.equal(ask({ soundFiles: true, offerSound: true }).text.split("\n").at(-2), "No sound effects.");
  assert.equal(ask().text.includes("Settings"), false, "no pointer to a setting kino does not have yet");
  assert.deepEqual({ listed: result.listed, flagged: result.flagged, total: result.total }, { listed: 3, flagged: 1, total: 3 });
  // No brief message, no calls: those lines are left out; a music layer is named.
  const plain = boardAsk({ id: "C4", board: { ...footage(), calls: [] }, frame: PORTRAIT, seconds: 4.4, music: "song" }).text.split("\n");
  assert.equal(plain[0], "The storyboard is ready (C4): 3 shots, 4.4 s, 1080×1920, music: song.");
  assert.equal(plain[1], "Look at: shot 2 (subject 4% from the crop edge).");
});

test("each part of a shot's sentence: no footage, no subject, touching the edge, eyes outside, quoted text cut, a sound", () => {
  const board = { rev: 1, music: "none", calls: [], open: [], shots: [
    shot({ id: "A", cue: 0, dur: 1, text: title("Orbit") }),
    shot({ id: "B", cue: 1, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], follow: "steady" }),
    shot({ id: "C", cue: 2, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], subject: { what: "her", boxes: [[30, 20, 12, 20]], eyes: 5 }, follow: "steady",
      text: title("A very long line that goes on past thirty-two characters") }),
    shot({ id: "D", cue: 3, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], subject: face, follow: "steady", sound: { media: "/api/media/b.wav", what: "crowd cheer" } }),
  ] };
  const result = boardAsk({ id: "C2", board, frame: PORTRAIT, seconds: 4 });
  const lines = result.text.split("\n");
  assert.equal(lines[1], "Look at: shot 2 (no subject marked), shot 3 (subject touches the crop edge), shot 3 (eyes outside the crop).");
  assert.deepEqual(lines.slice(2, 6), [
    "Shot 2, 1–2 s: no subject marked; no text.",
    'Shot 3, 2–3 s: her, 100% in crop, touching its edge, eyes outside it; "A very long line that goes on p…" in Inter 700.',
    'Shot 1, 0–1 s: no footage; "Orbit" in Inter 700.',
    "Shot 4, 3–4 s: Sintel's face, 100% in crop, eyes 22% from top; no text; sound: crowd cheer.",
  ]);
  // One shot has a sound effect: the line says which, so the others read as none.
  assert.equal(lines.at(-2), "Sound effects only on shot 4.");
  assert.equal(lines.at(-1), REPLY);
  // No sound effects never names the sound search switch.
  assert.equal(ask().text.includes("sound search off"), false);
  // crop "whole": the board's still fits a portrait phone screen inside the 16:9 frame, not cropped.
  const whole = stillScene(shot({ id: "W", media: "/api/media/p.png", in: 0, crop: "whole" }), { width: 720, height: 1564, mime: "image/png" }, { width: 1920, height: 1080, background: "#000000" }).layers[0];
  assert.deepEqual([Math.round(whole.x), whole.y, Math.round(whole.width), whole.height], [711, 0, 497, 1080]);
});

// Craft plan section 3: once the board names moves, the plain shots (no designed move) are said
// on their own line and listed first; a board from before moves has no such line.
test("the board's ask names the plain shots and lists them first; a move's name stays out of the person's ask", () => {
  const board = footage();
  board.shots[0].move = { kind: "transition", name: "zoom-through", ref: "promo@0.5" };
  board.shots[1].move = { kind: "camera", name: "whip-pan", ref: "phone-film@4" };
  const lines = boardAsk({ id: "C1", board, frame: PORTRAIT, seconds: 4.4 }).text.split("\n");
  assert.ok(lines.includes("Plain, footage plus words: shot 3."), lines.join("\n"));
  const sentences = lines.filter((line) => line.startsWith("Shot "));
  assert.deepEqual(sentences.map((line) => Number(line.match(/^Shot (\d+)/)[1])), [3, 2, 1]);
  assert.equal(sentences.some((line) => line.includes("; move ")), false);
  assert.equal(ask().text.includes("Plain"), false);
  // A chosen plain cut (move {none}) is a decision, not a flag: most shots should be one.
  board.shots[2].move = { none: "cut on the voice" };
  assert.equal(boardAsk({ id: "C1", board, frame: PORTRAIT, seconds: 4.4 }).text.includes("Plain"), false);
});

// The ask's style frame: the picked type direction over the first footage shot, in the board's own face.
test("styleFrameFacts: the first footage shot with the board's own text face, cased by the direction; no footage, no type or no face is null", () => {
  const records = new Map([["/api/media/a.mp4", { width: 384, height: 216 }]]);
  const board = footage();
  assert.deepEqual(styleFrameFacts({ board, type: "heavy sans, all caps, each word pops", records }),
    { shot: "S1", type: "heavy sans, all caps, each word pops", text: "THE DRAGON IS BACK", family: "Inter", weight: 700, size: 80, fill: "#ffffff", y: 60 });
  // The footage shot has no text: the board's next text is its face; with none, the style fonts and the brief's message.
  const plain = { ...board, shots: board.shots.map((entry) => ({ ...entry, text: "none" })) };
  assert.equal(styleFrameFacts({ board: plain, type: "serif", records }), null);
  const fonts = { display: { family: "Georgia", size: 90 } };
  assert.deepEqual(styleFrameFacts({ board: plain, type: "serif, lowercase", records, fonts, message: "The dragon is back over the village today and tonight" }),
    { shot: "S1", type: "serif, lowercase", text: "the dragon is back over the", family: "Georgia", weight: 700, size: 90, fill: "#ffffff", y: 50 });
  assert.equal(styleFrameFacts({ board, type: "  ", records }), null);
  assert.equal(styleFrameFacts({ board, type: "serif", records: new Map() }), null, "no footage in the library");
});

// Review round 1 of B4a: a voice-over is named, so the ask does not read as a silent video.
test("a voice-over: the header names the audio layer, and the shots' sound effects are said once", () => {
  const voiced = boardAsk({ id: "C1", board: { ...footage(), calls: [] }, frame: PORTRAIT, seconds: 4.4, audio: ["voice"] }).text.split("\n");
  assert.equal(voiced[0], "The storyboard is ready (C1): 3 shots, 4.4 s, 1080×1920, no music, audio: voice.");
  assert.equal(voiced.filter((line) => line.startsWith("Shot ")).some((line) => line.includes("no sound")), false);
  assert.equal(voiced.at(-2), SOUND_OFF);
  assert.ok(boardAsk({ id: "C1", board: footage(), frame: PORTRAIT, seconds: 4.4, audio: ["voice", "room tone", "crowd"] }).text.startsWith("The storyboard is ready (C1): 3 shots, 4.4 s, 1080×1920, no music, audio: voice, room tone and 1 more."));
});

// The ask says how many lines the clips say when none is heard, and nothing when one is or no clip speaks.
test("unheardLinesLine: counts the clips' lines when none is heard, quotes two, and is silent when one is heard or there are none", () => {
  const lines = [{ layer: "a", text: 'we "will"', from: 1.4, heard: false }, { layer: "b", text: "go", from: 3, heard: false }, { layer: "c", text: "now", from: 5, heard: false }];
  assert.equal(unheardLinesLine(lines), `Lines: your clips say 3 lines; none is heard (a.1 "we 'will'", b.3 "go", ...).`);
  assert.equal(unheardLinesLine(lines.slice(0, 1)), `Lines: your clips say 1 line; none is heard (a.1 "we 'will'").`);
  assert.equal(unheardLinesLine([{ ...lines[0], heard: true }, lines[1]]), "");
  assert.equal(unheardLinesLine([]), "");
  assert.ok(boardAsk({ id: "C1", board: footage(), frame: PORTRAIT, seconds: 4.4, heard: unheardLinesLine(lines.slice(0, 1)) }).text.includes("none is heard"));
});

// 15 shots of 1 s on a 9:16 video; the shots with in 2 and 3 are flagged (4% from the crop edge).
function fifteen({ call = 100 } = {}) {
  const shots = Array.from({ length: 15 }, (_, index) => {
    const at = index % 4;
    return shot({ id: `S${index + 1}`, cue: index, dur: 1, media: "/api/media/a.mp4", in: at, follow: "steady", why: "the story so far, said in one line",
      crop: at < 2 ? [18, 12, 24, 76] : [4, 12, 24, 76], subject: at < 2 ? { ...face, what: "Sintel's face in the burning village" } : dragon,
      text: index % 4 === 0 ? { ...title("The dragon is back and it is angry today"), family: "Montserrat" } : "none" });
  });
  // Three calls of `call` characters each, in words.
  const calls = [1, 2, 3].map((n) => `Call ${n}: Inter 700 for every line, white on the footage, no outline, and the cuts where kino found the shots`.slice(0, call));
  return { rev: 3, music: "none", calls, open: [], shots };
}

test("a 15-shot board: 8 shots, flagged first, then 'all shots'; the sentences share 35 tokens a shot, and the ask fits plan §12's 120 plus 35 a shot", () => {
  const input = { id: "C1", board: fifteen(), frame: PORTRAIT, seconds: 15, message: "Skaters learn the park reopens Saturday." };
  const first = boardAsk(input);
  const lines = first.text.split("\n");
  const sentences = lines.filter((line) => line.startsWith("Shot "));
  assert.equal(sentences.length, ASK_SHOTS);
  // Shots 3, 4, 7, 8, 11, 12 and 15 are flagged: they come first, then shot 1.
  assert.deepEqual(sentences.map((line) => Number(line.match(/^Shot (\d+)/)[1])), [3, 4, 7, 8, 11, 12, 15, 1]);
  // The seven flagged shots share their flag: they are counted, and the flag is said once.
  assert.equal(lines.find((line) => line.startsWith("Look at:")), "Look at: 7 shots (subject 4% from the crop edge).");
  assert.ok(lines.includes('7 more shots: say "all shots".'));
  assert.deepEqual({ listed: first.listed, flagged: first.flagged, total: first.total }, { listed: 8, flagged: 7, total: 15 });
  for (const line of sentences) assert.ok(line.length <= SENTENCE_MAX, `${line.length} characters: ${line}`);
  assert.ok(estimateTextTokens(sentences.join("\n")) <= SHOT_TOKENS * ASK_SHOTS, `the sentences are ${estimateTextTokens(sentences.join("\n"))} tokens`);
  // The short sentences leave room for shot 1's text, quoted whole up to 32 characters.
  assert.equal(sentences.at(-1), 'Shot 1, 0–1 s: Sintel\'s face in the burning village, 100% in crop, eyes 22% from top; "The dragon is back and it is an…" in Montserrat 700.');
  assert.equal(first.text.split("\n").find((line) => line.startsWith("My calls")).length, 26 + 3 * 100 + 2 * 3);
  assert.ok(kinoTokens(first.text) <= ASK_TOKENS + SHOT_TOKENS * ASK_SHOTS, `the ask is ${kinoTokens(first.text)} tokens besides the agent's own words`);
  // Every shot with text: the quotes are cut, and the ask still fits.
  const worded = fifteen();
  for (const entry of worded.shots) entry.text = { ...title("The dragon is back and it is angry today"), family: "Montserrat" };
  const tight = boardAsk({ ...input, board: worded });
  assert.ok(kinoTokens(tight.text) <= ASK_TOKENS + SHOT_TOKENS * ASK_SHOTS + 10, `every shot with text: ${kinoTokens(tight.text)} tokens`);
  // A long move on every shot: dropped from the sentences that do not fit, so the ask is no longer.
  for (const entry of worded.shots) entry.move = { kind: "transition", name: "speed-lines-phone", ref: "promo@4.2" };
  const moved = boardAsk({ ...input, board: worded });
  const said = (text) => estimateTextTokens(text.split("\n").filter((line) => line.startsWith("Shot ")).join("\n"));
  assert.ok(said(moved.text) <= Math.max(said(tight.text), SHOT_TOKENS * ASK_SHOTS), `sentences with moves: ${said(moved.text)} tokens`);
  assert.ok(kinoTokens(moved.text) <= ASK_TOKENS + SHOT_TOKENS * ASK_SHOTS + 10, `every shot with a move: ${kinoTokens(moved.text)} tokens`);

  const all = boardAsk({ ...input, all: true });
  assert.equal(all.text.split("\n").filter((line) => line.startsWith("Shot ")).length, 15);
  assert.equal(all.text.includes("more shots"), false);
  assert.equal(all.listed, 15);
  assert.ok(kinoTokens(withoutNext(all.text)) <= ASK_TOKENS + SHOT_TOKENS * 15, `all shots: ${kinoTokens(withoutNext(all.text))} tokens`);
});

test("after an approval lapsed: why, then only the changed shots, the rest counted as unchanged", () => {
  const why = ["shot 2 crop moved 8% of the frame width", "shot 3 text changed", "shot 5 media changed", "shot 6 follow changed", "shot 9 pacing changed"];
  const input = { id: "C2", board: fifteen(), frame: PORTRAIT, seconds: 15, message: "left out after a lapse", changed: { why, ids: ["S2", "S3", "S5", "S6", "S9"], approved: "C1" } };
  const result = boardAsk(input);
  const lines = result.text.split("\n");
  // Review round 2 of B4a: the approval named is the one the person gave (C1); C2 is this ask.
  assert.equal(lines[0], "The storyboard changed since you approved it (C1); asking again (C2): shot 2 crop moved 8% of the frame width; shot 3 text changed; shot 5 media changed; and 2 more.");
  assert.equal(lines.some((line) => line.startsWith("Brief:")), false);
  assert.deepEqual(lines.filter((line) => line.startsWith("Shot ")).map((line) => Number(line.match(/^Shot (\d+)/)[1])), [3, 2, 5, 6, 9]);
  assert.ok(lines.includes('10 unchanged: say "all shots".'));
  assert.equal(result.listed, 5);
  // Two reasons, no "and more"; "all shots" after a lapse lists every shot.
  assert.equal(boardAsk({ ...input, changed: { why: why.slice(0, 2), ids: ["S2"], approved: "C1" } }).text.split("\n")[0],
    "The storyboard changed since you approved it (C1); asking again (C2): shot 2 crop moved 8% of the frame width; shot 3 text changed.");
  assert.equal(boardAsk({ ...input, all: true }).listed, 15);
  // Review round 1 of B4a: 10 changed shots, 8 listed: the 2 left out are not called unchanged.
  const ten = boardAsk({ ...input, changed: { why, ids: Array.from({ length: 10 }, (_, index) => `S${index + 1}`) } }).text.split("\n");
  assert.equal(ten.filter((line) => line.startsWith("Shot ")).length, 8);
  assert.ok(ten.includes('2 more changed shots and 5 unchanged: say "all shots".'), ten.join("\n"));
  // Two changed shots cost far less than the whole ask, besides the agent's calls (100 characters each).
  const small = kinoTokens(boardAsk({ ...input, changed: { why: why.slice(0, 2), ids: ["S2", "S3"] } }).text);
  const whole = kinoTokens(boardAsk({ ...input, changed: null }).text);
  assert.ok(small <= ASK_TOKENS + SHOT_TOKENS * 2 && small < whole - 100, `${small} tokens after a lapse of 2 shots (${whole} for the whole ask)`);
});

// Review round 1 of B4a: the full-clip layer a board from footage starts from (the framing
// reference) is not left playing under the shot layers.
test("storyboard.md has the agent delete the full-clip layer, or make it shot 1, when it builds the shots", async () => {
  const text = (await readFile(new URL("../skills/kino/references/storyboard.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  assert.ok(text.includes("When you build the shots, delete it (or make it shot 1): its sound plays once."));
});

// Review round 1 of B4b: after "your call" the agent asks again, and that ask is the one the
// person sees, so it carries the fresh-eyes answer.
test("storyboard.md has the agent ask again with fresh after the person says your call", async () => {
  const text = (await readFile(new URL("../skills/kino/references/storyboard.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  const yourCall = text.split("It answers `your_call`")[1].split(" - ")[0];
  assert.ok(yourCall.includes('then ask again with the fresh-eyes answer: `notes {action:"checkpoint", id:"board", fresh:"ran"}`'), yourCall);
});

// ---- look {mode:"board"} on a real server ----------------------------------------------------

let server;
let clip;
before(async () => {
  if (skipWithoutMediaTools) return;
  server = await startTestServer();
  const response = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": path.basename(CLIP) }, body: await readFile(CLIP) });
  assert.equal(response.status, 201, await response.clone().text());
  clip = await response.json();
});
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const image = (reply) => Buffer.from(reply.images[0].data, "base64");

test("storyboard.md's footage board runs as written: look board shows the three shots with kino's numbers, flags shot 2, and says it in words", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  await agent("project", { action: "create", id: "footage-board", name: "Footage board", width: 1080, height: 1920, duration: 4.4, background: "#000000" });
  const [block] = jsonBlocks(skillSection("Storyboard: a board from footage"));
  const calls = JSON.parse(JSON.stringify(block).replaceAll("/api/media/<clip>.mp4", clip.src));
  const replies = [];
  for (const [index, { tool, ...input }] of calls.entries()) {
    const reply = await agent(tool, { project: "footage-board", ...input });
    assert.equal(reply.isError, undefined, `call ${index} (${tool}): ${reply.text}`);
    replies.push(reply);
  }
  const look = replies.at(-1);
  // The numbers are kino's own measures of the reference's shots (its crops and boxes may be
  // tuned; these stay true): every subject whole in its crop, shot 1's eyes marked, shot 2 alone
  // flagged, close to its crop's edge.
  const shots = calls[0].ops[0].shots;
  const measured = shots.map((entry) => shotMeasures({ ...entry, subject: { ...entry.subject, boxes: [entry.subject.box] } }, PORTRAIT));
  const moves = shots.map((entry) => entry.move ?? null);
  assert.deepEqual(look.data.shots, measured.map((numbers, index) => ({ n: index + 1, id: `S${index + 1}`, start: [0, 1.25, 3.33][index], end: [1.25, 3.33, 4.4][index], ...numbers, move: moves[index], plain: !moves[index] })));
  assert.deepEqual(measured.map((numbers) => numbers.inside), [[100], [100], [100]]);
  assert.ok(measured[0].eyes >= 20 && measured[0].eyes <= 45, `eyes ${measured[0].eyes}%`);
  assert.deepEqual(measured.map((numbers) => numbers.flags), [[], [`subject ${measured[1].edge}% from the crop edge`], []]);
  const lines = before0(look.text).split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "board r1, page 1 of 1: shots 1–3 of 3, 4.4 s, 1080×1920, music none, sound search off");
  // Each line gives the shot's place and its id (review round 2 of B4a), a flagged number only under look:.
  // Shot 1 names its move; shots 2 and 3 have none, so they are flagged plain.
  assert.equal(lines[1], `1 (S1) 0–1.25 s: 100% in, eyes ${measured[0].eyes}%; move zoom-through; text "The dragon is back"; sound none`);
  assert.equal(lines[2], `2 (S2) 1.25–3.33 s: 100% in; text none; sound none · look: ${measured[1].edge}% from the edge, plain`);
  assert.equal(lines[3], '3 (S3) 3.33–4.4 s: 100% in; text "Look up"; sound none · look: plain');
  assert.equal(lines[4], "step: ask the person (notes checkpoint board)");
  assert.match(look.text, /\nimage \S+\.png\nnext: notes \{"action":"checkpoint","id":"board"\}$/);
  assert.ok(estimateTextTokens(lines.join("\n")) <= 200);
  assert.deepEqual([look.data.mode, look.data.board, look.data.page, look.data.pages], ["board", 1, 1, 1]);
  // Three rows: 1092 × 819, 1,170 image tokens; the PNG is the file the text names.
  const png = image(look);
  assert.deepEqual(pngSize(png), { width: 1092, height: 819 });
  assert.equal(estimateImageTokens(pngSize(png)), 1_170);
  assert.deepEqual(await readFile(look.data.path), png);
});

test("look board refuses a project with no storyboard and a page past the last", { skip: skipWithoutMediaTools, timeout: 60_000 }, async () => {
  await agent("project", { action: "create", id: "no-board", name: "No board", width: 1080, height: 1920, duration: 4 });
  const none = await agent("look", { project: "no-board", mode: "board" });
  assert.equal(none.isError, true, none.text);
  assert.deepEqual(none.data, { error: "not_found", reason: 'No storyboard yet: edit {ops:[{op:"board", music, shots}]} (library {topic:"op", name:"board"}).' });
  const made = await agent("edit", { project: "no-board", ops: [{ op: "board", music: "none", shots: [
    { cue: 0, dur: 4, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text: { text: "Orbit", family: "Inter" }, sound: "none", why: "one card" },
  ] }] });
  assert.equal(made.isError, undefined, made.text);
  const card = await agent("look", { project: "no-board", mode: "board" });
  assert.equal(card.isError, undefined, card.text);
  // A card with no footage has no numbers.
  assert.equal(before0(card.text).split("\n")[1], '1 (S1) 0–4 s: no footage; text "Orbit"; sound none · look: plain');
  for (const page of [2, 0]) {
    const past = await agent("look", { project: "no-board", mode: "board", page });
    assert.equal(past.isError, true, past.text);
    assert.equal(past.data.error, "bad_input");
    assert.equal(past.data.reason, "page is 1 to 1 (1 shot, 4 a page).");
  }
});

test("a 15-shot board: 4 pages of at most 4 rows, each text within 200 tokens; the board stop lists 8 shots, then all 15", { skip: skipWithoutMediaTools, timeout: 180_000 }, async () => {
  await agent("project", { action: "create", id: "fifteen", name: "Fifteen shots", width: 1080, height: 1920, duration: 15, background: "#000000" });
  // The person's words name the vertical frame, so kino keeps 9:16 over the 16:9 clip (else it gives the scene the clip's shape before the board).
  const vertical = "fifteen vertical shots of the dragon clip";
  const named = await agent("notes", { project: "fifteen", action: "brief", fields: { ask: vertical, plays_on: { text: "vertical", by: "you", quote: vertical } } });
  assert.equal(named.isError, undefined, named.text);
  // One video layer of the clip, so the video has footage and the board stop asks.
  const layer = await agent("edit", { project: "fifteen", ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -1167, y: 0, width: 3413, height: 1920, mediaSourceDuration: 4.417 } }] });
  assert.equal(layer.isError, undefined, layer.text);
  const shots = Array.from({ length: 15 }, (_, index) => {
    const at = index % 4;
    return { cue: index, dur: 1, pacing: "free", media: clip.src, in: at, follow: "steady", sound: "none", why: "the story so far, said in one line", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" },
      crop: at < 2 ? [18, 12, 24, 76] : [4, 12, 24, 76],
      subject: at < 2 ? { what: "Sintel's face", box: [20, 15, 18, 37], eyes: 29 } : { what: "the red dragon", box: [5, 40, 22, 23] },
      text: [0, 4, 8, 12].includes(index) ? { text: `Line ${index + 1}: the dragon is back`, family: "Inter", weight: 700, size: 96, y: 20 } : "none" };
  });
  // Three calls of 100 characters, the most a board has.
  const calls = [1, 2, 3].map((n) => `Call ${n}: Inter 700 for every line, white on the footage, no outline, and the cuts where kino found the shots`.slice(0, 100));
  const saved = await agent("edit", { project: "fifteen", ops: [{ op: "board", music: "none", calls, shots }] });
  assert.equal(saved.isError, undefined, saved.text);

  const sizes = [];
  for (const page of [1, 2, 3, 4]) {
    const reply = await agent("look", { project: "fifteen", mode: "board", page });
    assert.equal(reply.isError, undefined, reply.text);
    const text = before0(reply.text);
    const lines = text.split("\n");
    const first = (page - 1) * 4 + 1, last = Math.min(page * 4, 15);
    assert.equal(lines[0], `board r1, page ${page} of 4: shots ${first}–${last} of 15, 15 s, 1080×1920, music none, sound search off`);
    assert.equal(lines.length, last - first + 3);
    assert.equal(lines.at(-1), page < 4 ? `more: shots ${first + 4}–${Math.min(page * 4 + 4, 15)} on page ${page + 1}` : "step: ask the person (notes checkpoint board)");
    assert.match(reply.text, page < 4 ? new RegExp(`\\nnext: look \\{"mode":"board","page":${page + 1}\\}$`) : /\nnext: notes \{"action":"checkpoint","id":"board"\}$/);
    assert.ok(estimateTextTokens(text) <= 200, `page ${page}: ${estimateTextTokens(text)} tokens`);
    assert.deepEqual(reply.data.shots.map((entry) => entry.n), Array.from({ length: last - first + 1 }, (_, index) => first + index));
    const size = pngSize(image(reply));
    sizes.push([size.width, size.height, estimateImageTokens(size)]);
    console.log(`# look board page ${page}: text ${estimateTextTokens(text)} tokens, image ${size.width}×${size.height} ${estimateImageTokens(size)} tokens`);
  }
  assert.deepEqual(sizes, [[1092, 1092, 1_521], [1092, 1092, 1_521], [1092, 1092, 1_521], [1092, 819, 1_170]]);

  // The person named the shape, so the board ask has no shape guess line to count.
  const shape = await agent("notes", { project: "fifteen", action: "brief", fields: { ask: "a vertical for my phone", plays_on: { text: "vertical, 9:16", by: "you", quote: "vertical for my phone" } } });
  assert.equal(shape.isError, undefined, shape.text);
  const brief = await agent("notes", { project: "fifteen", action: "brief", no_playback: "just start" });
  assert.equal(brief.isError, undefined, brief.text);
  const asked = await agent("notes", { project: "fifteen", action: "checkpoint", id: "board" });
  assert.equal(asked.isError, undefined, asked.text);
  assert.equal(asked.data.status, "waiting_for_you");
  const sentences = asked.data.ask.split("\n").filter((line) => line.startsWith("Shot "));
  assert.deepEqual(sentences.map((line) => Number(line.match(/^Shot (\d+)/)[1])), [3, 4, 7, 8, 11, 12, 15, 1]);
  assert.deepEqual(asked.data.board, { rev: 1, shots: 15, listed: 8, flagged: 7 });
  // Plan §12: the answer, its ask included, is 120 tokens plus 35 a shot listed, besides the
  // agent's own words (its three calls of 100 characters).
  assert.ok(kinoTokens(withoutNext(asked.text)) <= ASK_TOKENS + SHOT_TOKENS * ASK_SHOTS, `the answer is ${kinoTokens(withoutNext(asked.text))} tokens besides the agent's own words:\n${asked.text}`);
  // The video's first board ask, and the agent did not say whether a second agent read the board.
  const fresh = asked.data.ask.split("\n").filter((line) => line.startsWith("Fresh-eyes check: "));
  assert.deepEqual(fresh, ["Fresh-eyes check: not reported."]);
  assert.ok(estimateTextTokens(fresh[0]) <= FRESH_TOKENS);

  const all = await agent("notes", { project: "fifteen", action: "checkpoint", id: "board", all: true });
  assert.equal(all.isError, undefined, all.text);
  assert.equal(all.data.ask.split("\n").filter((line) => line.startsWith("Shot ")).length, 15);
  assert.equal(all.data.board.listed, 15);
  assert.ok(kinoTokens(withoutNext(all.text)) <= ASK_TOKENS + SHOT_TOKENS * 15, `all shots: ${kinoTokens(withoutNext(all.text))} tokens`);
  console.log(`# board stop: the answer with 8 shots ${estimateTextTokens(asked.text)} tokens (${kinoTokens(asked.text)} besides the agent's calls), all 15 shots ${estimateTextTokens(all.text)} (${kinoTokens(all.text)})`);
});

// ---- review round 2 of B4a -------------------------------------------------------------------

test("every flag reaches the chat text: text or eyes under the app's captions, a fourth flagged shot, a second flag", () => {
  const edge = (id, cue) => shot({ id, cue, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [4, 12, 24, 76], subject: dragon, follow: "steady" });
  const board = { rev: 1, music: "none", calls: [], open: [], shots: [edge("S1", 0), edge("S2", 1), edge("S3", 2),
    shot({ id: "S4", cue: 3, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], subject: face, follow: "steady", text: title("Out Friday", 80) }),
    shot({ id: "S5", cue: 4, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [4, 12, 24, 76], subject: dragon, follow: "steady", text: title("Look up", 80) })] };
  const lines = boardAsk({ id: "C1", board, frame: PORTRAIT, seconds: 5 }).text.split("\n");
  assert.equal(lines[1], "Look at: 4 shots (subject 4% from the crop edge), shots 4 and 5 (text under the app's captions).");
  assert.ok(lines.includes('Shot 4, 3–4 s: Sintel\'s face, 100% in crop, eyes 22% from top; "Out Friday" in Inter 700, under the app\'s captions.'), lines.join("\n"));
  assert.ok(lines.includes('Shot 5, 4–5 s: the red dragon, 100% in crop, 4% from edge; "Look up" in Inter 700, under the app\'s captions.'), lines.join("\n"));
  // Eyes low in the crop are under the captions too, and said so.
  const low = { ...board, shots: [shot({ id: "S1", cue: 0, dur: 5, media: "/api/media/a.mp4", in: 0, crop: [18, 0, 24, 76], subject: { ...face, eyes: 58 }, follow: "steady" })] };
  assert.match(boardAsk({ id: "C1", board: low, frame: PORTRAIT, seconds: 5 }).text, /eyes 76% from top, under the app's captions; no text\./);
  // Past three flags, the rest are counted (the sentences say them).
  const many = { ...board, shots: [...board.shots.slice(0, 4), shot({ id: "S5", cue: 4, dur: 1, media: "/api/media/a.mp4", in: 0, crop: [18, 12, 24, 76], follow: "steady" })] };
  many.shots[0] = { ...many.shots[0], subject: { ...face, eyes: 70 }, crop: [18, 12, 24, 76] };
  assert.match(boardAsk({ id: "C1", board: many, frame: PORTRAIT, seconds: 5 }).text.split("\n")[1], /, and \d more flags?\.$/);
});

// look board without a server: the rows handed to the renderer and the page's text. The renderer
// is a stub that keeps the rows; the file is the test clip's record.
const CLIP_RECORD = { width: 384, height: 216, duration: 4.417, name: "sintel-village-dragon.mp4", mime: "video/mp4" };
async function lookRows(board, { soundFiles = false, page = 1, layers = [] } = {}) {
  const document = { scenes: [{ id: "s", width: 1080, height: 1920, duration: board.shots.at(-1).cue + board.shots.at(-1).dur, background: "#000000", layers }], board };
  let rows = null;
  const look = { async boardImage(given) { rows = given; return { png: null, frames: [] }; } };
  const result = await boardLook({ page }, { document, look, fontsFor: async () => ({}), mediaRecord: async () => CLIP_RECORD, soundFiles });
  return { ...result, rows };
}

test("look board's sound column: 'none' (the built-in library needs no switch); the still draws the shot's own font", async () => {
  const board = { rev: 1, music: "none", calls: [], open: [], shots: [shot({ id: "S1", cue: 0, dur: 2, text: { ...title("Orbit"), family: "Montserrat" } })] };
  const soundLine = (rows) => rows[0].lines.map((line) => line.text).find((text) => text.startsWith("sound:"));
  assert.equal(soundLine((await lookRows(board)).rows), "sound: none");
  assert.equal(soundLine((await lookRows(board, { soundFiles: true })).rows), "sound: none");
  const { rows } = await lookRows(board);
  const text = rows[0].still.scene.layers.find((layer) => layer.type === "text");
  assert.deepEqual([text.fontFamily, text.fontWeight, text.text], ["Montserrat", 700, "Orbit"]);
});

test("look board's text stays within 200 tokens with every shot flagged, and names each shot's id", async () => {
  // The worst page: four shots whose subject the crop cuts (67% in), eyes at 76%, text at y 80
  // and a sound, after a title card added first moved the ids along.
  const hard = (id, cue) => shot({ id, cue, dur: 0.75, media: "/api/media/a.mp4", in: 1, crop: [18, 12, 24, 76], follow: "steady",
    subject: { what: "Sintel's face in the burning village", boxes: [[30, 15, 18, 37]], eyes: 70 },
    text: title("Out Friday everywhere, in every city", 80), sound: { media: "/api/media/b.wav", what: "a crowd cheering in a large stadium" } });
  const board = { rev: 2, music: "none", calls: [], open: [], shots: [shot({ id: "S5", cue: 0, dur: 1, text: title("Orbit") }), hard("S1", 1), hard("S2", 1.75), hard("S3", 2.5)] };
  const { text, extra } = await lookRows(board);
  const lines = text.split("\n");
  assert.ok(estimateTextTokens(text) <= PAGE_TOKENS, `${estimateTextTokens(text)} tokens:\n${text}`);
  assert.deepEqual(lines.slice(1, 5).map((line) => line.match(/^\d+ \((\w+)\)/)[1]), ["S5", "S1", "S2", "S3"]);
  assert.deepEqual(extra.shots.map((entry) => entry.id), ["S5", "S1", "S2", "S3"]);
  for (const line of lines.slice(2, 5)) assert.match(line, / · look: 67% in, eyes 76%, eyes and text under captions, plain$/);
  assert.equal(PAGE_TOKENS, 200);
  // Two-digit ids, a long move on every shot and a named song: the moves are left out too (the
  // image row still names them).
  const moved = (id, cue) => ({ ...hard(id, cue), move: { kind: "ui", name: "speed-lines-phone", ref: "promo@4.2" } });
  const song = createLayer("audio", { id: "song", name: "Midnight City (radio edit)", src: "/api/media/song.wav", mediaStart: 0, mediaDuration: 3.25 });
  const long = await lookRows({ ...board, music: "song", shots: [moved("S10", 0), moved("S11", 1), moved("S12", 1.75), moved("S13", 2.5)].map((entry, index) => index ? entry : { ...entry, dur: 1 }) }, { layers: [song] });
  assert.ok(estimateTextTokens(long.text) <= PAGE_TOKENS, `${estimateTextTokens(long.text)} tokens:\n${long.text}`);
  assert.equal(long.rows[0].lines.find((line) => line.text.startsWith("move:")).text, "move: ui speed-lines-phone (promo@4.2)");
  // With room, the quoted text and the sound are given in full.
  const one = await lookRows({ ...board, shots: [hard("S1", 0)] });
  assert.match(one.text.split("\n")[1], /^1 \(S1\) 0–0\.75 s: text "Out Friday everywhere, in every…"; sound a crowd cheering in a large stadium · look: /);
});
