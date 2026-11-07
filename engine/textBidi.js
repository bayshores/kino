import bidiFactory from "bidi-js";
import { getScript } from "unicode-properties";
import { textGraphemes } from "./textSource.js";

const bidi = bidiFactory();
const representatives = {
  L: "A", R: "א", AL: "ا", EN: "0", AN: "٠", ES: "+", ET: "$", CS: ",",
  NSM: "\u0300", BN: "\u00ad", ON: "\ufffc", B: "\n", S: "\t", WS: " ",
  LRE: "\u202a", RLE: "\u202b", PDF: "\u202c", LRO: "\u202d", RLO: "\u202e",
  LRI: "\u2066", RLI: "\u2067", FSI: "\u2068", PDI: "\u2069",
};
const trailingTypes = new Set(["S", "WS", "B", "LRI", "RLI", "FSI", "PDI", "BN", "RLE", "LRE", "RLO", "LRO", "PDF"]);
const neutralScripts = new Set(["Common", "Inherited", "Unknown"]);

function lowerBound(items, offset) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Resolve paragraph levels once, before line wrapping or style/font splitting. */
export function prepareTextBidi(value) {
  const text = String(value);
  let offset = 0;
  const characters = [...text].map((character) => {
    const start = offset;
    offset += character.length;
    const type = bidi.getBidiCharTypeName(character);
    // bidi-js' algorithm indexes UTF-16 units. Give it one BMP representative
    // with the same bidi class for each supplementary scalar, then map back to
    // the original string. BMP brackets/control characters remain unchanged.
    return { text: character, start, end: offset, type,
      encoded: character.length === 1 ? character : representatives[type] };
  });
  const encoded = characters.map((character) => character.encoded).join("");
  return { text, characters, encoded, embedding: bidi.getEmbeddingLevels(encoded, "auto") };
}

/** Font preparation also needs mirrored counterparts, before subset downloads. */
export function mirroredTextCharacters(text) {
  const context = prepareTextBidi(text);
  return context.characters.map((character, index) => context.embedding.levels[index] & 1
    ? bidi.getMirroredCharacter(character.text) ?? character.text : character.text).join("");
}

/** A wrapped line retains paragraph levels, logical spans, and whole graphemes. */
export function bidiTextLine(context, start = 0, end = context.text.length) {
  const first = lowerBound(context.characters, start);
  const last = lowerBound(context.characters, end);
  const characters = context.characters.slice(first, last);
  const paragraph = context.embedding.paragraphs.find((item) => item.start <= first && item.end >= first);
  const baseLevel = paragraph?.level ?? 0;
  const text = context.text.slice(start, end);
  const levels = context.embedding.levels.slice(first, last);
  // Expose the same L1 trailing-whitespace reset to shaping/caret consumers.
  // Use a line-local array when calling bidi-js: its reordering implementation
  // assumes zero-based indices while resetting the line's trailing levels.
  for (let index = characters.length - 1; index >= 0 && trailingTypes.has(characters[index].type); index--)
    levels[index] = baseLevel;
  const encoded = context.encoded.slice(first, last);
  const lineEmbedding = { levels, paragraphs: [{ start: 0, end: characters.length - 1, level: baseLevel }] };
  const order = bidi.getReorderedIndices(encoded, lineEmbedding);
  const ranks = new Uint32Array(order.length);
  order.forEach((logical, visual) => { ranks[logical] = visual; });
  const parts = textGraphemes(text).map((part) => {
    const from = lowerBound(characters, start + part.start);
    const to = lowerBound(characters, start + part.end);
    const level = levels[from] ?? baseLevel;
    const values = characters.slice(from, to);
    const display = values.map((character) => level & 1
      ? bidi.getMirroredCharacter(character.text) ?? character.text : character.text).join("");
    // Unicode's mirrored pairs have equal UTF-16 length. Keep that invariant
    // explicit so a future data update cannot silently corrupt source spans.
    if (display.length !== part.text.length) throw new Error("A mirrored character changed its source length.");
    const script = values.map((character) => getScript(character.text.codePointAt(0)))
      .find((value) => !neutralScripts.has(value)) ?? null;
    let visualOrder = Infinity;
    for (let index = from; index < to; index++) visualOrder = Math.min(visualOrder, ranks[index]);
    return { ...part, display, level, direction: level & 1 ? "rtl" : "ltr", script,
      mirrored: display !== part.text, visualOrder };
  });
  // Common punctuation follows its surrounding script inside a level run.
  // The font's public layout API maps each resulting single-script string to
  // its OpenType script; no private Fontkit tables or shapers are imported.
  for (let firstPart = 0; firstPart < parts.length;) {
    let lastPart = firstPart + 1;
    while (lastPart < parts.length && parts[lastPart].level === parts[firstPart].level) lastPart++;
    let script = parts.slice(firstPart, lastPart).find((part) => part.script)?.script ?? "Common";
    for (let index = firstPart; index < lastPart; index++) {
      script = parts[index].script ?? script;
      parts[index].script = script;
    }
    firstPart = lastPart;
  }
  const runs = [];
  for (const part of parts) {
    const previous = runs.at(-1);
    if (previous && previous.level === part.level && previous.script === part.script && previous.mirrored === part.mirrored)
      previous.end = part.end;
    else runs.push({ start: part.start, end: part.end, level: part.level, direction: part.direction,
      script: part.script, mirrored: part.mirrored });
  }
  return { text, display: parts.map((part) => part.display).join(""), parts, runs,
    direction: baseLevel & 1 ? "rtl" : "ltr", baseLevel,
    visualOrder(from, to) {
      const left = parts[lowerBound(parts, from)];
      const right = parts[lowerBound(parts, Math.max(from, to - 1))];
      return Math.min(left?.visualOrder ?? 0, right?.visualOrder ?? 0);
    } };
}
