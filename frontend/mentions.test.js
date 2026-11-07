import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MENTIONS,
  activeMention,
  findMentions,
  insertMention,
  matchMentionNames,
  mentionCandidates,
  mentionSegments,
  mentionableName,
  mentionsInText,
  mentionsName,
  rememberMentionNames,
} from "./mentions.js";

test("mentionable names are trimmed, and empty, Guest, too long or control-character names are left out", () => {
  assert.equal(mentionableName("  Ana Lima "), "Ana Lima");
  assert.equal(mentionableName(""), "");
  assert.equal(mentionableName("   "), "");
  assert.equal(mentionableName("Guest"), "");
  assert.equal(mentionableName("guest"), "");
  assert.equal(mentionableName("x".repeat(101)), "");
  assert.equal(mentionableName("Bad\nName"), "");
  assert.equal(mentionableName(42), "");
});

test("the @ list offers people in the file first, then past comment authors newest first, each once", () => {
  const names = mentionCandidates({
    people: [{ id: "p1", name: "Guest" }, { id: "p2", name: "Ana" }, { id: "p3", name: "  " }, { id: "p4", name: "bo" }],
    comments: [
      { id: "c1", author: "Old Author", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", author: "Bo", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "c3", author: "New Author", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "c4", author: "", createdAt: "2026-01-04T00:00:00.000Z" },
      { id: "c5", author: "ANA", createdAt: "2026-01-05T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(names, ["Ana", "bo", "New Author", "Old Author"]);
  assert.deepEqual(mentionCandidates(), []);
});

test("the mention being typed is found at the caret, and email addresses and line breaks end it", () => {
  assert.deepEqual(activeMention("Hi @An", 6), { start: 3, end: 6, query: "An" });
  assert.deepEqual(activeMention("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(activeMention("Hi @Ana Li", 10), { start: 3, end: 10, query: "Ana Li" });
  // The caret before the @, or a word character right before the @.
  assert.equal(activeMention("Hi @An", 2), null);
  assert.equal(activeMention("ana@example", 11), null);
  // A space straight after the @, or a line break in the query.
  assert.equal(activeMention("@ hello", 7), null);
  assert.equal(activeMention("@Ana\nnext", 9), null);
  assert.equal(activeMention("No mention", 10), null);
  assert.equal(activeMention(`@${"x".repeat(101)}`, 102), null);
  // A caret past the end counts as the end.
  assert.deepEqual(activeMention("(@Bo", 99), { start: 1, end: 4, query: "Bo" });
});

test("names that start with the query come first, then names with a later word that does", () => {
  const names = ["Ana Lima", "Bo", "Lisa", "Carl Li", "Ali"];
  assert.deepEqual(matchMentionNames(names, "li"), ["Lisa", "Ana Lima", "Carl Li"]);
  assert.deepEqual(matchMentionNames(names, "LI"), ["Lisa", "Ana Lima", "Carl Li"]);
  assert.deepEqual(matchMentionNames(names, "ana l"), ["Ana Lima"]);
  assert.deepEqual(matchMentionNames(names, ""), names);
  assert.deepEqual(matchMentionNames(names, "", 2), ["Ana Lima", "Bo"]);
  assert.deepEqual(matchMentionNames(names, "zz"), []);
});

test("a chosen name replaces the typed mention and the caret goes after its space", () => {
  const text = "Ping @an please";
  const mention = activeMention(text, 8);
  assert.deepEqual(insertMention(text, mention, "Ana Lima"), { text: "Ping @Ana Lima please", caret: 15 });
  const atEnd = activeMention("Hi @b", 5);
  assert.deepEqual(insertMention("Hi @b", atEnd, "Bo"), { text: "Hi @Bo ", caret: 7 });
});

test("mentions are found case-insensitively, the longest name first, and only standing on their own", () => {
  const names = ["Ana", "Ana Lima", "Bo"];
  assert.deepEqual(findMentions("@ana lima and @Bo.", names), [
    { start: 0, end: 9, name: "Ana Lima" },
    { start: 14, end: 17, name: "Bo" },
  ]);
  assert.deepEqual(findMentions("@Ana, see this", names), [{ start: 0, end: 4, name: "Ana" }]);
  // No mention inside an email address or a longer word.
  assert.deepEqual(findMentions("mail bo@bo.com or @Bob or @Anaïs", names), []);
  assert.deepEqual(findMentions("@Bo_x", names), []);
  assert.deepEqual(findMentions("@Bo", []), []);
  assert.deepEqual(findMentions("@Guest hi", ["Guest"]), []);
});

test("text splits into plain pieces and @Name pieces that join back to the same text", () => {
  const text = "Hey @ana, and @Bo!";
  const parts = mentionSegments(text, ["Ana", "Bo"]);
  assert.deepEqual(parts, [
    { text: "Hey " },
    { text: "@ana", mention: "Ana" },
    { text: ", and " },
    { text: "@Bo", mention: "Bo" },
    { text: "!" },
  ]);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(mentionSegments("", ["Ana"]), [{ text: "" }]);
  assert.deepEqual(mentionSegments("@Ana", ["Ana"]), [{ text: "@Ana", mention: "Ana" }]);
});

test("only names that appear as @Name are saved, once each, at most 20", () => {
  assert.deepEqual(mentionsInText("@Bo and @ana, again @BO", ["Ana", "Bo", "Cy"]), ["Bo", "Ana"]);
  assert.deepEqual(mentionsInText("Bo and Ana", ["Ana", "Bo"]), []);
  const many = Array.from({ length: 25 }, (_, index) => `Person${index}`);
  const text = many.map((name) => `@${name}`).join(" ");
  assert.equal(mentionsInText(text, many).length, MAX_MENTIONS);
});

test("a comment mentions a name only when its list has the name and its text has @Name", () => {
  const comment = { text: "Thanks @ana lima!", mentions: ["Ana Lima"] };
  assert.equal(mentionsName(comment, "Ana Lima"), true);
  assert.equal(mentionsName(comment, " ana lima "), true);
  assert.equal(mentionsName(comment, "Ana"), false);
  // In the list but not in the text (a list sent by another client), or in the text but not the list.
  assert.equal(mentionsName({ text: "Thanks", mentions: ["Ana Lima"] }, "Ana Lima"), false);
  assert.equal(mentionsName({ text: "Thanks @Ana Lima", mentions: [] }, "Ana Lima"), false);
  assert.equal(mentionsName({ text: "Thanks @Ana Lima" }, "Ana Lima"), false);
  assert.equal(mentionsName(comment, ""), false);
  assert.equal(mentionsName({ text: "@Guest", mentions: ["Guest"] }, "Guest"), false);
});

test("a name the @ list offered earlier is still saved as a mention after that person leaves the file", () => {
  // Review finding: Carol had the file open but never commented. Ann picked "@Carol" from the
  // @ list, then Carol closed the file before Ann posted, so the reply was saved without the mention.
  const whileCarolIsHere = mentionCandidates({ people: [{ name: "Carol" }, { name: "Ann" }], comments: [] });
  const afterCarolLeft = mentionCandidates({ people: [{ name: "Ann" }], comments: [] });
  assert.deepEqual(mentionsInText("@Carol can you check?", afterCarolLeft), [], "the current list alone loses her");

  let remembered = rememberMentionNames([], whileCarolIsHere);
  remembered = rememberMentionNames(remembered, afterCarolLeft);
  assert.deepEqual(remembered, ["Ann", "Carol"], "current names first, then earlier ones, each once");
  assert.deepEqual(mentionsInText("@Carol can you check?", remembered), ["Carol"]);

  // A renamed spelling replaces the old one (letter case is ignored), names that cannot be
  // mentioned are left out, and the list stays bounded.
  assert.deepEqual(rememberMentionNames(["carol", "Ann"], ["Carol", "Guest", " "]), ["Carol", "Ann"]);
  const many = Array.from({ length: 300 }, (_, index) => `Person ${index}`);
  const bounded = rememberMentionNames(many.slice(0, 250), many.slice(250));
  assert.equal(bounded.length, 200);
  assert.deepEqual(bounded.slice(0, 50), many.slice(250), "the newest names are kept first");
});
