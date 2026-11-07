import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTextStyleRanges,
  textStyleSegments,
  withEditedText,
  withTextStylePatches,
  withTextStyleRange,
  withWholeTextStyle,
} from "./textStyleRanges.js";

const fontSource = "/api/media/01234567-89ab-cdef-0123-456789abcdef.woff2";

function textLayer(text, overrides = {}) {
  return {
    type: "text",
    text,
    fontFamily: "Inter",
    fontSource,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 48,
    fill: "#171717",
    letterSpacing: 0,
    textStyleRanges: [],
    ...overrides,
  };
}

test("normalization drops empty spans and styles, and merges equal adjacent overrides", () => {
  assert.deepEqual(
    normalizeTextStyleRanges("abcdef", [
      { start: 0, end: 0, style: { fill: "#ffffff" } },
      { start: 1, end: 2, style: {} },
      { start: 2, end: 4, style: { fontWeight: 700, fill: "#ff0000" } },
      { start: 4, end: 6, style: { fill: "#ff0000", fontWeight: 700 } },
    ]),
    [{ start: 2, end: 6, style: { fontWeight: 700, fill: "#ff0000" } }],
  );
  assert.equal(normalizeTextStyleRanges("plain", undefined), undefined);
  assert.deepEqual(normalizeTextStyleRanges("plain", []), []);
});

test("normalization rejects malformed, unknown, unordered, overlapping and out-of-range spans", () => {
  assert.throws(() => normalizeTextStyleRanges("a", null), /must be an array/u);
  assert.throws(() => normalizeTextStyleRanges("a", [null]), /must be an object/u);
  assert.throws(() => normalizeTextStyleRanges("a", [{ start: 0, end: 1, style: {}, id: "x" }]), /supported range field/u);
  assert.throws(() => normalizeTextStyleRanges("a", [{ start: 0, end: 1, style: { color: "red" } }]), /supported text style field/u);
  assert.throws(() => normalizeTextStyleRanges("abc", [
    { start: 2, end: 3, style: { fontWeight: 700 } },
    { start: 0, end: 1, style: { fontWeight: 700 } },
  ]), /sorted/u);
  assert.throws(() => normalizeTextStyleRanges("abc", [
    { start: 0, end: 2, style: { fontWeight: 700 } },
    { start: 1, end: 3, style: { fill: "#ffffff" } },
  ]), /overlap/u);
  assert.throws(() => normalizeTextStyleRanges("abc", [{ start: 0, end: 4, style: {} }]), /0 to 3/u);
});

test("normalization keeps UTF-16 offsets on grapheme boundaries for emoji and combining marks", () => {
  assert.throws(() => normalizeTextStyleRanges("A😀B", [
    { start: 2, end: 3, style: { fill: "#ffffff" } },
  ]), /inside a grapheme/u);
  assert.throws(() => normalizeTextStyleRanges("e\u0301", [
    { start: 1, end: 2, style: { fontWeight: 700 } },
  ]), /inside a grapheme/u);
  assert.deepEqual(normalizeTextStyleRanges("A😀B", [
    { start: 1, end: 3, style: { fontWeight: 700 } },
  ]), [{ start: 1, end: 3, style: { fontWeight: 700 } }]);
});

test("normalization enforces the range cap and validates paint values", () => {
  const oversized = Array.from({ length: 2_049 }, () => ({ start: 0, end: 0, style: {} }));
  assert.throws(() => normalizeTextStyleRanges("", oversized), /2048/u);
  assert.throws(() => normalizeTextStyleRanges("a", [
    { start: 0, end: 1, style: { fill: "red" } },
  ]), /hex color/u);
  assert.throws(() => normalizeTextStyleRanges("a", [
    { start: 0, end: 1, style: { fill: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }] } } },
  ]), /at least two color stops/u);
  assert.deepEqual(normalizeTextStyleRanges("ab", [
    { start: 0, end: 2, style: { fill: { type: "linear", angle: 45, stops: [
      { offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" },
    ] } } },
  ])[0].style.fill.type, "linear");
});

test("range edits preserve unrelated overrides, split at selection edges and do not mutate", () => {
  const source = textLayer("abcdef", {
    textStyleRanges: [{ start: 0, end: 4, style: { fill: "#ff0000", fontWeight: 700 } }],
  });
  const changed = withTextStyleRange(source, 2, 5, { letterSpacing: 10 });

  assert.deepEqual(changed.textStyleRanges, [
    { start: 0, end: 2, style: { fontWeight: 700, fill: "#ff0000" } },
    { start: 2, end: 4, style: { fontWeight: 700, fill: "#ff0000", letterSpacing: 10 } },
    { start: 4, end: 5, style: { letterSpacing: 10 } },
  ]);
  assert.deepEqual(source.textStyleRanges, [
    { start: 0, end: 4, style: { fill: "#ff0000", fontWeight: 700 } },
  ]);
  const cleared = withTextStyleRange(changed, 2, 4, { fontWeight: undefined });
  assert.deepEqual(cleared.textStyleRanges, [
    { start: 0, end: 2, style: { fontWeight: 700, fill: "#ff0000" } },
    { start: 2, end: 4, style: { fill: "#ff0000", letterSpacing: 10 } },
    { start: 4, end: 5, style: { letterSpacing: 10 } },
  ]);
});

test("batched range edits match sequential valid edits and preserve source immutability", () => {
  const source = textLayer("abcdefghij", {
    textStyleRanges: [
      { start: 1, end: 5, style: { fontWeight: 700, fontSource, fill: "#ff0000" } },
      { start: 7, end: 9, style: { letterSpacing: 4 } },
    ],
  });
  const patches = [
    { start: 0, end: 2, style: { fontWeight: 500 } },
    { start: 4, end: 6, style: { letterSpacing: 8 } },
    { start: 6, end: 8, style: { fill: "#0000ff" } },
  ];
  const before = JSON.stringify(source);
  const batched = withTextStylePatches(source, patches);
  const sequential = patches.reduce((current, patch) =>
    withTextStyleRange(current, patch.start, patch.end, patch.style), source);

  assert.deepEqual(batched, sequential);
  assert.equal(batched.textStyleRanges[0].style.fontSource, undefined, "font edits clear the old pinned source");
  assert.equal(JSON.stringify(source), before);
});

test("batched range edits refuse overlap, bad grapheme boundaries and excessive patches atomically", () => {
  const source = textLayer("abc", {
    textStyleRanges: [{ start: 0, end: 1, style: { fill: "#ff0000" } }],
  });
  const before = JSON.stringify(source);
  assert.throws(() => withTextStylePatches(source, [
    { start: 0, end: 2, style: { fontWeight: 700 } },
    { start: 1, end: 3, style: { fill: "#0000ff" } },
  ]), /overlap/u);
  assert.equal(JSON.stringify(source), before);

  const graphemeLayer = textLayer("A😀B");
  const graphemeBefore = JSON.stringify(graphemeLayer);
  assert.throws(() => withTextStylePatches(graphemeLayer, [
    { start: 2, end: 3, style: { fill: "#00ff00" } },
  ]), /inside a grapheme/u);
  assert.equal(JSON.stringify(graphemeLayer), graphemeBefore);
  const excessive = Array.from({ length: 4_098 }, () => ({ start: 0, end: 0, style: {} }));
  assert.throws(() => withTextStylePatches(source, excessive), /4097/u);
});

test("batched range edits sweep two thousand runs over long text deterministically", () => {
  const text = "a".repeat(200_000);
  const red = Array.from({ length: 2_000 }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    style: { fill: "#ff0000" },
  }));
  const fillGaps = Array.from({ length: 1_999 }, (_, index) => ({
    start: index * 2 + 1,
    end: index * 2 + 2,
    style: { fill: "#ff0000" },
  }));
  const source = textLayer(text, { textStyleRanges: red });
  const changed = withTextStylePatches(source, fillGaps);

  assert.deepEqual(changed.textStyleRanges, [{ start: 0, end: 3_999, style: { fill: "#ff0000" } }]);
  assert.equal(source.textStyleRanges.length, 2_000);
  assert.equal(source.textStyleRanges[0].end, 1);
  assert.equal(source.textStyleRanges.at(-1).start, 3_998);
});

test("whole-layer styling removes matching range fields and retains explicit empty ranges", () => {
  const source = textLayer("Hi", {
    textStyleRanges: [{ start: 0, end: 2, style: { fontWeight: 700, fill: "#00ff00" } }],
  });
  const changed = withWholeTextStyle(source, { fontWeight: 500 });
  assert.equal(changed.fontWeight, 500);
  assert.deepEqual(changed.textStyleRanges, [{ start: 0, end: 2, style: { fill: "#00ff00" } }]);
  const cleared = withWholeTextStyle(textLayer("Hi", {
    textStyleRanges: [{ start: 0, end: 2, style: { fontWeight: 700 } }],
  }), { fontWeight: 400 });
  assert.deepEqual(cleared.textStyleRanges, []);
  assert.equal(Object.hasOwn(withWholeTextStyle({ text: "Hi", type: "text" }, { fontWeight: 700 }), "textStyleRanges"), false);
});

test("text edits map insertions, deletions and start insertion by prior grapheme style", () => {
  const source = textLayer("abcde", {
    textStyleRanges: [{ start: 1, end: 4, style: { fontWeight: 700 } }],
  });
  const deleted = withEditedText(source, "abde");
  assert.deepEqual(deleted.textStyleRanges, [{ start: 1, end: 3, style: { fontWeight: 700 } }]);
  const inserted = withEditedText(source, "abXcde");
  assert.deepEqual(inserted.textStyleRanges, [{ start: 1, end: 5, style: { fontWeight: 700 } }]);

  const firstStyled = textLayer("ab", {
    textStyleRanges: [{ start: 0, end: 1, style: { fill: "#ff0000" } }],
  });
  assert.deepEqual(withEditedText(firstStyled, "Xab").textStyleRanges, [
    { start: 0, end: 2, style: { fill: "#ff0000" } },
  ]);
  const plain = withEditedText({ type: "text", text: "a" }, "ab");
  assert.equal(Object.hasOwn(plain, "textStyleRanges"), false);
  assert.deepEqual(withEditedText(textLayer("a", { textStyleRanges: [] }), "ab").textStyleRanges, []);
});

test("text edits preserve combining and emoji styles in raw offsets, regardless of display casing", () => {
  const source = textLayer("e\u0301😀X", {
    textCase: "upper",
    textStyleRanges: [
      { start: 0, end: 2, style: { fill: "#ff0000" } },
      { start: 2, end: 4, style: { fontStyle: "italic" } },
    ],
  });
  const changed = withEditedText(source, "e\u0301\u0302😀X");
  assert.equal(changed.text, "e\u0301\u0302😀X");
  assert.deepEqual(changed.textStyleRanges, [
    { start: 0, end: 3, style: { fill: "#ff0000" } },
    { start: 3, end: 5, style: { fontStyle: "italic" } },
  ]);
  assert.deepEqual(textStyleSegments(textLayer("ß", {
    textCase: "upper", textStyleRanges: [{ start: 0, end: 1, style: { fill: "#00ff00" } }],
  })).map(({ start, end }) => [start, end]), [[0, 1]]);
});
