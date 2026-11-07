import { textSourceMap } from "./textSource.js";
import { textStyleSegments } from "./textStyleRanges.js";
import { bidiTextLine, prepareTextBidi } from "./textBidi.js";

/** Display spans retain their raw style boundaries before font subset shaping. */
export function textStyleRuns(layer) {
  const source = textSourceMap(layer);
  if (!layer.textStyleRanges?.length) return { ...source, runs: [{ start: 0, end: source.text.length, style: layer }] };
  const offsets = new Map(source.boundaries.map((value, index) => [value, source.displayOffsets[index]]));
  const runs = textStyleSegments(layer, 0, source.rawText.length, { preserveBoundaries: true, runtime: true }).map((segment) => ({
    start: offsets.get(segment.start), end: offsets.get(segment.end),
    style: { ...layer, ...segment.style, _textRangeFill: segment.overrides.fill,
      // A range's own weight wins over the layer's variable axes (fontAxes.js), so a bold word stays bold.
      ...(segment.overrides.fontWeight !== undefined && layer.axes?.wght !== undefined
        ? { axes: { ...layer.axes, wght: Number(segment.overrides.fontWeight) } } : {}) },
  }));
  return { ...source, runs };
}

/** Styles, fallback faces, scripts and paragraph-resolved direction share one seam. */
export function itemizeText(text, layer, fonts, { start = 0, runs, bidi } = {}) {
  const styles = runs ?? [{ start, end: start + text.length, style: layer }];
  const line = bidiTextLine(bidi ?? prepareTextBidi(text), bidi ? start : 0, (bidi ? start : 0) + text.length);
  const result = [];
  for (const span of styles) {
    const from = Math.max(start, span.start), to = Math.min(start + text.length, span.end);
    if (to <= from) continue;
    const value = line.display.slice(from - start, to - start);
    const faces = fonts.textRuns?.(value, span.style) ?? [{ text: value, start: 0, face: fonts.resolve(span.style) }];
    for (const run of faces) {
      const faceStart = from - start + run.start, faceEnd = faceStart + run.text.length;
      let low = 0, high = line.runs.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (line.runs[middle].end <= faceStart) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < line.runs.length && line.runs[index].start < faceEnd; index++) {
        const direction = line.runs[index];
        const begin = Math.max(faceStart, direction.start), end = Math.min(faceEnd, direction.end);
        if (end <= begin) continue;
        result.push({ ...run, ...direction, start: begin, end, text: line.display.slice(begin, end),
          baseDirection: line.direction, visualOrder: line.visualOrder(begin, end), style: span.style });
      }
    }
  }
  if (!result.length) result.push({ text, start: 0, end: text.length, style: layer,
    direction: line.direction, baseDirection: line.direction, level: line.baseLevel, visualOrder: 0,
    face: fonts.renderingFace?.(layer) ?? fonts.resolve(layer) });
  return result;
}
