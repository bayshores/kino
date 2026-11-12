import { catalogFontSource, parseCatalogFontSource } from "../engine/fontCatalogSource.js";
import { documentFontReferences, fontTextCharacters } from "../engine/fontDocuments.js";
import { fallbackFontRequests } from "../engine/fontGlyphReferences.js";
import { fallbackFaces } from "../engine/fontFallback.js";
import { textGraphemes } from "../engine/textSource.js";

const key = (value) => String(value ?? "").normalize("NFC").trim().toLowerCase();
const supports = (face, weight) => face.weight === weight ||
  (face.variableAxes?.wght && weight >= face.variableAxes.wght.min && weight <= face.variableAxes.wght.max);

export async function ensureDocumentFonts(document, catalog, { allowMissing = false, fonts } = {}) {
  const errors = [];
  for (const layer of documentFontReferences(document)) {
    const source = parseCatalogFontSource(layer.fontSource);
    if (source) {
      try { await catalog.ensureFace({ ...source, text: layer.text }); }
      catch (error) {
        if (!allowMissing) throw error;
        errors.push({ id: layer.fontSource, name: layer.fontFamily, error: error.message });
      }
    }
  }
  if (fonts) {
    await catalog.loadInto(fonts);
    errors.push(...await ensureFallbackFonts(document, fonts, catalog));
  }
  return errors;
}

/** Prewarm public fallback subsets before synchronous editor/export itemization. */
export async function ensureFallbackFonts(document, fonts, catalog) {
  const requests = fallbackFontRequests(document, fonts);
  if (!requests.length) return [];
  let families;
  try { families = (await catalog.list({ limit: 2500 })).families; }
  catch (error) { return [{ id: "glyph-fallback", name: "Character fallback", error: error.message }]; }
  const byId = new Map(families.map((family) => [family.id, family])), errors = [];
  for (const request of requests) {
    const graphemes = textGraphemes(request.text).map((part) => part.text).filter((text) => text !== "\n");
    const unresolved = () => graphemes.filter((text) => !fallbackFaces(fonts.faces, text, request.text)
      .some((face) => fonts.covers(face, text)));
    let remaining = unresolved(), lastError;
    for (const id of request.candidates) {
      if (!remaining.length) break;
      const family = byId.get(id);
      if (!family || !family.styles.includes("normal")) continue;
      const cached = fonts.faces.map((face) => parseCatalogFontSource(face.src)).filter((face) => face?.id === id && face.style === "normal")
        .sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true }))[0];
      const weight = cached?.weight ?? [...family.weights].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400))[0];
      try {
        await catalog.ensureFace({ id, ...(cached ? { version: cached.version } : {}), weight, style: "normal", text: remaining.join("\n") });
        await catalog.loadInto(fonts);
        remaining = unresolved();
      } catch (error) { lastError = error; }
    }
    if (remaining.length) errors.push({ id: `glyph-fallback:${request.candidates[0]}`, name: "Character fallback",
      error: lastError?.message ?? "Some characters have no available fallback font. Missing characters are shown as boxes." });
  }
  return errors;
}

function choiceProblem({ family, weight, style }) {
  if (typeof family !== "string" || !family.trim() || family.length > 256) return "Choose a font family.";
  if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 1000)) return "Font weight must be from 1 to 1000.";
  if (style !== undefined && !["normal", "italic"].includes(style)) return "Font style must be normal or italic.";
  return "";
}

// A catalog face for this layer's characters. When the face lacks some of them, the error also
// says which layer and face, so set_font can name fonts that have them (agent/font-help.mjs).
async function ensureLayerFace(catalog, face, layer, family) {
  try { return await catalog.ensureFace({ ...face, text: fontTextCharacters(layer) }); }
  catch (error) {
    if (error.code === "FONT_MISSING_CHARACTERS")
      Object.assign(error, { layer, face: { family, weight: face.weight, style: face.style, fontSource: catalogFontSource(face) } });
    throw error;
  }
}

/**
 * Downloads finish before any document operation. Exact local faces do not need catalog discovery.
 * A weight the family lacks becomes its nearest weight; `notes` (optional array) gets one line for it.
 */
export async function prepareFontPatches(layers, choice, { fonts, catalog, notes = null }) {
  const problem = choiceProblem(choice);
  if (problem) throw new Error(problem);
  if (choice.source !== undefined && (typeof choice.source !== "string" || choice.source.length > 512))
    throw new Error("Invalid replacement font source.");
  const local = fonts.entries().filter((face) => [face.family, ...(face.aliases ?? [])].some((name) => key(name) === key(choice.family)));
  const explicit = choice.source ? local.find((face) => face.src === choice.source) : null;
  if (choice.source && !explicit) throw new Error("That font file is unavailable in this project. Upload it again or choose another font.");
  let detailPromise;
  const detail = () => detailPromise ??= (async () => {
    const { families } = await catalog.list({ search: choice.family, limit: 2500 });
    const family = families.find((entry) => key(entry.family) === key(choice.family));
    return family ? catalog.detail(family.id) : null;
  })();
  const patches = [];
  for (const layer of layers) {
    let weight = choice.weight ?? layer.fontWeight ?? 400;
    let style = choice.style ?? layer.fontStyle ?? "normal";
    if (explicit) {
      style = explicit.style;
      weight = explicit.variableAxes?.wght ? Math.max(explicit.variableAxes.wght.min, Math.min(explicit.variableAxes.wght.max, weight)) : explicit.weight;
    }
    const pinned = key(layer.fontFamily) === key(choice.family) ? parseCatalogFontSource(layer.fontSource) : null;
    const candidates = [...local].sort((a, b) => Number(b.src === layer.fontSource) - Number(a.src === layer.fontSource));
    let face = explicit || candidates.find((entry) => {
      const source = parseCatalogFontSource(entry.src);
      return entry.style === style && supports(entry, weight) &&
        (!pinned || source?.id === pinned.id && source?.version === pinned.version);
    });
    if (face) {
      const catalogFace = parseCatalogFontSource(face.src);
      if (catalogFace) {
        const ready = await ensureLayerFace(catalog, catalogFace, layer, face.family);
        face = { ...face, family: ready.family, src: ready.src };
      }
    } else {
      const metadata = pinned ? await catalog.detail(pinned.id, { version: pinned.version }) : await detail();
      if (metadata) {
        const variants = Object.entries(metadata.variants).flatMap(([value, styles]) =>
          Object.entries(styles).filter(([, subsets]) => Object.keys(subsets).length).map(([fontStyle]) => ({ weight: Number(value), style: fontStyle })));
        if (!variants.some((entry) => entry.style === style)) style = variants.some((entry) => entry.style === "normal") ? "normal" : variants[0]?.style;
        const candidate = variants.filter((entry) => entry.style === style).sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight) || a.weight - b.weight)[0];
        if (!candidate) throw new Error(`Font “${choice.family}” has no usable static faces.`);
        weight = candidate.weight;
        face = await ensureLayerFace(catalog, { id: metadata.id, version: metadata.npmVersion ?? metadata.version, weight, style }, layer, metadata.family);
      } else if (local.length) {
        if (!local.some((entry) => entry.style === style)) style = local[0].style;
        face = local.filter((entry) => entry.style === style).sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];
        weight = face.variableAxes?.wght ? Math.max(face.variableAxes.wght.min, Math.min(face.variableAxes.wght.max, weight)) : face.weight;
      } else throw new Error(`Font “${choice.family}” is unavailable. Connect to download it, upload it, or choose a local font.`);
    }
    if (notes && choice.weight !== undefined && weight !== choice.weight) {
      const line = `${face.family} has no weight ${choice.weight}: set ${weight}, its nearest`;
      if (!notes.includes(line)) notes.push(line);
    }
    patches.push({ id: layer.id, fontFamily: face.family, fontSource: face.src || "", fontWeight: weight, fontStyle: style });
  }
  await catalog.loadInto(fonts);
  await ensureFallbackFonts({ scenes: [{ layers: layers.map((layer, index) => ({
    ...layer, ...patches[index], textStyleRanges: [],
  })) }] }, fonts, catalog);
  return patches;
}
