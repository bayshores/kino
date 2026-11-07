import { flattenAnimations } from "./animationTree.js";
import { documentTextLayers } from "./fontDocuments.js";
import { fallbackCatalogIds } from "./fontFallback.js";
import { fontReference } from "./textFontReferences.js";
import { textStyleRuns } from "./textItemization.js";
import { textGraphemes } from "./textSource.js";
import { layoutText } from "./textLayout.js";
import { mirroredTextCharacters } from "./textBidi.js";

function variants(layer) {
  const result = [layer];
  for (const animation of flattenAnimations(layer.animations)) {
    if (animation.enabled === false) continue;
    if (animation.kind === "change-text" && animation.text !== layer.text)
      result.push({ ...layer, text: animation.text, textStyleRanges: [] });
    if (animation.kind === "counter") result.push({ ...layer, text: "0123456789-., ", textStyleRanges: [] });
  }
  return result;
}

/** Preserve complete strings: deduplicating code points can change emoji sequences. */
export function fontGlyphReferences(document) {
  const references = new Map();
  for (const layer of documentTextLayers(document)) for (const variant of variants(layer)) {
    const { text, runs } = textStyleRuns(variant);
    const mirrored = mirroredTextCharacters(text);
    for (const run of runs) {
      for (const value of new Set([text.slice(run.start, run.end), mirrored.slice(run.start, run.end)])) {
        const reference = { ...fontReference(run.style), text: value };
        references.set(JSON.stringify(reference), reference);
      }
    }
  }
  return [...references.values()];
}

/** Computed public fallback dependencies travel with copies and access scans. */
export function layerFallbackFontReferences(layer, fonts) {
  if (layer?.type !== "text" || !fonts) return [];
  const references = new Map();
  for (const variant of variants(layer)) {
    const { text, runs } = textStyleRuns(variant);
    const texts = new Set([text, mirroredTextCharacters(text)]);
    for (const value of texts) for (const run of runs) {
      let parts;
      try { parts = fonts.textRuns(value.slice(run.start, run.end), run.style); }
      catch { continue; }
      for (const { face } of parts) if (face.fallbackFor) {
        const reference = { fontFamily: face.family, fontSource: face.src ?? "", fontWeight: face.weight, fontStyle: face.style };
        references.set(JSON.stringify(reference), reference);
      }
    }
  }
  return [...references.values()];
}

export function layerGlyphProblems(layer, fonts) {
  if (layer?.type !== "text") return [];
  const problems = new Map();
  for (const variant of variants(layer)) {
    let layout;
    try { layout = layoutText(variant, fonts); }
    catch { continue; } // The missing-font warning handles an unavailable registry.
    for (const line of layout.lines) for (const glyph of line.glyphs) if (glyph.missing) {
      const key = `${glyph.missingFamily}:${glyph.missing}`;
      if (!problems.has(key)) problems.set(key, { text: glyph.missing, family: glyph.missingFamily });
    }
  }
  return [...problems.values()];
}

export function documentGlyphProblems(document, fonts) {
  return documentTextLayers(document).flatMap((layer) => {
    const glyphs = layerGlyphProblems(layer, fonts);
    return glyphs.length ? [{ layerId: layer.id, name: layer.name, glyphs }] : [];
  });
}

/** Group only unresolved graphemes; downloads never receive the surrounding text. */
export function fallbackFontRequests(document, fonts) {
  const groups = new Map();
  for (const reference of fontGlyphReferences(document)) {
    let runs;
    try { runs = fonts.textRuns(reference.text, reference); } catch { continue; }
    for (const run of runs) if (run.face.missingGlyph) for (const { text } of textGraphemes(run.text)) {
      const candidates = fallbackCatalogIds(text, reference.text);
      if (!candidates.length || text.length > 65536) continue;
      const key = candidates.join(":");
      if (!groups.has(key)) groups.set(key, { candidates, graphemes: new Set() });
      groups.get(key).graphemes.add(text);
    }
  }
  return [...groups.values()].flatMap(({ candidates, graphemes }) => {
    const requests = []; let text = "";
    for (const grapheme of graphemes) {
      if (text.length + grapheme.length + 1 > 65536) { requests.push({ candidates, text }); text = ""; }
      text += (text ? "\n" : "") + grapheme;
    }
    if (text) requests.push({ candidates, text });
    return requests;
  });
}
