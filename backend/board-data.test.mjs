// The dashboard's board screen reads (milestone B4b): GET /api/dashboard/board-data, the board a
// storyboard stop showed as data (agent/board-data.mjs), and GET /api/dashboard/board-shot, one
// shot's source frame or cropped still as a PNG (board-look.mjs boardShotImage).
//
// The first part is the plain builder; the second runs a real server with the Sintel test clip
// (tests/fixtures/footage/SOURCES.md, CC BY 3.0), 384×216, 4.417 s. Font downloads are off, so
// nothing here goes online.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { shotMeasures } from "../engine/boardMeasure.js";
import { shotRoles } from "../engine/movePicks.js";
import { aspectWords, boardData } from "./agent/board-data.mjs";
import { skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

// ---- the builder -----------------------------------------------------------------------------

const CLIP_SRC = "/api/media/clip-1.mp4";
const GONE_SRC = "/api/media/gone-2.mp4";
const RECORDS = new Map([[CLIP_SRC, { name: "sintel-village-dragon.mp4", width: 384, height: 216, mime: "video/mp4" }], [GONE_SRC, null]]);
const shotOf = (id, cue, dur, extra = {}) => ({ id, cue, dur, pacing: "free", media: CLIP_SRC, in: cue, crop: [20, 12, 24, 76],
  subject: { what: "the dragon", boxes: [[24, 30, 14, 30]] }, follow: "steady", text: "none", sound: "none", why: "the dragon over the village", alts: [], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const titleCard = (id, cue, dur) => ({ id, cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "The dragon is back", family: "Inter", weight: 700, size: 96, y: 40, fill: "#ffffff" }, sound: "none", why: "the line", alts: [{ why: "a lower line" }], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" } });
const documentOf = (width, height) => ({ scenes: [{ id: "main", width, height, duration: 6, layers: [] }],
  board: { rev: 3, music: "none", calls: ["End on the title"], open: [], shots: [shotOf("S1", 0, 2, { alts: [{ media: GONE_SRC, in: 1, why: "the other clip" }] }), shotOf("S2", 2, 2, { media: GONE_SRC }), titleCard("S3", 4, 2)] } });
const STATE = { brief: { fields: { message: { text: "The dragon is back" }, plays_on: { text: "TikTok" } } } };

test("board-data for a 9:16 board: header, the app's covered areas, each shot's file, subject, measures and change", () => {
  const document = documentOf(1080, 1920);
  const round = { id: "C2", kind: "board", rev: 7, status: "waiting", fresh: "skipped", answer: null, changed: null,
    redone: { stop: "C1", named: ["S1", "S3"], asked: ["S1"], unasked: [{ id: "S2", what: ["footage"] }], missed: ["S3"], removed: [], changed: [{ id: "S1", what: ["crop"] }, { id: "S2", what: ["footage"] }] } };
  const data = boardData(document, { state: STATE, round, rev: 7, project: "dragon", records: RECORDS, soundFiles: true });
  const { shots, ...rest } = data;
  assert.deepEqual(rest, {
    project: "dragon", rev: 7, stop: "C2", status: "waiting", answer: null, fresh: "skipped",
    header: { board: 3, shots: 3, seconds: 6, width: 1080, height: 1920, aspect: "9:16", background: "#000000", platform: "TikTok" },
    purpose: "The dragon is back", music: null, audio: [], calls: ["End on the title"], open: [], lapsed: null, redone: round.redone,
    covered: { right: 11.1, bottom: 36.8, verified: false }, soundSearch: false, soundFiles: true,
  });
  const frame = { width: 1080, height: 1920 };
  assert.deepEqual(shots[0], { n: 1, id: "S1", start: 0, end: 2, dur: 2, speed: 1, role: shotRoles(document.board.shots, { [CLIP_SRC]: "sintel-village-dragon.mp4", [GONE_SRC]: null })[0], pacing: "free", follow: "steady", in: 0, crop: [20, 12, 24, 76], text: "none", sound: "none",
    why: "the dragon over the village", alts: [{ media: { src: GONE_SRC, missing: true }, in: 1, why: "the other clip" }], move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, media: { src: CLIP_SRC, name: "sintel-village-dragon.mp4", width: 384, height: 216, kind: "video" },
    subject: { what: "the dragon", boxes: [[24, 30, 14, 30]], by: "agent" }, measures: shotMeasures(document.board.shots[0], frame), change: { asked: true, what: ["crop"] } });
  assert.deepEqual(shots[1].media, { src: GONE_SRC, missing: true }, "kino's library no longer has it");
  assert.deepEqual(shots[1].change, { asked: false, what: ["footage"] }, "changed without being asked");
  assert.deepEqual([shots[2].media, shots[2].subject, shots[2].crop, shots[2].in, shots[2].follow, shots[2].change, shots[2].alts], ["none", "none", "none", "none", "none", null, [{ why: "a lower line" }]]);
  assert.deepEqual(shots[2].measures, shotMeasures(document.board.shots[2], frame));

  // No shot named: a change is not "asked" either way.
  const since = boardData(document, { round: { ...round, redone: { ...round.redone, named: [], asked: [], unasked: [], missed: [] } }, rev: 7, project: "dragon", records: RECORDS });
  assert.deepEqual(since.shots.map((shot) => shot.change), [{ asked: null, what: ["crop"] }, { asked: null, what: ["footage"] }, null]);
  assert.deepEqual([since.purpose, since.header.platform, since.soundFiles], [null, null, false], "no brief lines");
});

test("board-data for a 16:9 board has no covered areas; no round is not asked yet; no board is null", () => {
  const data = boardData(documentOf(1920, 1080), { rev: 2, project: "wide", records: RECORDS });
  assert.deepEqual([data.header.aspect, data.covered, data.stop, data.status, data.answer, data.fresh, data.redone], ["16:9", null, null, "not asked yet", null, null, null]);
  const answered = boardData(documentOf(1920, 1080), { rev: 2, project: "wide", records: RECORDS,
    round: { id: "C1", status: "answered", changed: { why: ["shot 2 text changed"], ids: ["S2"], approved: "C1" },
      answer: { via: "dashboard", read_as: "redo", words: null, shots: [{ id: "S2", n: 2, words: "closer" }], at: "2026-10-25T08:00:00.000Z", client: "dashboard", afterSeconds: 9 } } });
  assert.deepEqual(answered.answer, { via: "dashboard", read_as: "redo", words: null, shots: [{ id: "S2", n: 2, words: "closer" }], at: "2026-10-25T08:00:00.000Z" });
  assert.deepEqual(answered.lapsed, { why: ["shot 2 text changed"], approved: "C1" });
  assert.equal(boardData({ scenes: [{ id: "main", width: 1080, height: 1920, duration: 6, layers: [] }] }, { rev: 1, project: "none" }), null);
  assert.deepEqual([aspectWords({ width: 1080, height: 1080 }), aspectWords({ width: 1080, height: 1350 }), aspectWords({ width: 1000, height: 700 }), aspectWords({ width: 1078, height: 1920 })],
    ["1:1", "4:5", "1000×700", "9:16"]);
});

// ---- the routes, on a real server ---------------------------------------------------------------

const CLIP = fileURLToPath(new URL("../tests/fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const skip = skipWithoutMediaTools;
let server;
let clip;
let key;
before(async () => {
  if (skip) return;
  server = await startTestServer({ env: { MOTION_FONT_DOWNLOADS: "off" } });
  const response = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": path.basename(CLIP) }, body: await readFile(CLIP) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  clip = { ...media, src: media.src ?? media.media?.src };
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
});
after(async () => {
  await server?.stop();
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const footage = (cue, dur, inPoint, x, extra = {}) => ({ cue, dur, pacing: "free", media: clip.src, in: inPoint, crop: [x, 12, 24, 76],
  subject: { what: "the dragon", box: [x + 4, 30, 14, 30] }, follow: "steady", text: "none", sound: "none", why: "the dragon over the village", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" }, ...extra });
const motion = (cue, dur) => ({ cue, dur, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none",
  text: { text: "The dragon is back", family: "Inter" }, sound: "none", why: "the line on its own", move: { kind: "transition", name: "zoom-through", ref: "phone-film@7.27" } });
const STOP_SHOTS = () => [footage(0, 1.25, 0, 20), footage(1.25, 2.083, 1.25, 38), footage(3.333, 1.084, 3.333, 55, { alts: [{ crop: [8, 12, 24, 76], why: "wider" }] }), motion(4.417, 4.383)];
const editBoard = async (project, shots) => {
  const edited = await agent("edit", { project, ops: [{ op: "board", music: "none", shots, calls: ["End on the title"] }] });
  assert.equal(edited.isError, undefined, edited.text);
};
const read = (route, query) => server.api(`/api/dashboard/${route}?${new URLSearchParams(query)}`);
async function readJson(query) {
  const response = await read("board-data", query);
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test("GET board-data: by stop, by rev, the newest round, and each refusal", { skip, timeout: 120_000 }, async () => {
  const id = "board-data";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 8.8, background: "#101114" })).isError, undefined);
  const empty = await readJson({ project: id });
  assert.deepEqual([empty.status, empty.body.error], [404, "No storyboard in rev 1."]);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src } }] })).isError, undefined);
  const brief = await agent("notes", { project: id, action: "brief", fields: { plays_on: { text: "TikTok, 9:16, 9 s", by: "guessed" } } });
  assert.equal(brief.isError, undefined, brief.text);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  await editBoard(id, STOP_SHOTS());
  const before = await readJson({ project: id });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual([before.body.stop, before.body.status, before.body.header.shots, before.body.header.aspect, before.body.header.platform], [null, "not asked yet", 4, "9:16", "TikTok, 9:16, 9 s"]);
  assert.deepEqual(before.body.shots[0].media, { src: clip.src, name: "sintel-village-dragon.mp4", width: 384, height: 216, kind: "video" });
  assert.deepEqual(before.body.shots[3].media, "none");

  const asked = await agent("notes", { project: id, action: "checkpoint", id: "board", fresh: "ran" });
  assert.equal(asked.data.status, "waiting_for_you", asked.text);
  const byStop = await readJson({ project: id, stop: "c1" });
  assert.equal(byStop.status, 200, JSON.stringify(byStop.body));
  assert.deepEqual([byStop.headers.get("content-type"), byStop.headers.get("cache-control"), byStop.headers.get("x-content-type-options")], ["application/json; charset=utf-8", "no-cache", "nosniff"]);
  assert.deepEqual([byStop.body.project, byStop.body.stop, byStop.body.status, byStop.body.rev, byStop.body.fresh, byStop.body.calls], [id, "C1", "waiting", asked.data.rev, "ran", ["End on the title"]]);
  assert.deepEqual((await readJson({ project: id, rev: asked.data.rev })).body, byStop.body, "the revision C1 showed");
  assert.deepEqual((await readJson({ project: id })).body, byStop.body, "the newest storyboard round");
  // The board answered with a note on shot 2; the agent changes it and asks again.
  const answered = await server.api("/api/dashboard/stops", { method: "POST", headers: { "x-kino-review": key },
    body: { project: id, action: "answer", id: "C1", rev: asked.data.rev, read_as: "redo", shots: [{ id: "S2", words: "closer on the dragon" }] } });
  assert.equal(answered.status, 200, await answered.clone().text());
  const redone = STOP_SHOTS();
  redone[1] = { ...redone[1], crop: [42, 20, 16, 50], subject: { what: "the dragon", box: [44, 30, 12, 30] } };
  await editBoard(id, redone);
  const again = await agent("notes", { project: id, action: "checkpoint", id: "board" });
  assert.equal(again.data.id, "C2", again.text);
  const second = (await readJson({ project: id, stop: "C2" })).body;
  assert.deepEqual(second.redone, { stop: "C1", named: ["S2"], asked: ["S2"], unasked: [], missed: [], removed: [], changed: [{ id: "S2", what: ["crop"] }] });
  assert.deepEqual(second.shots.map((shot) => shot.change), [null, { asked: true, what: ["crop"] }, null, null]);
  assert.equal(second.fresh, null);
  const first = (await readJson({ project: id, stop: "C1" })).body;
  assert.deepEqual({ ...first.answer, at: "at" }, { via: "dashboard", read_as: "redo", words: null, shots: [{ id: "S2", n: 2, words: "closer on the dragon" }], at: "at" });
  assert.equal(first.status, "answered");
  assert.deepEqual(first.shots[1].crop, [38, 12, 24, 76], "C1 shows the board as it was then");

  for (const [query, status, error] of [
    [{ stop: "C1", rev: asked.data.rev }, 400, "Send stop or rev, not both."],
    [{ stop: "C9" }, 404, "C9 is not a storyboard stop of this project."],
    [{ rev: 0 }, 400, "rev is a saved revision of this project."],
    [{ rev: 999 }, 400, "rev is a saved revision of this project."],
    [{ rev: "two" }, 400, "rev is a saved revision of this project."],
    [{ rev: 1 }, 404, "No storyboard in rev 1."],
  ]) {
    const refused = await readJson({ project: id, ...query });
    assert.deepEqual([refused.status, refused.body.error], [status, error], JSON.stringify(query));
  }
  assert.equal((await readJson({ project: "no-such-project" })).status, 404);
  // The dashboard's stop summary leaves the round's shown and redone out (they are here).
  const summary = (await (await server.api(`/api/dashboard/snapshot?project=${id}`)).json()).agent.stops;
  assert.ok(summary.rounds.every((round) => !("shown" in round) && !("redone" in round)));
});

test("GET board-shot: a shot's source frame and cropped still as PNGs the asked width, kept by the browser, and each refusal", { skip, timeout: 120_000 }, async () => {
  const id = "board-shot";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration: 8.8, background: "#101114" })).isError, undefined);
  await editBoard(id, STOP_SHOTS());
  const { revision: rev } = await (await server.api(`/api/projects/${id}`)).json();
  const shotImage = async (query) => {
    const response = await read("board-shot", { project: id, rev, ...query });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual([response.headers.get("content-type"), response.headers.get("cache-control"), response.headers.get("x-content-type-options")],
      ["image/png", "private, max-age=31536000, immutable", "nosniff"]);
    return Buffer.from(await response.arrayBuffer());
  };
  // The source keeps the file's shape (384×216); the still is the video's 9:16.
  assert.deepEqual(pngSize(await shotImage({ shot: "S2", part: "source", w: 240 })), { width: 240, height: 135 });
  assert.deepEqual(pngSize(await shotImage({ shot: "S2", part: "source", w: 480 })), { width: 480, height: 270 });
  assert.deepEqual(pngSize(await shotImage({ shot: "S2", part: "still", w: 240 })), { width: 240, height: 427 });
  assert.deepEqual(pngSize(await shotImage({ shot: "S4", part: "still", w: 240 })), { width: 240, height: 427 }, "a title card's still");
  const head = await server.api(`/api/dashboard/board-shot?${new URLSearchParams({ project: id, rev, shot: "S1", part: "still", w: 240 })}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  // The last frame and an option still are the video's shape too.
  assert.deepEqual(pngSize(await shotImage({ shot: "S2", part: "last", w: 240 })), { width: 240, height: 427 });
  assert.deepEqual(pngSize(await shotImage({ shot: "S3", part: "alt1", w: 240 })), { width: 240, height: 427 });

  for (const [query, status, error] of [
    [{ shot: "S2", part: "frame", w: 240 }, 400, "part is source, still, last, alt1 or alt2."],
    [{ shot: "S1", part: "alt1", w: 240 }, 404, "shot S1 has no option 1."],
    [{ shot: "S2", part: "source", w: 300 }, 400, "w is 240, 480 or 960."],
    [{ shot: "S2", part: "source" }, 400, "w is 240, 480 or 960."],
    [{ shot: "S9", part: "source", w: 240 }, 404, `shot S9 is not in rev ${rev}.`],
    [{ shot: "S4", part: "source", w: 240 }, 404, "shot S4 has no footage."],
    [{ rev: undefined, shot: "S2", part: "source", w: 240 }, 400, "rev is a saved revision of this project."],
    [{ rev: rev + 1, shot: "S2", part: "source", w: 240 }, 400, "rev is a saved revision of this project."],
    [{ rev: 1, shot: "S2", part: "source", w: 240 }, 404, "shot S2 is not in rev 1."],
  ]) {
    const params = { project: id, rev, ...query };
    if (params.rev === undefined) delete params.rev;
    const refused = await read("board-shot", params);
    assert.deepEqual([refused.status, (await refused.json()).error], [status, error], JSON.stringify(query));
  }
});
