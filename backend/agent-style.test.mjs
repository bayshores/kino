// The style spec on the brief (notes brief fields.style, backend/agent/style.mjs) and what the agent
// sees of techniques: library {topic:"techniques"}, the check receipt's techniques line, and the
// style rules following a saved spec. Each refusal names the closest tag.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { briefChanges, briefSummary, emptyBrief } from "./agent/brief.mjs";
import { addRejected, styleProblem } from "./agent/style.mjs";
import { startTestServer } from "./media.test.support.mjs";
import { directionLock, styleContext } from "../engine/styleSpec.js";

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "claude-code", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const REFERENCE_SPEC = {
  wants: ["type-words", "dissolve"],
  avoids: ["beat-kick"],
  lines: [{ text: "lowercase captions, word by word", ref: "yt:3VHoNjrUD4Q", at: 8.2, tags: ["type-words"] }],
  by: "guessed",
};

test("style spec: an unknown tag is refused with the closest one; wants and avoids cannot share a tag", () => {
  const unknown = styleProblem({ wants: ["disolve"], by: "guessed" });
  assert.match(unknown.message, /"disolve" is not a technique; the closest is dissolve/);
  assert.equal(unknown.details.didYouMean[0], "dissolve");
  assert.match(styleProblem({ wants: ["dissolve"], avoids: ["dissolve"], by: "guessed" }).message, /wants and avoids dissolve/);
  assert.match(styleProblem({ wants: ["dissolve"] }).message, /style.by is "you"/);
  assert.equal(styleProblem({ wants: ["dissolve"], by: "you" }).code, "quote_needed");
  assert.match(styleProblem({ wants: ["dissolve"], by: "guessed", lines: [{ text: "x", at: 3 }] }).message, /at but no ref/);
  assert.match(styleProblem({ wants: ["dissolve"], by: "guessed", lines: [{ text: "x", ref: "yt:a", tags: ["zoomthrough"] }] }).message, /closest is zoom-through/);
  // An Inspire suggestion pasted as it came (guess:true) is refused until the agent confirms it.
  assert.match(styleProblem({ wants: ["slow-push"], by: "guessed", lines: [{ text: "slow push-ins", ref: "yt:a", at: 4, tags: ["slow-push"], guess: true }] }).message, /send the lines you confirm without guess/);
  assert.equal(styleProblem(REFERENCE_SPEC), null);
  // Every problem of one style comes at once, the first one's code and details kept.
  const several = styleProblem({ wants: ["disolve", "zoomthrough"], by: "maybe", lines: [{ text: "x", at: 3 }] });
  assert.match(several.message, /^4 problems in style: .*"disolve".*"zoomthrough".*at but no ref.*style.by is "you"/);
  assert.equal(several.details.didYouMean[0], "dissolve");
  // The person's spec is not replaced by a guess.
  assert.equal(styleProblem(REFERENCE_SPEC, { ...REFERENCE_SPEC, by: "you", quote: "like the launch film" }).code, "yours");
});

const IDEA_BIBLE = {
  by: "guessed", fonts: { caption: { family: "Inter", size: 48 }, quote: { family: "Fraunces", size: 72 } },
  spine: ["hook", "how", "signature", "coda"].map((role, index) => ({ role, from: index * 5, to: index * 5 + 5, purpose: `the ${role}` })),
  idea: "your notes turn into a deck while you watch",
  signatures: [{ beat: 2, what: "the note flies into a card", source: "deck.png, the review screen", why: "only this app makes cards", at: [11, 14] }],
  moments: [{ tag: "screen-zoom", beat: 2, what: "into the card" }],
};

test("style spec: idea, signatures and moments are checked; the lock needs them once a treatment is picked", () => {
  assert.equal(styleProblem(IDEA_BIBLE), null, "new beat roles and the quote face are accepted");
  const bad = styleProblem({ ...IDEA_BIBLE, idea: "", signatures: [{ beat: 9, what: "x" }], moments: [{ tag: "zoomthrough", beat: 1, what: "x" }] });
  assert.match(bad.message, /style\.idea is one sentence.*signatures\[0\]\.beat is 0 to 3.*signatures\[0\]\.source is 1 to 80.*closest is zoom-through/);
  const context = styleContext(IDEA_BIBLE);
  assert.equal(context.idea, IDEA_BIBLE.idea);
  assert.deepEqual([context.signatures.length, context.moments[0].tag, context.signatureRanges.map(({ from, to }) => [from, to])], [1, "screen-zoom", [[10, 15], [11, 14]]]);
  assert.deepEqual([styleContext({ wants: ["dissolve"] }).idea, styleContext({ wants: ["dissolve"] }).signatures], [null, []]);
  // An old bible (no idea, no picked treatment) keeps its lock; once a treatment is picked it needs both.
  const { idea, signatures, moments, ...old } = { ...IDEA_BIBLE, waived: "batch render" };
  assert.equal(directionLock(old), "locked");
  const picked = { treatments: { picked: { label: "A", index: 1 } } };
  assert.equal(directionLock(old, picked), "missing");
  assert.equal(directionLock({ ...old, idea }, picked), "missing", "an idea without a signature");
  assert.equal(directionLock({ ...old, idea, signatures }, picked), "locked");
});

test("style spec: saved on the brief, it raises the revision, keeps a confirmed brief confirmed, and shows on the dashboard", () => {
  const confirmed = { ...emptyBrief(), rev: 2, confirmedRev: 2, fields: { message: { text: "skate now", by: "guessed", rev: 1 } } };
  const changes = briefChanges(confirmed, { fields: { style: REFERENCE_SPEC } });
  assert.deepEqual(changes.lines, []);
  assert.deepEqual(changes.style.wants, ["type-words", "dissolve"]);
  // Sent again unchanged: nothing changes.
  assert.equal(briefChanges({ ...confirmed, style: changes.style }, { fields: { style: REFERENCE_SPEC } }).style, undefined);
  assert.throws(() => briefChanges(confirmed, { fields: { style: { wants: ["glitch"], by: "guessed" } } }), /closest is glitch-hit/);
  // The direction lock rides on the same spec: a spine, a style bible and the rejected text.
  const locked = { avoids: ["flash"], by: "guessed", waived: "batch run, no one watching", rejected: ["Seven open-weight models."],
    spine: [{ role: "Hook", from: 0, to: 3, uses: ["verdict"], purpose: "the judge's verdict first" }],
    fonts: { caption: { family: "JetBrains Mono", size: 48 } }, accent: { color: "#ff4f9a", share: 0.1 }, moves: [{ tag: "dissolve", where: "between walk shots" }], logo: { asset: "app-mark", max: 2 } };
  const saved = briefChanges(confirmed, { fields: { style: locked } }).style;
  assert.deepEqual([saved.spine[0].role, saved.waived, saved.rejected, saved.logo.max], ["hook", "batch run, no one watching", ["Seven open-weight models."], 2]);
  // The never list keeps the newest 12 and says which older texts it dropped.
  const draft = {};
  assert.deepEqual(addRejected(draft, Array.from({ length: 12 }, (unused, index) => `line ${index}`)), []);
  assert.deepEqual([addRejected(draft, "line 12"), draft.brief.style.rejected.length], [["line 0"], 12]);
  assert.match(styleProblem({ ...locked, moves: ["a", "b", "c", "d", "e"].map((where) => ({ tag: "dissolve", where })) }).message, /up to 4 moves/);
  assert.match(styleProblem({ ...locked, fonts: { body: { family: "Inter", size: 40 } } }).message, /takes caption, display, label/);
  assert.match(styleProblem({ ...locked, spine: [{ role: "hook", from: 3, to: 1, purpose: "x" }] }).message, /to after from/);
  assert.match(styleProblem({ ...locked, by: "you", quote: "yes" }).message, /style.waived is why/);
  // A style without by is merged into the saved one: one font size changes, the rest stays.
  const resized = briefChanges({ ...confirmed, style: saved }, { fields: { style: { fonts: { caption: { size: 60 } }, wants: ["flash"] } } }).style;
  assert.deepEqual([resized.fonts.caption, resized.spine.length, resized.avoids, resized.wants, resized.by], [{ family: "JetBrains Mono", size: 60 }, 1, [], ["flash"], "guessed"]);
  assert.throws(() => briefChanges({ ...confirmed, style: { ...saved, by: "you", quote: "yes" } }, { fields: { style: { fonts: { caption: { size: 60 } } } } }), /style is the person's/);
  // With by too it merges (an agent that resends only spine + signatures keeps the lock): a retimed
  // spine keeps the idea, fonts and waiver; another idea drops the waiver and the save says so.
  const lockedBrief = { ...confirmed, style: { ...IDEA_BIBLE, waived: "your call" } };
  const retimed = briefChanges(lockedBrief, { fields: { style: { spine: IDEA_BIBLE.spine.map((beat) => ({ ...beat, to: beat.to - 1 })), signatures: IDEA_BIBLE.signatures, by: "guessed" } } });
  assert.deepEqual([directionLock(retimed.style, lockedBrief), retimed.style.idea, retimed.lapsed], ["locked", IDEA_BIBLE.idea, undefined]);
  const pivot = briefChanges(lockedBrief, { fields: { style: { idea: "the deck builds itself" } } });
  assert.deepEqual([pivot.style.waived, pivot.lapsed], [undefined, "the waiver went: idea changed; waive again with a reason, or play it back"]);
  assert.throws(() => briefChanges(lockedBrief, { fields: { style: { by: "you" } } }), /needs quote/);
});

test("notes brief saves a style spec; check follows it and shows the techniques; library lists the vocabulary", async () => {
  const made = await agent("project", { action: "create", id: "styled", name: "styled", width: 1920, height: 1080, duration: 6 });
  assert.equal(made.isError, undefined, made.text);
  const words = (id, y, start) => [{ op: "add_layer", layerType: "text", properties: { id, name: id, text: `say it word by word ${id}`, x: 200, y, fontSize: 72 } },
    { op: "add_animation", layerId: id, animation: { kind: "in", start, duration: 0.8, from: { opacity: 0 }, to: { opacity: 1 }, unit: "words", stagger: 0.1 } }];
  const edited = await agent("edit", { project: "styled", ops: [...words("one", 100, 0.2), ...words("two", 400, 1.2), ...words("three", 700, 2.2)] });
  assert.equal(edited.isError, undefined, edited.text);

  const before = await agent("check", { project: "styled", pixels: false });
  assert.match(before.text, /\ntechniques: type-words 3.* · style: kino default/);
  assert.match(before.text, /W word_by_word/);
  assert.equal(before.data.techniques["type-words"], 3);

  const refused = await agent("notes", { project: "styled", action: "brief", fields: { style: { wants: ["type-word"], by: "guessed" } } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /closest is type-words/);

  const saved = await agent("notes", { project: "styled", action: "brief", fields: { style: REFERENCE_SPEC } });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /brief r1 saved: style \(guessed\)/);
  assert.match(saved.text, /style: wants type-words, dissolve · avoids beat-kick \(1 line, guessed; dissolve not backed by a ref or your words\)/);

  const after = await agent("check", { project: "styled", pixels: false });
  assert.doesNotMatch(after.text, /W word_by_word/);
  assert.match(after.text, /style: spec/);
  assert.match(after.text, /note: word_by_word is off: the style spec wants type-words\./);
  assert.match(after.text, /note: style spec: dissolve is guessed/);
  // dissolve is wanted but guessed: it asks for nothing (style_wanted reads backed wants only).
  assert.doesNotMatch(after.text, /W style_wanted/);
  const read = await agent("notes", { project: "styled", action: "brief" });
  assert.match(read.text, /style: wants type-words, dissolve/);

  const listing = await agent("library", { topic: "techniques" });
  assert.match(listing.text, /^transition: cut, match-cut\*, dissolve/);
  assert.ok(listing.text.length < 1600, `the listing stays small (${listing.text.length} characters)`);
  const one = await agent("library", { topic: "techniques", name: "slow-push" });
  assert.match(one.text, /^slow-push \(camera\): /);
  const wrong = await agent("library", { topic: "techniques", name: "slowpush" });
  assert.equal(wrong.isError, true);
});

test("the dashboard summary carries the spec without kino's bookkeeping", () => {
  const state = { brief: { ...emptyBrief(), rev: 1, style: { ...REFERENCE_SPEC, rev: 1, client: "claude-code", at: "2026-10-26T00:00:00.000Z" } } };
  assert.deepEqual(briefSummary(state).style, REFERENCE_SPEC);
  assert.equal(Object.hasOwn(briefSummary({ brief: emptyBrief() }), "style"), false);
});
