// Caption pages under common timed-text subtitle limits (captionPaging.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SUBTITLE_LIMITS, captionCharacters, pageEvents, pageProblems, pageScript, pageWords, readingSeconds, splitIntoPages, wrapCaption } from "./captionPaging.js";

const lines = (page) => page.split("\n");

test("the subtitle limits: 42 characters, 2 lines, 20 a second, 5/6 s to 7 s, 2 frames apart", () => {
  assert.deepEqual({ ...SUBTITLE_LIMITS }, { charactersPerLine: 42, lines: 2, charactersPerSecond: 20, minSeconds: 5 / 6, maxSeconds: 7, gapFrames: 2, closeGapsUnderSeconds: 0.5 });
  assert.equal(captionCharacters("  two   words "), 9);
  assert.equal(readingSeconds("hi"), 5 / 6);
  assert.equal(readingSeconds("x".repeat(60)), 3);
});

test("short text stays on one line; long text breaks into two balanced lines, not after a weak word", () => {
  assert.deepEqual(wrapCaption("A short caption".split(" ")), ["A short caption"]);
  const wrapped = wrapCaption("We kept every frame of the story and cut the rest of it away".split(" "));
  assert.equal(wrapped.length, 2);
  for (const line of wrapped) assert.ok(line.length <= 42, line);
  assert.ok(!/ (the|of|and|a|to)$/i.test(wrapped[0]), `top line ends on a weak word: ${wrapped[0]}`);
  assert.equal(wrapCaption(Array(30).fill("word")), null);
});

test("pages hold at most two lines of 42 characters and prefer to end at a clause break", () => {
  const text = "The engine reads your captions, splits them into pages, and times each page so it can be read. Nothing is sent to any outside service, ever.";
  const pages = splitIntoPages(text);
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(lines(page).length <= 2);
    for (const line of lines(page)) assert.ok(line.length <= 42, line);
  }
  assert.equal(pages.join(" ").replace(/\n/g, " "), text);
  assert.match(pages[0], /[,.]$/);
  // A measured width limit narrower than 42 characters is also kept.
  const narrow = splitIntoPages(text, { fits: (line) => line.length <= 20 });
  for (const page of narrow) for (const line of lines(page)) assert.ok(line.length <= 20, line);
  assert.throws(() => splitIntoPages("x".repeat(50)), /too wide/);
});

test("file events keep their times; overlaps are trimmed to a 2-frame gap", () => {
  const { pages, changes } = pageEvents([
    { start: 1, end: 3.5, text: "First" },
    { start: 3.4, end: 5, text: "Second" },
  ], { fps: 25 });
  assert.equal(pages[0].start, 1);
  assert.equal(pages[0].end, 3.32);
  assert.equal(pages[1].start, 3.4);
  assert.equal(changes.trimmed, 1);
  assert.deepEqual(pageProblems(pages, { fps: 25 }).gap, []);
});

test("timing fit lengthens pages too short to read and closes small gaps", () => {
  const events = [{ start: 1, end: 1.3, text: "Hi" }, { start: 2.5, end: 2.9, text: "A slightly longer caption here." }, { start: 6, end: 7, text: "End" }];
  const source = pageEvents(events, { fps: 30 });
  assert.equal(pageProblems(source.pages).short.length, 2);
  const fit = pageEvents(events, { fps: 30, timing: "fit" });
  assert.ok(fit.changes.lengthened >= 2);
  const problems = pageProblems(fit.pages);
  assert.deepEqual([problems.short, problems.fast, problems.gap], [[], [], []]);
  assert.ok(fit.pages[0].end - fit.pages[0].start >= 5 / 6 - 0.001); // times are kept to the millisecond
});

test("an event too long for one page is split, sharing its time by length", () => {
  const text = "This caption line is far too long to fit on one page at all, so the engine has to split it into two pages that share the time.";
  const { pages, split } = pageEvents([{ start: 10, end: 16, text }], { fps: 30 });
  assert.equal(split, 1);
  assert.ok(pages.length >= 2);
  assert.equal(pages[0].start, 10);
  assert.equal(pages.at(-1).end, 16);
  for (let index = 1; index < pages.length; index += 1) assert.ok(pages[index].start - pages[index - 1].end >= 2 / 30 - 0.001);
});

test("a timed transcript pages at sentence ends and pauses", () => {
  const words = [
    ["Ship", 0, 0.3], ["it", 0.3, 0.5], ["today.", 0.5, 1], ["Then", 1.1, 1.4], ["rest", 1.4, 1.8],
    ["after", 3, 3.3], ["the", 3.3, 3.4], ["pause.", 3.4, 4],
  ].map(([text, start, end]) => ({ text, start, end }));
  const { pages } = pageWords(words, { fps: 30 });
  assert.deepEqual(pages.map((page) => page.text), ["Ship it today.", "Then rest", "after the pause."]);
  assert.equal(pages[2].start, 3);
  assert.deepEqual(pages[0].words.map((word) => word.text), ["Ship", "it", "today."]);
  assert.throws(() => pageWords([{ text: "two words", start: 0, end: 1 }]), /one word/);
  assert.throws(() => pageWords([{ text: "x", start: 2, end: 1 }]), /start and end/);
});

test("plain text is timed by reading speed within its span, or refused when it cannot be read", () => {
  const { pages } = pageScript("First sentence here.\n\nSecond one is a little longer than that.", { start: 1, end: 9, fps: 30 });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].start, 1);
  assert.ok(pages[1].end <= 9);
  assert.deepEqual(Object.values(pageProblems(pages)).flat(), []);
  assert.throws(() => pageScript("x ".repeat(200), { start: 0, end: 2 }), /need .*s at 20 characters a second/);
});
