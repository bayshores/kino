// The face a text is really drawn in, said at the call that names it (board, add_layer, set_font,
// compose, update_layer). A family or weight that is not loaded draws in another face at the render
// (fontFacts: Inter, or the family's nearest weight), and before this the fact came only in the
// render receipt (run dm3-b: a display face at 800 was taken at the board and rendered Inter 700).
// A face the project's imported fonts, kino's bundled fonts or kino's font cache already hold is
// set on the layer at once; any other gets one line: the face drawn now and the one call that loads it.
import { fontFacts } from "../../engine/quality/textFacts.js";

const key = (name) => String(name ?? "").trim().toLowerCase();
const named = (face, family) => [face.family, ...(face.aliases ?? [])].some((name) => key(name) === key(family));
const supports = (face, weight) => face.weight === weight
  || Boolean(face.variableAxes?.wght && weight >= face.variableAxes.wght.min && weight <= face.variableAxes.wght.max);
const faceName = (family, weight, style) => `${family} ${weight}${style === "italic" ? " italic" : ""}`;
const nearest = (weights, weight) => [...weights].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || a - b)[0];

/** Where a loaded face came from, in words. */
export function faceOrigin(face) {
  const id = String(face?.id ?? ""), src = String(face?.src ?? "");
  if (id.startsWith("bundled:")) return "kino's bundled fonts";
  if (src.startsWith("/api/media/")) return "the project's imported fonts";
  return "kino's font cache";
}

/**
 * The face a text layer ({fontFamily, fontWeight, fontStyle, fontSource?}) draws in with `fonts`
 * (a FontRegistry), when it is not the one asked: {asked, drawn, family, weight, style, loaded}
 * (`loaded`: the weights of that family loaded, empty when the family is not). Null when it draws as
 * asked (a weight within 100 of the asked one counts, as check's font_fallback counts it).
 */
export function faceOff(layer, fonts) {
  const facts = fontFacts({ text: "A", ...layer }, fonts);
  if (!facts) return null;
  if (facts.sameFamily && Math.abs(facts.drawnWeight - facts.weight) < 100 && facts.drawnStyle === facts.style) return null;
  const loaded = [...new Set((fonts?.faces ?? []).filter((face) => named(face, facts.family) && face.style === facts.style).map((face) => face.weight))].sort((a, b) => a - b);
  return { asked: faceName(facts.family, facts.weight, facts.style), drawn: faceName(facts.drawnFamily, facts.drawnWeight, facts.drawnStyle),
    family: facts.family, weight: facts.weight, style: facts.style, loaded };
}

/** A loaded face of exactly that family, weight and style (the project's, kino's bundled, or cached), or null. */
export function localFace(fonts, family, weight, style = "normal") {
  return (fonts?.faces ?? []).find((face) => named(face, family) && (face.style ?? "normal") === style && supports(face, weight)) ?? null;
}

/**
 * The one call that loads the face `off` (faceOff) asks for, for the layers `refs` (their names or
 * codes; null on a board, whose layers come at its build): set_font with the family and the weight
 * kino's font catalog has (it downloads it), else a font file to import.
 */
export async function loadCall(off, refs, catalog) {
  let entry = null;
  try { entry = ((await catalog?.list?.({ search: off.family, limit: 50 }))?.families ?? []).find((one) => key(one.family) === key(off.family)) ?? null; }
  catch { /* the catalog could not be read (offline, no list): only the import is named */ }
  const layers = refs?.length ? `layers:${JSON.stringify(refs)}` : `layers:["<its built text layer>"]`;
  if (entry) {
    const has = entry.variable || entry.weights.includes(off.weight);
    const weight = has ? off.weight : nearest(entry.weights, off.weight);
    const call = `set_font {${layers}, family:${JSON.stringify(entry.family)}, weight:${weight}${off.style === "italic" ? ', style:"italic"' : ""}}`;
    return has ? `${call} loads it from kino's font catalog` : `kino's font catalog has ${entry.family} ${entry.weights.join(", ")}: ${call} loads the nearest`;
  }
  const file = `project {action:"import", file:"<a ${off.family} ${off.weight} font file>"} loads it`;
  if (off.loaded.length) return `kino's font catalog lists no ${off.family} ${off.weight}: weight ${nearest(off.loaded, off.weight)} draws as asked, or ${file}`;
  return `no font kino has or can fetch is named that: ${file}`;
}

/** The loaded weights of `off`'s family, in words ("" when none). */
export const loadedWeights = (off) => (off.loaded.length ? ` (${off.family} loaded here: ${off.loaded.join(", ")})` : "");

/**
 * The receipt lines for the text layers `layers` of an edit (the ones it made or changed), at most
 * `limit`, one per asked face. A face loaded locally that the layer's fontSource did not reach (it
 * names another file) is set on the layer in place (`layer.fontSource`, `layer.fontFamily`) and said.
 */
export async function faceAtCallNotes(layers, { fonts, catalog = null, nameOf = (layer) => layer.name ?? layer.id, limit = 3 } = {}) {
  const lines = [];
  const byFace = new Map();
  for (const layer of layers) {
    if (layer?.type !== "text" || !String(layer.text ?? "").trim()) continue;
    const off = faceOff(layer, fonts);
    if (!off) continue;
    const local = localFace(fonts, off.family, off.weight, off.style);
    if (local && local.src && local.src !== layer.fontSource && !faceOff({ ...layer, fontFamily: local.family, fontSource: local.src }, fonts)) {
      Object.assign(layer, { fontFamily: local.family, fontSource: local.src });
      lines.push(`font: ${nameOf(layer)} ${off.asked} loaded from ${faceOrigin(local)} (its fontSource named another face, so it drew in ${off.drawn})`);
      continue;
    }
    const face = `${key(off.family)}|${off.weight}|${off.style}`;
    if (!byFace.has(face)) byFace.set(face, { off, refs: [] });
    byFace.get(face).refs.push(nameOf(layer));
  }
  for (const { off, refs } of byFace.values()) {
    const whose = refs.slice(0, 4).join(", ") + (refs.length > 4 ? ` and ${refs.length - 4} more` : "");
    lines.push(`font: ${whose} ${refs.length === 1 ? "asks" : "ask"} ${off.asked}, not loaded: drawn in ${off.drawn} now${loadedWeights(off)}; ${await loadCall(off, refs, catalog)}`);
  }
  return lines.slice(0, limit);
}
