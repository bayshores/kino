import { defaultFonts } from "./fonts.js";
import { contourBounds, parsePath, pathBounds, serializePath } from "./vectorPath.js";
import { colorGlyph } from "./colorGlyphs.js";
import { layoutFontSize, letterSpacingPixels } from "./letterSpacing.js";
import { lineHeightPixels } from "./lineHeight.js";
import { textGraphemes } from "./textSource.js";
import { itemizeText, textStyleRuns } from "./textItemization.js";
import { prepareTextBidi } from "./textBidi.js";
import { letterJitterAt } from "./letterJitter.js";
export { displayText, textGraphemes } from "./textSource.js";

const cache = new WeakMap();
const MAX_CACHE_ENTRIES = 256;
const outlineCache = new Map();
const formattingOnly = (text) => /^[\p{Default_Ignorable_Code_Point}\p{Control}]+$/u.test(text);

function clusterFor(graphemes, start) {
  let low = 0, high = graphemes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (graphemes[middle].end > start) high = middle;
    else low = middle + 1;
  }
  return Math.min(low, Math.max(0, graphemes.length - 1));
}

export function glyphContours(glyph) {
  if (!glyph.path) return [];
  let contours = outlineCache.get(glyph.path);
  if (!contours) {
    contours = parsePath(glyph.path);
    outlineCache.set(glyph.path, contours);
    if (outlineCache.size > 2048) outlineCache.delete(outlineCache.keys().next().value);
  }
  // A letter that sits above or below the baseline (glyph.shift, pixels up) or turns about the
  // middle of its own ink (glyph.rotation, degrees, clockwise) is drawn there; its layout is unchanged.
  const lift = glyph.shift || 0, turn = (glyph.rotation || 0) * Math.PI / 180;
  const flat = ([x, y]) => [glyph.x + x * glyph.scale, glyph.y - lift - y * glyph.scale];
  let point = flat;
  if (turn && glyph.bounds) {
    const cx = glyph.x + glyph.bounds.x + glyph.bounds.width / 2, cy = glyph.y - lift + glyph.bounds.y + glyph.bounds.height / 2;
    const cos = Math.cos(turn), sin = Math.sin(turn);
    point = (pair) => { const [px, py] = flat(pair); return [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]; };
  }
  return contours.map((contour) => ({ ...contour, start: point(contour.start), segments: contour.segments.map((segment) => ({ c1: point(segment.c1), c2: point(segment.c2), end: point(segment.end) })) }));
}

// A glyph's SVG path data where it sits, and that path's bounds, remembered on frozen glyph
// objects. A frozen glyph cannot change its outline (`path`) or placement (`x`, `y`, `scale`,
// `rotation`, `shift`), the only inputs of glyphContours, so what is remembered for it is never out of date. render.js
// freezes the glyphs it keeps from frame to frame (textSvgCache.js), so drawing them again, and
// measuring them for bounds, reuses one path instead of rebuilding and re-measuring it each time.
// Entries go away with their glyph objects (a WeakMap). Other glyphs are worked out every time.
const frozenGlyphOutlines = new WeakMap(); // frozen glyph → { d, bounds }

function placedOutline(glyph) {
  let outline = frozenGlyphOutlines.get(glyph);
  if (outline) return outline;
  const contours = glyphContours(glyph);
  outline = { d: serializePath(contours), contours, bounds: null };
  if (typeof glyph === "object" && Object.isFrozen(glyph)) frozenGlyphOutlines.set(glyph, outline);
  return outline;
}

export function glyphPath(glyph) { return placedOutline(glyph).d; }

// The path data writes -0 as "0" (vectorPath.js serializePath), so the bounds read -0 as 0 too.
const plainZero = (value) => (value === 0 ? 0 : value);
const plainPoint = ([x, y]) => [plainZero(x), plainZero(y)];

/**
 * The bounds of glyphPath(glyph). For a frozen glyph they are shared: read them, do not change them.
 * Measured on the contours the path data was written from, which hold the same numbers, rather
 * than by parsing the path data back.
 */
export function glyphPathBounds(glyph) {
  const outline = placedOutline(glyph);
  outline.bounds ??= Object.freeze(contourBounds(outline.contours.map((contour) => ({ start: plainPoint(contour.start),
    segments: contour.segments.map((segment) => ({ c1: plainPoint(segment.c1), c2: plainPoint(segment.c2), end: plainPoint(segment.end) })) }))));
  return outline.bounds;
}

export function glyphDrawBounds(glyph) {
  if (glyph.color) return { x: glyph.x + glyph.bounds.x, y: glyph.y + glyph.bounds.y,
    width: glyph.bounds.width, height: glyph.bounds.height };
  return glyph.path ? { ...glyphPathBounds(glyph) } : null;
}

// A styled run that turns its letters or lifts them off the baseline (textStyleRanges rotation and
// baselineShift) puts "rotation" (degrees) and "shift" (pixels up) on each of its glyphs; glyphContours draws them.
function turnedGlyph(style) {
  const turn = Number(style._textRangeRotation) || 0, lift = (Number(style._textRangeShift) || 0) / 100 * layoutFontSize(style.fontSize);
  return { ...(turn ? { rotation: turn } : {}), ...(lift ? { shift: lift } : {}) };
}

function sameShapingStyle(left, right) {
  return !left.face.missingGlyph && !right.face.missingGlyph && left.face.font === right.face.font &&
    left.direction === right.direction && left.level === right.level &&
    left.script === right.script && left.mirrored === right.mirrored && left.end === right.start &&
    ["fontFamily", "fontSource", "fontWeight", "fontStyle", "fontSize", "letterSpacing", "kerning", "ligatures", "tabularNumbers"]
      .every((key) => left.style[key] === right.style[key]);
}

function shapeItemRuns(runs) {
  const groups = [];
  for (const run of runs) {
    const group = groups.at(-1);
    if (group && sameShapingStyle(group.at(-1), run)) group.push(run);
    else groups.push([run]);
  }
  const shape = (run) => ({ ...shapeRun(run.text, run.style, run.face, run),
    start: run.start, end: run.end, style: run.style, visualOrder: run.visualOrder });
  return groups.flatMap((group) => {
    if (group.length === 1) return [shape(group[0])];
    const first = group[0], last = group.at(-1);
    const combined = shape({ ...first, text: group.map((run) => run.text).join(""), end: last.end,
      visualOrder: Math.min(...group.map((run) => run.visualOrder)) });
    const rangeAt = (offset) => {
      let low = 0, high = group.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (group[middle].end <= offset) low = middle + 1;
        else high = middle;
      }
      return group[Math.min(low, group.length - 1)];
    };
    // Paint alone must not break Arabic joining or move combining marks.
    // A glyph that crosses a paint boundary cannot take two colors without
    // clipping its outline. Preserve the existing split-run behavior there,
    // rather than silently painting the whole ligature with one range's color.
    if (combined.glyphs.some((glyph) => first.start + glyph.end > rangeAt(first.start + glyph.start).end))
      return group.map(shape);
    combined.glyphs = combined.glyphs.map((glyph) => {
      const { fill: ignoredFill, rotation: ignoredTurn, shift: ignoredShift, ...rest } = glyph;
      const { style } = rangeAt(first.start + glyph.start);
      const fill = style._textRangeFill;
      return { ...rest, ...(fill === undefined ? {} : { fill }), ...turnedGlyph(style) };
    });
    return [combined];
  });
}

/** Real GSUB/GPOS positions and font outlines; no character-width guesses. */
export function shapeText(text, layer, fonts = defaultFonts, options = {}) {
  text = String(text).normalize("NFC");
  const runs = itemizeText(text, layer, fonts, options);
  if (runs.length === 1) return { ...shapeRun(runs[0].text, runs[0].style, runs[0].face, runs[0]),
    text, graphemes: textGraphemes(text), direction: runs[0].baseDirection };
  const graphemes = textGraphemes(text);
  const shaped = shapeItemRuns(runs)
    .sort((left, right) => left.visualOrder - right.visualOrder || left.start - right.start);
  let cursor = 0;
  let remainingRuns = shaped.filter((run) => run.spacingClusters > 0).length;
  const glyphs = shaped.flatMap((run, index) => {
    const values = run.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + cursor,
      start: run.start + glyph.start, end: run.start + glyph.end,
      cluster: clusterFor(graphemes, run.start + glyph.start) }));
    cursor += run.width;
    if (run.spacingClusters > 0 && --remainingRuns > 0) {
      // At a reversed style boundary, tracking belongs to the logical
      // predecessor on the right. Uniform tracking remains one visual gap.
      const next = shaped[index + 1];
      const style = next?.end === run.start ? next.style : run.style;
      cursor += letterSpacingPixels(style.letterSpacing, style.fontSize);
    }
    return values;
  });
  return { text, width: cursor, glyphs, graphemes, direction: runs[0].baseDirection,
    ascent: Math.max(...shaped.map((run) => run.ascent)), descent: Math.max(...shaped.map((run) => run.descent)),
    fontSize: Math.max(...shaped.map((run) => run.fontSize)), scale: shaped[0].scale,
    hasFallback: shaped.some((run) => run.hasFallback) };
}

function colorBounds(color, scale) {
  if (color.kind === "image") return { x: color.x * scale, y: color.y * scale,
    width: color.width * scale, height: color.height * scale };
  const boxes = color.layers.map(({ path }) => pathBounds(path));
  const left = Math.min(0, ...boxes.map((box) => box.x)), right = Math.max(0, ...boxes.map((box) => box.x + box.width));
  const top = Math.min(0, ...boxes.map((box) => -box.y - box.height)), bottom = Math.max(0, ...boxes.map((box) => -box.y));
  return { x: left * scale, y: top * scale, width: (right - left) * scale, height: (bottom - top) * scale };
}

function missingRun(text, layer, face, options = {}) {
  const fontSize = layoutFontSize(layer.fontSize), scale = fontSize / 1000;
  const graphemes = textGraphemes(text), spacing = letterSpacingPixels(layer.letterSpacing, fontSize);
  // A deliberately visible replacement box for one unsupported grapheme. Its
  // measured em box is used consistently for drawing, caret movement and export.
  const path = "M100 0L100 800L700 800L700 0ZM160 60L640 60L640 740L160 740Z";
  const direction = options.direction ?? "ltr";
  const ordered = graphemes.map((part, cluster) => ({ part, cluster }));
  if (direction === "rtl") ordered.reverse();
  let cursor = 0, spacingClusters = 0;
  const glyphs = ordered.map(({ part, cluster }) => {
    const hidden = formattingOnly(part.text);
    if (!hidden && spacingClusters++) cursor += spacing;
    const glyph = { id: 0, start: part.start, end: part.end, cluster, direction, level: options.level ?? 0,
    x: cursor, y: 0, advance: hidden ? 0 : fontSize * 0.8,
    path: /^[\s\p{Default_Ignorable_Code_Point}\p{Control}]*$/u.test(part.text) ? "" : path, scale,
    ...(/^[\s\p{Default_Ignorable_Code_Point}\p{Control}]*$/u.test(part.text) ? {} : { missing: part.text, missingFamily: face.missingFor ?? face.family }),
    ...(layer._textRangeFill === undefined ? {} : { fill: layer._textRangeFill }), ...turnedGlyph(layer),
    bounds: { x: fontSize * 0.1, y: -fontSize * 0.8, width: fontSize * 0.6, height: fontSize * 0.8 } };
    cursor += glyph.advance;
    return glyph;
  });
  return { text, width: cursor, spacingClusters,
    glyphs, graphemes, direction, ascent: fontSize * 0.8, descent: fontSize * 0.2,
    fontSize, scale, hasFallback: true };
}

function shapeRun(text, layer, face, options = {}) {
  if (face.missingGlyph) return missingRun(text, layer, face, options);
  try { return shapeFaceRun(text, layer, face, options); }
  catch {
    // A damaged contextual lookup must not hide an otherwise usable layer.
    // Retry complete graphemes; only the ones that still fail become boxes.
    const graphemes = textGraphemes(text), parts = graphemes.map((part) => {
      try { return shapeFaceRun(part.text, layer, face, options); }
      catch { return missingRun(part.text, layer, face, options); }
    });
    let cursor = 0;
    const spacing = letterSpacingPixels(layer.letterSpacing, layer.fontSize);
    let remaining = parts.filter((part) => part.spacingClusters > 0).length;
    const ordered = parts.map((part, cluster) => ({ part, cluster }));
    if (options.direction === "rtl") ordered.reverse();
    const glyphs = ordered.flatMap(({ part, cluster }) => {
      const result = part.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + cursor, cluster,
        start: glyph.start + graphemes[cluster].start, end: glyph.end + graphemes[cluster].start }));
      cursor += part.width;
      if (part.spacingClusters > 0 && --remaining > 0) cursor += spacing;
      return result;
    });
    return { text, width: cursor, glyphs, graphemes, direction: options.direction ?? parts[0]?.direction ?? "ltr",
      spacingClusters: parts.reduce((sum, part) => sum + part.spacingClusters, 0),
      ascent: Math.max(0, ...parts.map((part) => part.ascent)), descent: Math.max(0, ...parts.map((part) => part.descent)),
      fontSize: layoutFontSize(layer.fontSize), scale: layoutFontSize(layer.fontSize) / face.font.unitsPerEm,
      hasFallback: true };
  }
}

function glyphSourceRanges(run, text, graphemes, font) {
  const ranges = Array(run.glyphs.length);
  const indices = run.glyphs.map((_, index) => index);
  if (run.direction === "rtl") indices.reverse();
  let cursor = 0, previous = null;
  const pending = [];
  for (const index of indices) {
    const glyph = run.glyphs[index];
    let characters = String.fromCodePoint(...(glyph.codePoints ?? [])).normalize("NFC");
    // Fontkit caches glyph objects. A base produced by an earlier decomposition
    // (e.g. é -> e + accent) can retain an empty source list when later used as
    // an ordinary e. The public cmap lookup distinguishes that source character
    // from added artwork such as Arabic dots, without consuming the next letter.
    if (!characters && cursor < text.length && font.glyphForCodePoint(text.codePointAt(cursor)).id === glyph.id)
      characters = String.fromCodePoint(text.codePointAt(cursor));
    // A multiple substitution may add artwork with no source code points
    // (for example an Arabic letter's dots). It belongs to its base; it must
    // not consume the next letter or acquire a separate animation unit.
    if (!characters) {
      if (previous) ranges[index] = previous;
      else pending.push(index);
      continue;
    }
    if (cursor >= text.length && previous) { ranges[index] = previous; continue; }
    const next = String.fromCodePoint(text.codePointAt(cursor) || 0);
    const matched = text.slice(cursor, cursor + characters.length) === characters;
    const range = { start: cursor, end: Math.min(text.length, cursor + (matched ? characters.length : next.length)) };
    ranges[index] = previous = range;
    for (const pendingIndex of pending.splice(0)) ranges[pendingIndex] = range;
    cursor = range.end;
  }
  if (graphemes.length === 1) {
    // Variation-selector aliases and decomposed artwork can consume fewer
    // code points than the source. A single grapheme remains indivisible.
    if (cursor < text.length && previous) previous.end = text.length;
    return Array.from(ranges, (range) => range ?? { start: 0, end: text.length });
  }
  if (cursor < text.length && formattingOnly(text.slice(cursor)) && previous) previous.end = text.length;
  else if (cursor < text.length || pending.length) throw new Error("The font did not preserve text source spans.");
  return ranges;
}

// A font glyph's outline as SVG path data in font units. fontkit keeps one glyph object per
// glyph of a font, with its outline, so the text is made once per glyph instead of every time
// text using it is laid out again (a size, spacing or line height that animates does that on
// every frame). Entries go away with their fonts (a WeakMap).
const fontOutlines = new WeakMap(); // fontkit glyph → path data
function fontOutline(glyph) {
  let outline = fontOutlines.get(glyph);
  if (outline === undefined) {
    outline = glyph.path?.toSVG() ?? "";
    fontOutlines.set(glyph, outline);
  }
  return outline;
}

function shapeFaceRun(text, layer, face, options = {}) {
  const font = face.font;
  const scale = layoutFontSize(layer.fontSize) / font.unitsPerEm;
  // tabularNumbers: every digit as wide as the others (OpenType tnum), so a counting number keeps its width.
  // Code fonts (JetBrains Mono, Fira Code) put their ligatures in calt, so ligatures:false turns it off too.
  const features = { kern: layer.kerning !== false, liga: layer.ligatures !== false, clig: layer.ligatures !== false,
    ...(layer.ligatures === false ? { calt: false } : {}),
    ...(layer.tabularNumbers === true ? { tnum: true } : {}),
    ...(options.mirrored ? { rtlm: false } : {}) };
  const run = font.layout(String(text), features, undefined, undefined, options.direction);
  const graphemes = textGraphemes(text);
  const sourceRanges = glyphSourceRanges(run, text, graphemes, font);
  // Letter spacing is a percentage of the font size (letterSpacing.js): the pixels added after each letter.
  const spacing = letterSpacingPixels(layer.letterSpacing, layer.fontSize);
  const invalid = new Set();
  const items = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const { start, end } = sourceRanges[index];
    const cluster = clusterFor(graphemes, start);
    const sourceCharacters = text.slice(start, end);
    const visible = sourceCharacters && !/^[\p{Default_Ignorable_Code_Point}\p{Control}\s]*$/u.test(sourceCharacters);
    const invisible = sourceCharacters && !visible;
    const hidden = sourceCharacters && formattingOnly(sourceCharacters);
    let color, path = "", bounds = { x: 0, y: 0, width: 0, height: 0 };
    try {
      color = invisible ? null : colorGlyph(face, glyph, layer.fontSize);
      path = invisible || color && color.kind !== "unsupported" ? "" : fontOutline(glyph);
      // A blank glyph the font put in place of a letter (the spacer before a code ligature such as
      // "//" or "===", whose wide glyph draws over both cells) is not a missing one.
      const spacer = Boolean(glyph.id) && !path && !color && [...sourceCharacters].length === 1
        && font.glyphForCodePoint(sourceCharacters.codePointAt(0))?.id !== glyph.id;
      if (!invisible && (color?.kind === "unsupported" || (visible && (!glyph.id || !path && !color && !spacer)))) invalid.add(cluster);
      else bounds = color ? colorBounds(color, scale) : { x: glyph.bbox.minX * scale, y: -glyph.bbox.maxY * scale,
        width: (glyph.bbox.maxX - glyph.bbox.minX) * scale, height: (glyph.bbox.maxY - glyph.bbox.minY) * scale };
    } catch { if (!invisible) invalid.add(cluster); }
    if (invisible) { color = null; path = ""; bounds = { x: 0, y: 0, width: 0, height: 0 }; }
    const item = {
      id: glyph.id, start, end, cluster, direction: options.direction ?? run.direction, level: options.level ?? 0, hidden: Boolean(hidden),
      ...(layer._textRangeFill === undefined ? {} : { fill: layer._textRangeFill }), ...turnedGlyph(layer),
      x: position.xOffset * scale,
      y: -position.yOffset * scale,
      advance: hidden ? 0 : position.xAdvance * scale,
      path, scale,
      ...(color ? { color } : {}),
      bounds,
    };
    return item;
  });
  const glyphs = [];
  let cursor = 0, spacingClusters = 0;
  for (let index = 0; index < items.length;) {
    const start = index, cluster = items[index].cluster;
    while (index < items.length && items[index].cluster === cluster) index++;
    const hidden = items.slice(start, index).every((item) => item.hidden);
    if (!hidden && spacingClusters++) cursor += spacing;
    if (invalid.has(cluster)) {
      const part = graphemes[cluster];
      if (part) {
        const replacement = missingRun(part.text, layer, face, options).glyphs[0];
        glyphs.push({ ...replacement, start: part.start, end: part.end, cluster, x: cursor });
        cursor += replacement.advance;
      }
    } else for (let at = start; at < index; at++) {
      glyphs.push({ ...items[at], x: cursor + items[at].x });
      cursor += items[at].advance;
    }
  }
  return { text: String(text), width: cursor, spacingClusters, glyphs, graphemes, direction: run.direction,
    ascent: font.ascent * scale, descent: -font.descent * scale, fontSize: layoutFontSize(layer.fontSize), scale,
    hasFallback: Boolean(face.fallbackFor || glyphs.some((glyph) => glyph.color || glyph.missing)) };
}

// The lines of one paragraph that fit in `width`: [{ text, start }], `start` being where the line
// begins in the paragraph (the spaces at a line break belong to no line).
function wrapParagraph(paragraph, width, layer, fonts, paragraphStart, runs, bidi) {
  if (!paragraph) return [{ text: "", start: 0 }];
  if (!Number.isFinite(width) || width <= 0) return [{ text: paragraph, start: 0 }];
  const graphemes = textGraphemes(paragraph);
  const lines = [];
  let start = 0;
  // Whether the graphemes from `start` up to `end` fit on one line.
  const fits = (end) => shapeText(paragraph.slice(graphemes[start].start, graphemes[end - 1].end), layer, fonts,
    { start: paragraphStart + graphemes[start].start, runs, bidi }).width <= width + 1e-7;
  while (start < graphemes.length) {
    // Grow the line 1, 2, 4, 8… graphemes until it is too wide, then binary search the last
    // step. Shaping takes longer the longer the text, so a search that measures about a line
    // at a time keeps a long paragraph fast (one that measured half the paragraph per line did not).
    let fit = start, high = start + 1;
    while (high <= graphemes.length && fits(high)) {
      fit = high;
      high = high === graphemes.length ? high + 1 : Math.min(graphemes.length, start + 2 * (high - start));
    }
    let low = fit + 1;
    high = Math.min(high - 1, graphemes.length);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) { fit = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (fit === graphemes.length) { lines.push({ text: paragraph.slice(graphemes[start].start), start: graphemes[start].start }); break; }
    if (fit === start) fit = start + 1;
    let boundary = fit;
    // Prefer a word/hyphen/CJK boundary, keeping oversized graphemes intact.
    for (let index = fit - 1; index >= start; index--) {
      if (/\s|[-\u2010\u2013\u2e80-\u9fff]/u.test(graphemes[index].text)) { boundary = index + 1; break; }
    }
    lines.push({ text: paragraph.slice(graphemes[start].start, graphemes[boundary - 1].end).replace(/[\t ]+$/u, ""), start: graphemes[start].start });
    start = boundary;
    while (start < graphemes.length && /^[\t ]+$/u.test(graphemes[start].text)) start++;
  }
  return lines;
}

// The layer's fixed letter jitter (letterJitter.js): each glyph turns and lifts a little more.
function jitteredLine(line, start, layer) {
  if (!layer.jitter) return line;
  const size = layoutFontSize(layer.fontSize);
  return { ...line, glyphs: line.glyphs.map((glyph) => {
    if (!glyph.path) return glyph;
    const { rotation, shift } = letterJitterAt(layer.jitter, start + glyph.start);
    return { ...glyph, rotation: (glyph.rotation || 0) + rotation, shift: (glyph.shift || 0) + shift / 100 * size };
  }) };
}

export function layoutText(layer, fonts = defaultFonts) {
  let entries = cache.get(fonts);
  if (!entries) { entries = new Map(); cache.set(fonts, entries); }
  // Text that sizes itself ignores the box size it is given (width and height for "width-height",
  // height for "height"), so the key leaves it out: the layer and its resized copy
  // (resizeTextLayer) then share one layout instead of shaping the same text twice.
  const sizing = layer.textResize || "fixed";
  const keyWidth = sizing === "width-height" ? null : layer.width;
  const keyHeight = sizing === "fixed" ? layer.height : null;
  const key = JSON.stringify([fonts.version, layer.text, keyWidth, keyHeight, layer.fontFamily, layer.fontSource, layer.fontSize, layer.fontWeight, layer.axes, layer.fontStyle, layer.letterSpacing, layer.lineHeight, layer.textAlign, layer.verticalAlign, layer.textResize, layer.textCase, layer.kerning, layer.ligatures, layer.tabularNumbers === true, layer.textStyleRanges, layer.jitter]);
  if (entries.has(key)) return entries.get(key);
  // NFC, as shapeText shapes each line, so a line's `start` and its glyphs' `start` count the same text.
  const { text, runs } = textStyleRuns(layer);
  const bidi = prepareTextBidi(text);
  const fontSize = Math.max(0.1, Number(layer.fontSize) || 24);
  // The distance from one line to the next (lineHeight.js): a Line height animation changes it
  // on every frame, which moves every line and changes the height the lines take.
  const lineHeight = lineHeightPixels(layer.lineHeight, fontSize);
  const textResize = layer.textResize || "fixed";
  const limit = textResize === "width-height" ? Infinity : Math.max(0, Number(layer.width) || 0);
  // Each line keeps `start`, where it begins in `text` (textUnits and unitGlyphs use it).
  let paragraphStart = 0;
  const shaped = text.split("\n").flatMap((paragraph) => {
    const lines = wrapParagraph(paragraph, limit, layer, fonts, paragraphStart, runs, bidi).map((line) => {
      const start = paragraphStart + line.start;
      const shapedLine = jitteredLine(shapeText(line.text, layer, fonts, { start, runs, bidi }), start, layer);
      const nominalHeight = lineHeightPixels(layer.lineHeight, shapedLine.fontSize);
      return { ...shapedLine, start, lineHeight: shapedLine.hasFallback
        ? Math.max(nominalHeight, shapedLine.ascent + shapedLine.descent) : nominalHeight };
    });
    paragraphStart += paragraph.length + 1;
    return lines;
  });
  const naturalWidth = Math.max(0, ...shaped.map((line) => line.width));
  const naturalHeight = shaped.reduce((sum, line) => sum + line.lineHeight, 0);
  const width = textResize === "width-height" ? Math.max(1, Math.ceil(naturalWidth)) : Math.max(0, Number(layer.width) || 0);
  const height = textResize === "fixed" ? Math.max(0, Number(layer.height) || 0) : Math.max(1, Math.ceil(naturalHeight));
  const vertical = layer.verticalAlign === "bottom" ? height - naturalHeight : layer.verticalAlign === "middle" ? (height - naturalHeight) / 2 : 0;
  let lineTop = vertical;
  const lines = shaped.map((line) => {
    const placed = { ...line,
      x: layer.textAlign === "right" ? width - line.width : layer.textAlign === "center" ? (width - line.width) / 2 : 0,
      y: lineTop + (line.lineHeight - line.ascent - line.descent) / 2 + line.ascent,
    };
    lineTop += line.lineHeight;
    return placed;
  });
  const result = { text, width, height, naturalWidth, naturalHeight, fontSize, lineHeight, lines };
  entries.set(key, result);
  if (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value);
  return result;
}

export function resizeTextLayer(layer, fonts = defaultFonts) {
  if (layer.type !== "text" || !layer.textResize || layer.textResize === "fixed") return layer;
  const { width, height } = layoutText(layer, fonts);
  const next = { ...layer, width, height };
  // Intrinsic resizing keeps the selected alignment anchor in place, just as
  // changing a centered fluid text line preserves its center on the canvas.
  if (Number.isFinite(layer.x) && layer.textResize === "width-height") {
    const anchor = layer.textAlign === "right" ? 1 : layer.textAlign === "center" ? 0.5 : 0;
    next.x += ((Number(layer.width) || 0) - width) * anchor;
  }
  if (Number.isFinite(layer.y)) {
    const anchor = layer.verticalAlign === "bottom" ? 1 : layer.verticalAlign === "middle" ? 0.5 : 0;
    next.y += ((Number(layer.height) || 0) - height) * anchor;
  }
  return next;
}

/** Unit assignment retains full-line kerning and ligature placement. */
export function textUnits(layout, mode = "layer") {
  const units = [];
  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
    const line = layout.lines[lineIndex];
    const ranges = mode === "letters" ? line.graphemes : mode === "words"
      ? [...line.text.matchAll(/\S+\s*/gu)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
      : [{ text: line.text, start: 0, end: line.text.length }];
    // `sourceStart` and `sourceEnd`: where the unit's characters are in the whole text.
    const lineUnits = ranges.map((range) => ({ ...range, lineIndex, sourceStart: line.start + range.start, sourceEnd: line.start + range.end, glyphs: [] }));
    for (const glyph of line.glyphs) {
      let index = 0;
      if (mode === "letters") index = glyph.cluster;
      else if (mode === "words") {
        let low = 0, high = ranges.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (ranges[middle].start <= glyph.start) low = middle + 1;
          else high = middle;
        }
        index = low - 1;
        if (index < 0 || glyph.start >= ranges[index].end) continue;
      }
      lineUnits[index]?.glyphs.push({ ...glyph, x: glyph.x + line.x, y: glyph.y + line.y });
    }
    units.push(...lineUnits);
  }
  if (mode === "layer") return [{ text: layout.text, sourceStart: 0, sourceEnd: Infinity, glyphs: units.flatMap((unit) => unit.glyphs) }];
  return units;
}

/**
 * The glyphs that `unit` (a unit of textUnits, from the layer's own layout) draws in `layout`,
 * the text laid out in that unit's animated state: the glyphs of the unit's own characters,
 * wherever this layout puts them, in textbox coordinates like textUnits' glyphs.
 *
 * A text animation by letters, words or lines numbers its units in the layer's own layout, and
 * each unit is laid out in its own state (its own time with stagger, so its own letter spacing,
 * size or width). When that state wraps the text differently, the units are matched by their
 * characters, not by their order: wrapping drops the spaces at a line break and can add or
 * remove lines, so the n-th unit of the new layout can be another letter, word or line. This
 * way each letter is still drawn once, by the unit it belongs to, at its place in the new layout.
 */
export function unitGlyphs(layout, unit) {
  const from = Number(unit?.sourceStart);
  const to = Number(unit?.sourceEnd);
  const glyphs = [];
  if (!(to > from)) return glyphs;
  for (const line of layout.lines) {
    if (line.start >= to || line.start + line.text.length < from) continue;
    for (const glyph of line.glyphs) {
      const source = line.start + glyph.start;
      if (source >= from && source < to) glyphs.push({ ...glyph, x: glyph.x + line.x, y: glyph.y + line.y });
    }
  }
  return glyphs;
}
