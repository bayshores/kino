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
import { plainWordsProblem, storedQuoteProblem } from "./agent/brief.mjs";
import { createBlockRunner, translateBlock } from "./agent/blocks.mjs";
import { layerHash, LAYERS_PER_PAGE, projectOutline } from "./agent/outline.mjs";
import { inspectTargets, MAX_INSPECT } from "./agent/inspect.mjs";
import { adviceLine, checkDocument, checkReport, checkSummary, groupFixLines, liveWaivers, MAX_FINDINGS, mergeFindings, openFindingLines, staleWaiverLine, waivedRefs, waiverNotes } from "./agent/checks.mjs";
import { staleWaivers, waiversFor } from "./agent/quality.mjs";
import { matchReferences } from "./agent/exposure-match.mjs";
import { liftDark } from "./agent/lift-dark.mjs";
import { applyTables } from "../engine/quality/liftDark.js";
import { curvesTables } from "../engine/effects/colorMath.js";
import { defaultFonts } from "../engine/fonts.js";

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

test("an effect choice that reads like a color word stays as written; a fill of the same word is still a color", () => {
  const { document, resolver } = titleAndCard();
  const [lines, card] = translateOperations([
    { op: "add_animation", layer: "card", effect: "edge-lines", parameters: { background: "transparent", color: "green" } },
    { op: "update_layer", layer: "card", properties: { fill: "transparent" } },
  ], resolver, document);
  assert.equal(lines.animation?.to?.background ?? lines.parameters?.background, "transparent");
  assert.equal(card.properties.fill, "#00000000");
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
  // An effect_fit waiver names the cue that motivates the effect, and the cue exists.
  assert.throws(() => translateOperations([{ op: "waive_check", code: "effect_fit", target: "card", reason: "I like it" }], resolver, document), /names the cue that motivates the effect/);
  const cued = { ...document, cues: [{ name: "punch-1", kind: "marker", time: 1 }] };
  assert.equal(translateOperations([{ op: "waive_check", code: "effect_fit", target: "card", reason: "the punch at cue:punch-1" }], resolver, cued).length, 1);
  // A type_seen waiver names the reference (or picked treatment) that chose the type.
  assert.throws(() => translateOperations([{ op: "waive_check", code: "type_seen", target: "card", reason: "I like it" }], resolver, document), /names the reference that chose this type/);
  // The id must be one of this project's references (a style line's ref or a saved one).
  const waiver = { op: "waive_check", code: "type_seen", target: "card", reason: "set like the title in yt:dQw4w9WgXcQ" };
  assert.throws(() => translateOperations([waiver], resolver, document), /yt:dQw4w9WgXcQ, which is not a reference of this project/);
  // A link among the refs is matched by its id, never by a word of it.
  resolver.references = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
  assert.throws(() => translateOperations([{ ...waiver, reason: "set like yt:youtube" }], resolver, document), /not a reference of this project/);
  resolver.references = ["yt:other-ref1", "yt:dQw4w9WgXcQ"];
  assert.equal(translateOperations([waiver], resolver, document).length, 1);
  assert.throws(() => translateOperations([{ ...waiver, reason: "treatment B type direction" }], resolver, document), /names the reference that chose this type/);
  // A glob over hundreds of word layers passes the 200-waiver limit: the error says what to do instead.
  const many = { ...ops[1], target: Array.from({ length: 201 }, (_, index) => `word-${index}`) };
  assert.throws(() => applyOperations(document, [many]), /would make 201 waivers .*Name fewer layers/);
});

test("waivers: crop and shape need the person's words on layers; face-cut codes refuse * and scenes; ask_unmet names the word; unknown codes get a did-you-mean", () => {
  // sky-1 is the layer "shot-*" leaves out: a glob that reaches all three would be "*" in disguise.
  const document = sceneDocument([rectangle("shot-1"), rectangle("shot-2"), rectangle("sky-1")]);
  const resolver = createResolver(document, assignCodes(emptyCodes(), document));
  const send = (op) => translateOperations([{ op: "waive_check", reason: "meant", ...op }], resolver, document);
  const said = "keep the tight crop on the eyes";
  // shape_guess: never a waiver, whatever the quote or target; the call that keeps a shape is named.
  for (const target of ["shot-1", "s1", "*"]) assert.throws(() => send({ code: "shape_guess", target, quote: said }), /kept only by the person naming a shape: notes .*plays_on/);
  // soft_upscale names its layers, never "*"; reference_range names the rows it keeps.
  assert.throws(() => send({ code: "soft_upscale", target: "*" }), /soft_upscale names the layers .*not target:"\*"/);
  assert.throws(() => send({ code: "reference_range", target: "main", reason: "on purpose" }), /keeps only the rows its reason names/);
  assert.equal(send({ code: "reference_range", target: "main", reason: "kept dark on purpose" }).length, 1);
  // default_font names a reference moment the agent labeled type (within 0.5 s).
  resolver.seenRefs = [{ id: "yt:AAAAAAAAAAA", seen: [{ at: 4.4, kinds: ["type"] }, { at: 12.75, kinds: ["overlay"] }, { at: 22.3, kinds: ["type", "made"] }] }];
  assert.throws(() => send({ code: "default_font", target: "shot-1", reason: "as in yt:AAAAAAAAAAA @12.75" }), (thrown) => thrown.message === 'default_font names a moment you labeled type ("as in yt:AAAAAAAAAAA @4.4"); yt:AAAAAAAAAAA @12.75 is not one (labeled: 4.4, 22.3).');
  assert.throws(() => send({ code: "default_font", target: "shot-1", reason: "I like it" }), /names a moment you labeled type/);
  assert.equal(send({ code: "default_font", target: "shot-1", reason: "as in yt:AAAAAAAAAAA @22.5" }).length, 1);
  resolver.seenRefs = [{ id: "yt:AAAAAAAAAAA", seen: [{ at: 4.4, kinds: ["overlay"] }] }];
  assert.throws(() => send({ code: "default_font", target: "shot-1", reason: "as in yt:AAAAAAAAAAA @4.4" }), /none of your saved references has one\. Label what you see first: library/);
  delete resolver.seenRefs;
  // A name that is a layer and a scene: a scene-wide finding takes the scene; any other code must say which.
  const twin = sceneDocument([rectangle("s1"), rectangle("shot-2"), rectangle("mains")]);
  const twinResolver = createResolver(twin, assignCodes(emptyCodes(), twin));
  const twinSend = (op) => translateOperations([{ op: "waive_check", reason: "meant", ...op }], twinResolver, twin);
  assert.equal(twinSend({ code: "held_static", target: "s1", quote: "keep the long still hold" })[0].target, "main");
  assert.throws(() => twinSend({ code: "overlap", target: "s1" }), /"s1" names both a layer and a scene/);
  // A layer name one letter off the scene's ("mains", scene "main") is no twin: the layer, no fix listed.
  assert.equal(twinSend({ code: "overlap", target: "mains" })[0].target, "mains");
  assert.deepEqual(twinResolver.fixes, []);
  // crop_no_subject: the person's quote, on layers only.
  for (const code of ["crop_no_subject"]) {
    assert.throws(() => send({ code, target: "shot-1" }), /Only the person can keep it/);
    assert.throws(() => send({ code, target: "shot-1", quote: "your call" }), /Only the person can keep it/);
    assert.throws(() => send({ code, target: "*", quote: said }), /not target:"\*"/);
    assert.throws(() => send({ code, target: "main", quote: said }), /names layers, not the scene "main"/);
    assert.throws(() => send({ code, target: "s1", quote: said }), /names layers, not the scene "s1"/);
    assert.throws(() => send({ code, target: ["shot-1", "main"], quote: said }), /not the scene "main"/);
    for (const glob of ["**", "?*", "*?", "*-*", "s*"]) assert.throws(() => send({ code, target: glob, quote: said }), /reaches every layer/, `glob ${glob}`);
    const [kept] = send({ code, target: "shot-*", quote: said });
    assert.deepEqual(kept.target, ["shot-1", "shot-2"]);
    assert.match(kept.reason, /the person: "keep the tight crop on the eyes"/);
  }
  // frozen_picture: the agent keeps a drawn hold (named in its reason) on named layers; other reasons need the person.
  // Its refusal names the drawn-hold way; "the animation holds" counts as naming one.
  assert.throws(() => send({ code: "frozen_picture", target: "shot-1", reason: "looks fine" }), /Only the person can keep it.*say "drawn hold" in reason/);
  assert.equal(send({ code: "frozen_picture", target: "shot-1", reason: "the source animation holds this frame" })[0].target, "shot-1");
  assert.throws(() => send({ code: "frozen_picture", target: "*", reason: "drawn hold of 1.2 s" }), /not target:"\*"/);
  assert.equal(send({ code: "frozen_picture", target: "shot-1", reason: "anime held cel, a drawn hold of 1.2 s" })[0].target, "shot-1");
  // frozen_footage takes the same drawn-hold reason (it then keeps only a stop on the file's own pose).
  assert.equal(send({ code: "frozen_footage", target: "shot-1", reason: "drawn hold of the file's own pose" })[0].target, "shot-1");
  assert.throws(() => send({ code: "frozen_footage", target: "shot-1", reason: "looks fine" }), /Only the person can keep it.*say "drawn hold" in reason/);
  // mediaStart and mediaDuration on a shape mean when it shows: a Show and a Hide, said in the fixes.
  const bandResolver = createResolver(document, assignCodes(emptyCodes(), document));
  const [band, ...timed] = translateOperations([{ op: "add_layer", layerType: "rectangle", properties: { name: "band", mediaStart: 2, mediaDuration: 1.5 } }], bandResolver, document);
  assert.equal(band.properties.mediaStart, undefined);
  // They run as add_animation ops on the new layer (the engine's add_layer takes no animations).
  assert.deepEqual(timed.map((op) => [op.type, op.layerId, op.preset, op.start]), [["add_animation", "band", "show", 2], ["add_animation", "band", "hide", 3.5]]);
  assert.match(bandResolver.fixes.at(-1), /mediaStart\/mediaDuration → show at 2 s, hide at 3.5 s/);
  // On update_layer the Show to move is not certain: saved as sent, the notes give the calls.
  translateOperations([{ op: "update_layer", layer: "shot-1", properties: { mediaStart: 2, mediaDuration: 1 } }], bandResolver, document);
  assert.match(bandResolver.notes.at(-1), /do nothing on a rectangle.*\{op:"add_animation", layer:"shot-1", preset:"show", start:2\}, \{op:"add_animation", layer:"shot-1", preset:"hide", start:3\}/);
  // head_cut_off and narrow_window: the agent may waive them, on one layer at a time.
  for (const code of ["head_cut_off", "narrow_window"]) {
    assert.throws(() => send({ code, target: "*" }), /not target:"\*"/);
    assert.throws(() => send({ code, target: ["shot-1", "*"] }), /not target:"\*"/);
    assert.throws(() => send({ code, target: "main" }), /names layers, not the scene "main"/);
    assert.throws(() => send({ code, target: "**" }), /reaches every layer/);
    assert.deepEqual(send({ code, target: "shot-1" })[0].target, "shot-1");
    assert.equal(translateOperations([{ op: "unwaive_check", code, target: "main" }], resolver, document).length, 1, "removing is never refused");
    // With the source looks known, a layer nobody looked at is refused look_first; one that was looked at is kept.
    resolver.sourceLooks = {};
    assert.throws(() => send({ code, target: "shot-1" }), (thrown) => thrown.code === "look_first" && thrown.message.includes(`${code} on Rectangle: look at its source first (look {mode:"source", layer:"Rectangle"}): a waiver keeps a shot you looked at; marking what you see (mark_subject) clears it without one.`));
    resolver.sourceLooks = { "shot-1": { src: "a.mp4", at: [1] } };
    assert.equal(send({ code, target: "shot-1" })[0].target, "shot-1");
    delete resolver.sourceLooks;
  }
  // A finding of a whole scene (a still hold, the ending) is kept by naming the scene with the person's words;
  // text_slides, ending_seen and music_stall never name a layer, so a layer waiver is refused, not saved to cover nothing.
  assert.equal(send({ code: "held_static", target: "main", quote: "keep the long still hold" })[0].target, "main");
  assert.equal(send({ code: "held_static", target: "shot-1", quote: "keep the long still hold" })[0].target, "shot-1");
  for (const code of ["text_slides", "ending_seen", "music_stall"]) {
    assert.equal(send({ code, target: "s1", quote: "keep the long still hold" })[0].target, "main");
    assert.throws(() => send({ code, target: "shot-1", quote: "keep the long still hold" }), /covers a whole scene and names no layer/);
    assert.throws(() => send({ code, target: "shot-*", quote: "keep the long still hold" }), /names no layer/);
    assert.throws(() => send({ code, target: "*", quote: "keep the long still hold" }), /not target:"\*"/);
  }
  // ask_unmet: the reason names an origin word (kino's search result), whole word.
  assert.throws(() => send({ code: "ask_unmet", target: "main", reason: "the tower is off screen" }), /no origin word/);
  resolver.origin = { words: [{ word: "tower", count: 11, of: 15 }] };
  assert.throws(() => send({ code: "ask_unmet", target: "main", reason: "not needed" }), /names the origin word in its reason \("tower"\)/);
  assert.throws(() => send({ code: "ask_unmet", target: "main", reason: "towers are off screen" }), /names the origin word/);
  assert.equal(send({ code: "ask_unmet", target: "main", reason: "no Tower here: the keeper's story is on the stairs" })[0].target, "main");
  // reference_kinds: plain on purpose is kept only with words the person typed (stored ask, stop answer or typed note), on a scene.
  const brief = { fields: { ask: [{ text: "make me a fan edit, keep it plain and simple, no effects", at: 1 }] }, log: [{ q: "style?", a: "only hard cuts ok" }] };
  resolver.storedQuoteProblem = (quote) => storedQuoteProblem(brief, quote, ["just cuts please"]);
  resolver.plainQuoteProblem = (quote) => plainWordsProblem(brief, quote);
  // Their words, but not about plain: refused with their sentence that is.
  assert.throws(() => send({ code: "reference_kinds", target: "s1", quote: "make me a fan edit" }), /does not say what is plain.*Closest of their sentences that does: "make me a fan edit, keep it plain and simple, no effects"/);
  assert.throws(() => send({ code: "reference_kinds", target: "s1" }), /check \{rules:\["reference_kinds"\]\} names each kind.*Plain on purpose is the person's call/);
  assert.throws(() => send({ code: "reference_kinds", target: "s1", quote: "your call" }), /Plain on purpose is the person's call/);
  assert.throws(() => send({ code: "reference_kinds", target: "s1", quote: "make it very busy and loud" }), /not in the person's stored words: closest: "make me a fan edit/);
  assert.throws(() => send({ code: "reference_kinds", target: "shot-1", quote: "keep it plain and simple" }), /covers a whole scene and names no layer/);
  const [plain] = send({ code: "reference_kinds", target: "s1", quote: "keep it plain and simple", reason: "they want cuts only" });
  assert.equal(plain.reason, 'they want cuts only (the person: "keep it plain and simple")');
  assert.equal(send({ code: "reference_kinds", target: "s1", reason: 'they said "just cuts please"' })[0].reason, 'they said "just cuts please" (the person: "just cuts please")');
  // A no-voice answer to the storyboard's Lines line keeps the song alone.
  assert.equal(plainWordsProblem(brief, "keep it music only"), null);
  // A log reply is the agent's note of what they said, so it is not their words.
  assert.throws(() => send({ code: "reference_kinds", target: "s1", quote: "only hard cuts ok" }), /not in the person's stored words/);
  resolver.storedQuoteProblem = (quote) => storedQuoteProblem({}, quote);
  assert.throws(() => send({ code: "reference_kinds", target: "s1", quote: "keep it plain and simple" }), /no message of theirs is stored/);
  delete resolver.storedQuoteProblem;
  delete resolver.plainQuoteProblem;
  // A code nobody checks is refused with the closest names; gates and new rules are known.
  assert.throws(() => send({ code: "crop_no_subjct", target: "shot-1" }), (thrown) => {
    assert.ok(thrown instanceof OperationError);
    assert.equal(thrown.suggestions[0], "crop_no_subject");
    return /is not a check rule or a gate/.test(thrown.message);
  });
  for (const code of ["review", "reference", "viewer", "needs", "treatments", "critique", "footage", "spoiler", "no_music", "av_offset", "narrow_window"])
    assert.equal(send({ code, target: code === "narrow_window" ? "shot-1" : "*" }).length, 1, code);
  // A waiver of a per-layer rule on "*" or on every layer is allowed; the receipt notes say how many layers it covers
  // (per-layer findings of checks.mjs count too; a whole-video gate does not).
  resolver.fixes.length = 0;
  resolver.notes.length = 0;
  send({ code: "overlap", target: "*" });
  send({ code: "overlap", target: "shot-1" });
  send({ code: "review", target: "*" });
  send({ code: "off_canvas", target: "*" });
  assert.deepEqual(resolver.notes, ["waive_check overlap covers 3 layers", "waive_check off_canvas covers 3 layers"]);
  assert.deepEqual(resolver.fixes, []);
});

test("mark_subject keeps part on the box (1-30 characters) and refuses a bad one in words", async () => {
  const document = sceneDocument([{ type: "add_layer", layerType: "video", properties: { id: "clip", name: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width: 640, height: 360 } }]);
  const runner = createBlockRunner({ fontsFor: async () => [], listMedia: async () => [], fontCatalog: [], operationContext: {} });
  const mark = (extra) => runner.apply(document, translateBlock({ op: "mark_subject", layer: "clip", t: 1, box: [40, 40, 20, 8], ...extra }, createResolver(document), document), {});
  assert.deepEqual((await mark({ part: "eyes" })).scenes[0].layers[0].subjectBoxes.boxes, [{ at: 1, box: [40, 40, 20, 8], by: "agent", part: "eyes" }]);
  assert.equal("part" in (await mark({})).scenes[0].layers[0].subjectBoxes.boxes[0], false, "a whole-subject mark has no part");
  for (const part of ["", "x".repeat(31), 5])
    await assert.rejects(mark({ part }), /part is 1-30 characters naming the part you mean \(eyes\), or leave it out for the whole subject\./);
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

test("other scenes are folded to one line; pointing, checks and inbox come before the plan and the layer rows", () => {
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
    "pointing L2 (you selected it in the editor)",
    "checks 0 err · 0 warn",
    "inbox ◆1",
    '  N1 note "Bigger logo"',
    "plan ▸ Animate (1/2)",
    "s1 main 'Main' 640×360 4s bg #ffffff · 1 layer · 0 anims",
    "s2 outro 'Outro' 320×180 2s bg #ffffff · 1 layer · 0 anims",
    outline.split("\n")[8],
    "status {scene} lists another scene's layers",
  ]);
  assert.match(outline.split("\n")[8], /^ {2}L2 logo rectangle /);
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
  // The waived findings follow the waived count (each name once, the same list check prints); the
  // open ones follow the open counts, so neither list reads as the other's.
  const waivedTwice = findings.map((finding) => ({ ...finding, waived: "on purpose" }));
  assert.equal(checkSummary([...waivedTwice, { ...never, rule: "type_min", ref: "L1" }, { ...never, rule: "safe_zone", ref: "L1", waived: "ok" }, { ...never, rule: "safe_zone", ref: "L1", waived: "ok" }]),
    "1 err · 0 warn (type_min L1) · 4 waived (past_scene_end A1, past_scene_end A2, …)");
  // By rule then ref (A2 before A10), not finding order, so the same waivers read the same on every revision.
  const tenth = { ...waivedTwice[0], ref: "A10" };
  assert.deepEqual(waivedRefs([tenth, ...waivedTwice, ...[...waivedTwice].reverse()]), ["past_scene_end A1", "past_scene_end A2", "past_scene_end A10"]);
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
  // A missing reference kind is advice that names its place in the line the agent reads.
  assert.equal(adviceLine([{ severity: "info", rule: "reference_kinds", measured: "made at 0 of 30 moments", at: 11.3 }, { severity: "info", rule: "reference_kinds", measured: "spoken at 0 of 30 moments" }]),
    "reference_kinds x2 (made at 0 of 30, free moment 11.3 s; spoken at 0 of 30)");
  // A check that names its rules lists the advice too.
  assert.equal(checkReport(findings, { info: true }).findings.filter((finding) => finding.severity === "info").length, 3);
  assert.deepEqual(openFindingLines(findings), ["overlap (title)", "hold x2 (say4)"]);
  const waivers = (count, code) => Array.from({ length: count }, (_, index) => ({ code, target: `L${index}`, reason: "on purpose" }));
  assert.deepEqual(waiverNotes(waivers(5, "hold")), []);
  const [note, ...rest] = waiverNotes([...waivers(6, "hold"), ...waivers(2, "judder")]);
  assert.match(note, /^hold is waived 6 times here: likely a kino false positive/);
  assert.equal(rest.length, 0);
  // A crop waiver says what a mark does instead, not "kino false positive".
  assert.deepEqual(waiverNotes(waivers(6, "narrow_window")), ['narrow_window is waived 6 times here: each keeps a crop kino cannot see into; a mark after look {mode:"source"} clears it, and every stop shows the count.']);
  // `codes` limits the notes to the rules an edit just waived.
  assert.deepEqual(waiverNotes(waivers(6, "hold"), { codes: ["judder"] }), []);
  assert.equal(waiverNotes(waivers(6, "hold"), { codes: ["hold"] }).length, 1);
  // A waiver of a rule that ran and silenced nothing is stale: it no longer counts, and one line names it.
  // A gate (review) is never judged, nor a rule that renders frames (contrast) when none were rendered.
  const holds = waivers(6, "hold");
  const stale = staleWaivers([...holds, { code: "review", target: "*" }, { code: "contrast", target: "L1" }], new Set(holds.slice(1)), { pixelsRan: false });
  assert.deepEqual(stale, [holds[0]]);
  assert.deepEqual(waiverNotes(liveWaivers(holds, stale)), []);
  assert.equal(staleWaiverLine(stale), 'stale waivers (nothing left to waive): hold L0. Drop each: edit unwaive_check {code:"hold", target:"L0"}.');
  assert.equal(staleWaiverLine([]), "");
  // A finding naming three layers (soft_upscale on one file) is waived only when all three are; each matching waiver is in use.
  const model = { sceneId: "s1", itemOf: (id) => ({ id }) };
  const soft = (target) => ({ code: "soft_upscale", target, reason: "a small test clip" });
  const grouped = { rule: "soft_upscale", itemId: "a", itemIds: ["a", "b", "c"] };
  const one = waiversFor(grouped, model, [soft("a")]);
  assert.deepEqual([one.waiver, one.used.length], [undefined, 1]);
  assert.equal(waiversFor(grouped, model, [soft("a"), soft("b"), soft("c")]).waiver?.target, "a");
  assert.equal(waiversFor(grouped, model, [soft("s1")]).waiver?.target, "s1");
  // frozen_footage: a drawn-hold waiver keeps a stop on the file's own still pose (native) under 2 s, never a stop the edit made.
  const drawn = { code: "frozen_footage", target: "a", reason: "drawn hold: the file holds this pose" };
  assert.equal(waiversFor({ rule: "frozen_footage", itemId: "a", at: 0, until: 1.9, native: { start: 1, end: 1.4 } }, model, [drawn]).waiver, drawn);
  assert.equal(waiversFor({ rule: "frozen_footage", itemId: "a", at: 0, until: 1.9 }, model, [drawn]).waiver, undefined);
  assert.equal(waiversFor({ rule: "frozen_footage", itemId: "a", at: 0, until: 2.4, native: { start: 1, end: 1.4 } }, model, [drawn]).waiver, undefined);
});

test("match_references grades only the shot outside the references' range, replaces its own grade on a second run and takes it off with remove", async () => {
  const shot = (id, start) => createLayer("video", { id, name: id, src: `/api/media/${id}.mp4`, x: 0, y: 0, width: 1920, height: 1080, start, duration: 5, mediaStart: start, mediaDuration: 5, mediaSourceDuration: 20 });
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "main", width: 1920, height: 1080, duration: 10, layers: [shot("dark", 0), shot("lit", 5)] })] }));
  // The dark shot renders at 60 of 255, the lit one at 110; the references span 84 to 131. Graded,
  // the dark shot renders 75 at the stops the model asks for (something drawn above it) and 92 from 2 stops.
  const gradeOf = (scene) => scene.layers.find((layer) => layer.id === "dark")?.animations.find((animation) => animation.id === "dark.match-ref");
  const render = async (scene, times, { width }) => times.map((time) => {
    const height = Math.round((width * 9) / 16);
    const stops = gradeOf(scene)?.parameters?.stops;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(time >= 5 ? 110 : stops === undefined ? 60 : stops >= 2 ? 92 : 75);
    return { width, height, pixels };
  });
  const refs = [84, 131, 100].map((level) => ({ fingerprint: { look: { brightness: level / 255 } } }));
  const sent = [];
  const runOps = async (doc, ops) => {
    sent.push(...ops);
    const next = structuredClone(doc);
    for (const op of ops) for (const layer of next.scenes[0].layers) {
      if (op.op === "delete_animation") layer.animations = layer.animations.filter((animation) => animation.id !== op.animationId);
      if (op.op === "add_animation" && layer.id === op.layerId) layer.animations.push({ id: op.id, effect: { key: op.effect }, parameters: op.parameters });
    }
    return next;
  };
  const first = await matchReferences(document, { refs, fonts: defaultFonts, render, runOps });
  // Drawn short of its aim (75, not 92), the grade is worked out again from the render: a second, stronger one.
  assert.deepEqual(sent.map((op) => [op.op, op.layerId, op.id, op.effect]), [["add_animation", "dark", "dark.match-ref", "color-grade"], ["add_animation", "dark", "dark.match-ref", "color-grade"]]);
  assert.ok(sent[0].parameters.stops > 0 && sent[0].parameters.shoulder === 1 && sent[1].parameters.stops > sent[0].parameters.stops);
  assert.match(first.lines[0], /your 3 references 84 to 131 \(median 100\): dark 60 to 92 \(\+[\d.]+ stops\); 1 shot already inside, left alone/);
  // Sent again (the grade is in the document now): the old grade goes first, then the new one.
  const graded = structuredClone(document);
  graded.scenes[0].layers[0].animations.push({ id: "dark.match-ref", effect: { key: "color-grade" } });
  sent.length = 0;
  await matchReferences(graded, { refs, fonts: defaultFonts, render, runOps });
  assert.deepEqual(sent.map((op) => op.op), ["delete_animation", "add_animation", "add_animation"]);
  sent.length = 0;
  const removed = await matchReferences(graded, { remove: true, refs, fonts: defaultFonts, render, runOps });
  assert.deepEqual([sent.map((op) => op.animationId), removed.lines[0]], [["dark.match-ref"], "match_references main: took off 1 match grade"]);
  // One reference is no range: nothing changes and the line says why.
  const one = await matchReferences(document, { refs: refs.slice(0, 1), fonts: defaultFonts, render, runOps });
  assert.equal(one.skipped, true);
  // layer (one) works as layers does, the way a first guess sends it.
  const [picked] = translateOperations([{ op: "match_references", layer: "dark", lower: true }], createResolver(document), document);
  assert.deepEqual([picked.layerIds, picked.layerId, picked.lower], [["dark"], undefined, true]);
});

test("lift_dark aims a dark shot at the other shots' median, adds a curve and grain, reports the render's numbers and replaces its own effects", async () => {
  // Two 16:9 shots in a frame of `frame` [w, h], placed at y with height h (letterbox bars around them in 9:16).
  const shotsIn = ([frameWidth, frameHeight], [y, height]) => {
    const shot = (id, start) => createLayer("video", { id, name: id, src: `/api/media/${id}.mp4`, x: 0, y, width: frameWidth, height, start, duration: 5, mediaStart: start, mediaDuration: 5, mediaSourceDuration: 20 });
    return parseDocument(createDocument({ scenes: [createScene({ id: "main", width: frameWidth, height: frameHeight, duration: 10, layers: [shot("dark", 0), shot("lit", 5)] })] }));
  };
  const document = shotsIn([1920, 1080], [0, 1080]);
  // The dark shot is a ramp from 6 to 60 of 255 (mean 33), drawn through its lift curve when it has
  // one; the lit shot is 90 everywhere; black outside the shots' band.
  const curveOf = (scene) => scene.layers.find((layer) => layer.id === "dark")?.animations.find((animation) => animation.id === "dark.lift")?.parameters?.master;
  const render = async (scene, times, { width }) => times.map((time) => {
    const height = Math.round((width * scene.height) / scene.width), [y0, y1] = [scene.layers[0].y, scene.layers[0].y + scene.layers[0].height].map((y) => Math.round((y * width) / scene.width));
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let at = 0; at < pixels.length; at += 4) {
      const row = Math.floor(at / 4 / width), band = row >= y0 && row < y1;
      pixels.fill(!band ? 0 : time >= 5 ? 90 : 6 + Math.round(54 * ((at / 4) % width) / width), at, at + 3), pixels[at + 3] = 255;
    }
    const curve = time < 5 && curveOf(scene);
    if (!curve) return { width, height, pixels };
    // The curve draws on the layer only: the bars stay as they were.
    const drawn = applyTables([{ width, height, pixels }], curvesTables({ master: curve }))[0];
    for (let at = 0; at < pixels.length; at += 4) if (Math.floor(at / 4 / width) >= y0 && Math.floor(at / 4 / width) < y1) pixels.set(drawn.pixels.subarray(at, at + 4), at);
    return { width, height, pixels };
  });
  const sent = [];
  const runOps = async (doc, ops) => {
    sent.push(...ops);
    const next = structuredClone(doc);
    for (const op of ops) for (const layer of next.scenes[0].layers) {
      if (op.op === "delete_animation") layer.animations = layer.animations.filter((animation) => animation.id !== op.animationId);
      if (op.op === "add_animation" && layer.id === op.layerId) layer.animations.push({ id: op.id, effect: { key: op.effect }, parameters: op.parameters });
    }
    return next;
  };
  const first = await liftDark(document, { layerIds: ["dark"], fonts: defaultFonts, render, runOps });
  assert.deepEqual(sent.map((op) => [op.op, op.layerId, op.id, op.effect]), [["add_animation", "dark", "dark.lift", "curves"], ["add_animation", "dark", "dark.lift-grain", "grain"]]);
  assert.match(first.lines[0], /^lift_dark target 90 \(median of 1 other shot\): dark mean 33 to (8[89]|9[0-2]), contrast \(p90-p10\) 43 to \d+, black 7 to 7 \(a plain gamma [\d.]+ to the same mean: contrast \d+, black \d+\); \+[\d.]+ stops, grain [\d.]+\./);
  // The black point stays, the contrast grows past the gamma's.
  const [lift] = first.lifted;
  assert.ok(lift.after.contrast > lift.gamma.stats.contrast && lift.gamma.stats.p2 > lift.after.p2);
  // Sent again with grain:false and a target: the old effects go first, then only the curve.
  sent.length = 0;
  await liftDark(first.document, { layerIds: ["dark"], target: 60, grain: false, fonts: defaultFonts, render, runOps });
  assert.deepEqual(sent.map((op) => op.op === "delete_animation" ? op.animationId : op.id), ["dark.lift", "dark.lift-grain", "dark.lift"]);
  // In a 9:16 frame the same shots sit between black bars: each is measured inside its own box, so
  // the bars neither set the black point nor pull the shot past the other shot's 90.
  const tall = await liftDark(shotsIn([1080, 1920], [656, 608]), { layerIds: ["dark"], fonts: defaultFonts, render, runOps });
  assert.match(tall.lines[0], /^lift_dark target 90 \(median of 1 other shot\): dark mean 33 to (8[89]|9[0-2]), contrast \(p90-p10\) 43 to \d+, black 7 to 7 /, tall.lines[0]);
  const [picked] = translateOperations([{ op: "lift_dark", layer: "dark", target: 80 }], createResolver(document), document);
  assert.deepEqual([picked.layerIds, picked.target], [["dark"], 80]);
});
