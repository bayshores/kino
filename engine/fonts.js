import { create } from "fontkit";
import { parseUnicodeRange } from "./fontCatalogSource.js";
import { uploadedFontMetadata } from "./fontMetadata.js";
import { faceCoversCodePoints, fallbackFaces } from "./fontFallback.js";
import { colorGlyph, createColorGlyphReader } from "./colorGlyphs.js";
import { AXIS_TAGS, animatesAxes, variationSettings } from "./fontAxes.js";

const keyFor = (family) => String(family).normalize("NFC").trim().toLocaleLowerCase();
const matchesFamily = (face, family) => [face.family, ...(face.aliases ?? [])].some((name) => keyFor(name) === keyFor(family));
const missingFont = (message) => Object.assign(new Error(message), { code: "FONT_UNAVAILABLE" });

/** Font bytes belong to this registry, never to another project's export. */
export class FontRegistry {
  constructor() {
    this.faces = [];
    this.version = 0;
    this.errors = [];
    this.coverage = new WeakMap();
    // Variable font instances per face: 16 for still text, 256 for animated axes (fontAxes.js),
    // kept apart so still text never trims (or inherits) a sweep's instances.
    this.variations = new WeakMap();
    this.animatedVariations = new WeakMap();
  }

  register(bytes, metadata = {}) {
    const font = create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    if (!font || !Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0 || typeof font.layout !== "function")
      throw new Error("This file does not contain a supported font face.");
    if (metadata.filename) metadata = { ...uploadedFontMetadata(font, metadata.filename), ...metadata };
    const family = String(metadata.family || font.familyName || "").trim();
    if (!family) throw new Error("The font has no family name.");
    const face = {
      id: String(metadata.id || `${family}-${metadata.weight || font["OS/2"]?.usWeightClass || 400}-${metadata.style || font.subfamilyName}`),
      family,
      ...(metadata.aliases?.length ? { aliases: [...new Set(metadata.aliases.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()))] } : {}),
      weight: Number(metadata.weight || font["OS/2"]?.usWeightClass || 400),
      style: metadata.style || (/italic|oblique/i.test(font.subfamilyName || "") ? "italic" : "normal"),
      ...(metadata.src ? { src: metadata.src } : {}),
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(metadata.subset ? { subset: metadata.subset, defaultSubset: metadata.defaultSubset } : {}),
      ...(metadata.unicodeRange ? { unicodeRange: metadata.unicodeRange, ranges: parseUnicodeRange(metadata.unicodeRange) } : {}),
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.version ? { packageVersion: metadata.version } : {}),
      ...(AXIS_TAGS.some((tag) => font.variationAxes?.[tag]) ? { variableAxes: Object.fromEntries(AXIS_TAGS
        .filter((tag) => font.variationAxes[tag])
        .map((tag) => [tag, { min: font.variationAxes[tag].min, max: font.variationAxes[tag].max, default: font.variationAxes[tag].default }])) } : {}),
      font,
      colorReader: createColorGlyphReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
    };
    this.faces = this.faces.filter((entry) => entry.id !== face.id);
    this.faces.push(face);
    this.version += 1;
    return this.entries().find((entry) => entry.id === face.id);
  }

  entries() { return this.faces.map(({ font, ranges, colorReader, ...entry }) => ({ ...entry })); }

  replace(registry) {
    this.faces = [...registry.faces];
    this.errors = [...registry.errors];
    this.version += 1;
  }

  resolve(layer = {}) {
    const family = layer.fontFamily || "Inter";
    const style = layer.fontStyle || "normal";
    const sourced = layer.fontSource ? this.faces.filter((face) => face.src === layer.fontSource) : null;
    if (sourced && !sourced.length)
      throw missingFont(`The linked font for “${family}” is unavailable. Import it again or choose a loaded family.`);
    // A saved upload keeps its exact face even when its old filename-derived family
    // differs from the newly grouped internal family, or another upload shares that name.
    const matches = (sourced ?? this.faces.filter((face) => matchesFamily(face, family))).filter((face) => face.style === style);
    if (!matches.length)
      throw missingFont(`Font “${family}”${style === "italic" ? " italic" : ""} is unavailable. Import that font or choose a loaded family.`);
    const weight = Number(layer.fontWeight || 400);
    const referenced = matches.find((face) => face.src === layer.fontSource && face.weight === weight &&
      (!face.subset || face.subset === face.defaultSubset)) || matches.find((face) => face.src === layer.fontSource && face.weight === weight);
    matches.sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight));
    const face = referenced || matches[0];
    // A variable face draws the asked weight and axes (fontAxes.js). An animated layer rounds
    // its values and keeps more instances, so a sweep reuses them instead of making one a frame.
    const axes = face.font.variationAxes ?? {};
    if (!AXIS_TAGS.some((tag) => axes[tag])) return face;
    const animated = animatesAxes(layer);
    const settings = variationSettings(axes, layer, { quantize: animated });
    const key = JSON.stringify(settings);
    const store = animated ? this.animatedVariations : this.variations;
    let variations = store.get(face.font);
    if (!variations) { variations = new Map(); store.set(face.font, variations); }
    let font = variations.get(key);
    if (!font) {
      font = Object.keys(settings).length ? face.font.getVariation(settings) : face.font;
      variations.set(key, font);
    } else { variations.delete(key); variations.set(key, font); }
    if (variations.size > (animated ? 256 : 16)) variations.delete(variations.keys().next().value);
    return { ...face, font, ...(Object.keys(settings).length ? { variation: settings } : {}) };
  }

  /** Drawing can use an available face while the original reference remains recoverable. */
  renderingFace(layer = {}) {
    try { return this.resolve(layer); }
    catch (error) {
      if (error.code !== "FONT_UNAVAILABLE") throw error;
      const available = this.faces.some((face) => matchesFamily(face, layer.fontFamily)) ? layer.fontFamily : "Inter";
      const family = this.faces.some((face) => matchesFamily(face, available)) ? available : this.faces[0]?.family;
      if (!family) throw error;
      const style = this.faces.some((face) => matchesFamily(face, family) && face.style === layer.fontStyle) ? layer.fontStyle :
        (this.faces.find((face) => matchesFamily(face, family) && face.style === "normal")?.style ?? this.faces.find((face) => matchesFamily(face, family)).style);
      return { ...this.resolve({ ...layer, fontSource: "", fontFamily: family, fontStyle: style }), missingReference: true };
    }
  }

  covers(face, text) {
    // Space and formatting controls need advances, not visible font artwork.
    // Emoji subsets often omit their cmap entries entirely.
    if (/^[\s\p{Default_Ignorable_Code_Point}\p{Control}]*$/u.test(text)) return true;
    let cache = this.coverage.get(face.font);
    if (!cache) { cache = new Map(); this.coverage.set(face.font, cache); }
    const key = `${face.id}:${text}`;
    if (cache.has(key)) return cache.get(key);
    let supported = false;
    try {
      supported = faceCoversCodePoints(face, text) && face.font.layout(text).glyphs.every((glyph) => {
        const source = glyph.codePoints?.length ? glyph.codePoints.map((point) => String.fromCodePoint(point)).join("") : text;
        if (/^[\s\p{Default_Ignorable_Code_Point}\p{Control}]*$/u.test(source)) return true;
        if (!glyph.id) return false;
        const color = colorGlyph(face, glyph, 128);
        if (color) return color.kind !== "unsupported";
        return Boolean(glyph.path?.toSVG());
      });
    } catch { /* The rest of this text can still use a different face. */ }
    cache.set(key, supported);
    if (cache.size > 10_000) cache.delete(cache.keys().next().value);
    return supported;
  }

  /** One face per complete grapheme; adjacent faces coalesce before contextual shaping. */
  textRuns(text, layer = {}) {
    const base = this.renderingFace(layer);
    const faces = base.subset ? this.faces.filter((face) => face.src === base.src && face.weight === base.weight && face.style === base.style) : [];
    const ordered = [base, ...faces.filter((face) => face.id !== base.id)];
    const runs = [];
    for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      let face = ordered.find((entry) => this.covers(entry, part.segment));
      if (!face) {
        const fallback = fallbackFaces(this.faces, part.segment, layer.text ?? text)
          .find((entry) => this.covers(entry, part.segment));
        face = fallback ? { ...fallback, fallbackFor: base.family }
          : { ...base, id: `${base.id}:missing`, missingGlyph: true, missingFor: base.family };
      }
      const previous = runs.at(-1);
      if (previous?.face.id === face.id) previous.text += part.segment;
      else runs.push({ text: part.segment, start: part.index, face });
    }
    return runs.length ? runs : [{ text, start: 0, face: base }];
  }
}

// Browser catalogs are scoped by the service. Node's default contains bundled
// fonts only; custom export registries are passed explicitly.
export const defaultFonts = new FontRegistry();
