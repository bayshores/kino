// The deck in the agent service (backend/agent/deck.mjs): dealt once the treatment is picked, shown
// in status and on the brief, rerolled and swapped with notes {action:"deck"}, steered away from
// this machine's last projects, counted by check (deck_unused), and varied by variants
// {vary:"deck"}. Also the project seed recipes and compose use by default, and the treatments
// saved on the brief (backend/agent/treatments.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { projectSeed } from "../engine/deck.js";
import { askText } from "./agent/stops.mjs";
import { cleanTreatments, pickedSignature, pickLines, shownLines, treatmentsProblem, treatmentsText } from "./agent/treatments.mjs";
import { briefChanges, lockCall } from "./agent/brief.mjs";
import { mediaKeys, newDeal } from "./agent/deck.mjs";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const savedState = async (project) => JSON.parse(await readFile(path.join(server.dataDirectory, "agent", "projects", `${project}.json`), "utf8"));
const documentOf = async (project) => (await (await server.api(`/api/projects/${project}`)).json()).document;
const guessed = (text) => ({ text, by: "guessed" });
// The order steps before building (brief.mjs orderStep), waived: these tests are about the deck.
const ORDER_WAIVERS = ["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a deck test" }));
const DECK_LINE = /^deck \(seed (\d+)\): [a-z0-9-]+(, [a-z0-9-]+)*(, set piece: [a-z0-9-]+)?; swaps left (\d)$/;

async function newVideo(id, { madeFrom = "skate.mp4 footage, music, captions", duration = 20, message = "skate crew" } = {}) {
  const made = await agent("project", { action: "create", id, name: id, width: 1080, height: 1920, duration });
  assert.equal(made.isError, undefined, made.text);
  const saved = await agent("notes", { project: id, action: "brief", fields: { message: guessed(message), made_from: guessed(madeFrom) } });
  assert.equal(saved.isError, undefined, saved.text);
}
const statusDeck = async (id) => (await agent("status", { project: id })).text.split("\n").find((line) => line.startsWith("deck ("));

test("the deck is dealt once the treatment is picked, shows in status and on the brief, and stays the same across reads", async () => {
  await newVideo("deck-status");
  assert.equal(await statusDeck("deck-status"), undefined, "no deck while the brief is still being asked");
  await agent("notes", { project: "deck-status", action: "brief", no_playback: "just start" });
  await agent("notes", { project: "deck-status", action: "brief", fields: { treatments: FIVE } });
  assert.equal(await statusDeck("deck-status"), undefined, "no deck before the pick: the treatments are not the dealt cards");
  assert.equal((await savedState("deck-status")).deck ?? null, null);
  await agent("notes", { project: "deck-status", action: "brief", fields: { treatments: { pick: "B", why: "the map is what a skater retells" } } });
  const line = await statusDeck("deck-status");
  assert.match(line, DECK_LINE);
  assert.equal(Number(DECK_LINE.exec(line)[1]), projectSeed("deck-status"));
  assert.equal(await statusDeck("deck-status"), line, "the same hand on every read");
  const read = await agent("notes", { project: "deck-status", action: "deck" });
  assert.equal(read.isError, undefined, read.text);
  assert.equal(read.text.split("\n")[0], line);
  assert.match(read.text, /^for: video, text, sound/m);
  assert.equal(read.data.deck.cards.length + (read.data.deck.setPiece ? 1 : 0), read.text.split("\n").filter((entry) => entry.startsWith("- ")).length, "one line per card");
  assert.ok((await agent("notes", { project: "deck-status", action: "brief" })).text.includes(line), "the brief read shows the deck");
  assert.equal((await savedState("deck-status")).deck.seed, projectSeed("deck-status"));
  // The pick's signature saved (the next order step): dealt again with its technique first.
  const signed = await agent("notes", { project: "deck-status", action: "brief", fields: { style: {
    signatures: [{ beat: 3, what: "mask-wipe along the line", source: "route.mp4, the full loop", why: "only this crew's route" }],
    moments: [{ tag: "mask-wipe", beat: 3, what: "the route draws itself" }] } } });
  assert.equal(signed.isError, undefined, signed.text);
  await statusDeck("deck-status");
  assert.deepEqual((await savedState("deck-status")).deck.cards[0], { tag: "mask-wipe", group: "transition", why: "signature" });
});

test("reroll deals again with the next seed; swaps need a reason and stop at 2 a deal; the brief keeps them", async () => {
  await newVideo("deck-swap");
  await agent("notes", { project: "deck-swap", action: "brief", no_playback: "just start" });
  const first = (await agent("notes", { project: "deck-swap", action: "deck" })).data.deck;
  const again = await agent("notes", { project: "deck-swap", action: "deck", reroll: true });
  assert.match(again.text, /^dealt again \(deal 2\)\./);
  assert.equal(again.data.deck.seed, first.seed + 1);
  const cards = again.data.deck.cards.map((card) => card.tag);
  const fresh = ["dissolve", "drift", "type-swap", "light-sweep", "whip-pan", "parallax"].filter((tag) => !cards.includes(tag));
  const noReason = await agent("notes", { project: "deck-swap", action: "deck", swap: { out: cards[0], in: fresh[0] } });
  assert.equal(noReason.data.error, "bad_input");
  assert.match(noReason.data.reason, /needs why/);
  const swapped = await agent("notes", { project: "deck-swap", action: "deck", swap: { out: cards[0], in: fresh[0], why: "no fast shots in this footage" } });
  assert.equal(swapped.isError, undefined, swapped.text);
  assert.match(swapped.text, /swaps left 1/);
  await agent("notes", { project: "deck-swap", action: "deck", swap: { out: cards[1], in: fresh[1], why: "the material is calm" } });
  const third = await agent("notes", { project: "deck-swap", action: "deck", swap: { out: cards[2], in: fresh[2], why: "one more" } });
  assert.equal(third.data.error, "swap_limit");
  const brief = await agent("notes", { project: "deck-swap", action: "brief" });
  assert.match(brief.text, new RegExp(`deck swap: ${cards[0]} → ${fresh[0]} \\(no fast shots in this footage\\)`));
  // A reroll starts the next deal with its 2 swaps.
  const rerolled = await agent("notes", { project: "deck-swap", action: "deck", reroll: true });
  assert.equal(rerolled.data.deck.swaps.length, 0);
  assert.equal(rerolled.data.deck.seed, first.seed + 2);
  assert.equal((await agent("notes", { project: "deck-swap", action: "deck", reroll: "yes" })).data.error, "bad_input");
});

test("novelty: each new project's deal steers away from the last projects' decks", async () => {
  const ids = ["deck-novel-1", "deck-novel-2", "deck-novel-3"];
  for (const id of ids) {
    await newVideo(id, { message: `skate crew ${id.at(-1)}` });
    await agent("notes", { project: id, action: "brief", no_playback: "just start" });
  }
  const decks = [];
  for (const id of ids) decks.push((await agent("notes", { project: id, action: "deck" })).data.deck);
  assert.ok(decks[1].awayFrom.includes("deck-novel-1"));
  assert.ok(decks[2].awayFrom.includes("deck-novel-2") && decks[2].awayFrom.length <= 3);
  assert.equal(new Set(decks.map((deck) => deck.cards.map((card) => card.tag).join(","))).size, 3, "three different hands");
  // A remake (shares media or the story with a recent project) is not steered away from it.
  const recent = [{ projectId: "app-trailer", cards: ["flash"], used: ["beat-kick"], media: ["/api/media/walk.mp4"], dealtAt: "x" },
    { projectId: "same-story", cards: [], used: [], story: "the app wins hack day", dealtAt: "x" }, { projectId: "logo-only", cards: [], used: [], media: ["/api/media/logo.png", "/api/media/b.mp4"], dealtAt: "x" },
    { projectId: "other", cards: [], used: [], dealtAt: "x" }];
  const inputs = { style: null, material: { known: false }, moves: [], basis: "", media: ["/api/media/walk.mp4", "/api/media/logo.png"], story: "the app wins hack day" };
  assert.deepEqual(newDeal({ projectId: "app-v2", inputs, recent }).awayFrom, ["logo-only", "other"], "one reused logo is not a remake");
  const layer = (type, src) => ({ type, src });
  assert.deepEqual(mediaKeys({ scenes: [{ layers: [layer("video", "/a.mp4"), layer("audio", "/hit.wav"), layer("image", "/logo.png")] }] }), ["/a.mp4", "/logo.png"], "a shared sound is not shared material");
});

test("the material steers the deal: footage without words gets one light type card", async () => {
  await newVideo("deck-silent", { madeFrom: "drone.mp4 footage only" });
  await agent("notes", { project: "deck-silent", action: "brief", no_playback: "just start" });
  const deck = (await agent("notes", { project: "deck-silent", action: "deck" })).data.deck;
  const type = deck.cards.filter((card) => card.group === "type").map((card) => card.tag);
  assert.equal(type.length, 1);
  assert.ok(["type-fade", "type-slide", "type-pop", "type-mask-rise", "type-blur-in"].includes(type[0]), type[0]);
  assert.equal(deck.material, "video");
});

test("check warns deck_unused when the video uses under half the deck, and records what it used", async () => {
  await newVideo("deck-check", { duration: 10 });
  await agent("notes", { project: "deck-check", action: "brief", no_playback: "just start" });
  const edited = await agent("edit", { project: "deck-check", ops: [...ORDER_WAIVERS,
    { op: "add_layer", layerType: "text", properties: { id: "title", name: "title", text: "skate now", x: 200, y: 600, fontSize: 96 } },
    { op: "add_animation", layerId: "title", animation: { kind: "in", start: 0.3, duration: 0.6, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } } }] });
  assert.equal(edited.isError, undefined, edited.text);
  // deck_unused is advice: one line in a plain check, the finding itself when check names it.
  assert.match((await agent("check", { project: "deck-check", pixels: false })).text, /^advice \(does not block\): .*deck_unused/m);
  const checked = await agent("check", { project: "deck-check", rules: ["deck_unused"], pixels: false });
  const line = checked.text.split("\n").find((entry) => entry.startsWith("I deck_unused"));
  assert.ok(line, checked.text);
  assert.match(line, /of the deck \(seed \d+\) unused/);
  assert.ok(Array.isArray((await savedState("deck-check")).deck.used));
});

test("compose and recipe default their seed to the project's seed, not 1; a given seed is kept", async () => {
  const beats = [{ recipe: "headline-reveal", text: "Your week, in one view" }, { recipe: "cta-end", text: "Try it free", sub: "orbit.app" }];
  for (const id of ["seed-a", "seed-b"]) {
    await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 8 });
    const composed = await agent("edit", { project: id, ops: [{ op: "compose", format: "16:9", look: "crisp", beats }] });
    assert.equal(composed.isError, undefined, composed.text);
    const scene = (await documentOf(id)).scenes.find((entry) => entry.composition);
    assert.equal(scene.composition.seed, projectSeed(id));
  }
  assert.notEqual(projectSeed("seed-a"), projectSeed("seed-b"));
  const given = await agent("edit", { project: "seed-a", ops: [{ op: "compose", format: "16:9", look: "crisp", seed: 5, beats }] });
  assert.equal(given.isError, undefined, given.text);
  assert.equal((await documentOf("seed-a")).scenes.find((entry) => entry.composition).composition.seed, 5);
  await agent("project", { action: "create", id: "seed-r", name: "seed-r", width: 1920, height: 1080, duration: 6 });
  const recipe = await agent("edit", { project: "seed-r", ops: [{ op: "recipe", name: "headline-reveal", text: "Hello there" }] });
  assert.equal(recipe.isError, undefined, recipe.text);
  const made = (await documentOf("seed-r")).scenes[0].layers.find((layer) => layer.recipe && !layer.recipe.part);
  assert.equal(made.recipe.settings.seed, projectSeed("seed-r"));
});

test("variants {vary:\"deck\"} makes 3 scenes from the next decks; picking one makes its deck the project's", async () => {
  await agent("project", { action: "create", id: "deck-variants", name: "deck-variants", width: 1920, height: 1080, duration: 10 });
  await agent("notes", { project: "deck-variants", action: "brief", fields: { message: guessed("plan the week") }, no_playback: "just start" });
  const composed = await agent("edit", { project: "deck-variants", ops: [...ORDER_WAIVERS, { op: "compose", format: "16:9", look: "bold", beats: [
    { recipe: "headline-reveal", text: "Your team's week, in one view" }, { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" }, { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app" }] }] });
  assert.equal(composed.isError, undefined, composed.text);
  const current = (await agent("notes", { project: "deck-variants", action: "deck" })).data.deck;
  const varied = await agent("edit", { project: "deck-variants", ops: [{ op: "variants", vary: "deck" }] });
  assert.equal(varied.isError, undefined, varied.text);
  const variants = (await documentOf("deck-variants")).scenes.filter((scene) => scene.variant?.vary === "deck" && scene.variant.of !== scene.id);
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((scene) => scene.variant.deck.seed), [current.seed + 1, current.seed + 2, current.seed + 3]);
  assert.ok(variants.every((scene) => scene.composition.seed === scene.variant.deck.seed));
  assert.match(varied.data.notes.join("\n"), /deck \d+ built/);
  const picked = await agent("edit", { project: "deck-variants", ops: [{ op: "pick_variant", scene: variants[1].id }] });
  assert.equal(picked.isError, undefined, picked.text);
  const adopted = (await agent("notes", { project: "deck-variants", action: "deck" })).data.deck;
  assert.equal(adopted.seed, current.seed + 2);
  assert.deepEqual(adopted.cards.map((card) => card.tag), variants[1].variant.deck.cards);
});

const FIVE = [
  { idea: "a slow city-at-dawn montage with a voice", who: "the city", tension: "is the city still asleep?", turn: "the first board hits the road", move: "slow push on every shot", rhythm: "even, calm", p: 0.6, source: "dawn.mp4, the empty street" },
  { idea: "the crew's day told by one skateboard", who: "the board's owner", tension: "whose board is it?", turn: "the owner lands the kickflip", move: "match cuts on the board", rhythm: "builds to the kickflip", p: 0.15, source: "crew.mp4, the board passed on" },
  { idea: "a map that draws the route as they skate", who: "the crew", tension: "where are they going?", turn: "the line closes the loop", move: "mask-wipe along the line", rhythm: "steady, then a stop", p: 0.1, source: "route.mp4, the loop" },
  { idea: "every trick frozen with its name", who: "a skater", tension: "will the hard one land?", turn: "the last freeze is a fall", move: "freeze-frame and type-giant", rhythm: "stop and go", p: 0.25, source: "tricks.mp4, each landing" },
  { idea: "the city's sounds as the beat", who: "a passer-by", tension: "what is that noise?", turn: "the wheels join the beat", move: "cuts on street sounds", rhythm: "syncopated", p: 0.05, source: "street.wav, the horns" },
];

test("treatments: a source names the move's material; the pick drafts the lock's idea, signature and idea spine", () => {
  const withSource = FIVE.map((entry, index) => (index === 2 ? { ...entry, source: "route.mp4, the full loop at 0:40" } : entry));
  assert.equal(treatmentsProblem(withSource), null);
  assert.match(treatmentsProblem(withSource.map((entry) => ({ ...entry, source: "x".repeat(81) }))).message, /^treatments\[0\]\.source is 81 characters, limit 80\. .* \(5 problems\)$/);
  // Every field over its limit at once, named with its length and limit.
  const long = withSource.map((entry, index) => (index === 1 ? { ...entry, idea: "x".repeat(125), rhythm: "y".repeat(61) } : entry));
  assert.equal(treatmentsProblem(long).message, "treatments[1].idea is 125 characters, limit 120. treatments[1].rhythm is 61 characters, limit 60. (2 problems)");
  const cleaned = cleanTreatments(withSource);
  // Picking a treatment with an idea of 81 to 120 characters fills the idea line and style.idea.
  const longIdea = "a".repeat(100);
  const longList = cleanTreatments(withSource.map((entry, index) => (index === cleaned.shown[0] ? { ...entry, idea: longIdea } : entry)));
  const longPick = briefChanges({ treatments: longList }, { fields: { treatments: { pick: "A", why: "a reason" } } });
  assert.deepEqual([longPick.lines[0].line.text, longPick.style.idea], [longIdea, longIdea]);
  assert.equal(shownLines(cleaned)[1], "B. a map that draws the route as they skate · the crew: where are they going? → the line closes the loop · mask-wipe along the line");
  // A list saved before who, tension and turn shows as it did.
  const old = cleanTreatments(withSource.map(({ who, tension, turn, ...rest }) => rest));
  assert.equal(shownLines(old)[1], "B. a map that draws the route as they skate · mask-wipe along the line (route.mp4, the full loop at 0:40) · steady, then a stop");
  const picked = cleanTreatments({ pick: "B" }, cleaned);
  assert.deepEqual(pickedSignature(picked), { what: "mask-wipe along the line", source: "route.mp4, the full loop at 0:40" });
  assert.match(treatmentsText({ treatments: picked }), /: a map that draws the route as they skate · signature: mask-wipe along the line \(route\.mp4/);
  // The lock is drafted around the idea and its signature; the sales template only with no idea.
  const brief = { fields: { idea: { text: "a map that draws the route as they skate", by: "guessed" } }, treatments: picked };
  const style = lockCall({ brief }).input.fields.style;
  assert.deepEqual(style.spine.map((beat) => beat.role), ["hook", "problem", "turn", "signature", "payoff", "end"]);
  assert.deepEqual([style.idea, style.signatures[0].beat, style.signatures[0].source], [brief.fields.idea.text, 3, "route.mp4, the full loop at 0:40"]);
  // A spine saved before the build is kept: the lock asks the rest of the bible (fonts, the dealt
  // moves, the logo) with the saved avoids, never the spine; saved moves and logo are not asked again.
  const early = { by: "guessed", idea: "x", signatures: style.signatures, avoids: ["beat-kick"], spine: [{ role: "hook", from: 0, to: 2, purpose: "y" }] };
  const kept = lockCall({ brief: { ...brief, style: early }, deck: { cards: [{ tag: "mask-wipe" }] } }).input.fields.style;
  assert.deepEqual([Object.keys(kept), kept.moves[0].tag, kept.sources.moves], [["avoids", "fonts", "moves", "sources", "logo"], "mask-wipe", "dealt"]);
  const full = lockCall({ brief: { ...brief, style: { ...early, moves: kept.moves, logo: kept.logo } }, deck: { cards: ["mask-wipe"] } }).input.fields.style;
  assert.deepEqual(Object.keys(full), ["avoids", "fonts"]);
  // No idea: no template spine; the call asks for the idea and its signature first.
  const noIdea = lockCall({ brief: { fields: {} } }).input.fields.style;
  assert.deepEqual([noIdea.spine, noIdea.idea, noIdea.signatures.length], [undefined, "<one sentence: what only this product can show, from its real material>", 1]);
});

test("treatments: 5 saved on the brief, the most typical dropped, the 3 least typical shown; a pick becomes the idea", async () => {
  assert.match(treatmentsProblem(FIVE.slice(0, 4)).message, /list of 5/);
  assert.match(treatmentsProblem([...FIVE.slice(0, 4), { ...FIVE[4], p: 2 }]).message, /p is 0 to 1/);
  assert.match(treatmentsProblem({ pick: "B" }, null).message, /first/);
  const cleaned = cleanTreatments(FIVE);
  assert.equal(cleaned.dropped, 0);
  assert.deepEqual(cleaned.shown, [4, 2, 1]);
  // 3 whos ("The Crew" is "crew"): the 3 shown are the least typical of each who, so the 2nd crew story gives way.
  const threeWhos = cleanTreatments(FIVE.map((entry, index) => ({ ...entry, who: ["the city", "a kid", "The Crew", "the city", "crew"][index] })));
  assert.deepEqual([threeWhos.shown, threeWhos.shown.map((index) => threeWhos.list[index].who)], [[4, 1, 3], ["crew", "a kid", "the city"]]);
  // Your own pick says why.
  assert.match(treatmentsProblem({ pick: "B" }, cleaned).message, /^why is 1 to 80 characters, required on your own pick/);

  await newVideo("treat");
  await agent("notes", { project: "treat", action: "brief", log: [{ q: "What's wrong or missing?", a: "looks right", kind: "playback", rev: 1, confirmed: true }] });
  const saved = await agent("notes", { project: "treat", action: "brief", fields: { treatments: FIVE } });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /treatments: dropped the most typical \(p 0\.6: a slow city-at-dawn montage with a voice\)/);
  assert.match(saved.text, /^A\. the city's sounds as the beat · a passer-by: what is that noise\? → the wheels join the beat · cuts on street sounds$/m);
  assert.equal(saved.data.brief.confirmedRev, saved.data.brief.rev, "saving treatments keeps a confirmed brief confirmed");
  // The stop's ask shows them until the person picks.
  const brief = (await savedState("treat")).brief;
  const ask = askText({ id: "C1", kind: "rough", video: { seconds: 20 }, checked: { errors: 0, warnings: 0 }, pick: pickLines(brief) });
  assert.match(ask, /Pick a direction \(or say your own\):\nA\. the city's sounds as the beat/);
  const pick = await agent("notes", { project: "treat", action: "brief", fields: { treatments: { pick: "B", quote: "the map one" } } });
  assert.equal(pick.isError, undefined, pick.text);
  const after = await savedState("treat");
  assert.deepEqual(after.brief.treatments.picked, { label: "B", index: 2, by: "you", quote: "the map one" });
  assert.equal(after.brief.fields.idea.text, "a map that draws the route as they skate");
  assert.equal(after.brief.fields.idea.quote, "the map one");
  assert.deepEqual(pickLines(after.brief), [], "nothing to pick any more");
  // "just start": the stop does not ask; the agent picks.
  assert.deepEqual(pickLines({ treatments: cleaned, noPlayback: { reason: "just start" } }), []);
  assert.match(treatmentsText({ treatments: cleaned, noPlayback: { reason: "just start" } }), /\npick the one a viewer would retell tomorrow that this material can carry; say why: fields:\{treatments:\{pick:"A", why:"<why>"\}\}\.$/);
});
