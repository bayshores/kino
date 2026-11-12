import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { boardPicks, pickWords, picksFor, SHOT_PICKS, CUT } from "./movePicks.js";
import { boardCoverage, boardSpan, isPlainShot, keepShotIds, mainScene, MOVE_REF, moveProblems, movesNeeded, moveWords, normalizeBoard, ONE_FRAME, reframeBoard, SHOT_LAYERS } from "./board.js";

// A shot of motion design: every layer "none" but its text.
const motion = (cue, dur, extra = {}) => ({ id: `S${Math.round(cue * 1000)}`, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none",
  follow: "none", text: "none", sound: "none", why: "a line", ...extra });
const tiled = (...ends) => ({ shots: ends.map((end, index) => motion(index ? ends[index - 1] : 0, end - (index ? ends[index - 1] : 0))) });
const video = { start: 0, end: 24, music: null, length: 24 };
const music = (start, end, length = 30) => ({ start, end, music: "song", length });

test("a document keeps a board of the right shape, rounded, and has none without one", () => {
  const board = { rev: 1, music: "none", shots: [motion(0.12345, 2, { text: { text: "Ship", family: "Inter", weight: 700, size: 96.04, y: 20, fill: "#ffffff" } })] };
  const document = parseDocument(createDocument({ id: "b", name: "Board", board }));
  assert.equal(document.board.shots[0].cue, 0.123);
  assert.equal(document.board.shots[0].text.size, 96);
  assert.deepEqual(document.board.calls, []);
  assert.deepEqual(document.board.open, []);
  assert.deepEqual(document.board.shots[0].alts, []);
  assert.equal("board" in parseDocument(createDocument({ id: "b", name: "Board" })), false);
  assert.equal("board" in normalizeBoard({ board: null }), false);
});

test("normalizeBoard names the field that is wrong", () => {
  const shaped = (shots, extra = {}) => () => normalizeBoard({ board: { rev: 1, music: "none", shots, ...extra } });
  assert.throws(shaped([motion(0, 1), motion(1, 1), motion(2, 1, { text: "Ship faster" })]), /^Error: document\.board\.shots\[2\]\.text must be "none" or \{text, family/);
  assert.throws(shaped([motion(0, 1, { text: { text: "x" } })]), /^Error: document\.board\.shots\[0\]\.text\.family must be text of 1 to 100 characters/);
  for (const layer of SHOT_LAYERS) {
    const shot = motion(0, 1);
    delete shot[layer];
    assert.throws(shaped([shot]), new RegExp(`document\\.board\\.shots\\[0\\]\\.${layer} must be given \\("none" when empty\\)`), layer);
  }
  assert.throws(shaped([motion(0, 1, { pacing: "fast" })]), /shots\[0\]\.pacing must be beat_cut, phrase_flow, free/);
  assert.throws(shaped([motion(0, 1, { follow: "zoom" })]), /shots\[0\]\.follow must be steady, track, sweep or "none"/);
  assert.throws(shaped([motion(0, 1, { crop: [50, 0, 60, 100] })]), /shots\[0\]\.crop must be "none", "whole" or \[x, y, w, h\]/);
  // A portrait phone screen shown whole beside other things in a 16:9 video: crop "whole".
  assert.equal(shaped([motion(0, 1, { media: "/api/media/phone.png", in: 0, crop: "whole" })])().board.shots[0].crop, "whole");
  assert.throws(shaped([motion(0, 1, { subject: { what: "her", boxes: [] } })]), /shots\[0\]\.subject\.boxes must be a list of 1 to 4 boxes/);
  assert.throws(shaped([motion(0, 1, { color: "red" })]), /shots\[0\]\.color is not a field of a shot/);
  assert.throws(shaped([motion(0, 1, { id: "A" }), motion(1, 1, { id: "A" })]), /shots\[1\]\.id must be unique/);
  assert.throws(shaped([]), /document\.board\.shots must be a list of 1 to 60 shots/);
  assert.throws(shaped([motion(0, 1)], { rev: 0 }), /document\.board\.rev must be a whole number from 1/);
  assert.throws(shaped([motion(0, 1)], { open: ["a", "b", "c", "d"] }), /document\.board\.open must be a list of at most 3/);
});

test("a shot's move: {kind, name, ref, planned?} or {none}; every bad field named at once; a board without moves still loads, its shots plain", () => {
  const move = { kind: "transition", name: " zoom-through ", ref: "app-trailer@0.5" };
  const board = (shots) => normalizeBoard({ board: { rev: 1, music: "none", shots } }).board;
  const kept = board([motion(0, 1, { move }), motion(1, 1, { move: { none: "a held face" } }), motion(2, 1)]).shots;
  assert.deepEqual(kept.map((shot) => shot.move), [{ kind: "transition", name: "zoom-through", ref: "app-trailer@0.5" }, { none: "a held face" }, undefined]);
  assert.deepEqual(kept.map(isPlainShot), [false, true, true]);
  assert.deepEqual(kept.map((shot) => moveWords(shot)), ["transition zoom-through (app-trailer@0.5)", "none: a held face", "unknown"]);
  assert.throws(() => board([motion(0, 1, { move: "none" })]), /shots\[0\]\.move "none" says why: move \{none:"<reason>"\}/);
  const known = (name) => name === "zoom-through";
  assert.deepEqual(moveProblems({ kind: "x", name: "zoom-thru", ref: "app-trailer", extra: 1 }, "shot 2 move", known), [
    "shot 2 move.extra is not a field of a move (kind, name, ref, planned).",
    "shot 2 move.kind is type, transition, camera or ui.",
    'shot 2 move.name "zoom-thru" is not a kino move or preset (library {topic:"moves"}).',
    'shot 2 move.ref is "<reference key>@<seconds>", the reference moment it copies (e.g. "app-trailer@3.2").',
  ]);
  // refHelp adds what the project would accept to a bad ref's message, and only to that message.
  const help = (sent) => `saved: ${sent}`;
  assert.deepEqual(moveProblems({ kind: "type", name: "zoom-through", ref: "yt:uXlWYZ022zU" }, "m", known, { refHelp: help }),
    ['m.ref is "<reference key>@<seconds>", the reference moment it copies (e.g. "app-trailer@3.2"). saved: yt:uXlWYZ022zU']);
  assert.deepEqual(moveProblems({ kind: "type", name: "zoom-through", ref: "yt:uXlWYZ022zU@3.2" }, "m", known, { refHelp: help }), []);
  // A saved YouTube reference can be named by its id as inspire lists it, "yt:" kept.
  assert.deepEqual(moveProblems({ kind: "type", name: "zoom-through", ref: "yt:uXlWYZ022zU@3.2" }, "m", known), []);
  assert.equal(MOVE_REF.exec("yt:uXlWYZ022zU@3.2")[1], "uXlWYZ022zU");
  // A planned move not built yet is accepted only marked planned.
  assert.deepEqual(moveProblems({ kind: "ui", name: "roll", ref: "app-launch@8.9" }, "m", known), ['m.name "roll" is planned, not built yet: add planned: true.']);
  assert.deepEqual(moveProblems({ kind: "ui", name: "roll", ref: "app-launch@8.9", planned: true }, "m", known), []);
  // A saved planned move whose name has since been built (off the planned list) still loads.
  assert.deepEqual(board([motion(0, 1, { move: { ...move, planned: true } })]).shots[0].move, { kind: "transition", name: "zoom-through", ref: "app-trailer@0.5", planned: true });
  // move_needed: only while no key beat (hook, reveal, payoff) has a designed move; plain cuts elsewhere pass.
  const cut = { none: "cut" };
  assert.equal(movesNeeded({ shots: [motion(0, 1, { move }), motion(1, 1, { move: cut }), motion(2, 1, { move: cut }), motion(3, 1, { move: cut })] }), null);
  assert.equal(movesNeeded({ shots: [motion(0, 1, { move: cut }), motion(1, 1), motion(2, 1, { move })] }), null);
  assert.deepEqual(movesNeeded({ shots: [motion(0, 1), motion(1, 1)] }).shots, [1, 2]);
  const named = (text) => ({ text: { text, family: "Inter", weight: 700, size: 96, y: 50, fill: "#ffffff" } });
  const needed = movesNeeded({ shots: [motion(0, 1, { media: "/api/media/a.mp4" }), motion(1, 1, { media: "/api/media/b.mp4", move: { kind: "ui", name: "ui-plane", ref: "x@1" } }),
    motion(2, 1, { media: "/api/media/c.mp4", move: cut }), motion(3, 1, { ...named("Orbit"), move: cut }), motion(4, 1, { media: "/api/media/e.mp4" }), motion(5, 1, named("Get it"))] });
  assert.deepEqual(needed.shots, [1, 4, 6], "the hook, the reveal (a name) and the payoff; shot 2's move is off the key beats");
  assert.match(needed.message, /^no designed move on the hook, reveal or payoff \(shots 1, 4, 6\)\./);
  // With a spine, the payoff is the shots in its payoff beat (2 and 3); a move on the last shot (the end) does not count.
  const spine = [{ role: "payoff", from: 1, to: 3 }];
  const spined = movesNeeded({ shots: [motion(0, 1), motion(1, 1), motion(2, 1), motion(3, 1, { move })] }, {}, spine);
  assert.deepEqual(spined.shots, [1, 2, 3]);
  // The payoff's run of shots is named once in Fits, so the refusal stays small however many shots the beat spans.
  const fits = spined.message.split("Fits: ")[1];
  assert.equal(fits.match(/payoff/g).length, 1, fits);
  assert.match(fits, /shots 2-3 \(payoff, /);
});

test("picksFor offers each shot the moves that fit what it holds; a plain cut first off the key beats, and the board's own device again", () => {
  const line = (text) => ({ text, family: "Inter", weight: 700, size: 90, y: 50, fill: "#ffffff" });
  const names = (shot, context = {}) => picksFor(shot, { role: "hook", ...context }).picks.map((entry) => entry.name);
  const recording = motion(0, 2, { media: "/api/media/a.mp4", why: "the week fills in" });
  // A screen recording (by its file name, or by the shot's words) gets UI moves; a screenshot is an app still.
  assert.deepEqual(picksFor(recording, { name: "Screen Recording 1.mov", role: "reveal" }), { word: "app recording", picks: SHOT_PICKS.screen, role: "reveal" });
  assert.deepEqual(picksFor(recording, { name: "Screen Recording 1.mov" }).picks, [CUT, ...SHOT_PICKS.screen.slice(0, 2)], "off the key beats, a plain cut first");
  assert.equal(picksFor(motion(0, 2, { media: "/api/media/b.png", why: "the app's inbox" })).word, "app still");
  // Phone footage beside an app shot carries into the screen; a typed request types on; a voice is captioned.
  assert.deepEqual(names(motion(0, 2, { media: "/api/media/c.mp4", why: "her hand on the phone" }), { next: recording, nextName: "screen.mov" }), ["carry", "zoom-through"]);
  assert.deepEqual(names(motion(0, 2, { text: line("Plan my week around the gym"), why: "she types the request" })), ["type-on", "rewrite", "stream"]);
  assert.equal(picksFor(motion(0, 2, { media: "/api/media/c.mp4", sound: { media: "/api/media/vo.wav", what: "the voice says it" } }), { role: "hook" }).picks[0].name, "caption-words");
  // A list rolls; a name assembles; the last shot ends quietly; plain footage after footage gets a transition.
  assert.deepEqual(names(motion(0, 2, { text: line("Mail, notes, calendar") })), ["roll", "assemble", "decode"]);
  assert.deepEqual(names(motion(0, 2, { text: line("Orbit") }), { last: true }), ["logo-settle", "assemble", "decode"]);
  const street = motion(0, 2, { media: "/api/media/d.mp4" });
  assert.deepEqual(names(street, { prev: street }), ["whip", "zoom-through", "carry"]);
  // On a board: the hook and payoff get moves, every other shot a plain cut first; once a shot
  // uses a device, a shot of the same kind is offered it again (a motif), not a new one.
  const punched = { ...street, move: { kind: "camera", name: "window-punch-in", ref: "phone-film@3.13" } };
  const picks = boardPicks([punched, street, street, street]);
  assert.deepEqual(picks.map((entry) => [entry.role ?? null, entry.picks[0].name, entry.picks[1].name]),
    [["hook", "window-punch-in", "frame"], [null, "cut", "window-punch-in"], [null, "cut", "window-punch-in"], ["payoff", "window-punch-in", "logo-settle"]]);
  assert.equal(pickWords(picks[1].picks[1]), "camera window-punch-in again, as shot 1 (phone-film@3.13)");
  assert.equal(pickWords(picks[1].picks[0]), 'a plain cut on the voice or the beat (move {none:"cut"})');
  assert.match(pickWords(SHOT_PICKS.screen[1]), /^ui build-in after split_image \(agent-launch@12\.0\)$/);
});

test("boardSpan is the music layer's Play range, or the main scene's whole length", () => {
  const song = createLayer("audio", { id: "song-id", name: "song", src: "/api/media/song.wav", mediaStart: 1, mediaDuration: 4 });
  const scene = createScene({ id: "main", name: "Main", duration: 10, width: 1080, height: 1920, layers: [song] });
  const component = createScene({ id: "part", name: "Part", duration: 3, isComponent: true });
  const document = parseDocument(createDocument({ id: "span", name: "Span", scenes: [component, scene] }));
  assert.equal(mainScene(document).id, "main", "a component scene is never the main scene");
  assert.deepEqual(boardSpan(document, { music: "song-id", shots: [] }), { start: 1, end: 5, music: "song", length: 10 });
  assert.deepEqual(boardSpan(document, { music: "none", shots: [] }), { start: 0, end: 10, music: null, length: 10 });
});

test("boardCoverage says where the shots leave a gap or overlap, in kino's sentences", () => {
  assert.equal(boardCoverage(tiled(4, 8, 24), video), null);
  const gap = { shots: [motion(0, 2), motion(2, 1), motion(3, 1.2), motion(4.8, 19.2)] };
  assert.deepEqual(boardCoverage(gap, music(0, 24)), { code: "gap", at: [4.2, 4.8],
    message: "the shots leave a gap in the music from 4.2 to 4.8 s (after shot 3): make shot 3 longer or start shot 4 at 4.2 s." });
  assert.equal(boardCoverage({ shots: [motion(0.5, 23.5)] }, video).message, "the shots start at 0.5 s, after the video starts (0 s): start shot 1 at 0 s.");
  assert.equal(boardCoverage(tiled(10, 22), music(0, 24)).message, "the shots end at 22 s, before the music ends (24 s): make the last shot 2 s longer.");
  const overlap = { shots: [motion(0, 1.5), motion(1.5, 1.5), motion(3, 1.5), motion(4, 20)] };
  assert.deepEqual(boardCoverage(overlap, video), { code: "overlap", at: [4, 4.5], message: "shot 4 starts at 4 s, inside shot 3 (3–4.5 s): start it at 4.5 s." });
  const order = { shots: [motion(0, 1.5), motion(1.5, 1.5), motion(3, 1), motion(2, 22)] };
  assert.equal(boardCoverage(order, video).message, "shots are in time order: shot 4 starts at 2 s, before shot 3 (3 s).");
  assert.equal(boardCoverage(order, video).code, "overlap");
  const outside = tiled(3, 6, 9, 12, 15, 18, 21, 23, 25);
  assert.deepEqual(boardCoverage(outside, video), { code: "overlap", at: [24, 25], message: "shot 9 ends at 25 s, after the video ends (24 s)." });
  // Music that starts later: the shots start with it, and may run on to the video's end.
  assert.equal(boardCoverage({ shots: [motion(2, 3), motion(5, 25)] }, music(2, 20)), null);
});

test("shots meet within one frame at 30 fps", () => {
  assert.equal(ONE_FRAME, 1 / 30);
  assert.equal(boardCoverage({ shots: [motion(0, 1), motion(1.03, 22.97)] }, video), null, "a 0.03 s gap is within a frame");
  assert.equal(boardCoverage({ shots: [motion(0, 1), motion(0.97, 23.03)] }, video), null, "a 0.03 s overlap is within a frame");
  assert.equal(boardCoverage({ shots: [motion(0, 1), motion(1.04, 22.96)] }, video).code, "gap");
  assert.equal(boardCoverage({ shots: [motion(0, 1), motion(0.96, 23.04)] }, video).code, "overlap");
  assert.equal(boardCoverage({ shots: [motion(0.03, 23.97)] }, video), null, "a first shot one frame late still starts the video");
  assert.equal(boardCoverage({ shots: [motion(0, 23.97)] }, video), null, "a last shot one frame short still ends it");
  assert.equal(boardCoverage({ shots: [motion(0, 24.03)] }, video), null, "a last shot one frame long still fits");
});

// Review round 1 of B4a: the approved storyboard is compared shot by shot by id, and agents send
// the board again without ids, so a shot keeps the id of the shot it continues.
test("keepShotIds: a shot sent again keeps its id by its clip and in-point, or its text; new shots get new ids", () => {
  const clip = (cue, dur, inPoint, extra = {}) => ({ cue, dur, pacing: "free", media: "/api/media/a.mp4", in: inPoint, crop: [20, 12, 24, 76], subject: "none", follow: "steady",
    text: "none", sound: "none", why: "a shot", ...extra });
  const card = (cue, dur, words) => ({ ...motion(cue, dur), id: undefined, text: { text: words, family: "Inter", weight: 700, size: 96, y: 20, fill: "#ffffff" } });
  const before = [{ ...clip(0, 1.25, 0), id: "S1" }, { ...clip(1.25, 2.083, 1.25), id: "S2" }, { ...clip(3.333, 1.084, 3.333), id: "S3" }, { ...card(4.417, 4.383, "Look up"), id: "S4" }];
  // A title card first moves every shot: each keeps its own id, the card gets a new one.
  const again = [card(0, 1, "Sintel"), clip(1, 1.25, 0), clip(2.25, 2.083, 1.25), clip(4.333, 1.084, 3.333), card(5.417, 3.383, "Look up")];
  assert.deepEqual(keepShotIds(again, before).map((shot) => shot.id), ["S5", "S1", "S2", "S3", "S4"]);
  // An in-point nudged a little is the same shot; a new clip at a place keeps that place's id.
  const nudged = [clip(0, 1.25, 0.1), { ...clip(1.25, 2.083, 1.25), media: "/api/media/b.mp4" }, clip(3.333, 1.084, 3.333), card(4.417, 4.383, "Look up")];
  assert.deepEqual(keepShotIds(nudged, before).map((shot) => shot.id), ["S1", "S2", "S3", "S4"]);
  // Ids the agent sends are kept; a shot removed frees nothing for reuse by place.
  const sent = [{ ...clip(0, 1.25, 0), id: "open" }, clip(1.25, 3.167, 1.25), card(4.417, 4.383, "Look up")];
  assert.deepEqual(keepShotIds(sent, before).map((shot) => shot.id), ["open", "S2", "S4"]);
  // The first board: S1, S2, ... by place.
  assert.deepEqual(keepShotIds([card(0, 1, "a"), card(1, 1, "b")]).map((shot) => shot.id), ["S1", "S2"]);
});

test("reframeBoard: each crop becomes the widest window of the new frame around its old center, kept inside the file", () => {
  const shot = (crop, extra = {}) => ({ id: "S1", media: "/api/media/a.mp4", crop, ...extra });
  const sizes = { "/api/media/a.mp4": { width: 1920, height: 1080 } };
  // 9:16 crops on a 16:9 file, the scene now 16:9: the whole file.
  const wide = reframeBoard({ shots: [shot([20, 12, 24, 76]), { ...motion(1, 1), crop: "none" }] }, { width: 1920, height: 1080 }, (src) => sizes[src]);
  assert.deepEqual(wide, { board: { shots: [shot([0, 0, 100, 100]), { ...motion(1, 1), crop: "none" }] }, shots: [1] });
  // The other way: a 9:16 window (31.6% of the width) centered on the old crop, clamped at the right edge.
  const tall = reframeBoard({ shots: [shot([80, 0, 20, 100], { alts: [{ crop: [0, 0, 50, 100], why: "the left" }] })] }, { width: 1080, height: 1920 }, (src) => sizes[src]);
  assert.deepEqual(tall.board.shots[0].crop, [68.4, 0, 31.6, 100]);
  assert.deepEqual(tall.board.shots[0].alts[0].crop, [9.2, 0, 31.6, 100]);
  // Nothing to change, or a file of unknown size: null.
  assert.equal(reframeBoard({ shots: [shot([0, 0, 100, 100])] }, { width: 1920, height: 1080 }, (src) => sizes[src]), null);
  assert.equal(reframeBoard({ shots: [shot([20, 12, 24, 76])] }, { width: 1920, height: 1080 }, () => null), null);
});
