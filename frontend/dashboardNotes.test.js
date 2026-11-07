// Notes on the frame (frontend/dashboard/noteSpot.js): what a click snaps to, the dot, the words.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { layerBounds } from "./layerBounds.js";
import { bubbleSide, noteCursorRows, noteDot, noteGroups, noteNumber, noteReader, noteStatus, notesForYou, readerLine, snapNote } from "./dashboard/noteSpot.js";

// A 1920×1080 scene: a full-frame clip, a phone group with its screen in it, and a small title.
function scene() {
  const backdrop = createLayer("rectangle", { id: "backdrop", name: "backdrop", width: 1920, height: 1080 });
  const phone = createLayer("group", { id: "phone", name: "phone", width: 400, height: 800, x: 500, y: 0 });
  const screen = createLayer("rectangle", { id: "screen", name: "screen", parentId: "phone", width: 300, height: 500 });
  const title = createLayer("text", { id: "title", name: "title", text: "Hi", width: 300, height: 80, x: -600, y: -400 });
  const made = createScene({ id: "s1", width: 1920, height: 1080, layers: [backdrop, phone, screen, title] });
  return { document: createDocument({ scenes: [made] }), scene: made };
}

function middleOf(document, sceneValue, id) {
  const box = layerBounds(document, sceneValue, [id]);
  return { x: box.x + sceneValue.width / 2 + box.width / 2, y: box.y + sceneValue.height / 2 + box.height / 2 };
}

test("a click snaps to the group around the layer under it, with that group's box", () => {
  const { document, scene: made } = scene();
  const at = middleOf(document, made, "screen");
  const snap = snapNote(document, made, at);
  assert.equal(snap.layerId, "phone");
  assert.ok(snap.area.width > 1 && snap.area.height > 1);
  assert.ok(at.x >= snap.area.x && at.x <= snap.area.x + snap.area.width && at.y >= snap.area.y && at.y <= snap.area.y + snap.area.height, JSON.stringify({ at, area: snap.area }));
  assert.deepEqual(snap.point, { x: Math.round(at.x), y: Math.round(at.y) });
});

test("a click on a layer that covers most of the frame keeps the spot", () => {
  const { document, scene: made } = scene();
  const snap = snapNote(document, made, { x: 60, y: 1040 });
  assert.equal(snap.layerId, null);
  assert.deepEqual(snap.area, { x: 60, y: 1040, width: 1, height: 1 });
});

test("a locked layer lets the click through to the one under it", () => {
  const { document, scene: made } = scene();
  const at = middleOf(document, made, "title");
  assert.equal(snapNote(document, made, at).layerId, "title");
  made.layers.find((layer) => layer.id === "title").locked = true;
  assert.equal(snapNote(document, made, at).layerId, null, "only the backdrop is under it, and it is too big");
});

test("a note's number, dot, bubble side and state words", () => {
  assert.equal(noteNumber("N12"), "12");
  assert.equal(noteNumber("x"), "x");
  assert.deepEqual(noteDot({ area: { x: 100, y: 50, width: 200, height: 100 } }), { x: 200, y: 100 });
  assert.deepEqual(noteDot({ point: { x: 7, y: 8 }, area: { x: 0, y: 0, width: 50, height: 50 } }), { x: 7, y: 8 });
  assert.equal(noteDot({}), null);
  assert.equal(bubbleSide({ x: 1500, y: 10 }, { width: 1920 }), "left");
  assert.equal(bubbleSide({ x: 100, y: 10 }, { width: 1920 }), "right");
  assert.equal(bubbleSide(null, { width: 1920 }), "center");
  assert.equal(noteStatus({ status: "new" }).words, "queued");
  assert.equal(noteStatus({ status: "new", channelAt: "2026-10-28T08:00:00Z" }).words, "sent");
  assert.equal(noteStatus({ status: "seen" }).words, "working");
  assert.equal(noteStatus({ status: "addressed" }).words, "fixed");
  assert.equal(noteStatus({ status: "resolved" }).words, "done");
});

test("the notes view: stopped, open, always, done; the cursor rows; what needs you; who reads", () => {
  const notes = [
    { id: "N4", status: "addressed" }, { id: "N3", status: "new", always: true }, { id: "N2", status: "resolved", always: true }, { id: "N1", status: "resolved" },
  ];
  const groups = noteGroups(notes, [{ id: "S1" }]);
  assert.deepEqual(groups.open.map((note) => note.id), ["N4", "N3"]);
  assert.deepEqual(groups.always.map((note) => note.id), ["N3", "N2"]);
  assert.deepEqual(groups.done.map((note) => note.id), ["N1"]);
  assert.deepEqual(noteCursorRows(groups).map((row) => `${row.type} ${row.id}`), ["stopped S1", "note N4", "note N3"]);
  assert.equal(notesForYou(notes, [{ id: "S1" }]), 2);
  const now = Date.parse("2026-10-27T12:00:00Z");
  const data = { projectId: "p1", agents: [{ name: "Juno", projectId: "p2", lastAt: "2026-10-27T11:59:00Z" }, { name: "Nova", projectId: "p1", lastAt: "2026-10-27T11:58:00Z" }] };
  assert.equal(readerLine(noteReader(data, now)), "Nova reads notes between steps");
  assert.equal(readerLine(noteReader(data, now + 3_600_000)), "notes wait until an agent starts");
  assert.equal(noteReader({ ...data, crew: { members: [{ name: "Ada", projectId: "p1", state: "idle" }] } }, now + 3_600_000), "Ada");
});
