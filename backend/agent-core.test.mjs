// Milestone A2, pure parts of the agent service: short codes and name lookup (refs), operation
// translation (translate), the status outline, inspect selectors and the check rules.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyOperations } from "../engine/operations.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { assignCodes, closest, createResolver, documentObjects, emptyCodes, ReferenceError } from "./agent/refs.mjs";
import { OperationError, translateOperations } from "./agent/translate.mjs";
import { layerHash, LAYERS_PER_PAGE, projectOutline } from "./agent/outline.mjs";
import { inspectTargets, MAX_INSPECT } from "./agent/inspect.mjs";
import { adviceLine, checkDocument, checkReport, checkSummary, groupFixLines, MAX_FINDINGS, mergeFindings, openFindingLines, waiverNotes } from "./agent/checks.mjs";

// A one-scene document ("main", 640×360) with the given engine operations applied.
function sceneDocument(operations = [], { duration = 4 } = {}) {
  const document = createDocument({ id: "demo", name: "Demo", scenes: [createScene({ id: "main", name: "Main", width: 640, height: 360, duration })] });
  return parseDocument(applyOperations(document, operations.map((operation) => ({ sceneId: "main", ...operation }))));
}

const text = (id, properties = {}) => ({ type: "add_layer", layerType: "text", properties: { id, text: id, x: 10, y: 10, ...properties } });
const rectangle = (id, properties = {}) => ({ type: "add_layer", layerType: "rectangle", properties: { id, x: 100, y: 100, width: 200, height: 100, ...properties } });
const fade = (layerId, start, duration) => ({ type: "add_animation", layerId, preset: "preset-fade", start, duration });

// The title + card document most tests start from: L1 title (text), L2 card, A1 title.in.
function titleAndCard() {
  const document = sceneDocument([text("title", { name: "Hero title", fontSize: 48 }), rectangle("card"), fade("title", 0.5, 1)]);
  const codes = assignCodes(emptyCodes(), document);
  return { document, codes, resolver: createResolver(document, codes) };
}

// ---- refs ----------------------------------------------------------------------------------

test("codes are handed out in document order by kind, kept across edits and never reused", () => {
  const { document, codes } = titleAndCard();
  const animationId = documentObjects(document).animations[0].id;
  assert.deepEqual(codes.byId, { main: "s1", title: "L1", card: "L2", [animationId]: "A1" });

  // Delete the card and add a new layer: the title keeps L1 and the new layer gets L3, not L2.
  const next = parseDocument(applyOperations(document, [{ type: "delete_layer", sceneId: "main", layerId: "card" }, { sceneId: "main", ...rectangle("panel") }]));
  const after = assignCodes(codes, next);
  assert.equal(after.byId.title, "L1");
  assert.equal(after.byId.panel, "L3");
  assert.equal(after.byId.card, undefined, "a removed layer's code is forgotten");
  assert.deepEqual(after.next, { s: 2, L: 4, A: 2 });
});

test("the resolver finds IDs, short codes in any case, display names and layer.kind", () => {
  const { document, resolver } = titleAndCard();
  const animationId = documentObjects(document).animations[0].id;
  assert.equal(resolver.resolve("title", "layer"), "title");
  assert.equal(resolver.resolve("L1", "layer"), "title");
  assert.equal(resolver.resolve("l2", "layer"), "card");
  assert.equal(resolver.resolve("TITLE", "layer"), "title", "an ID matches regardless of case");
  assert.equal(resolver.resolve("Hero title", "layer"), "title", "a unique display name works for layers");
  assert.equal(resolver.resolve("hero TITLE", "layer"), "title");
  assert.equal(resolver.resolve("Main", "scene"), "main", "a unique display name works for scenes");
  assert.equal(resolver.resolve("s1", "scene"), "main");
  assert.equal(resolver.resolve("A1", "animation"), animationId);
  assert.equal(resolver.resolve("title.in", "animation"), animationId, "layer.kind names the one animation of that kind");
  assert.deepEqual(resolver.fixes, [], "exact matches are not reported as fixes");
});

test("a code of the wrong kind is refused with suggestions of the right kind", () => {
  const { resolver } = titleAndCard();
  assert.throws(() => resolver.resolve("L1", "scene"), (error) => {
    assert.ok(error instanceof ReferenceError);
    assert.equal(error.code, "unknown_ref");
    assert.equal(error.kind, "scene");
    assert.ok(error.suggestions.includes("s1"));
    return true;
  });
});

test("a swap of neighbouring letters counts as one edit, so 'titel' is fixed to 'title' and reported", () => {
  const { resolver } = titleAndCard();
  assert.equal(resolver.resolve("titel", "layer"), "title");
  assert.equal(resolver.resolve("crad", "layer"), "card");
  assert.equal(resolver.resolve("cards", "layer"), "card", "one extra letter is one edit");
  assert.deepEqual(resolver.fixes, ["titel → title", "crad → card", "cards → card"]);
  assert.equal(closest("titel", ["card", "main", "title"])[0], "title");
});

test("names of 8 or more letters allow two edits; shorter ones allow one; under 4 letters none", () => {
  const document = sceneDocument([text("headline"), rectangle("title"), rectangle("card")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  assert.equal(resolver.resolve("headlinexx", "layer"), "headline", "10 letters, 2 edits away");
  assert.throws(() => resolver.resolve("titlexx", "layer"), /No layer "titlexx"\. Did you mean title/, "7 letters, 2 edits away is too far");
  assert.equal(resolver.resolve("tile", "layer"), "title", "4 letters, 1 edit away");
  assert.throws(() => resolver.resolve("crd", "layer"), ReferenceError, "under 4 letters is never fixed");
  assert.deepEqual(resolver.fixes, ["headlinexx → headline", "tile → title"]);
});

test("a display name several layers share answers with each layer's code and ID, not No layer", () => {
  // Older projects named every caption shade a move made "Caption shade".
  const document = sceneDocument([rectangle("said-1-scrim", { name: "Caption shade" }), rectangle("said-2-scrim", { name: "Caption shade" }), text("title")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  assert.throws(() => resolver.resolve("Caption shade", "layer"), (error) => {
    assert.ok(error instanceof ReferenceError && error.ambiguous);
    assert.match(error.message, /^"Caption shade" names 2 layers: L1 \(said-1-scrim\), L2 \(said-2-scrim\)/);
    assert.deepEqual(error.suggestions, ["said-1-scrim", "said-2-scrim"]);
    return true;
  });
  assert.equal(resolver.resolve("said-2-scrim", "layer"), "said-2-scrim");
});

test("a far miss or a near miss with two candidates throws a ReferenceError with did-you-mean", () => {
  const document = sceneDocument([rectangle("card1"), rectangle("card2"), text("title")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  assert.throws(() => resolver.resolve("zzzzzz", "layer"), (error) => {
    assert.ok(error instanceof ReferenceError);
    assert.match(error.message, /^No layer "zzzzzz"\. Did you mean /);
    assert.equal(error.suggestions.length, 3);
    return true;
  });
  assert.throws(() => resolver.resolve("card3", "layer"), (error) => {
    assert.deepEqual(error.suggestions.slice(0, 2), ["card1", "card2"], "both near names are offered, neither is picked");
    return true;
  });
  assert.deepEqual(resolver.fixes, []);
});

test("IDs declared earlier in a batch resolve before they exist", () => {
  const { resolver } = titleAndCard();
  assert.throws(() => resolver.resolve("badge", "layer"), ReferenceError);
  resolver.declare("layer", "badge", { sceneId: "main" });
  assert.equal(resolver.resolve("badge", "layer"), "badge");
  assert.equal(resolver.sceneOf("layer", "badge"), "main");
});

// ---- translate -----------------------------------------------------------------------------

test("translate renames the documented short field names without reporting them as fixes", () => {
  const document = sceneDocument([text("title"), rectangle("card"), fade("title", 0, 1), { type: "add_layer", layerType: "group", properties: { id: "box" } }]);
  const codes = assignCodes(emptyCodes(), document);
  const resolver = createResolver(document, codes);
  const animationId = documentObjects(document).animations[0].id;
  const [layer, scene, layers, parent, animation, added] = translateOperations([
    { op: "update_layer", layer: "title", properties: { x: 5 } },
    { op: "update_scene", scene: "s1", properties: { duration: 6 } },
    { op: "group_layers", layers: ["L1", "card"], groupId: "pair" },
    { op: "move_layers", layerIds: ["card"], parent: "box" },
    { op: "update_animation", animation: "title.in", properties: { duration: 2 } },
    { op: "add_animation", layer: "card", animation: { kind: "in", duration: 1, from: { opacity: 0 }, to: { opacity: 1 } } },
  ], resolver, document);
  assert.deepEqual(layer, { type: "update_layer", layerId: "title", sceneId: "main", properties: { x: 5 } });
  assert.deepEqual(scene, { type: "update_scene", sceneId: "main", properties: { duration: 6 } });
  assert.deepEqual(layers.layerIds, ["title", "card"]);
  assert.equal(parent.parentId, "box");
  assert.equal(animation.animationId, animationId);
  assert.equal(animation.layerId, "title", "update_animation gets the layer of its animation");
  assert.equal(typeof added.animation, "object", "in add_animation, animation is the animation itself");
  assert.equal(added.animationId, undefined);
  // Before AF-2 each of these six renames was a line in the receipt's `fixed`.
  assert.deepEqual(resolver.fixes, []);
});

test("{op:'add_layer', type:<layer type>} means layerType, and top-level name and scene fields move into properties", () => {
  const { document, resolver } = titleAndCard();
  const [layer, scene] = translateOperations([
    { op: "add_layer", type: "ellipse", name: "Dot", properties: { x: 3 } },
    { op: "add_scene", name: "Outro", width: 320, height: 180, duration: 2, background: "#000000" },
  ], resolver, document);
  assert.deepEqual(layer, { type: "add_layer", layerType: "ellipse", sceneId: "main", properties: { x: 3, name: "Dot", id: "dot" } });
  assert.deepEqual(scene, { type: "add_scene", properties: { name: "Outro", width: 320, height: 180, duration: 2, background: "#000000", id: "outro" } });
  assert.equal(scene.sceneId, undefined, "add_scene needs no scene");
  assert.ok(resolver.fixes.includes("type → layerType"));
});

test("a new layer named without an ID gets a slug ID, with -2 when the slug is taken, usable later in the batch", () => {
  const document = sceneDocument([text("hero-title")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  const translated = translateOperations([
    { op: "add_layer", layerType: "text", name: "Hero title", properties: { text: "One" } },
    { op: "add_layer", layerType: "text", name: "Hero Title!", properties: { text: "Two" } },
    { op: "add_layer", layerType: "rectangle", name: "  Big   Card!! " },
    { op: "add_animation", layer: "hero-title-3", preset: "preset-fade", start: 0, duration: 1 },
    { op: "add_layer", layerType: "rectangle", id: "chosen", name: "Ignored for the ID" },
  ], resolver, document);
  assert.equal(translated[0].properties.id, "hero-title-2", "hero-title already exists");
  assert.equal(translated[1].properties.id, "hero-title-3");
  assert.equal(translated[2].properties.id, "big-card", "runs of other characters become one dash, none at the ends");
  assert.equal(translated[3].layerId, "hero-title-3", "a later operation can use the new ID");
  assert.equal(translated[4].properties.id, "chosen", "a caller-chosen ID wins");

  // The translated batch is valid engine input.
  const after = parseDocument(applyOperations(document, translated));
  assert.deepEqual(after.scenes[0].layers.map((layer) => layer.id), ["hero-title", "hero-title-2", "hero-title-3", "big-card", "chosen"]);
  assert.equal(after.scenes[0].layers[2].animations.length, 1);
});

test("accented letters lose their accents in slug IDs", () => {
  const { document, resolver } = titleAndCard();
  const [layer] = translateOperations([{ op: "add_layer", layerType: "rectangle", name: "Ünïcode Card" }], resolver, document);
  assert.equal(layer.properties.id, "unicode-card");
});

test("stagger items may be layer names (all of that layer's animations) or animation names", () => {
  const document = sceneDocument([text("title"), rectangle("card"), fade("title", 0, 1), fade("card", 0, 1)]);
  const codes = assignCodes(emptyCodes(), document);
  const resolver = createResolver(document, codes);
  const cardAnimation = documentObjects(document).animations.find((entry) => entry.layer.id === "card").id;
  const [stagger] = translateOperations([{ op: "stagger_animations", items: ["title", "card.in"], delay: 0.1 }], resolver, document);
  assert.deepEqual(stagger.items, [{ layerId: "title" }, cardAnimation]);
  assert.equal(stagger.sceneId, "main");
  const after = parseDocument(applyOperations(document, [stagger]));
  const starts = after.scenes[0].layers.map((layer) => layer.animations[0].start);
  assert.deepEqual(starts, [0, 0.1]);
});

test("in a document with several scenes the scene comes from the layer named", () => {
  const base = sceneDocument([text("title")]);
  const document = parseDocument(applyOperations(base, [{ type: "add_scene", properties: { id: "outro", name: "Outro" } }, { type: "add_layer", sceneId: "outro", layerType: "rectangle", properties: { id: "logo" } }]));
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  const [first, second, third] = translateOperations([
    { op: "update_layer", layer: "logo", properties: { x: 1 } },
    { op: "update_layer", layer: "title", properties: { x: 1 } },
    { op: "update_scene", scene: "Outro", properties: { duration: 2 } },
  ], resolver, document);
  assert.equal(first.sceneId, "outro");
  assert.equal(second.sceneId, "main");
  assert.equal(third.sceneId, "outro");
});

test("waive_check takes a list or a glob of layer names and saves one waiver per layer matching now", () => {
  const document = sceneDocument([rectangle("arch-1"), rectangle("arch-2"), rectangle("Arch-3"), rectangle("card")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  const ops = translateOperations([
    { op: "waive_check", code: "overlap", target: "arch-*", reason: "a wall of arches" },
    { op: "waive_check", code: "type_min", target: ["card", "L1"], reason: "tiny on purpose" },
    { op: "unwaive_check", code: "overlap", target: "arch-?" },
  ], resolver, document);
  assert.deepEqual(ops.map((op) => op.target), [["arch-1", "arch-2", "Arch-3"], ["card", "arch-1"], ["arch-1", "arch-2", "Arch-3"]]);
  const waived = parseDocument(applyOperations(document, ops.slice(0, 2))).checkWaivers;
  assert.deepEqual(waived.map((waiver) => `${waiver.code} ${waiver.target}`), ["overlap arch-1", "overlap arch-2", "overlap Arch-3", "type_min card", "type_min arch-1"]);
  assert.deepEqual(parseDocument(applyOperations(document, ops)).checkWaivers.map((waiver) => waiver.target), ["card", "arch-1"]);
  assert.throws(() => translateOperations([{ op: "waive_check", code: "overlap", target: "wall-*", reason: "x" }], resolver, document), /No layer name matches "wall-\*"/);
  // A glob over hundreds of word layers passes the 200-waiver limit: the error says what to do instead.
  const many = { ...ops[1], target: Array.from({ length: 201 }, (_, index) => `word-${index}`) };
  assert.throws(() => applyOperations(document, [many]), /would make 201 waivers .*target:"\*"/);
});

test("translate errors name the operation's number and offer close names", () => {
  const { document, codes } = titleAndCard();
  assert.throws(() => translateOperations([{ op: "update_layer", layer: "title", properties: {} }, { op: "add_layr" }], createResolver(document, codes), document), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.index, 1);
    assert.equal(error.type, "add_layr");
    assert.equal(error.suggestions[0], "add_layer");
    return true;
  });
  assert.throws(() => translateOperations([{ op: "update_layer", layer: "nope-nope-nope", properties: {} }], createResolver(document, codes), document), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.index, 0);
    assert.ok(error.cause instanceof ReferenceError);
    assert.ok(error.suggestions.length > 0);
    return true;
  });
  assert.throws(() => translateOperations([{ op: "update_layer", type: "delete_layer" }], createResolver(document, codes), document), /Give op or type, not both/);
  assert.throws(() => translateOperations([], createResolver(document, codes), document), /1 to 200 operations/);
  const tooMany = Array.from({ length: 201 }, () => ({ op: "rename_project", name: "x" }));
  assert.throws(() => translateOperations(tooMany, createResolver(document, codes), document), /201 operations; send at most 200/);
});

// ---- outline -------------------------------------------------------------------------------

test("the outline header counts in singular and plural", () => {
  const { document, codes } = titleAndCard();
  const one = sceneDocument([text("title"), fade("title", 0, 1)]);
  assert.match(projectOutline({ document: one, revision: 3 }, { codes: assignCodes(emptyCodes(), one) }).text.split("\n")[0], /^Demo \(demo\) rev 3 · 1 scene · 1 layer · 1 anim$/);
  assert.match(projectOutline({ document, revision: 2 }, { codes }).text.split("\n")[0], / · 1 scene · 2 layers · 1 anim$/);
  const empty = sceneDocument();
  const lines = projectOutline({ document: empty, revision: 1 }, { codes: assignCodes(emptyCodes(), empty) }).text.split("\n");
  assert.match(lines[0], / · 0 layers · 0 anims$/);
  assert.equal(lines[1], "s1 main 'Main' 640×360 4s bg #ffffff · 0 layers · 0 anims");
});

test("the outline has one line per layer with code, type, position, size and animations", () => {
  const { document, codes } = titleAndCard();
  const lines = projectOutline({ document, revision: 2 }, { codes }).text.split("\n");
  assert.match(lines[2], /^ {2}L1 title text 'Hero title' "title" 10,10 \d+×\d+ \S+ Inter 400 48px \| A1 in fade 0\.5–1\.5$/);
  assert.match(lines[3], /^ {2}L2 card rectangle 'Rectangle' 100,100 200×100 /);
});

test("layers already read and unchanged are counted, not repeated; changes and removals are shown", () => {
  const { document, codes } = titleAndCard();
  const first = projectOutline({ document, revision: 2 }, { codes });
  assert.deepEqual(Object.keys(first.shown.main), ["title", "card"]);
  assert.equal(first.shown.main.title, layerHash(document.scenes[0].layers[0]));

  // Nothing changed: both layers are counted.
  const again = projectOutline({ document, revision: 2 }, { codes, seen: first.shown });
  assert.doesNotMatch(again.text, /L1 title|L2 card/);
  assert.match(again.text, /\[2 layers unchanged since you last read them; status \{full:true\} repeats them\]/);

  // The card moves, a badge is added and the title is deleted.
  const next = parseDocument(applyOperations(document, [
    { type: "update_layer", sceneId: "main", layerId: "card", properties: { x: 300 } },
    { sceneId: "main", ...rectangle("badge") },
    { type: "delete_layer", sceneId: "main", layerId: "title" },
  ]));
  const nextCodes = assignCodes(codes, next);
  assert.notEqual(layerHash(next.scenes[0].layers[0]), first.shown.main.card, "the hash follows the layer's content");
  const changed = projectOutline({ document: next, revision: 3 }, { codes: nextCodes, seen: again.shown });
  assert.match(changed.text, /L2 card rectangle 'Rectangle' 300,100/);
  assert.match(changed.text, /L3 badge rectangle/);
  assert.match(changed.text, /removed since you last read: title$/m);
  assert.doesNotMatch(changed.text, /unchanged/);
  assert.deepEqual(Object.keys(changed.shown.main).sort(), ["badge", "card"]);

  // full:true repeats every layer.
  const full = projectOutline({ document: next, revision: 3 }, { codes: nextCodes, seen: changed.shown, full: true });
  assert.match(full.text, /L2 card/);
  assert.match(full.text, /L3 badge/);
});

test("a removed layer with a random ID is named by the code the agent knew, not its UUID", () => {
  const document = sceneDocument([{ type: "add_layer", layerType: "rectangle", properties: { x: 0, y: 0 } }]);
  const randomId = document.scenes[0].layers[0].id;
  const codes = assignCodes(emptyCodes(), document);
  const first = projectOutline({ document, revision: 2 }, { codes });
  assert.match(first.text, /^ {2}L1 rectangle /m, "the agent reads the layer as L1");
  const next = parseDocument(applyOperations(document, [{ type: "delete_layer", sceneId: "main", layerId: randomId }]));
  const after = projectOutline({ document: next, revision: 3 }, { codes: assignCodes(codes, next), seen: first.shown });
  assert.match(after.text, /removed since you last read: L1$/m);
});

test("the outline shows 40 layer lines per page and says how to get the next page", () => {
  assert.equal(LAYERS_PER_PAGE, 40);
  const document = sceneDocument(Array.from({ length: 45 }, (_, index) => rectangle(`box-${index}`, { width: 10, height: 10 })));
  const codes = assignCodes(emptyCodes(), document);
  const layerLines = (text) => text.split("\n").filter((line) => /^ {2}L\d+ /.test(line));
  const first = projectOutline({ document, revision: 2 }, { codes });
  assert.equal(layerLines(first.text).length, 40);
  assert.match(first.text, /page 1\/2 · status \{page:2\} for more$/);
  const second = projectOutline({ document, revision: 2 }, { codes, page: 2 });
  assert.deepEqual(layerLines(second.text).map((line) => line.trim().split(" ")[1]), ["box-40", "box-41", "box-42", "box-43", "box-44"]);
  assert.match(second.text, /page 2\/2$/);
  // After reading page 1, the next status shows the 5 unread layers on one page.
  const after = projectOutline({ document, revision: 2 }, { codes, seen: first.shown });
  assert.equal(layerLines(after.text).length, 5);
  assert.match(after.text, /\[40 layers unchanged/);
});

// The outline remembered only the last page of a full:true listing: after status {full:true}
// and {full:true, page:2} of 50 layers, a plain status re-printed the 40 of page 1 as unread, and
// after deleting all of them it listed only page 2's names as removed.
test("each page of a full:true listing is remembered: a later status repeats none and lists every removed name", () => {
  const document = sceneDocument(Array.from({ length: 50 }, (_, index) => rectangle(`box-${index}`, { width: 10, height: 10 })));
  const codes = assignCodes(emptyCodes(), document);
  const layerLines = (text) => text.split("\n").filter((line) => /^ {2}L\d+ /.test(line));
  const first = projectOutline({ document, revision: 2 }, { codes, full: true });
  assert.match(first.text, /page 1\/2 · status \{full:true, page:2\} for more$/);
  const second = projectOutline({ document, revision: 2 }, { codes, full: true, page: 2, seen: first.shown });
  assert.equal(layerLines(second.text).length, 10);
  const plain = projectOutline({ document, revision: 2 }, { codes, seen: second.shown });
  assert.equal(layerLines(plain.text).length, 0, plain.text);
  assert.match(plain.text, /\[50 layers unchanged/);
  // A full read still shows every row, even ones read before.
  const again = projectOutline({ document, revision: 2 }, { codes, full: true, seen: second.shown });
  assert.equal(layerLines(again.text).length, 40);
  const ids = document.scenes[0].layers.map((layer) => layer.id);
  const empty = parseDocument(applyOperations(document, ids.map((layerId) => ({ type: "delete_layer", sceneId: "main", layerId }))));
  const after = projectOutline({ document: empty, revision: 3 }, { codes: assignCodes(codes, empty), seen: second.shown });
  const removed = after.text.match(/removed since you last read: (.*)$/m)?.[1].split(", ");
  assert.deepEqual(removed, ids, after.text);
});

test("other scenes are folded to one line; plan, inbox, pointing and checks get their own lines", () => {
  const base = sceneDocument([text("title")]);
  const document = parseDocument(applyOperations(base, [{ type: "add_scene", properties: { id: "outro", name: "Outro", width: 320, height: 180, duration: 2 } }, { type: "add_layer", sceneId: "outro", layerType: "rectangle", properties: { id: "logo" } }]));
  const codes = assignCodes(emptyCodes(), document);
  const { text: outline, shown } = projectOutline({ document, revision: 4 }, {
    codes, focus: "outro",
    plan: { steps: [{ text: "Build", done: true }, { text: "Animate", done: false }] },
    inbox: ['N1 note "Bigger logo"'], checks: "0 err · 0 warn", pointing: "L2 (you selected it in the editor)",
  });
  assert.deepEqual(outline.split("\n"), [
    "Demo (demo) rev 4 · 2 scenes · 2 layers · 0 anims",
    "plan ▸ Animate (1/2)",
    "s1 main 'Main' 640×360 4s bg #ffffff · 1 layer · 0 anims",
    "s2 outro 'Outro' 320×180 2s bg #ffffff · 1 layer · 0 anims",
    outline.split("\n")[4],
    "status {scene} lists another scene's layers",
    "inbox ◆1",
    '  N1 note "Bigger logo"',
    "pointing L2 (you selected it in the editor)",
    "checks 0 err · 0 warn",
  ]);
  assert.match(outline.split("\n")[4], /^ {2}L2 logo rectangle /);
  assert.deepEqual(Object.keys(shown), ["outro"], "only the focus scene's layers count as read");
});

// ---- inspect -------------------------------------------------------------------------------

function inspectDocument() {
  const base = sceneDocument([
    text("title", { name: "Main title", fontSize: 72 }), text("caption", { fontSize: 24 }),
    rectangle("card"), fade("title", 0, 1), { type: "add_animation", layerId: "card", preset: "preset-fade", mode: "out", start: 3, duration: 1 },
  ]);
  const document = parseDocument(applyOperations(base, [
    { type: "add_scene", properties: { id: "outro", name: "Outro" } },
    { type: "add_layer", sceneId: "outro", layerType: "rectangle", properties: { id: "logo", name: "Logo title" } },
  ]));
  const codes = assignCodes(emptyCodes(), document);
  return { document, codes, resolver: createResolver(document, codes) };
}

const heads = (result) => result.text.split("\n").filter((line) => !line.startsWith(" "));

test("inspect selectors pick layers by type, field comparisons, name contains and scene", () => {
  const { resolver, codes } = inspectDocument();
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["text"] })), ["L1 title text in main", "L2 caption text in main"]);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["text[fontSize>40]"] })), ["L1 title text in main"]);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["text[fontSize<=24]"] })), ["L2 caption text in main"]);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["*[name~=TITLE]"] })), ["L1 title text in main", "L4 logo rectangle in outro"]);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["s2 rectangle"] })), ["L4 logo rectangle in outro"]);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["rectangle"] })), ["L3 card rectangle in main", "L4 logo rectangle in outro"]);
  // A name pattern, a pattern for a layer's animations, and a bare [condition].
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["ca*"] })), ["L2 caption text in main", "L3 card rectangle in main"]);
  assert.match(inspectTargets(resolver, codes, { targets: ["card.*"] }).text, /^A2 .* on card$/m);
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["[name~=TITLE]"] })), ["L1 title text in main", "L4 logo rectangle in outro"]);
  const none = inspectTargets(resolver, codes, { targets: ["text[fontSize>100]"] });
  assert.deepEqual([none.text, none.count, none.matched], ["Nothing matched.", 0, 0]);
});

test("inspect animation selectors match animation fields", () => {
  const { resolver, codes } = inspectDocument();
  const entering = inspectTargets(resolver, codes, { targets: ["animation[kind=in]"] });
  assert.equal(entering.matched, 1);
  assert.match(entering.text, /^A1 'Fade In' in preset fade opacity 0→1 0s\+1s .* on title$/m);
  const leaving = inspectTargets(resolver, codes, { targets: ["animation[kind=out]"] });
  assert.match(leaving.text, /^A2 .* out .* 3s\+1s .* on card$/m);
});

test("inspect by name lists only non-default fields and every animation; fields limits the answer", () => {
  const { resolver, codes } = inspectDocument();
  const full = inspectTargets(resolver, codes, { targets: ["title"] });
  const [head, differences, animation] = full.text.split("\n");
  assert.equal(head, "L1 title text in main");
  assert.match(differences, /name "Main title"/);
  assert.match(differences, /fontSize 72/);
  assert.doesNotMatch(differences, /fontFamily/, "default fields are left out");
  assert.match(animation, /^ {2}A1 'Fade In' in /);

  // A field that is not set is null; a name that is no layer field says so (it was "fontsize null").
  const picked = inspectTargets(resolver, codes, { targets: ["L1"], fields: ["fontSize", "text", "role", "fontsize"] });
  assert.equal(picked.text, 'L1 title text in main\n  fontSize 72\n  text "title"\n  role null\nfontsize: not a layer field. Did you mean fontSize, fontStyle, fontSource?');
  // Names that are no field are one line for every target, not one each.
  const many = inspectTargets(resolver, codes, { targets: ["text", "rectangle"], fields: ["fontsize", "opacty"] });
  assert.equal(many.text.split("\n").filter((line) => /not layer fields/.test(line)).length, 1);
  assert.match(many.text, /\nnot layer fields: fontsize \(fontSize, [^)]*\?\), opacty \(opacity[^)]*\?\)$/);
  // Other editors' play names point at kino's: trimStart is mediaOffset, startTime mediaStart.
  const clip = sceneDocument([{ type: "add_layer", layerType: "video", properties: { id: "clip", mediaOffset: 2.5, mediaStart: 1 } }]);
  const clipCodes = assignCodes(emptyCodes(), clip);
  assert.equal(inspectTargets(createResolver(clip, clipCodes), clipCodes, { targets: ["clip"], fields: ["trimStart", "startTime"] }).text.split("\n").slice(1).join("\n"),
    "  trimStart: the field is mediaOffset. mediaOffset 2.5\n  startTime: the field is mediaStart. mediaStart 1");
  // A name edit reads as another field gives that field and its value: color and colour were
  // "not a layer field. Did you mean blur, role, donut?", although edit maps color to fill.
  const aliases = inspectTargets(resolver, codes, { targets: ["L1"], fields: ["color", "colour", "font"] });
  assert.equal(aliases.text, 'L1 title text in main\n  color: the field is fill. fill "#171717"\n  colour: the field is fill. fill "#171717"\n  font: the field is fontFamily. fontFamily "Inter"');

  // A scene's name or code lists the layers of that scene.
  assert.deepEqual(heads(inspectTargets(resolver, codes, { targets: ["s2"] })), ["L4 logo rectangle in outro"]);
  // Duplicates are shown once.
  assert.equal(inspectTargets(resolver, codes, { targets: ["title", "L1", "text[fontSize>40]"] }).count, 1);
});

test("inspect shows at most 10 targets and names the rest", () => {
  assert.equal(MAX_INSPECT, 10);
  const document = sceneDocument(Array.from({ length: 13 }, (_, index) => rectangle(`box-${index}`)));
  const codes = assignCodes(emptyCodes(), document);
  const result = inspectTargets(createResolver(document, codes), codes, { targets: ["rectangle"] });
  assert.equal(result.count, 10);
  assert.equal(result.matched, 13);
  assert.match(result.text, /\+3 more matched \(box-10, box-11, box-12\); narrow the selector or name them\.$/);
});

test("inspect names every other match, so one inspect \"*\" lists a whole scene", () => {
  const document = sceneDocument(Array.from({ length: 60 }, (_, index) => rectangle(`box-${index}`)));
  const codes = assignCodes(emptyCodes(), document);
  const result = inspectTargets(createResolver(document, codes), codes, { targets: ["*"] });
  assert.equal(result.matched, 60);
  const more = result.text.split("\n").at(-1);
  assert.match(more, /^\+50 more matched \(box-10, box-11, .*, box-59\); narrow the selector or name them\.$/);
  assert.doesNotMatch(more, /…/);
});

test("inspect refuses an unknown name with a ReferenceError", () => {
  const { resolver, codes } = inspectDocument();
  assert.throws(() => inspectTargets(resolver, codes, { targets: ["no-such-thing-at-all"] }), ReferenceError);
});

test("inspect suggests layer names (not only scenes) for an unknown target", () => {
  const { resolver, codes } = inspectDocument();
  assert.throws(() => inspectTargets(resolver, codes, { targets: ["captoin-text"] }), (error) => {
    assert.ok(error.suggestions.includes("caption"), `suggestions were ${JSON.stringify(error.suggestions)}`);
    return true;
  });
});

// A card with an animation group starting at 1 s: a move (scene time 1–2 s) and an opacity
// change (scene time 2–3 s), stored relative to the group.
function groupedDocument({ duration = 4 } = {}) {
  const base = sceneDocument([rectangle("card"), { type: "add_animation", layerId: "card", preset: "move", start: 1, duration: 1 }, { type: "add_animation", layerId: "card", preset: "opacity", start: 2, duration: 1 }], { duration });
  const ids = documentObjects(base).animations.map((entry) => entry.id);
  const document = parseDocument(applyOperations(base, [{ type: "group_animations", sceneId: "main", animationIds: ids }]));
  const codes = assignCodes(emptyCodes(), document);
  const group = documentObjects(document).animations.find((entry) => entry.animation.kind === "composed");
  return { document, codes, ids, group, resolver: createResolver(document, codes) };
}

test("inspect gives an animation inside an animation group its real start and its group's name", () => {
  const { codes, ids, group, resolver } = groupedDocument();
  const result = inspectTargets(resolver, codes, { targets: [codes.byId[ids[1]]] });
  assert.match(result.text, / 2s\+1s /, "the opacity change starts 2 s into the scene");
  assert.match(result.text, new RegExp(`in group ${codes.byId[group.id]}$`));
});

test("an animation group shows its time span instead of 'undefined'", () => {
  const { codes, resolver } = groupedDocument();
  const result = inspectTargets(resolver, codes, { targets: ["card"] });
  assert.match(result.text, /composed 2 inside/);
  assert.doesNotMatch(result.text, /undefined/);
});

test("an animation inside a group that runs past the scene end is reported", () => {
  const { document, codes, ids } = groupedDocument({ duration: 2.5 });
  const findings = checkDocument(document, { codes });
  assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.ref}`), [`past_scene_end ${codes.byId[ids[1]]}`]);
});

// ---- checks --------------------------------------------------------------------------------

test("an animation past the scene end is a warning when cut off and an error when it never plays", () => {
  const document = sceneDocument([text("late"), fade("late", 1.5, 1), text("never", { y: 100 }), fade("never", 3, 1)], { duration: 2 });
  const codes = assignCodes(emptyCodes(), document);
  const findings = checkDocument(document, { codes });
  const [never, late] = findings;
  assert.equal(findings.length, 2);
  assert.deepEqual([never.severity, never.rule, never.ref, never.at], ["error", "past_scene_end", "A2", 3]);
  assert.equal(never.message, "A2 runs 3–4s but main ends at 2s, so it never plays.");
  assert.deepEqual(never.fix, { op: "update_scene", sceneId: "main", properties: { duration: 4 } });
  assert.deepEqual([late.severity, late.ref, late.at], ["warn", "A1", 1.5]);
  assert.match(late.message, /so it is cut off\.$/);
  assert.deepEqual(late.fix, { op: "update_animation", animationId: "A1", properties: { duration: 0.5 } });
  assert.equal(checkSummary(findings), "1 err · 1 warn (past_scene_end A2, past_scene_end A1)");
  // check {fix:"auto"} lines: one per rule and reason, the layers named.
  const tries = (ref) => `exit_ratio ${ref}: still adds an error after 3 tries`;
  assert.deepEqual(groupFixLines([...["a", "b", "c", "d", "e"].map(tries), "type_min a: size 36", "exit_ratio z: it did not clear the finding", tries("a")]),
    ["exit_ratio a, b, c, d +1: still adds an error after 3 tries", "type_min a: size 36", "exit_ratio z: it did not clear the finding"]);
  // A count made without rendering frames says so: for every scene, or for the scenes named.
  assert.equal(checkSummary([], { unchecked: "all" }), "0 err · 0 warn · unchecked: contrast, flashing, luma_jump, frozen_picture");
  assert.equal(checkSummary([], { unchecked: ["s2"] }), "0 err · 0 warn · unchecked in s2: contrast, flashing, luma_jump, frozen_picture");
  assert.equal(checkSummary([], { unchecked: ["s2", "s3", "s4", "s5", "s6"] }), "0 err · 0 warn · unchecked in s2, s3, s4 +2: contrast, flashing, luma_jump, frozen_picture");
});

test("a layer that rests outside the scene and never moves in is reported with a centring fix", () => {
  const document = sceneDocument([
    rectangle("away", { x: 1000, y: 10, width: 50, height: 50 }),
    rectangle("flyin", { x: 1000, y: 10, width: 50, height: 50 }),
    { type: "add_animation", layerId: "flyin", preset: "move", start: 0, duration: 1 },
    rectangle("hidden", { x: -500, y: 10, width: 50, height: 50, visible: false }),
    rectangle("inside"),
  ]);
  const findings = checkDocument(document, { codes: assignCodes(emptyCodes(), document) });
  assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.ref}`), ["off_canvas away"]);
  assert.equal(findings[0].message, "away sits outside the 640×360 scene and never moves in, so it is never seen.");
  assert.deepEqual(findings[0].fix, { op: "update_layer", layerId: "away", properties: { x: 295, y: 155 } });
});

test("empty text and media missing from the workspace are reported", async (t) => {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "kino-agent-core-media-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const present = "0123abcd-0000-4000-8000-000000000001.png";
  const missing = "0123abcd-0000-4000-8000-000000000002.png";
  await writeFile(path.join(mediaRoot, `${present}.json`), "{}");
  const document = createDocument({ id: "media", name: "Media", scenes: [createScene({ id: "main", width: 640, height: 360, layers: [
    createLayer("text", { id: "blank", text: "   ", x: 10, y: 10 }),
    createLayer("image", { id: "there", src: `/api/media/${present}`, x: 0, y: 0, width: 100, height: 100 }),
    createLayer("image", { id: "gone", src: `/api/media/${missing}`, x: 0, y: 0, width: 100, height: 100 }),
    // A bare file name is not imported media: the renderer draws nothing for it.
    createLayer("image", { id: "named", src: "logo.png", x: 0, y: 0, width: 100, height: 100 }),
    createLayer("image", { id: "embedded", src: "data:image/png;base64,iVBORw0KGgo=", x: 0, y: 0, width: 100, height: 100 }),
    // A video with no file at all cannot be drawn; hidden, it is never drawn; audio only plays nothing.
    createLayer("video", { id: "empty", src: "", x: 0, y: 0, width: 100, height: 100 }),
    createLayer("image", { id: "hidden-empty", src: "", visible: false, x: 0, y: 0, width: 100, height: 100 }),
    createLayer("audio", { id: "quiet", src: "" }),
  ] })] });
  const findings = checkDocument(document, { codes: assignCodes(emptyCodes(), document), mediaRoot });
  assert.deepEqual(findings.map((finding) => `${finding.severity} ${finding.rule} ${finding.ref}`), ["error missing_media gone", "error missing_media named", "error missing_media empty", "warn empty_text blank"]);
  assert.match(findings[2].message, /empty is a video layer with no src/);
  assert.deepEqual(findings[3].fix, { op: "delete_layer", layerId: "blank" });
  // A rendered check that stopped on that media says nothing more, so only the cause is listed.
  const stopped = { severity: "error", rule: "contrast", internal: true, message: "The contrast check could not run: image layer “named” must use /api/media/... or an embedded raster image." };
  assert.deepEqual(mergeFindings(findings, [stopped], { document }).map((finding) => finding.rule), ["missing_media", "missing_media", "missing_media", "empty_text"]);
  const noFile = { ...stopped, message: "The contrast check could not run: Video layer “empty” has no src (no media file)." };
  assert.deepEqual(mergeFindings(findings, [noFile], { document }).map((finding) => finding.rule), ["missing_media", "missing_media", "missing_media", "empty_text"]);
  assert.deepEqual(mergeFindings([], [stopped], { document }).map((finding) => finding.rule), ["contrast"], "kept when no media is missing");
});

test("checks can be limited to one scene, and the report keeps the first 10 findings", () => {
  const blanks = Array.from({ length: 12 }, (_, index) => text(`blank-${index}`, { text: "" }));
  const base = sceneDocument(blanks);
  const document = parseDocument(applyOperations(base, [{ type: "add_scene", properties: { id: "outro" } }, { type: "add_layer", sceneId: "outro", layerType: "text", properties: { id: "empty-outro", text: "" } }]));
  const codes = assignCodes(emptyCodes(), document);
  assert.equal(checkDocument(document, { codes }).length, 13);
  assert.deepEqual(checkDocument(document, { codes, sceneId: "outro" }).map((finding) => finding.ref), ["empty-outro"]);
  const report = checkReport(checkDocument(document, { codes }));
  assert.equal(MAX_FINDINGS, 10);
  assert.deepEqual([report.errors, report.warnings, report.findings.length, report.more], [0, 13, 10, 3]);
  assert.match(report.rules, /past_scene_end/);
  assert.equal(checkReport([]).more, undefined);
  // Triage: gates first, then brief warnings, at most 2 of a rule while others wait; the rest counted by rule.
  const many = [...Array.from({ length: 30 }, () => ({ severity: "warn", rule: "held_static" })), { severity: "warn", rule: "style_avoided" }, { severity: "error", rule: "contrast" }];
  const triaged = checkReport(many, { limit: 4 });
  assert.deepEqual(triaged.findings.map((finding) => finding.rule), ["contrast", "style_avoided", "held_static", "held_static"]);
  assert.equal(triaged.moreByRule, "held_static 28");
  // Every gate is listed before any warning, even past 2 of one rule.
  assert.deepEqual(checkReport([...many, ...Array.from({ length: 3 }, () => ({ severity: "error", rule: "type_min" }))], { limit: 4 }).findings.map((finding) => finding.rule), ["contrast", "type_min", "type_min", "type_min"]);
  assert.equal(checkSummary([]), "0 err · 0 warn");
});

test("an edit names an animation it adds earlier in the same edit by layer.kind, and removing a missing waiver changes nothing", () => {
  const document = sceneDocument();
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  const [, added, update, unwaive] = translateOperations([
    { op: "add_layer", layerType: "text", name: "words", properties: { text: "Hi" }, animations: [{ preset: "fade", start: 0, duration: 0.5 }] },
    { op: "update_animation", animation: "words.in", properties: { duration: 1 } },
    { op: "unwaive_check", code: "reading_time", target: "words" },
  ], resolver, document);
  assert.equal(update.animationId, added.id);
  assert.equal(unwaive.type, "unwaive_check");
  assert.ok(resolver.fixes.includes("unwaive_check: no reading_time waiver on words, nothing to remove"));
  assert.doesNotThrow(() => applyOperations(document, [{ type: "unwaive_check", code: "reading_time", target: "*" }]));
});

test("advice is one line and not a warning; open findings list by rule; a rule waived 6 times is named as kino's likely mistake", () => {
  const findings = [
    { severity: "error", rule: "overlap", ref: "title" },
    { severity: "warn", rule: "hold", ref: "say4" },
    { severity: "warn", rule: "hold", ref: "say5" },
    { severity: "warn", rule: "judder", ref: "pan", waived: "a whip on purpose" },
    { severity: "info", rule: "busy_edit", ref: "s1" },
    { severity: "info", rule: "busy_edit", ref: "s1" },
    { severity: "info", rule: "pacing_jump", ref: "s1" },
  ];
  const report = checkReport(findings);
  assert.deepEqual([report.errors, report.warnings, report.info, report.waived], [1, 2, 3, 1]);
  assert.ok(report.findings.every((finding) => finding.severity !== "info"));
  assert.equal(report.advice, "busy_edit x2, pacing_jump");
  assert.equal(adviceLine(findings.slice(0, 4)), "");
  // A check that names its rules lists the advice too.
  assert.equal(checkReport(findings, { info: true }).findings.filter((finding) => finding.severity === "info").length, 3);
  assert.deepEqual(openFindingLines(findings), ["overlap (title)", "hold x2 (say4)"]);
  const waivers = (count, code) => Array.from({ length: count }, (_, index) => ({ code, target: `L${index}`, reason: "on purpose" }));
  assert.deepEqual(waiverNotes(waivers(5, "hold")), []);
  const [note, ...rest] = waiverNotes([...waivers(6, "hold"), ...waivers(2, "judder")]);
  assert.match(note, /^hold is waived 6 times here: likely a kino false positive/);
  assert.equal(rest.length, 0);
});
