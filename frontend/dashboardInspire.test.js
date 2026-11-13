// The inspire screen's data (frontend/dashboard/inspireView.js) as plain data: the queries with their
// counts and the active one, the grid's tiles (empty ones while a search runs), cut ticks with
// the beat-matched ones, the words under a tile, the picked reference's rows, the arrows in the
// grid, and the dashboard events that update it. The data has the shape of the server's
// projectView (backend/inspire.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SEARCHING_TILES, arrange, boardRows, boardTiles, briefLine, detailRows, factRows, viewWords, filmCells, filterBoards, foundCount, ideaFrames, kindCounts, shelves, soundDetail, soundNote, soundRow, ideasSummary, ideaTimeWords, lengthWords, motionWords, searcher, soFarWords, soundtrackRows, musicOrder, seekTime, songPlayhead, songSeek, sourceWords, stepStates, ticks, tileChips, tileLabel, tileWords, tiles,
  watchSentence, withInspireEvent,
} from "./dashboard/inspireView.js";
import { applyEvent, fromSnapshot, needKey, needsYouRows, optionLabel } from "./dashboard/state.js";
import { needsBar } from "./dashboard/needsBar.js";
import { needWords } from "./dashboard/agentView.js";
import { keyAction, parseCommand } from "./dashboard/keys.js";

const juno = { id: "a2", name: "juno", color: "#5ab0ff" };
const measured = {
  id: "yt:AAAAAAAAAAA", title: "Asahi alley", channel: "Someone", duration: 39, url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", thumb: true, state: "measured", bpm: 124,
  numbers: { seconds: 39, shots: 5, cuts: [3.9, 10, 20, 32.9], cutsPerSecond: 0.1, longest: { seconds: 12.9, start: 20, where: null }, onBeat: [true, false, true, true], onBeatCount: 3 },
};
const inspire = {
  searches: [
    { n: 1, query: "walking tour edit", by: juno, state: "done", wanted: 8, ids: ["yt:AAAAAAAAAAA", "yt:BBBBBBBBBBB"], count: 2 },
    { n: 2, query: "phone app, on the street", by: "you", state: "done", wanted: 8, ids: ["yt:BBBBBBBBBBB", "yt:CCCCCCCCCCC"], count: 2 },
    { n: 3, query: "accessibility demo", by: juno, state: "searching", wanted: 8, ids: [] },
  ],
  saved: ["yt:AAAAAAAAAAA"],
  refs: {
    "yt:AAAAAAAAAAA": measured,
    "yt:BBBBBBBBBBB": { id: "yt:BBBBBBBBBBB", title: "Crossing", channel: "Other", duration: 259, thumb: false, state: "measuring", phase: "reading cuts" },
    "yt:CCCCCCCCCCC": { id: "yt:CCCCCCCCCCC", title: "Cat", channel: "Cats", duration: 20, thumb: false, state: "queued", place: 1 },
  },
  queue: { running: "yt:BBBBBBBBBBB", phase: "reading cuts", waiting: 1 },
};

test("panel 1: who searched last", () => {
  assert.deepEqual(searcher(inspire), { you: false, id: "a2", name: "juno", color: "#5ab0ff" });
  const youLater = { ...inspire, searches: [...inspire.searches, { n: 4, query: "city walk", by: "you", state: "done", ids: [], count: 0 }] };
  assert.equal(searcher(youLater).name, "juno", "the agent still searching keeps panel 1");
  const done = { ...inspire, searches: inspire.searches.slice(0, 2) };
  assert.equal(searcher(done).you, true);
  assert.equal(searcher({ searches: [] }), null);
  assert.equal(briefLine({ brief: { lines: [{ name: "audience", text: "skaters" }, { name: "message", text: "fast-cut walking edits" }] } }), "fast-cut walking edits");
  assert.equal(briefLine(null), "");
});

test("panel 2: each reference once, in search order, numbered, then empty tiles for the running search", () => {
  const list = tiles(inspire);
  assert.deepEqual(list.map((tile) => [tile.id, tile.number, tile.state]), [
    ["yt:AAAAAAAAAAA", 1, "measured"], ["yt:BBBBBBBBBBB", 2, "measuring"], ["yt:CCCCCCCCCCC", 3, "queued"],
    ...Array.from({ length: SEARCHING_TILES }, () => [null, undefined, "searching"]),
  ]);
  assert.equal(foundCount(list), 3);
  assert.deepEqual(tileWords(list[0]), { left: "0.1 cuts/s", right: "39 s" });
  assert.deepEqual(tileWords(list[1]), { left: "reading cuts", right: "4:19", busy: true });
  assert.deepEqual(tileWords(list[2]), { left: "waits to be read", right: "20 s" });
  assert.equal(tileLabel(list[0]), "1. Asahi alley, Someone, 39 s, 5 shots, 0.1 cuts/s, 3 of 4 cuts on the beat");
  assert.equal(tileLabel(list[1]), "2. Crossing, Other, 4:19, reading cuts");
});

test("cut ticks sit at their time across the measured stretch; the beat-matched ones are marked", () => {
  assert.deepEqual(ticks(measured.numbers).map((tick) => [Math.round(tick.x * 100), tick.beat]), [[10, true], [26, false], [51, true], [84, true]]);
  assert.deepEqual(ticks(null), []);
  assert.deepEqual(ticks({ ...measured.numbers, onBeat: null }).map((tick) => tick.beat), [null, null, null, null]);
});

test("panel 3: shots, cuts a second, longest and where, length, beat, and cuts on the beat n of m", () => {
  assert.deepEqual(detailRows(measured), {
    rows: [["shots", "5 in 39 s"], ["cuts/s", "0.1"], ["longest", "12.9 s, from 0:20"], ["length", "39 s"], ["beat", "124 bpm"], ["kept", "numbers and a thumbnail"]],
    beat: { n: 3, m: 4 },
  });
  // A fingerprinted reference: its shares, and the screen says the small strips are kept.
  const printed = { ...measured, strips: 19, print: { still: 0.22, camera: 0.58, text: 0.47, lowercase: 0.8, words: 0.56, blurDips: 12 } };
  assert.deepEqual(detailRows(printed).rows.slice(5), [["camera", "moves 58%, still 22%"], ["text", "on screen 47%, 80% lowercase, 56% word by word"], ["blur dips", "12"],
    ["kept", "numbers, a thumbnail and 19 small frame strips (240 px); the video is deleted"]]);
  const long = { ...measured, duration: 259, bpm: null, numbers: { ...measured.numbers, seconds: 90, longest: { seconds: 20, start: 70, where: "the end" }, onBeat: null, onBeatCount: null } };
  assert.deepEqual(detailRows(long).rows.slice(2, 5), [["longest", "20 s, at the end"], ["length", "4:19 (read the first 90 s)"], ["beat", "no steady beat"]]);
  assert.equal(detailRows(long).beat, null);
  assert.deepEqual(detailRows({ state: "queued" }), { rows: [], beat: null });
  assert.equal(lengthWords(3725), "1:02:05");
  // Who made it, beside the channel: views, a verified channel and why kino doubts it.
  assert.equal(sourceWords({ views: 1_234_567, verified: true }), " · 1.2M views · verified");
  assert.equal(sourceWords({ views: 618, doubt: "few views" }), " · 618 views · doubt: few views");
  assert.equal(sourceWords({}), "");
  // The page's facts list: plain labels, the rest of a row kept for hover.
  assert.deepEqual(factRows(printed).map(([label, value]) => `${label}: ${value}`), ["Cuts on the beat: 3 of 4", "Shots: 5 in 39 s", "Cuts a second: 0.1",
    "Longest shot: 12.9 s, from 0:20", "Beat: 124 bpm", "Camera moves: 58%", "Text on screen: 47%", "Blur dips: 12"]);
  assert.equal(factRows(printed)[6][2], "80% lowercase, 56% word by word");
  assert.deepEqual([factRows({ state: "queued" }), viewWords(2_140_000), viewWords(null)], [[], "2.1M views", ""]);
  // The tile's chips: views, then why kino doubts it, same frames and hidden copies, in few words.
  assert.deepEqual(tileChips({ views: 12_400, doubt: "ai title, template, very short", same: true, copies: ["yt:a"] }).map((chip) => chip.text), ["12k", "ai", "template", "short", "same frames", "+1 copy"]);
  assert.deepEqual(tileChips({}), []);
});

test("boards: All found and Saved pinned, one board per search newest first, a filter, N more; shelves; show and sort", () => {
  const sound = { id: "yt:SSSSSSSSSSS", kind: "sound", title: "Soft whoosh", channel: "fx", duration: 3, thumb: true, state: "measured",
    sound: { peaks: [0.1, 0.9, 0.2], peakAt: 1.1, loudness: -18.2, start: 0, end: 2.1, length: 2.1 } };
  const withSounds = { ...inspire, saved: [...inspire.saved, sound.id], refs: { ...inspire.refs, [sound.id]: sound },
    searches: [...inspire.searches, { n: 4, query: "whoosh", by: "you", kind: "sounds", state: "done", ids: [sound.id], count: 1 }] };
  const rows = boardRows(withSounds);
  assert.deepEqual(rows.map((row) => [row.key, row.sub]), [
    ["all", "4, 4 searches"], ["saved", "1 video, 1 sound"], ["s4", "Soft: 1"], ["s3", "searching"], ["s2", "Crossing, Cat: 2"], ["s1", "Asahi, Crossing: 2"],
  ]);
  assert.deepEqual(rows[0].cover, ["yt:AAAAAAAAAAA", "yt:SSSSSSSSSSS"], "covers only thumbnails");
  assert.deepEqual(filterBoards(rows, "WALK").shown.map((row) => row.key), ["s1"]);
  assert.deepEqual(filterBoards(rows, "", 2), { pinned: rows.slice(0, 2), shown: rows.slice(2, 4), more: 2 });
  assert.deepEqual(kindCounts(withSounds, { candidates: [{ measure: {} }, { measure: {} }, {}] }), { videos: 3, music: 2, sounds: 1 });
  assert.deepEqual(boardTiles(withSounds, "s2").map((tile) => tile.id), ["yt:BBBBBBBBBBB", "yt:CCCCCCCCCCC"]);
  assert.deepEqual(boardTiles(withSounds, "saved", "sounds").map((tile) => tile.id), [sound.id], "a sound board on the sounds tab");
  assert.deepEqual(boardTiles(withSounds, "s4"), [], "a sounds board has no videos");
  assert.deepEqual(shelves(withSounds).map((shelf) => [shelf.name, shelf.count, shelf.tiles.length]), [["accessibility demo", 0, 4], ["phone app, on the street", 2, 2], ["walking tour edit", 2, 2]]);
  const list = tiles(inspire);
  assert.deepEqual(arrange(list, { show: "read" }).map((tile) => tile.id), ["yt:AAAAAAAAAAA"]);
  assert.deepEqual(arrange(list, { show: "saved", saved: inspire.saved }).map((tile) => tile.id), ["yt:AAAAAAAAAAA"]);
  assert.deepEqual(arrange(list, { sort: "short" }).filter((tile) => tile.id).map((tile) => tile.id), ["yt:CCCCCCCCCCC", "yt:AAAAAAAAAAA", "yt:BBBBBBBBBBB"]);
  assert.equal(arrange(list, { sort: "short" }).at(-1).id, null, "tiles still searching stay last");
  // A sound as a row and in detail, and the note "send to" leaves.
  const row = soundRow(tiles(withSounds, "sounds")[0], withSounds.saved);
  assert.deepEqual([row.title, row.length, row.saved, Math.round(row.peak * 100), row.peaks.length], ["Soft whoosh", "0:02", true, 52, 3]);
  assert.deepEqual(soundDetail(sound), [["length", "2.1 s"], ["peak", "1.1 s in"], ["loudness", "-18 LUFS"], ["source", "YouTube"]]);
  assert.equal(soundNote({ id: sound.id, title: 'Soft "air" whoosh' }), `use sound yt:SSSSSSSSSSS "Soft 'air' whoosh"`);
});

test("dashboard events: a project's inspire replaces it, a reference's update changes only that one", () => {
  const state = fromSnapshot({ boot: "b", seq: 1, projectId: "p1", projects: [{ id: "p1" }], inspire });
  assert.equal(state.inspire, inspire);
  const moved = applyEvent(state, { seq: 2, type: "inspire-ref", ref: { ...inspire.refs["yt:BBBBBBBBBBB"], state: "measured", phase: undefined, numbers: measured.numbers } });
  assert.equal(moved.inspire.refs["yt:BBBBBBBBBBB"].state, "measured");
  assert.equal(moved.inspire.queue.running, null);
  assert.equal(moved.inspire.refs["yt:AAAAAAAAAAA"], measured);
  const elsewhere = applyEvent(moved, { seq: 3, type: "inspire", projectId: "p2", inspire: { searches: [], saved: [], refs: {}, queue: {} } });
  assert.equal(elsewhere.inspire, moved.inspire, "another project's searches are not shown");
  const unknown = withInspireEvent(inspire, { type: "inspire-ref", ref: { id: "yt:ZZZZZZZZZZZ", state: "measured" } }, "p1");
  assert.equal(unknown, inspire, "a reference this project never found is left out");
  const replaced = applyEvent(moved, { seq: 4, type: "inspire", projectId: "p1", inspire: { searches: [], saved: [], refs: {}, queue: {} } });
  assert.deepEqual(replaced.inspire.searches, []);
});

test("F3 opens inspire from any screen, and so does the command line", () => {
  assert.equal(keyAction({ key: "F3" }, { screen: "main" }), "inspire");
  assert.equal(keyAction({ key: "F3" }, { screen: "crew" }), "inspire");
  assert.deepEqual(parseCommand("inspire"), { action: "inspire" });
});

test("watching a reference: the steps, the motion in words, the sentence and the cuts so far", () => {
  assert.deepEqual(stepStates("finding the beat").map((step) => `${step.name}:${step.state}`), ["cuts:done", "beat:now", "movement and text:next", "frames:next"]);
  assert.deepEqual(stepStates("fetching").map((step) => step.state), ["next", "next", "next", "next"]);
  assert.equal(motionWords({ u: [0.01, 0.012], v: [0.001, 0] }), "drifting right");
  assert.equal(motionWords({ u: [-0.03, -0.03], v: [-0.03, -0.03] }), "moving fast up and to the left");
  assert.equal(motionWords({ u: [0, 0], v: [0, 0] }), "still");
  assert.equal(motionWords(null), "");
  const live = { t: 20.8, flow: { cols: 2, rows: 1, u: [0.01, 0.01], v: [0, 0] }, text: [{ box: [0.3, 0.9, 0.5, 0.08], s: "we get these depth maps" }] };
  assert.equal(watchSentence("reading motion and text", live), 'the arrows show which way the picture moves. right now: drifting right. words on screen: "we get these depth maps".');
  const blurry = { ...live, text: [{ box: [0, 0, 1, 1], s: "Open8d9e" }, { box: [0, 0, 1, 1], s: "0.99" }] };
  assert.doesNotMatch(watchSentence("reading motion and text", blurry), /words on screen/, "text Vision misread is not quoted");
  assert.match(watchSentence("fetching", null), /deleted when kino is done/);
  assert.deepEqual(soFarWords({ seconds: 70, cuts: Array(85).fill(1), onBeat: Array(85).fill(false), onBeatCount: 16 }), ["85 cuts, about one a second", "the cuts ignore the music"]);
  assert.deepEqual(soFarWords({ seconds: 58, cuts: Array(19).fill(1), onBeat: null, onBeatCount: null }), ["19 cuts, about one every 3 seconds"]);
  assert.deepEqual(soFarWords(null), []);
});

const ideas = {
  id: "I1", ref: "yt:AAAAAAAAAAA", title: "a launch film", seconds: 70, by: juno, status: "waiting", thumb: true,
  strips: [{ at: 0.8, file: "01.jpg" }, { at: 15, file: "12.jpg" }, { at: 53.5, file: "24.jpg" }],
  take: [
    { n: 1, title: "short lowercase lines", from: 0.8, to: 5.3, what: "a caption a shot", why: "easy to read", use: "open with 3 lines", tags: [], on: true },
    { n: 2, title: "two soft dissolves", from: 8.6, what: "the only soft changes", why: "it feels special", use: "one dissolve", tags: [], on: false },
  ],
  skip: [{ n: 3, title: "the logo in the corner", why: "their brand", on: false }],
};

test("ideas: their video's strips along its length, the frames of each idea, its time, and the answer's words", () => {
  assert.deepEqual(filmCells(ideas.strips, 70).map((cell) => [cell.file, Math.round(cell.x * 100), Math.round(cell.w * 100)]), [["01.jpg", 0, 21], ["12.jpg", 21, 55], ["24.jpg", 76, 24]]);
  assert.deepEqual(filmCells([], 70), []);
  assert.deepEqual(ideaFrames(ideas.strips, ideas.take[0]).map((frame) => frame.file), ["01.jpg", "01.jpg", "01.jpg"]);
  assert.deepEqual(ideaFrames(ideas.strips, { from: 14, to: 54 }).map((frame) => frame.file), ["12.jpg", "12.jpg", "24.jpg"]);
  assert.deepEqual(ideaFrames(ideas.strips, ideas.take[1]).map((frame) => frame.frame), [0, 3, 5], "one moment: three frames of its strip");
  assert.equal(ideaTimeWords(ideas.take[0]), "0:01 to 0:05");
  assert.equal(ideaTimeWords(ideas.take[1]), "0:09");
  assert.deepEqual(ideasSummary(ideas), { on: 1, total: 2, line: "1 of 2 ideas on" });
});

test("waiting ideas need you: a row the top bar names, answered on the inspire screen", () => {
  const state = { projectId: "p1", inspire: { ...inspire, ideas }, approvals: [], agent: null };
  const rows = needsYouRows(state);
  assert.deepEqual(rows.map((row) => row.type), ["ideas"]);
  assert.equal(needKey(rows[0]), "ideas/p1/I1");
  assert.deepEqual(needsBar(rows, 0), { who: "juno", what: "2 ideas from a launch film · pick them on F3", keys: [["a", "pick ideas"]], more: 0 });
  assert.deepEqual(needsBar(rows, 0, () => null, { here: true }).keys, [["a", "allow"], ["d", "not yet"]]);
  assert.equal(needWords(rows[0]).todo, "pick the ideas to use, then allow");
  // Once answered they leave "needs you".
  assert.deepEqual(needsYouRows({ ...state, inspire: { ...inspire, ideas: { ...ideas, status: "allowed" } } }), []);
  // An open judge round needs you too (a brings its box back); judge events replace it.
  const judge = { id: "J1", rev: 4, status: "open", pairs: [{ n: 1, pick: null, files: ["J1-01-1.jpg", "J1-01-2.jpg"] }] };
  const judged = applyEvent({ ...state, inspire, seq: 1, agent: { notes: [] } }, { type: "judge", projectId: "p1", judge });
  const [row] = needsYouRows(judged);
  assert.equal(needKey(row), "judge/p1/J1");
  assert.deepEqual(needsBar([row], 0).keys, [["a", "pick"]]);
  assert.equal(needWords(row).allow, "pick");
  assert.deepEqual(needsYouRows(applyEvent(judged, { type: "judge", projectId: "p1", judge: { ...judge, status: "done" } })), []);
  // A material question (notes needs) comes with a call's agent slice; a picks the recommended option.
  const need = { id: "M1", status: "open", ask: "Do you have a screen recording?", why: "the app reads small", options: [{ do: "keep the phone capture", cost: "soft" }, { do: "redraw the screen", cost: "less real", recommended: true }] };
  const asked = applyEvent({ ...state, inspire, seq: 1, agents: [], calls: [], agent: { notes: [] } }, { type: "call", seq: 2, projectId: "p1", event: { verb: "notes", by: "agent" }, agent: { notes: [], needs: [need, { ...need, id: "M2", status: "planned" }] } });
  const [material] = needsYouRows(asked);
  assert.equal(needsYouRows(asked).length, 1, "only unanswered needs ask you");
  assert.equal(needKey(material), "material/p1/M1");
  assert.deepEqual(needsBar([material], 0).keys, [["a", "option 2"]]);
  assert.deepEqual([needWords(material).todo, needWords(material).allow], ["Do you have a screen recording?", "option 2"]);
  // The found footage option's tool syntax reads as plain words.
  const found = { do: 'library {topic:"footage", search:"the cook <doing>", want:"<words>"}, then scan and import', cost: "found clips, not your own shots" };
  assert.deepEqual([optionLabel(found), optionLabel(need.options[0])], ["find footage", "keep the phone capture"]);
});

test("the live frame is kept while its reference is measured and dropped when it is done", () => {
  const live = { id: "yt:BBBBBBBBBBB", t: 1, seconds: 30, image: null, flow: null, text: [] };
  let next = withInspireEvent(inspire, { type: "inspire-live", live }, "p1");
  assert.equal(next.live, live);
  assert.equal(withInspireEvent(inspire, { type: "inspire-live", live: { ...live, id: "yt:ZZZZZZZZZZZ" } }, "p1"), inspire, "an unknown reference is ignored");
  next = withInspireEvent(next, { type: "inspire-ref", ref: { ...inspire.refs["yt:BBBBBBBBBBB"], state: "measured" } }, "p1");
  assert.equal(next.live, null);
});

test("soundtrack rows: license chip or the source (YouTube), tempo, the curve from where the drop meets the payoff, beat marks", () => {
  const energy = Array.from({ length: 40 }, (_, t) => (t < 30 ? 20 : 90));
  const rows = soundtrackRows({ story: { length: 10, beats: [{ from: 0, to: 6 }, { from: 6, to: 10 }] }, candidates: [
    { id: "openverse:a", source: "openverse", title: "Lights", creator: "Ana", license: "CC BY 4.0", measure: { bpm: 119.6, energy, sections: [{ at: 30, kind: "drop" }] }, note: { verdict: "pick", why: "drop on the reveal" }, picked: true },
    { id: "yt:abcdefghijk", source: "youtube", title: "Trailer", creator: "x", license: "license unknown" },
  ] });
  assert.deepEqual(rows.map((row) => [row.license, row.bpm, row.verdict, row.picked]), [["CC BY 4.0", "120 bpm", "pick", true], ["YouTube", "not measured", null, false]]);
  assert.deepEqual(rows[0].marks, [60]);
  assert.match(rows[0].path, /^M0,19\.6 L.* L60,4\.2 /, "the song starts 24 s in: quiet until the payoff at 6 s, then loud");
  assert.equal(rows[1].path, "");
  // Its preview (seconds 20 to 40 of the song) plays under a playhead on the curve; a click seeks.
  const [song] = soundtrackRows({ story: { length: 10, beats: [] }, candidates: [{ id: "yt:abcdefghijk", source: "youtube", title: "T", measure: { energy, sections: [], preview: { from: 20, seconds: 20 } } }] });
  assert.deepEqual([song.key, song.start, songPlayhead(song, 5), songPlayhead(song, 25), songSeek(song, 50)], ["yt-abcdefghijk", 0, null, null, null]);
  const dropped = { ...rows[0], preview: { from: 20, seconds: 20 } };
  assert.deepEqual([songPlayhead(dropped, 4), songPlayhead(dropped, 19), songSeek(dropped, 50), songSeek(dropped, 100)], [0, null, 9, 14]);
  assert.equal(rows[1].preview, null, "a song measured before previews were kept has none");
  // The music tab: measured songs by fit (one chip), newest first on a tie, songs you said no to last.
  const ranked = soundtrackRows({ story: { length: 10, beats: [] }, candidates: [
    { id: "a", measure: { energy }, fit: { fit: 40, why: "no drop in the video" } }, { id: "b", measure: { energy }, fit: { fit: 85, why: "like X" }, rejected: true },
    { id: "c", measure: { energy }, fit: { fit: 70 } }, { id: "d" }, { id: "e", measure: { energy }, fit: { fit: 40 } }] });
  assert.deepEqual(musicOrder(ranked).map((row) => [row.id, row.fit]), [["c", 70], ["e", 40], ["a", 40], ["b", 85]]);
  assert.deepEqual([ranked[1].rejected, ranked[1].fitWhy], [true, "like X"]);
  // The server's shortlist order (varied lanes first) wins over fit; the lane is a chip.
  const varied = soundtrackRows({ story: { length: 10, beats: [] }, candidates: [
    { id: "a", measure: { energy }, fit: { fit: 80, order: 2, lane: "house" } }, { id: "b", measure: { energy }, fit: { fit: 60, order: 1, lane: "lo-fi" } }] });
  assert.deepEqual(musicOrder(varied).map((row) => [row.id, row.lane]), [["b", "lo-fi"], ["a", "house"]]);
  // The player's seek bar: a click a quarter of the way in jumps a quarter in; off the ends clamps.
  assert.deepEqual([seekTime(50, 200, 90), seekTime(-10, 200, 90), seekTime(500, 200, 90), seekTime(50, 200, 0)], [22.5, 0, 90, 0]);
});
