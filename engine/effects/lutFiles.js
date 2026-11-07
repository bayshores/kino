// Which .cube files the lut effects of some layers read, and how a file that can't be read is
// reported. The renderer itself never reads files: the editor preview (ScenePreview.jsx) and the
// export (backend/export.mjs) load each file once, parse it with parseCubeLut, and pass the
// results to renderSceneSvg as `luts`, a Map of src → parsed LUT (null while it is still
// loading, { error } when it can't be used). The lut effect (colorGrading.js renderLut) reads it.

import { flattenAnimations } from "../animationTree.js";
import { effectMediaSources } from "./catalog.js";
import { parseCubeLut } from "./colorMath.js";

/** The src of every .cube file that the effect operations of these layers use. */
export function layersLutSources(layers, { enabledOnly = true } = {}) {
  const sources = new Set();
  for (const layer of Array.isArray(layers) ? layers : []) {
    for (const animation of flattenAnimations(layer?.animations, { enabledOnly }))
      for (const source of effectMediaSources(animation)) sources.add(source);
  }
  return sources;
}

/** Parse the text of a .cube file for `luts`; a file that can't be used becomes { error }. */
export function loadedLut(source, text) {
  try {
    return parseCubeLut(text);
  } catch (error) {
    return { error: `${source}: ${error.message}` };
  }
}

/** The `luts` entry for a .cube file that could not be read at all. */
export function missingLut(source) {
  return { error: `The LUT ${source} could not be read. Import the .cube file again with project {action:"import", file} and set the lut effect's lut to the new src.` };
}
