import { fontGlyphReferences } from "./fontGlyphReferences.js";

/** Return only the registered face metadata needed to draw text in this document. */
export function viewerFontEntries(document, fonts) {
  if (!fonts || typeof fonts.entries !== "function" || typeof fonts.renderingFace !== "function" ||
      typeof fonts.textRuns !== "function" || !Array.isArray(fonts.faces)) return [];

  const entries = fonts.entries();
  const entryIds = new Set(entries.map(({ id }) => id));
  const faceIds = new Set(fonts.faces.map(({ id }) => id));
  const idsByFont = new Map();
  for (const face of fonts.faces) if (face.font && !idsByFont.has(face.font)) idsByFont.set(face.font, face.id);

  const selected = new Set();
  const include = (face) => {
    if (!face) return;
    const id = faceIds.has(face.id) ? face.id : idsByFont.get(face.font);
    if (id && entryIds.has(id)) selected.add(id);
  };

  for (const reference of fontGlyphReferences(document)) {
    try { include(fonts.renderingFace(reference)); }
    catch { /* A registry with no usable face contributes no renderable entry. */ }
    try {
      for (const run of fonts.textRuns(reference.text, reference)) include(run.face);
    } catch { /* Keep any base rendering face already selected above. */ }
  }

  // `entries()` follows registry order and omits font objects and internal coverage data.
  return entries.filter(({ id }) => selected.has(id));
}
