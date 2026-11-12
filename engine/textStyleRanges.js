import { normalizeFill } from "./paintValidation.js";
import { LETTER_SPACING_LIMIT } from "./letterSpacing.js";

export const TEXT_STYLE_KEYS = Object.freeze([
  "fontFamily",
  "fontSource",
  "fontWeight",
  "fontStyle",
  "fontSize",
  "fill",
  "letterSpacing",
]);

// Range-only keys: a letter can turn (degrees) or sit above or below the baseline (percent of its font
// size, up is positive). The layer has no such style (its own rotation turns the whole box).
export const RANGE_ONLY_KEYS = Object.freeze(["rotation", "baselineShift"]);
const ALL_RANGE_KEYS = Object.freeze([...TEXT_STYLE_KEYS, ...RANGE_ONLY_KEYS]);
const STYLE_KEY_SET = new Set(ALL_RANGE_KEYS);
const FONT_SOURCE_PATTERN =
  /^\/api\/(?:(?:media\/[a-f0-9-]{36})|(?:fonts\/[a-z0-9_-][a-z0-9._-]*))\.(?:ttf|otf|woff|woff2)$/iu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const REMOVE = Symbol("remove text style property");
const EMPTY_STYLE = Object.freeze({});

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) fail(path, "accessors are not allowed");
  return descriptor.value;
}

function recordKeys(value, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail(path, "symbol fields are not allowed");
  return keys;
}

function requireText(text, path = "text") {
  if (typeof text !== "string") fail(path, "must be text");
  return text;
}

function requireOffset(value, limit, path) {
  if (!Number.isInteger(value) || value < 0 || value > limit)
    fail(path, `must be an integer from 0 to ${limit}`);
  return value;
}

function requireNumber(value, min, max, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(path, `must be a finite number from ${min} to ${max}`);
  return value;
}

function validateFontSource(value, path) {
  if (typeof value !== "string") fail(path, "must be text");
  if (value.length > 512) fail(path, "cannot exceed 512 characters");
  if (value && (!FONT_SOURCE_PATTERN.test(value) || value.includes("..")))
    fail(path, "must be empty or a safe local font URL under /api/media or /api/fonts");
  return value;
}

function normalizeStyleValue(key, value, path) {
  switch (key) {
    case "fontFamily":
      if (typeof value !== "string") fail(path, "must be text");
      if (value.length > 256) fail(path, "cannot exceed 256 characters");
      return value;
    case "fontSource":
      return validateFontSource(value, path);
    case "fontWeight":
      return requireNumber(value, 1, 1_000, path);
    case "fontStyle":
      if (value !== "normal" && value !== "italic") fail(path, "must be normal or italic");
      return value;
    case "fontSize":
      return requireNumber(value, 0.1, 10_000, path);
    case "fill":
      return normalizeFill(value, path);
    case "letterSpacing":
      return requireNumber(value, -LETTER_SPACING_LIMIT, LETTER_SPACING_LIMIT, path);
    case "rotation":
      return requireNumber(value, -360, 360, path);
    case "baselineShift":
      return requireNumber(value, -200, 200, path);
    default:
      fail(path, "is not a supported text style field");
  }
}

function readStyle(style, path, { allowRemoval = false } = {}) {
  const keys = recordKeys(style, path);
  for (const key of keys) {
    if (!STYLE_KEY_SET.has(key)) fail(`${path}.${key}`, "is not a supported text style field");
  }
  const normalized = {};
  for (const key of ALL_RANGE_KEYS) {
    if (!Object.hasOwn(style, key)) continue;
    const value = ownValue(style, key, `${path}.${key}`);
    if (allowRemoval && value === undefined) normalized[key] = REMOVE;
    else normalized[key] = normalizeStyleValue(key, value, `${path}.${key}`);
  }
  return normalized;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return false;
}

function sameStyle(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function mergeAdjacent(ranges) {
  const merged = [];
  for (const range of ranges) {
    if (range.start === range.end || Object.keys(range.style).length === 0) continue;
    const previous = merged.at(-1);
    if (previous?.end === range.start && sameStyle(previous.style, range.style)) {
      previous.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end, style: range.style });
    }
  }
  if (merged.length > 2_048) fail("textStyleRanges", "cannot contain more than 2048 ranges");
  return merged;
}

function assertGraphemeBoundaries(text, ranges, path) {
  const targets = [...new Set(ranges.flatMap(({ start, end }) => [start, end]))]
    .sort((left, right) => left - right);
  let targetIndex = 0;
  const consume = (boundary) => {
    while (targets[targetIndex] === boundary) targetIndex += 1;
  };

  consume(0);
  for (const part of graphemeSegmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (targets[targetIndex] < end)
      fail(path, `range offset ${targets[targetIndex]} falls inside a grapheme`);
    consume(end);
  }
  if (targetIndex < targets.length && targets[targetIndex] !== text.length)
    fail(path, `range offset ${targets[targetIndex]} falls inside a grapheme`);
  consume(text.length);
  if (targetIndex < targets.length) fail(path, "contains an invalid text boundary");
}

function normalizeRangeArray(text, ranges, path, { validateBoundaries = true } = {}) {
  if (!Array.isArray(ranges)) fail(path, "must be an array");
  if (ranges.length > 2_048) fail(path, "cannot contain more than 2048 ranges");
  const keys = Reflect.ownKeys(ranges);
  if (keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= ranges.length)))
    fail(path, "arrays cannot have custom properties");

  const normalized = [];
  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < ranges.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(ranges, String(index));
    if (!descriptor || !("value" in descriptor)) fail(itemPath, "sparse arrays and accessors are not allowed");
    const range = descriptor.value;
    const rangeKeys = recordKeys(range, itemPath);
    for (const key of rangeKeys) {
      if (key !== "start" && key !== "end" && key !== "style")
        fail(`${itemPath}.${key}`, "is not a supported range field");
    }
    const start = requireOffset(ownValue(range, "start", `${itemPath}.start`), text.length, `${itemPath}.start`);
    const end = requireOffset(ownValue(range, "end", `${itemPath}.end`), text.length, `${itemPath}.end`);
    if (end < start) fail(itemPath, "end must be greater than or equal to start");
    if (start < previousStart) fail(path, "ranges must be sorted by start offset");
    if (start < previousEnd) fail(path, "ranges cannot overlap");
    const style = readStyle(ownValue(range, "style", `${itemPath}.style`), `${itemPath}.style`);
    normalized.push({ start, end, style });
    previousStart = start;
    previousEnd = end;
  }

  if (validateBoundaries) assertGraphemeBoundaries(text, normalized, path);
  return mergeAdjacent(normalized);
}

/** Validate and canonicalize raw UTF-16 grapheme style ranges. */
export function normalizeTextStyleRanges(text, ranges, path = "textStyleRanges") {
  requireText(text);
  if (ranges === undefined) return undefined;
  return normalizeRangeArray(text, ranges, path);
}

function layerText(layer) {
  if (!isRecord(layer)) throw new TypeError("A text layer is required.");
  return requireText(layer.text, "text");
}

function layerRanges(layer, text) {
  const ranges = layer.textStyleRanges;
  if (ranges === undefined) return [];
  return normalizeRangeArray(text, ranges, "textStyleRanges");
}

function rangeStyleAt(ranges, offset) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range && range.start <= offset && offset < range.end ? range.style : EMPTY_STYLE;
}

function effectiveStyle(layer, rangeStyle = EMPTY_STYLE) {
  const style = {};
  for (const key of TEXT_STYLE_KEYS) {
    if (Object.hasOwn(layer, key)) style[key] = layer[key];
  }
  Object.assign(style, rangeStyle);
  if ((Object.hasOwn(rangeStyle, "fontFamily") || Object.hasOwn(rangeStyle, "fontWeight") ||
       Object.hasOwn(rangeStyle, "fontStyle")) && !Object.hasOwn(rangeStyle, "fontSource")) {
    style.fontSource = "";
  }
  return style;
}

function requireInterval(text, start, end, path = "textStyleSegments") {
  requireOffset(start, text.length, `${path}.start`);
  requireOffset(end, text.length, `${path}.end`);
  if (end < start) fail(path, "end must be greater than or equal to start");
  assertGraphemeBoundaries(text, [{ start, end }], path);
}

/** Return contiguous effective-style spans, including the whole-layer style across gaps. */
export function textStyleSegments(layer, start = 0, end = layer?.text?.length, { preserveBoundaries = false, runtime = false } = {}) {
  const text = layerText(layer);
  if (end === undefined) end = text.length;
  requireInterval(text, start, end);
  if (start === end) return [];

  // Model validation canonicalizes saved ranges. A sampled animation retains
  // their boundaries and may overshoot a saved numeric limit; don't normalize
  // those transient values or merge formerly different paints at an endpoint.
  const ranges = runtime ? layer.textStyleRanges ?? [] : layerRanges(layer, text);
  const boundaries = [start, end];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    boundaries.push(Math.max(start, range.start), Math.min(end, range.end));
  }
  boundaries.sort((left, right) => left - right);

  const segments = [];
  let rangeIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const segmentStart = boundaries[index];
    const segmentEnd = boundaries[index + 1];
    if (segmentStart === segmentEnd) continue;
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= segmentStart) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const style = effectiveStyle(layer,
      range && range.start <= segmentStart && range.end >= segmentEnd ? range.style : EMPTY_STYLE);
    const previous = segments.at(-1);
    if (!preserveBoundaries && previous?.end === segmentStart && sameStyle(previous.style, style)) previous.end = segmentEnd;
    else segments.push({ start: segmentStart, end: segmentEnd, style,
      ...(preserveBoundaries ? { overrides: range && range.start <= segmentStart && range.end >= segmentEnd ? range.style : EMPTY_STYLE } : {}) });
  }
  return segments;
}

function patchRanges(text, ranges, start, end, patch) {
  if (start === end || Object.keys(patch).length === 0) return ranges;
  const changesFontFace = ["fontFamily", "fontWeight", "fontStyle"].some((key) => Object.hasOwn(patch, key));
  const suppliesFontSource = Object.hasOwn(patch, "fontSource") && patch.fontSource !== REMOVE;
  const output = [];
  const cuts = [start, end];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) {
      output.push(range);
      continue;
    }
    if (range.start < start) output.push({ start: range.start, end: start, style: range.style });
    if (range.end > end) output.push({ start: end, end: range.end, style: range.style });
    cuts.push(Math.max(start, range.start), Math.min(end, range.end));
  }
  cuts.sort((left, right) => left - right);
  const uniqueCuts = cuts.filter((value, index) => index === 0 || value !== cuts[index - 1]);
  let rangeIndex = 0;
  for (let index = 0; index < uniqueCuts.length - 1; index += 1) {
    const segmentStart = uniqueCuts[index];
    const segmentEnd = uniqueCuts[index + 1];
    if (segmentStart === segmentEnd) continue;
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= segmentStart) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const originalStyle = range && range.start <= segmentStart && range.end >= segmentEnd ? range.style : EMPTY_STYLE;
    const style = applyStylePatch(originalStyle, patch, changesFontFace, suppliesFontSource);
    if (Object.keys(style).length) output.push({ start: segmentStart, end: segmentEnd, style });
  }
  output.sort((left, right) => left.start - right.start);
  return mergeAdjacent(output);
}

function applyStylePatch(originalStyle, patch, changesFontFace, suppliesFontSource) {
  const style = { ...originalStyle };
  if (changesFontFace && !suppliesFontSource) delete style.fontSource;
  for (const key of ALL_RANGE_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    if (patch[key] === REMOVE) delete style[key];
    else style[key] = patch[key];
  }
  return style;
}

function normalizeTextStylePatches(text, patches, path = "textStylePatches") {
  if (!Array.isArray(patches)) fail(path, "must be an array");
  if (patches.length > 4_097) fail(path, "cannot contain more than 4097 patches");
  const keys = Reflect.ownKeys(patches);
  if (keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= patches.length)))
    fail(path, "arrays cannot have custom properties");

  const normalized = [];
  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < patches.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(patches, String(index));
    if (!descriptor || !("value" in descriptor)) fail(itemPath, "sparse arrays and accessors are not allowed");
    const patch = descriptor.value;
    const patchKeys = recordKeys(patch, itemPath);
    for (const key of patchKeys) {
      if (key !== "start" && key !== "end" && key !== "style")
        fail(`${itemPath}.${key}`, "is not a supported patch field");
    }
    const start = requireOffset(ownValue(patch, "start", `${itemPath}.start`), text.length, `${itemPath}.start`);
    const end = requireOffset(ownValue(patch, "end", `${itemPath}.end`), text.length, `${itemPath}.end`);
    if (end < start) fail(itemPath, "end must be greater than or equal to start");
    if (start < previousStart) fail(path, "patches must be sorted by start offset");
    if (start < previousEnd) fail(path, "patches cannot overlap");
    const style = readStyle(ownValue(patch, "style", `${itemPath}.style`), `${itemPath}.style`, { allowRemoval: true });
    normalized.push({ start, end, style });
    previousStart = start;
    previousEnd = end;
  }
  return normalized;
}

function* endpoints(ranges) {
  for (const range of ranges) {
    yield range.start;
    yield range.end;
  }
}

function mergedBoundaries(leftRanges, rightRanges) {
  const left = endpoints(leftRanges);
  const right = endpoints(rightRanges);
  let leftOffset = left.next().value;
  let rightOffset = right.next().value;
  const boundaries = [];
  const add = (offset) => {
    if (boundaries.at(-1) !== offset) boundaries.push(offset);
  };
  while (leftOffset !== undefined || rightOffset !== undefined) {
    if (leftOffset === undefined) {
      add(rightOffset);
      rightOffset = right.next().value;
    } else if (rightOffset === undefined) {
      add(leftOffset);
      leftOffset = left.next().value;
    } else if (leftOffset === rightOffset) {
      add(leftOffset);
      leftOffset = left.next().value;
      rightOffset = right.next().value;
    } else if (leftOffset < rightOffset) {
      add(leftOffset);
      leftOffset = left.next().value;
    } else {
      add(rightOffset);
      rightOffset = right.next().value;
    }
  }
  return boundaries;
}

/** Apply sorted disjoint range edits in one validation and boundary sweep. */
export function withTextStylePatches(layer, patches) {
  const text = layerText(layer);
  const normalizedPatches = normalizeTextStylePatches(text, patches);
  const ranges = layer.textStyleRanges === undefined
    ? []
    : normalizeRangeArray(text, layer.textStyleRanges, "textStyleRanges", { validateBoundaries: false });
  assertGraphemeBoundaries(text, [...ranges, ...normalizedPatches], "textStylePatches");

  if (normalizedPatches.length === 0) return layer;
  const boundaries = mergedBoundaries(ranges, normalizedPatches);
  const output = [];
  let rangeIndex = 0;
  let patchIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === end) continue;
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= start) rangeIndex += 1;
    while (patchIndex < normalizedPatches.length && normalizedPatches[patchIndex].end <= start) patchIndex += 1;
    const range = ranges[rangeIndex];
    const originalStyle = range && range.start <= start && range.end >= end ? range.style : EMPTY_STYLE;
    const patch = normalizedPatches[patchIndex];
    const activePatch = patch && patch.start <= start && patch.end >= end ? patch.style : null;
    const style = activePatch
      ? applyStylePatch(originalStyle, activePatch,
        ["fontFamily", "fontWeight", "fontStyle"].some((key) => Object.hasOwn(activePatch, key)),
        Object.hasOwn(activePatch, "fontSource") && activePatch.fontSource !== REMOVE)
      : { ...originalStyle };
    if (Object.keys(style).length) output.push({ start, end, style });
  }

  const nextRanges = mergeAdjacent(output);
  if (sameValue(ranges, nextRanges)) return layer;
  return { ...layer, textStyleRanges: nextRanges };
}

/** Apply range overrides without changing the source layer or its existing overrides. */
export function withTextStyleRange(layer, start, end, patch) {
  const text = layerText(layer);
  requireInterval(text, start, end, "textStyleRange");
  const normalizedPatch = readStyle(patch, "textStyleRange.patch", { allowRemoval: true });
  if (start === end || Object.keys(normalizedPatch).length === 0) return layer;
  const ranges = layerRanges(layer, text);
  const nextRanges = patchRanges(text, ranges, start, end, normalizedPatch);
  if (sameValue(ranges, nextRanges)) return layer;
  return { ...layer, textStyleRanges: nextRanges };
}

/** Apply whole-layer text styling and remove only the corresponding range overrides. */
export function withWholeTextStyle(layer, patch) {
  const text = layerText(layer);
  const normalizedPatch = readStyle(patch, "textStyle.patch", { allowRemoval: true });
  if (Object.keys(normalizedPatch).length === 0) return layer;

  const nextLayer = { ...layer };
  const changedKeys = new Set(Object.keys(normalizedPatch));
  const changesFontFace = ["fontFamily", "fontWeight", "fontStyle"].some((key) => changedKeys.has(key));
  const suppliesFontSource = changedKeys.has("fontSource") && normalizedPatch.fontSource !== REMOVE;
  for (const key of changedKeys) {
    if (normalizedPatch[key] === REMOVE) delete nextLayer[key];
    else nextLayer[key] = normalizedPatch[key];
  }
  if (changesFontFace && !suppliesFontSource) nextLayer.fontSource = "";
  const ranges = layerRanges(layer, text);
  const nextRanges = mergeAdjacent(ranges.map((range) => {
    const style = { ...range.style };
    for (const key of changedKeys) delete style[key];
    if (changesFontFace && !suppliesFontSource) delete style.fontSource;
    return { start: range.start, end: range.end, style };
  }));
  if (layer.textStyleRanges !== undefined || nextRanges.length) nextLayer.textStyleRanges = nextRanges;
  return nextLayer;
}

function commonPrefixLength(left, right) {
  let index = 0;
  const limit = Math.min(left.length, right.length);
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function commonSuffixStarts(left, right, prefixLength) {
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex > prefixLength && rightIndex > prefixLength &&
         left.charCodeAt(leftIndex - 1) === right.charCodeAt(rightIndex - 1)) {
    leftIndex -= 1;
    rightIndex -= 1;
  }
  return [leftIndex, rightIndex];
}

function* graphemeSpans(text) {
  for (const part of graphemeSegmenter.segment(text))
    yield { start: part.index, end: part.index + part.segment.length };
}

function* graphemeBoundaries(text) {
  yield 0;
  for (const grapheme of graphemeSpans(text)) yield grapheme.end;
}

function greatestCommonBoundary(leftText, rightText, limit) {
  const left = graphemeBoundaries(leftText);
  const right = graphemeBoundaries(rightText);
  let leftOffset = left.next().value;
  let rightOffset = right.next().value;
  let common = 0;
  while (leftOffset <= limit && rightOffset <= limit) {
    if (leftOffset === rightOffset) {
      common = leftOffset;
      leftOffset = left.next().value;
      rightOffset = right.next().value;
    } else if (leftOffset < rightOffset) leftOffset = left.next().value;
    else rightOffset = right.next().value;
  }
  return common;
}

function firstAlignedSuffixBoundary(oldText, newText, oldLimit, newLimit, delta) {
  const oldBoundaries = graphemeBoundaries(oldText);
  const newBoundaries = graphemeBoundaries(newText);
  let oldOffset = oldBoundaries.next().value;
  let newOffset = newBoundaries.next().value;
  while (oldOffset < oldLimit) oldOffset = oldBoundaries.next().value;
  while (newOffset < newLimit) newOffset = newBoundaries.next().value;
  while (oldOffset !== undefined && newOffset !== undefined) {
    const mapped = oldOffset + delta;
    if (mapped === newOffset) return [oldOffset, newOffset];
    if (mapped < newOffset) oldOffset = oldBoundaries.next().value;
    else newOffset = newBoundaries.next().value;
  }
  return [oldText.length, newText.length];
}

function appendStyledGrapheme(ranges, grapheme, style) {
  if (Object.keys(style).length === 0) return;
  const previous = ranges.at(-1);
  if (previous?.end === grapheme.start && sameStyle(previous.style, style)) previous.end = grapheme.end;
  else ranges.push({ start: grapheme.start, end: grapheme.end, style });
}

function appendOriginalPrefix(oldText, ranges, beforeOffset, output) {
  let rangeIndex = 0;
  for (const grapheme of graphemeSpans(oldText)) {
    if (grapheme.end > beforeOffset) break;
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= grapheme.start) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const style = range && range.start <= grapheme.start && range.end >= grapheme.end ? range.style : EMPTY_STYLE;
    appendStyledGrapheme(output, grapheme, style);
  }
}

function appendInheritedMiddle(newText, start, end, style, output) {
  for (const grapheme of graphemeSpans(newText)) {
    if (grapheme.start < start) continue;
    if (grapheme.end > end) break;
    appendStyledGrapheme(output, grapheme, style);
  }
}

function appendOriginalSuffix(oldText, newText, oldStart, newStart, delta, ranges, output) {
  const oldGraphemes = graphemeSpans(oldText);
  let oldGrapheme = oldGraphemes.next().value;
  while (oldGrapheme && oldGrapheme.start < oldStart) oldGrapheme = oldGraphemes.next().value;
  let rangeIndex = 0;
  while (rangeIndex < ranges.length && ranges[rangeIndex].end <= oldStart) rangeIndex += 1;
  for (const grapheme of graphemeSpans(newText)) {
    if (grapheme.start < newStart) continue;
    if (!oldGrapheme || oldGrapheme.start + delta !== grapheme.start || oldGrapheme.end + delta !== grapheme.end)
      fail("textStyleRanges", "the edited text could not preserve grapheme mapping");
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= oldGrapheme.start) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const style = range && range.start <= oldGrapheme.start && range.end >= oldGrapheme.end ? range.style : EMPTY_STYLE;
    appendStyledGrapheme(output, grapheme, style);
    oldGrapheme = oldGraphemes.next().value;
  }
}

/** Preserve formatted graphemes around a minimal text edit; inserted text inherits before-caret style. */
export function withEditedText(layer, nextText) {
  const oldText = layerText(layer);
  requireText(nextText, "nextText");
  if (oldText === nextText) return layer;
  if (layer.textStyleRanges === undefined) return { ...layer, text: nextText };

  const ranges = layerRanges(layer, oldText);
  if (!ranges.length) return { ...layer, text: nextText, textStyleRanges: ranges };

  const prefixLength = commonPrefixLength(oldText, nextText);
  const [oldSuffixRaw, newSuffixRaw] = commonSuffixStarts(oldText, nextText, prefixLength);
  const prefix = greatestCommonBoundary(oldText, nextText, prefixLength);
  const delta = nextText.length - oldText.length;
  const [oldSuffix, newSuffix] = firstAlignedSuffixBoundary(
    oldText, nextText, oldSuffixRaw, newSuffixRaw, delta,
  );

  let inheritedStyle = EMPTY_STYLE;
  if (oldText.length > 0) {
    const caretSample = prefixLength === 0 ? 0 : prefixLength - 1;
    inheritedStyle = rangeStyleAt(ranges, caretSample);
  }
  const output = [];
  appendOriginalPrefix(oldText, ranges, prefix, output);
  appendInheritedMiddle(nextText, prefix, newSuffix, inheritedStyle, output);
  appendOriginalSuffix(oldText, nextText, oldSuffix, newSuffix, delta, ranges, output);
  return { ...layer, text: nextText, textStyleRanges: normalizeRangeArray(nextText, output, "textStyleRanges") };
}
