// The deck (engine/deck.js): a seeded hand of techniques per project. The same inputs always deal
// the same hand; projects and rerolls deal different ones; the material, a backed style spec and
// the last projects steer it; the default edit is never dealt; swaps are limited and need a reason.
import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applySwap, cardNames, DECK_GROUPS, dealDeck, dealSeed, DEFAULT_SET, deckLine, deckUse, materialOf, projectSeed, SWAP_LIMIT, swapProblem } from "./deck.js";
import { LOUD_TAGS, PLAIN_TAGS, techniqueOf } from "./techniques.js";
import { styleContext } from "./styleSpec.js";
import { askLine, askMatches } from "./askWords.js";

const FOOTAGE = { known: true, fromLayers: true, video: true, pictures: true, pictureCount: 3, text: true, numbers: false, sound: true, device: false };
const tags = (deck) => deck.cards.map((card) => card.tag);
const deals = (count, options = {}) => Array.from({ length: count }, (_, index) => dealDeck({ projectId: `project-${index}`, material: FOOTAGE, ...options }));

test("a deal is the same for the same project, reroll and inputs, and different across projects and rerolls", () => {
  assert.equal(projectSeed("skate-edit"), projectSeed("skate-edit"));
  assert.ok(projectSeed("skate-edit") >= 1 && projectSeed("skate-edit") <= 9999);
  assert.equal(dealSeed("skate-edit", 2), projectSeed("skate-edit") + 2);
  const first = dealDeck({ projectId: "skate-edit", material: FOOTAGE });
  assert.deepEqual(dealDeck({ projectId: "skate-edit", material: FOOTAGE }), first);
  assert.equal(first.seed, projectSeed("skate-edit"));
  const rerolled = dealDeck({ projectId: "skate-edit", reroll: 1, material: FOOTAGE });
  assert.equal(rerolled.seed, first.seed + 1);
  assert.notDeepEqual(tags(rerolled), tags(first));
  // 40 projects: almost every hand is its own.
  const hands = new Set(deals(40).map((deck) => tags(deck).join(",")));
  assert.ok(hands.size >= 38, `${hands.size} different hands of 40`);
});

test("a hand has one or two cards per group, at most one set piece, and never the default edit", () => {
  for (const deck of deals(300)) {
    for (const group of DECK_GROUPS) {
      const count = deck.cards.filter((card) => card.group === group).length;
      assert.ok(count >= 1 && count <= 2, `${group}: ${count} in ${deckLine(deck)}`);
    }
    assert.ok(deck.cards.length >= 4 && deck.cards.length <= 6);
    // Never a plain card or a rhythm card, never two of the default set, so never the default hand.
    assert.ok(!deck.cards.some((card) => PLAIN_TAGS.includes(card.tag) || card.group === "rhythm"), deckLine(deck));
    assert.ok(deck.cards.filter((card) => DEFAULT_SET.includes(card.tag)).length <= 1, deckLine(deck));
    // Every card is one check can find, so deck_unused can count it.
    assert.ok(deck.cards.every((card) => techniqueOf(card.tag).detect));
  }
  // A loud accent needs a measured moment, so it is never dealt: not as a card, not when a backed
  // spec wants it, not inside a set piece.
  const loudMoves = [{ name: "rgb-split-hit", tags: ["rgb-split", "beat-kick", "glitch-hit"] }, { name: "flash-cut", tags: ["flash"] }];
  const style = styleContext({ wants: [...LOUD_TAGS], by: "guessed", lines: [{ text: "flashes and shakes", ref: "yt:abc", at: 2, tags: [...LOUD_TAGS] }] });
  // Nor as the signature: a spec whose first moment is a loud accent gets a set piece instead.
  const signed = LOUD_TAGS.map((tag) => styleContext({ idea: "one fight", signatures: [{ at: [2, 4] }], moments: [{ tag, at: 3 }] }));
  for (const deck of [...deals(200), ...deals(20, { style, moves: loudMoves }), ...signed.flatMap((entry) => deals(5, { style: entry }))]) {
    assert.ok(!deck.cards.some((card) => LOUD_TAGS.includes(card.tag)), deckLine(deck));
    assert.ok(!LOUD_TAGS.includes(deck.setPiece?.name), deckLine(deck));
    assert.ok(!loudMoves.some((move) => move.name === deck.setPiece?.name), deckLine(deck));
  }
});

test("the material filters the hand: no device cards without a phone, no type-heavy cards without words, no speed ramp without video", () => {
  const moves = [
    { name: "swipe-cards", tags: ["swipe-cards"] },
    { name: "speed-lines-phone", tags: ["speed-lines", "particles"] },
    { name: "zoom-through", tags: ["zoom-through", "speed-ramp"] },
  ];
  const silent = { ...FOOTAGE, text: false };
  for (const deck of deals(200, { material: silent, moves })) {
    assert.ok(!["swipe-cards", "speed-lines-phone"].includes(deck.setPiece?.name), deckLine(deck));
    // No words on screen: no reveal of words is dealt at all (there is no default type look).
    assert.equal(deck.cards.filter((card) => card.group === "type").length, 0, deckLine(deck));
  }
  const shapes = { known: true, fromLayers: true, video: false, pictures: false, pictureCount: 0, text: true, numbers: false, sound: false, device: false };
  for (const deck of deals(200, { material: shapes, moves: [{ name: "masked-type", tags: ["type-giant"], needs: ["video"] }] })) {
    assert.ok(!tags(deck).some((tag) => ["speed-ramp", "freeze-frame", "depth-blur", "type-counter"].includes(tag)), deckLine(deck));
    assert.ok(!["split-screen", "masked-type"].includes(deck.setPiece?.name), deckLine(deck));
  }
  // A phone screen recording: phone moves can be dealt.
  const phone = { ...FOOTAGE, device: true };
  assert.ok(deals(200, { material: phone, moves }).some((deck) => deck.setPiece?.name === "swipe-cards"));
  // With no material yet nothing is filtered.
  assert.ok(deals(300, { material: { known: false } }).some((deck) => tags(deck).includes("speed-ramp")));
});

test("materialOf reads the document and the brief's made_from words", () => {
  const document = parseDocument(createDocument({ id: "m", scenes: [createScene({ id: "s", width: 1920, height: 1080, layers: [
    createLayer("video", { id: "app", name: "Screen recording", src: "/api/media/app.mp4", x: 700, y: 40, width: 480, height: 1000 }),
    createLayer("text", { id: "t", name: "t", text: "3 taps to book", x: 100, y: 100 }),
  ] })] }));
  const material = materialOf(document);
  assert.deepEqual({ ...material }, { known: true, fromLayers: true, video: true, pictures: true, pictureCount: 1, text: true, numbers: true, sound: false, device: true });
  const empty = parseDocument(createDocument({ id: "e", scenes: [createScene({ id: "s" })] }));
  assert.equal(materialOf(empty).known, false);
  const fromWords = materialOf(empty, { madeFrom: "skate2.mp4 and its street sound" });
  assert.equal(fromWords.known, true);
  assert.equal(fromWords.fromLayers, false);
  assert.equal(fromWords.video, true);
  assert.equal(fromWords.sound, true);
  assert.equal(fromWords.numbers, false, "a number in a file name is not a number to count");
  // Measured facts: a marked subject box, faces and heard lines join the material only when present.
  document.scenes[0].layers[0].subjectBoxes = { src: "/api/media/app.mp4", boxes: [{ at: 1, box: [10, 10, 40, 80], by: "agent" }] };
  assert.deepEqual(materialOf(document, { facts: { lines: 4 } }), { ...material, subject: true, subjectClips: 1, cutOut: true, lines: 4 });
});

test("made cards come on evidence only: a fact that holds or a reference label, under the label caps", () => {
  // No fact, no label: never a made card.
  assert.ok(deals(100).every((deck) => !deck.cards.some((card) => card.group === "made")));
  // Heard lines and a subject: a fact card, said why.
  const facts = { ...FOOTAGE, subject: true, subjectClips: 2, cutOut: true, lines: 4 };
  for (const deck of deals(50, { material: facts })) {
    const made = deck.cards.filter((card) => card.group === "made");
    assert.ok(made.length >= 1 && made.length <= 2, deckLine(deck));
    assert.ok(made.every((card) => card.why === "fact" && ["cut_out", "keep_line", "rim-light"].includes(card.tag)), deckLine(deck));
  }
  // A cut-out without a subject is never dealt, even when a reference shows it.
  const cutOut = [{ name: "cut_out", refs: ["yt:a", "yt:b"] }];
  assert.ok(deals(50, { evidence: cutOut }).every((deck) => !tags(deck).includes("cut_out")));
  // Labels: loud treatments become dealable; at most half the hand, at most 2 from one reference.
  const evidence = ["overexpose", "smear", "shatter", "speed-lines", "punch-in", "zoom-through"].map((name) => ({ name, refs: ["yt:a"] }));
  const hands = deals(80, { evidence });
  assert.ok(hands.some((deck) => deck.cards.some((card) => ["overexpose", "smear", "shatter"].includes(card.tag))));
  for (const deck of hands) {
    const labeled = deck.cards.filter((card) => card.why === "seen");
    assert.ok(labeled.length <= 2, `one reference gives at most 2: ${deckLine(deck)}`);
    assert.ok(labeled.length * 2 <= deck.cards.length + (deck.setPiece ? 1 : 0), deckLine(deck));
    assert.ok(labeled.every((card) => card.refs === 1));
  }
  // A made card counts as used when the scene holds it (madeNamesIn, passed with the moves).
  const made = { cards: [{ tag: "cut_out", group: "made", why: "fact" }], setPiece: null };
  assert.deepEqual(deckUse(made, {}, ["cut_out"]), { used: ["cut_out"], unused: [] });
});

test("a backed style spec is dealt first; avoided tags never; a guessed spec only leans", () => {
  const backed = styleContext({ wants: ["blur-through", "type-mask-rise", "type-blur-in", "parallax"], avoids: ["glitch-hit"], by: "guessed",
    lines: [{ text: "blur-through between screens", ref: "yt:abc", at: 4.2, tags: ["blur-through", "type-mask-rise", "type-blur-in", "parallax"] }] });
  for (const deck of deals(100, { style: backed })) {
    for (const tag of ["blur-through", "type-mask-rise", "parallax"]) assert.ok(tags(deck).includes(tag), deckLine(deck));
    // The blur-in is never dealt, not even when the spec wants it (style_wanted still holds the video to it).
    assert.ok(!tags(deck).includes("type-blur-in"), deckLine(deck));
    assert.equal(deck.cards.find((card) => card.tag === "parallax").why, "spec");
    assert.ok(!tags(deck).includes("glitch-hit"));
  }
  const guessed = styleContext({ wants: ["dissolve"], by: "guessed" });
  const leaning = deals(300, { style: guessed }).filter((deck) => tags(deck).includes("dissolve")).length;
  const plain = deals(300).filter((deck) => tags(deck).includes("dissolve")).length;
  assert.ok(leaning > plain && leaning < 300, `guessed: ${leaning} of 300 deal dissolve (no spec: ${plain})`);
});

test("around the signature: moments[0] is dealt first, else a set piece always; the rest is seeded glue", () => {
  const signatures = [{ beat: 2, what: "the clip breaks apart", source: "skate.mp4, the kickflip", why: "only this crew lands it" }];
  for (const deck of deals(30, { style: styleContext({ signatures, moments: [{ tag: "tile-ring", beat: 2, what: "the ring" }], by: "guessed" }) })) {
    assert.deepEqual([deck.setPiece?.name, deck.setPiece?.why], ["tile-ring", "signature"]);
    assert.match(deckLine(deck), /signature: tile-ring/);
  }
  const card = deals(30, { style: styleContext({ moments: [{ tag: "whip-pan", beat: 1, what: "the whip" }], by: "guessed" }) });
  assert.ok(card.every((deck) => deck.cards[0].tag === "whip-pan" && deck.cards[0].why === "signature" && deck.cards.length >= 4));
  // A signature with no moment: a set piece in every hand (without one, about half have none).
  const pieces = deals(30, { style: styleContext({ signatures, by: "guessed" }) });
  assert.ok(pieces.every((deck) => deck.setPiece?.why === "signature"), pieces.map(deckLine).join("\n"));
  assert.ok(new Set(pieces.map((deck) => tags(deck).join())).size >= 25, "the glue stays seeded");
});

test("novelty: techniques the last projects were dealt or used come up far less", () => {
  const recent = ["dissolve", "slow-push", "type-words", "particles", "parallax"];
  const count = (list) => list.reduce((sum, deck) => sum + tags(deck).filter((tag) => recent.includes(tag)).length, 0);
  const fresh = count(deals(300));
  const steered = count(deals(300, { recent }));
  assert.ok(steered < fresh / 2, `recent tags dealt ${steered} times with history, ${fresh} without`);
});

test("moves join as one set piece when the library exists; techniques only before", () => {
  const moves = [{ name: "zoom-through", tags: ["zoom-through", "speed-ramp"] }, { name: "caption-words", tags: ["type-words", "type-blur-in"] }, { name: "tile-ring", tags: ["tile-ring"] }];
  const withMoves = deals(60, { moves });
  assert.ok(withMoves.every((deck) => deck.setPiece?.kind === "move"));
  assert.ok(new Set(withMoves.map((deck) => deck.setPiece.name)).size === 3);
  const line = deckLine(withMoves[0]);
  assert.match(line, /^deck \(seed \d+\): [a-z-]+(, [a-z-]+)+, set piece: [a-z-]+; swaps left 2$/);
  // Without moves the set piece is split-screen at most.
  assert.ok(deals(60).every((deck) => !deck.setPiece || deck.setPiece.name === "split-screen"));
  // A move the person's own words name is the set piece, with the word (askWords.js); three asks
  // from different kinds of video find their move by its own text.
  const library = [{ name: "energy-aura", about: "light rises from the subject's outline", fits: "a figure powering up, an aura" },
    { name: "glitch", about: "the picture tears into offset blocks", fits: "a digital error" }, { name: "fog", about: "Fog" }, ...moves];
  const entries = library.map((move) => ({ name: move.name, text: `${move.about ?? ""} ${move.fits ?? ""}` }));
  assert.equal(askLine(askMatches("make an aura edit of the hooded guy, dark and menacing", entries)), 'for your words: "aura" -> energy-aura');
  assert.equal(askLine(askMatches("a talking-head interview with a glitching intro", entries)), 'for your words: "glitching" -> glitch');
  assert.equal(askLine(askMatches("a horror game trailer, fog everywhere", entries)), 'for your words: "fog" -> fog');
  const asked = askMatches("an aura edit", entries);
  assert.ok(deals(20, { moves: library, asked }).every((deck) => deck.setPiece.name === "energy-aura" && deck.setPiece.word === "aura"));
});

test("swaps: at most 2 a deal, each with a reason, for a card in the hand, into a technique check can find or a move", () => {
  const deck = { ...dealDeck({ projectId: "swap", material: FOOTAGE }), swaps: [] };
  const [first, second, third] = tags(deck);
  const fresh = ["dissolve", "drift", "type-swap", "light-sweep", "whip-pan"].filter((tag) => !tags(deck).includes(tag));
  assert.match(swapProblem(deck, { out: first, in: fresh[0] }), /needs why/);
  assert.match(swapProblem(deck, { out: "nope", in: fresh[0], why: "does not fit" }), /not in the hand/);
  assert.match(swapProblem(deck, { out: first, in: "cut", why: "plain" }), /plain default or a rhythm/);
  assert.match(swapProblem(deck, { out: first, in: "match-cut", why: "shapes line up" }), /cannot find it/);
  assert.match(swapProblem(deck, { out: first, in: second, why: "again" }), /already in the hand/);
  assert.match(swapProblem(deck, { out: first, in: fresh[0], why: "no", extra: 1 }), /not extra/);
  assert.match(swapProblem(deck, { out: first, in: fresh[0], why: "too loud" }, { avoids: [fresh[0]] }), /avoids/);
  assert.equal(swapProblem(deck, { out: first, in: fresh[0], why: "no fast shots in this footage" }), null);
  const once = applySwap(deck, { out: first, in: fresh[0], why: "no fast shots in this footage" });
  assert.ok(tags(once).includes(fresh[0]) && !tags(once).includes(first));
  const twice = applySwap(once, { out: second, in: fresh[1], why: "the material is calm" });
  assert.equal(twice.swaps.length, SWAP_LIMIT);
  assert.match(swapProblem(twice, { out: third, in: fresh[2], why: "one more" }), /used its 2 swaps/);
  // A move swaps in for the set piece only.
  const withPiece = { ...deck, setPiece: { kind: "move", name: "zoom-through", tags: ["zoom-through"] } };
  assert.match(swapProblem(withPiece, { out: first, in: "tile-ring", why: "a hero moment" }, { moves: ["tile-ring", "zoom-through"] }), /set piece is zoom-through/);
  const piece = applySwap(withPiece, { out: "zoom-through", in: "tile-ring", why: "a hero moment" }, { moves: [{ name: "tile-ring", tags: ["tile-ring"] }] });
  assert.equal(piece.setPiece.name, "tile-ring");
  assert.deepEqual(cardNames(piece).at(-1), "tile-ring");
});

test("deckUse counts the cards a video shows; a move counts by its tags", () => {
  const deck = { cards: [{ tag: "dissolve" }, { tag: "drift" }, { tag: "type-words" }], setPiece: { kind: "move", name: "parallax-stack", tags: ["parallax", "depth-blur"] } };
  assert.deepEqual(deckUse(deck, { dissolve: 2, "depth-blur": 1, cut: 9 }), { used: ["dissolve", "parallax-stack"], unused: ["drift", "type-words"] });
  // A move the scene holds counts even when check cannot name its techniques.
  assert.deepEqual(deckUse({ ...deck, setPiece: { kind: "move", name: "tile-ring", tags: ["tile-ring"] } }, {}, ["tile-ring"]).used, ["tile-ring"]);
});
