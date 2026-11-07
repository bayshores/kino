import test from "node:test";
import assert from "node:assert/strict";
import { bidiTextLine, prepareTextBidi } from "./textBidi.js";

const visual = (line) => [...line.parts].sort((a, b) => a.visualOrder - b.visualOrder)
  .map((part) => part.display).join("");

test("paragraph direction, numbers and mirrored brackets follow mixed logical text", () => {
  for (const [text, direction, expected] of [
    ["אבג", "rtl", "גבא"],
    ["abc אבג 123", "ltr", "abc 123 גבא"],
    ["אבג abc 123", "rtl", "abc 123 גבא"],
    ["עברית (123) abc", "rtl", "abc (123) תירבע"],
  ]) {
    const line = bidiTextLine(prepareTextBidi(text));
    assert.equal(line.direction, direction, text);
    assert.equal(visual(line), expected, text);
  }
});

test("wrapped lines retain their paragraph base and reset their own trailing whitespace", () => {
  const context = prepareTextBidi("אבג abc xyz");
  const line = bidiTextLine(context, 4, 8);
  assert.equal(line.direction, "rtl");
  assert.equal(line.text, "abc ");
  assert.equal(visual(line), " abc");
  assert.deepEqual(line.parts.map((part) => part.level), [2, 2, 2, 1]);
  assert.equal(bidiTextLine(prepareTextBidi("abc\nאבג"), 4, 7).direction, "rtl");
  assert.equal(bidiTextLine(prepareTextBidi("אבג\n"), 4, 4).direction, "ltr");
});

test("supplementary scalars and emoji sequences retain complete source graphemes", () => {
  const rtl = bidiTextLine(prepareTextBidi("𞤀 a"));
  assert.equal(rtl.direction, "rtl", "the supplementary Adlam letter is a strong RTL character");
  assert.equal(visual(rtl), "a 𞤀");
  const text = "😀 👩‍👦 🇺🇸 1️⃣ 👍🏽 אב";
  const line = bidiTextLine(prepareTextBidi(text));
  assert.equal(line.direction, "ltr", "regional-indicator flag characters have Unicode bidi class L");
  assert.equal(bidiTextLine(prepareTextBidi("😀 👩‍👦 1️⃣ 👍🏽 אב")).direction, "rtl",
    "neutral emoji and a numeric keycap do not choose the first strong direction");
  assert.deepEqual(line.parts.filter((part) => !/^\s$/u.test(part.text)).map((part) => part.text),
    ["😀", "👩‍👦", "🇺🇸", "1️⃣", "👍🏽", "א", "ב"]);
  for (const part of line.parts) assert.equal(text.slice(part.start, part.end), part.text);
  assert.ok(line.parts.at(-1).visualOrder < line.parts.at(-2).visualOrder);
});

test("isolates do not choose the enclosing paragraph direction and combining marks stay with their base", () => {
  const line = bidiTextLine(prepareTextBidi("\u2067אב\u2069 a"));
  assert.equal(line.direction, "ltr");
  assert.equal(visual(line).replace(/[\u2067\u2069]/gu, ""), "בא a");
  const marked = bidiTextLine(prepareTextBidi("אבָג"));
  assert.equal(visual(marked), "גבָא");
  assert.deepEqual(marked.parts.map((part) => part.text), ["א", "בָ", "ג"]);
});

test("same-direction Arabic and Hebrew keep distinct script runs", () => {
  const line = bidiTextLine(prepareTextBidi("عربي עברית"));
  assert.ok(line.runs.some((run) => run.script === "Arabic" && run.direction === "rtl"));
  assert.ok(line.runs.some((run) => run.script === "Hebrew" && run.direction === "rtl"));
  assert.deepEqual(line.runs.map((run) => run.start), [...line.runs.map((run) => run.start)].sort((a, b) => a - b));
});
