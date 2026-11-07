// Which files may use an uploaded media file through a sharing link.
//
// Each uploaded file has a small record (`<id>.json` in the media folder). `projectId` names the
// file it was uploaded to. A sharing link may use the media of its own file only (see
// allowedMedia in index.mjs): the media in the file's saved document, and the media uploaded to it.
//
// The owner can also bring media from another file into a file, for example by pasting an image
// layer from file A into file B. While B's document holds that layer, B's links may use the image.
// So that removing the layer doesn't take this away (cut and paste it into another scene, or
// delete it and undo), every save of B lists B in the record's `usedInProjects`. A file that
// has used a media file keeps that permission, the same way as a file the media was uploaded to.

import { overrideReferenceLayers } from "../engine/componentOverrides.js";
import { parseMediaSource } from "./media-source.mjs";
import { layerFontReferences } from "../engine/textFontReferences.js";
import { layerFallbackFontReferences } from "../engine/fontGlyphReferences.js";
import { layersLutSources } from "../engine/effects/lutFiles.js";

/**
 * The IDs of the uploaded files a document uses: each layer's picture, video or sound (`src`)
 * and font file (`fontSource`), the .cube files of its lut effects (also turned-off ones), and
 * those that component instances use through their overrides (a swapped picture, a text in
 * another font; see engine/componentOverrides.js).
 * Pass the rendering font registry to include family-only font references in old
 * documents and MCP edits. Explicit sources remain tracked even if unavailable.
 */
export function documentMediaIds(document, { fonts } = {}) {
  const ids = new Set();
  const scenes = Array.isArray(document?.scenes) ? document.scenes : [];
  const layers = [...scenes.flatMap((scene) => (Array.isArray(scene?.layers) ? scene.layers : [])), ...overrideReferenceLayers(document)];
  for (const source of layersLutSources(layers, { enabledOnly: false })) {
    const parsed = parseMediaSource(source);
    if (parsed) ids.add(parsed.id);
  }
  for (const layer of layers) {
    for (const source of [layer?.src, layer?.fontSource, ...(layer?.textStyleRanges ?? []).map((range) => range.style?.fontSource)]) {
      const parsed = parseMediaSource(source);
      if (parsed) ids.add(parsed.id);
    }
    if (layer?.type === "text" && fonts) {
      // Use exactly the face the renderer selects (family, style, weight and
      // explicit source), including inherited component override properties.
      for (const reference of [...layerFontReferences(layer), ...layerFallbackFontReferences(layer, fonts)]) {
        try {
          const parsed = parseMediaSource(fonts.resolve(reference).src);
          if (parsed) ids.add(parsed.id);
        } catch {
          // Unavailable fonts are valid saved state; explicit references above
          // still retain their bytes so importing/recovering the font can fix it.
        }
      }
    }
  }
  return ids;
}

/** True when a sharing link for `projectId` may use the media file of this record. */
export function mediaAllowedIn(entry, projectId) {
  return entry?.projectId === projectId || (Array.isArray(entry?.usedInProjects) && entry.usedInProjects.includes(projectId));
}

/**
 * The record with `projectId` added to `usedInProjects`, or null when the record already lets
 * that file use the media (so nothing needs to be written).
 */
export function recordProjectUse(entry, projectId) {
  if (!entry || typeof entry !== "object" || typeof projectId !== "string" || mediaAllowedIn(entry, projectId)) return null;
  const used = Array.isArray(entry.usedInProjects) ? entry.usedInProjects.filter((id) => typeof id === "string") : [];
  return { ...entry, usedInProjects: [...used, projectId] };
}
