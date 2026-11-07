// Facts about a text layer that only the font code knows, for the polish rules
// (engine/quality/rules/polish.js): which face the renderer really draws it with, and where its
// lines break. kinoTimeline.js puts them on each text item of the checker's model.
import { defaultFonts } from "../fonts.js";
import { layoutText, resizeTextLayer } from "../textLayout.js";
import { askedAxes } from "../fontAxes.js";

const familyKey = (family) => String(family ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

/**
 * The face asked for and the face drawn: {family, weight, style, drawnFamily, drawnWeight,
 * drawnStyle}. They differ when the asked family or weight is not loaded, so the renderer falls
 * back to another family (Inter) or to the nearest weight it has. Null when no face draws at all.
 */
export function fontFacts(layer, fonts = defaultFonts) {
  const asked = { family: layer.fontFamily || "Inter", weight: Number(layer.fontWeight) || 400, style: layer.fontStyle || "normal" };
  let face;
  try { face = (fonts ?? defaultFonts).renderingFace(layer); } catch { return null; }
  if (!face) return null;
  // A variable font draws every weight on its axis, and the axes a text asks for (fontAxes.js)
  // only when the face drawn has them: `variable` confirms the variable face loaded.
  const faceAxes = face.font?.variationAxes ?? {};
  const variable = Object.keys(faceAxes).length > 0;
  const missingAxes = [...new Set(askedAxes(layer).flatMap((axes) => Object.keys(axes)))].filter((tag) => !faceAxes[tag]);
  return {
    ...asked, variable, missingAxes,
    drawnFamily: face.family ?? asked.family,
    drawnWeight: faceAxes.wght ? asked.weight : Number(face.weight) || 400,
    drawnStyle: face.style ?? "normal",
    sameFamily: familyKey(face.family) === familyKey(asked.family) && !face.missingReference,
  };
}

/**
 * The lines a laid-out text state draws: [{text, width, soft}], where `soft` is true for a line
 * the layout wrapped (the next line goes on in the same paragraph) and false for one that ends
 * its paragraph (a typed line break, or the end of the text).
 */
export function linesOf(state, fonts = defaultFonts) {
  const layout = layoutText(state, fonts ?? defaultFonts);
  const text = layout.text;
  return layout.lines.map((line) => {
    const end = line.start + line.text.length;
    return { text: line.text.trim(), width: Math.round(line.width), soft: end < text.length && text[end] !== "\n" };
  });
}

/**
 * Widths that change how a wrapped text breaks, in the layer's own pixels: `oneLine`, the width
 * that fits each paragraph on one line, and `balanced`, the narrowest width that keeps the same
 * number of lines (so the last line is as long as it can be, not one word under a long line).
 */
export function wrapWidths(layer, fonts = defaultFonts) {
  const registry = fonts ?? defaultFonts;
  const base = resizeTextLayer(layer, registry);
  const count = (width) => layoutText({ ...base, width, textResize: "height" }, registry).lines.length;
  const oneLine = Math.ceil(layoutText({ ...base, textResize: "width-height" }, registry).naturalWidth) + 2;
  const lines = count(base.width);
  let low = Math.max(1, Math.floor(oneLine / Math.max(1, lines))), high = Math.max(low, Math.ceil(Number(base.width) || oneLine));
  // The narrowest width with no more lines than now (layoutText is cached, so this is cheap).
  for (let step = 0; step < 12 && high - low > 2; step += 1) {
    const middle = Math.floor((low + high) / 2);
    if (count(middle) <= lines) high = middle; else low = middle;
  }
  return { oneLine, balanced: high + 2, lines };
}
