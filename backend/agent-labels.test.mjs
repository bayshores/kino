// The plain words the dashboard shows for each agent call (milestone LIVE, backend/agent/labels.mjs):
// the label table of design F2, names instead of IDs, no secrets (share links, file paths, URLs),
// at most 60 characters and no control or bidi characters. Also the pointing line (F5) and the
// words for what a call is about.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { callLabel, callTarget, pointingText, timeText } from "./agent/labels.mjs";
import { assignCodes, emptyCodes } from "./agent/refs.mjs";

// One scene "S1" with a Title text, a Logo image and a card with a random ID (it gets a short code).
function sample() {
  const document = createDocument({
    id: "labels",
    scenes: [createScene({ id: "s1", name: "S1", duration: 4, layers: [
      createLayer("text", { id: "title", name: "Title" }),
      createLayer("rectangle", { id: "logo", name: "Logo" }),
      createLayer("rectangle", { id: "4f0c2a6e-1b2c-4d5e-8f90-123456789abc", name: "card" }),
    ] })],
  });
  return { document, codes: assignCodes(emptyCodes(), document) };
}

test("each call reads as the design's label table says", () => {
  const { document, codes } = sample();
  const label = (verb, input) => callLabel(verb, input, { document, codes });
  assert.equal(label("look", { mode: "sheet", from: 1, to: 2 }), "look at 1.0–2.0 s");
  assert.equal(label("look", { mode: "frame", t: 0.5 }), "look at 0.5 s");
  assert.equal(label("look", { mode: "sheet" }), "look at the whole scene");
  assert.equal(label("look", {}), "look at the whole scene", "sheet is look's default mode");
  assert.equal(label("edit", { ops: [{ op: "add_layer", layerType: "text", name: "Title" }] }), "add text Title");
  assert.equal(label("edit", { ops: [{ op: "add_layer", type: "text", properties: { name: "Title" } }] }), "add text Title");
  assert.equal(label("edit", { ops: [{ op: "update_layer", layer: "logo", properties: { x: 10, y: 20 } }] }), "move Logo");
  assert.equal(label("edit", { ops: [{ op: "update_layer", layer: "logo", properties: { width: 10 } }] }), "resize Logo");
  assert.equal(label("edit", { ops: [{ op: "update_layer", layer: "logo", properties: { opacity: 0.5 } }] }), "change Logo");
  assert.equal(label("edit", { ops: [
    { op: "update_layer", layer: "logo", properties: { x: 10 } },
    { op: "delete_layer", layer: "title" },
    { op: "add_animation", layer: "title", preset: "fade-in" },
  ] }), "move Logo +2 more");
  assert.equal(label("edit", { dry_run: true, ops: [{ op: "delete_layer", layer: "title" }] }), "try: delete Title");
  assert.equal(label("edit", { ops: [{ op: "add_scene", name: "outro" }] }), "add scene outro");
  assert.equal(label("inspect", { targets: ["title", "logo"] }), "inspect Title, Logo");
  assert.equal(label("check", { scene: "s1" }), "check S1");
  assert.equal(label("check", {}), "check the video");
  assert.equal(label("history", { action: "revert", turn: "T3" }), "revert T3");
  assert.equal(label("project", { action: "share" }), "create a share link");
  assert.equal(label("project", { action: "manage", options: { resource: "shares", action: "create" } }), "create a share link");
  assert.equal(label("status", {}), "read the outline");
});

test("a layer with a random ID is named by its name, and by its short code without one", () => {
  const { document, codes } = sample();
  const code = codes.byId["4f0c2a6e-1b2c-4d5e-8f90-123456789abc"];
  assert.ok(code, "the card has a short code");
  assert.equal(callLabel("look", { mode: "zoom", layer: code }, { document, codes }), "zoom on card");
  const nameless = structuredClone(document);
  nameless.scenes[0].layers[2].name = "";
  assert.equal(callLabel("look", { mode: "zoom", layer: code }, { document: nameless, codes }), `zoom on ${code}`);
  assert.doesNotMatch(callLabel("look", { mode: "zoom", layer: code }, { document: nameless, codes }), /4f0c2a6e/);
});

test("a label holds no secrets: an import names only the file, and paths and URLs never appear", () => {
  const { document, codes } = sample();
  const import1 = callLabel("project", { action: "import", file: "/Users/someone/Private/clips/beach.mov" }, { document, codes });
  assert.equal(import1, "import beach.mov");
  const windows = callLabel("project", { action: "import", file: "C:\\Users\\someone\\clip.mp4" }, { document, codes });
  assert.equal(windows, "import clip.mp4");
  const search = callLabel("library", { topic: "media", search: "https://example.com/secret?token=abc" }, { document, codes });
  assert.equal(search, "search media for a link");
  const named = callLabel("edit", { ops: [{ op: "add_layer", layerType: "image", name: "/Users/someone/Desktop/logo.png" }] }, { document, codes });
  assert.equal(named, "add image logo.png");
});

test("every label is at most 60 characters with no control, bidi or zero-width characters", () => {
  const { document, codes } = sample();
  const hostile = `Ti\u202etle\u0007\u200b${"x".repeat(200)}`;
  const inputs = [
    ["edit", { ops: [{ op: "add_layer", layerType: "text", name: hostile }] }],
    ["edit", { ops: [{ op: `bogus\u0000op_${"y".repeat(80)}` }] }],
    ["look", { mode: "strip", anim: hostile }],
    ["look", { mode: `weird\u202emode${"z".repeat(90)}` }],
    ["inspect", { targets: [hostile, hostile, hostile, hostile, hostile, hostile] }],
    ["library", { topic: "media", search: hostile }],
    ["notes", { action: "reply", id: hostile }],
    ["project", { action: "create", name: hostile }],
    ["render", { action: "wait", job: hostile }],
    ["history", { action: "revert", turn: hostile }],
    ["edit", { retry: hostile }],
    ["unknown_verb_with_a_very_long_name_that_goes_on_and_on_and_on", {}],
    ["look", null],
    ["edit", { ops: "not a list" }],
  ];
  for (const [verb, input] of inputs) {
    const text = callLabel(verb, input, { document, codes });
    assert.ok(text.length > 0 && text.length <= 60, `${verb}: "${text}" is 1 to 60 characters`);
    assert.doesNotMatch(text, /\p{C}/u, `${verb}: "${text}" has no control characters`);
  }
});

test("times read with one decimal, or two when they need them", () => {
  assert.equal(timeText(2), "2.0");
  assert.equal(timeText(0.5), "0.5");
  assert.equal(timeText(1.25), "1.25");
  assert.equal(timeText(1.254), "1.25");
});

test("the pointing line names layers, a time range in a scene, or both", () => {
  const { codes } = sample();
  assert.equal(pointingText({ sceneId: "s1", layerIds: ["logo"], where: "dashboard" }, { codes }), "logo (you selected it in the dashboard)");
  assert.equal(pointingText({ sceneId: "s1", layerIds: ["logo", "title"], where: "dashboard" }, { codes }), "logo, title (you selected them in the dashboard)");
  assert.equal(pointingText({ sceneId: "s1", layerIds: [], range: [2, 3.5], where: "dashboard" }, { codes }), "2.0–3.5 s in s1 (you selected it in the dashboard)");
  assert.equal(pointingText({ sceneId: "s1", layerIds: ["logo"], range: [2, 3.5], where: "dashboard" }, { codes }), "logo at 2.0–3.5 s in s1 (you selected it in the dashboard)");
  assert.equal(pointingText({ sceneId: "s1", layerIds: [] }, { codes }), null);
});

test("the words for what a call is about name layers and times for screen readers", () => {
  const { document, codes } = sample();
  assert.deepEqual(callTarget(document, codes, { sceneId: "s1", layerIds: ["title"], range: [1, 2] }),
    { sceneId: "s1", sceneName: "S1", layerIds: ["title"], time: null, range: [1, 2], text: "Title, 1.0–2.0 s" });
  assert.equal(callTarget(document, codes, { sceneId: "s1", time: 0.5 }).text, "0.5 s");
  assert.equal(callTarget(document, codes, { sceneId: "s1" }).text, "S1");
  assert.equal(callTarget(document, codes, {}).text, "the video");
});
