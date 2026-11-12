// Help for text whose font lacks a character (such as ∞): fonts that really draw it, and the one
// update_layer op that draws just those characters in such a font with a textStyleRanges range.
// set_font refusals, check's missing_glyphs warning and library {topic:"fonts"} use it.
//
// Installed faces (bundled, uploaded or already downloaded) are looked at glyph by glyph first.
// Then a few catalog families. The catalog lists each subset's Unicode range, but a range can
// include a character its file lacks (Noto Sans Symbols 2 lists ∞ and has none), so a range only
// rules a family out: kino downloads the subset and looks at the real glyph before naming it.
import { fontIgnorableCharacter, parseCatalogFontSource, parseUnicodeRange, unicodeRangeContains } from "../../engine/fontCatalogSource.js";
import { fallbackCatalogIds } from "../../engine/fontFallback.js";
import { KINO_OWN_FAMILIES } from "../../engine/footage/treatments.js";
import { textGraphemes } from "../../engine/textSource.js";
import { withTextStylePatches, withWholeTextStyle } from "../../engine/textStyleRanges.js";

// Tried after the renderer's own fallback families for the characters: families with wide symbol coverage.
const WIDE_FAMILIES = ["roboto", "open-sans", "lora", "onest", "noto-sans-symbols", "noto-sans-symbols-2"];
const MAX_DOWNLOADS = 6;
const LISTED = 15;

const quoted = (characters) => characters.slice(0, 5).map((character) => JSON.stringify(character)).join(", ");
const nearest = (values, wanted) => [...values].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b)[0];

/** "Roboto 900", "Lora 400 italic" */
export const fontLabel = (font) => `${font.family} ${font.weight}${font.style === "italic" ? " italic" : ""}`;
// "Roboto 400 (fontSource /api/fonts/…)": what a textStyleRanges style needs to use that font.
const withSource = (font) => `${fontLabel(font)} (fontSource ${font.fontSource})`;

// The kind of face a family is, so a stand-in can be of the same kind: "serif", "monospace" or
// "sans" (sans-serif, display and handwriting faces, whose missing characters look best in a
// sans), from the catalog's category, else from the name ("Noto Serif", "Roboto Mono"). Undefined
// when neither says.
function kindOf(family, categories) {
  const category = categories.get(String(family ?? "").toLowerCase());
  if (category) return category === "serif" || category === "monospace" ? category : "sans";
  if (/serif/i.test(family) && !/sans/i.test(family)) return "serif";
  if (/\bmono\b|\bcode\b/i.test(family)) return "monospace";
  return /sans/i.test(family) ? "sans" : undefined;
}

/**
 * Up to `limit` fonts that draw every one of `characters` (graphemes), one per family: fonts of
 * the same kind as `family` (the font that lacks them: a sans for Anton, not a serif) first, then
 * the weight nearest `weight`, then the order kino tries catalog families in (so installing the
 * fonts it named does not reorder them): { fonts: [{family, weight, style, fontSource}], catalogError? }.
 * `fonts` is the project's FontRegistry; catalog faces this downloads are added to it.
 */
export async function fontsWithCharacters(characters, { fonts, catalog, family, weight = 400, style = "normal", limit = 3 }) {
  const wanted = [...new Set(characters)].filter((character) => character.trim());
  if (!wanted.length) return { fonts: [] };

  // The catalog: which families it has (offline, only the families already downloaded) and
  // each one's category.
  let catalogError;
  let inCatalog = new Map();
  const categories = new Map();
  if (catalog) {
    try {
      const { families, error, downloadsEnabled } = await catalog.list();
      inCatalog = new Map(families.map((entry) => [entry.id, entry.family]));
      for (const entry of families) if (entry.category) categories.set(entry.family.toLowerCase(), entry.category);
      catalogError = error ?? (downloadsEnabled ? undefined : "font downloads are off");
    } catch (error) { catalogError = error.message; }
  }
  const kind = family ? kindOf(family, categories) : undefined;
  const sameKind = (name) => !kind || kindOf(name, categories) === kind;
  // The catalog families tried, in order: the renderer's fallback families for these characters,
  // then WIDE_FAMILIES.
  const tried = [...new Set([...wanted.flatMap((character) => fallbackCatalogIds(character)), ...WIDE_FAMILIES])];
  const triedIndex = (font) => {
    const index = tried.indexOf(parseCatalogFontSource(font.fontSource)?.id);
    return index < 0 ? tried.length : index;
  };
  const found = [];
  const draws = (faces) => wanted.every((character) => faces.some((face) => fonts.covers(face, character)));
  const add = (font) => { if (!found.some((other) => other.family === font.family)) found.push(font); };
  // The search stops at `limit` fonts once one of them is of the same kind.
  const enough = () => found.length >= limit && found.some((font) => sameKind(font.family));

  // Installed: the subset files of one catalog face share its src, so they are looked at together.
  const bySource = new Map();
  for (const face of fonts.faces) if (face.src && face.style === style) {
    if (!bySource.has(face.src)) bySource.set(face.src, []);
    bySource.get(face.src).push(face);
  }
  [...bySource.values()].filter(draws).map(([face]) => ({ family: face.family, weight: face.weight, style, fontSource: face.src }))
    .sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight)).forEach(add);

  // Catalog: the families tried, the ones of the same kind first.
  let downloads = 0;
  const ids = tried.filter((id) => inCatalog.has(id))
    .sort((a, b) => Number(!sameKind(inCatalog.get(a))) - Number(!sameKind(inCatalog.get(b))));
  for (const id of ids) {
    if (enough() || downloads >= MAX_DOWNLOADS) break;
    try {
      const detail = await catalog.detail(id);
      if (found.some((font) => font.family === detail.family)) continue;
      const faceStyle = Object.values(detail.variants).some((styles) => styles[style]) ? style : "normal";
      const faceWeight = nearest(Object.keys(detail.variants).map(Number).filter((value) => detail.variants[value][faceStyle]), weight);
      if (faceWeight === undefined) continue;
      const ranges = detail.variants[faceWeight][faceStyle].map((subset) => parseUnicodeRange(detail.unicodeRange[subset]));
      const listed = (character) => [...character].every((part) => fontIgnorableCharacter(part) ||
        ranges.some((range) => unicodeRangeContains(range, part.codePointAt(0))));
      if (!wanted.every(listed)) continue;
      downloads += 1;
      const ready = await catalog.ensureFace({ id, version: detail.version, weight: faceWeight, style: faceStyle, text: wanted.join("") });
      await catalog.loadInto(fonts);
      if (draws(fonts.faces.filter((face) => face.src === ready.src)))
        add({ family: ready.family, weight: faceWeight, style: faceStyle, fontSource: ready.src });
    } catch (error) { catalogError = error.message; }
  }
  const ranked = found.sort((a, b) => Number(!sameKind(a.family)) - Number(!sameKind(b.family)) ||
    Math.abs(a.weight - weight) - Math.abs(b.weight - weight) || triedIndex(a) - triedIndex(b)).slice(0, limit);
  return { fonts: ranked, ...(catalogError && !ranked.length ? { catalogError } : {}) };
}

// The graphemes of the layer's own text that hold one of `characters` (code points or graphemes).
function graphemesWith(layer, characters) {
  const wanted = new Set(characters);
  return textGraphemes(layer.text).filter((part) => wanted.has(part.text) || [...part.text].some((point) => wanted.has(point)));
}

/**
 * The layer with only the graphemes that hold `characters` drawn in `font`: one textStyleRanges
 * range per run, other ranges kept. Null when the layer's own text has none of them (they come
 * from a Change text animation, say).
 */
export function withCharactersInFont(layer, characters, font) {
  const style = { fontFamily: font.family, fontWeight: font.weight, fontSource: font.fontSource,
    ...(font.style !== (layer.fontStyle || "normal") ? { fontStyle: font.style } : {}) };
  const patches = [];
  for (const part of graphemesWith(layer, characters)) {
    const previous = patches.at(-1);
    if (previous?.end === part.start) previous.end = part.end;
    else patches.push({ start: part.start, end: part.end, style });
  }
  return patches.length ? withTextStylePatches(layer, patches) : null;
}

// Characters shown only by a Change text or Counter animation are not in the layer's own text,
// so no textStyleRanges range can hold them.
const NOT_IN_TEXT = "They come from an animation's text (Change text or Counter), which a range cannot hold: choose one of these fonts for the layer, or change that text.";

function nothingFound(characters, catalogError) {
  return `No installed font and no catalog font kino looked at has ${quoted(characters)}${catalogError ? ` (the catalog could not be searched: ${catalogError})` : ""}. Change the text, or project import a font file that has ${characters.length === 1 ? "it" : "them"}.`;
}

/**
 * set_font cannot give some layers the face it chose: each lacks some of its characters.
 * `lacking` is [{ layer, layerRef, characters, choice }], `choice` the face ({family, weight,
 * style, fontSource}). Returns { message, instead? }: `instead` holds one update_layer op per
 * layer that sets the face and draws just those characters in the first font that has them. It
 * is given only when every layer has such an op.
 */
export async function missingCharactersHelp(lacking, { fonts, catalog, opNumber = "<op number>" }) {
  const searches = new Map();
  const notes = new Map(); // what a layer lacks and the fonts that have it → the layers it is true of
  const note = (text, layerRef) => notes.set(text, [...(notes.get(text) ?? []), layerRef]);
  const instead = [];
  let firstFont;
  for (const { layer, layerRef, characters, choice } of lacking) {
    const searched = graphemesWith(layer, characters).map((part) => part.text);
    const wanted = searched.length ? searched : characters;
    // Layers that lack the same characters share one search.
    const key = JSON.stringify([wanted, choice.weight, choice.style]);
    if (!searches.has(key)) searches.set(key, fontsWithCharacters(wanted, { fonts, catalog, family: choice.family, weight: choice.weight, style: choice.style }));
    const { fonts: found, catalogError } = await searches.get(key);
    const lacks = `${choice.family} does not include ${quoted(characters)}.`;
    if (!found.length) { note(`${lacks} ${nothingFound(characters, catalogError)}`, layerRef); continue; }
    const face = { fontFamily: choice.family, fontWeight: choice.weight, fontStyle: choice.style, fontSource: choice.fontSource };
    const next = withCharactersInFont(withWholeTextStyle(layer, face), characters, found[0]);
    const named = `Fonts with ${characters.length === 1 ? "it" : "them"} (glyphs checked): ${found.map(withSource).join(", ")}.`;
    if (!next) { note(`${lacks} ${named} ${NOT_IN_TEXT}`, layerRef); continue; }
    note(`${lacks} ${named}`, layerRef);
    firstFont ??= found[0];
    instead.push({ op: "update_layer", layerId: layerRef, properties: { ...face, textStyleRanges: next.textStyleRanges } });
  }
  const said = [...notes].map(([text, refs]) => (lacking.length > 1 ? `${refs.join(", ")}: ${text}` : text)).join(" ");
  if (instead.length < lacking.length) return { message: said };
  const [{ characters, choice }] = lacking;
  const drawn = lacking.length > 1 ? "the characters each layer lacks in the first font named for it"
    : `${quoted(characters)} in ${fontLabel(firstFont)}`;
  return {
    message: `${said} "instead" keeps ${choice.family} and draws only ${drawn} (a textStyleRanges range); edit {retry, fix:{"${opNumber}": instead}} sends it in place of this op.`,
    instead,
  };
}

/**
 * check's missing_glyphs warning: { message, fix }. The message names fonts that have the
 * characters; the fix is the update_layer op that draws just those characters in the first.
 */
export async function missingGlyphsHelp({ layer, layerRef, characters, fonts, catalog }) {
  const { fonts: found, catalogError } = await fontsWithCharacters(characters,
    { fonts, catalog, family: layer.fontFamily, weight: layer.fontWeight || 400, style: layer.fontStyle || "normal" });
  if (!found.length) return { message: "", fix: nothingFound(characters, catalogError) };
  const next = withCharactersInFont(layer, characters, found[0]);
  const message = `${found.map(withSource).join(", ")} ${found.length === 1 ? "has" : "have"} them (glyphs checked)`;
  if (!next) return { message: `${message}.`, fix: NOT_IN_TEXT };
  return { message: `${message}; the fix draws only those characters in ${fontLabel(found[0])}.`,
    fix: { op: "update_layer", layerId: layerRef, properties: { textStyleRanges: next.textStyleRanges } } };
}

// Words that describe a face, not name one: the catalog's category, a weight and name parts.
const CLASS_WORDS = { serif: "serif", sans: "sans-serif", sansserif: "sans-serif", mono: "monospace", monospace: "monospace", script: "handwriting", brush: "handwriting", hand: "handwriting", handwriting: "handwriting", handwritten: "handwriting",
  marker: "handwriting", scrawl: "handwriting", scribble: "handwriting", cursive: "handwriting", calligraphy: "handwriting", display: "display" };
// Style words the catalog has no tag for (Fontsource lists a category and subsets only): a family
// fits when its name holds any of the parts. GUESS: common family names, not a measured list.
const STYLE_NAMES = {
  stencil: ["stencil"], slab: ["slab"], blackletter: ["fraktur", "gotisch", "pirata", "blackletter", "jacquard", "new rocker", "metal mania"],
  typewriter: ["typewriter", "special elite", "courier", "cutive"], grunge: ["dirt", "distressed", "grunge", "spray", "burned", "scratch", "rock salt", "special elite"],
  distressed: ["dirt", "distressed", "grunge", "spray", "burned", "scratch", "rock salt", "special elite"], scratchy: ["scratch", "rock salt", "special elite", "dirt", "distressed"],
};
// Words that put a category's families with that word in their name first (GUESS, same source).
const BOOST_NAMES = { brush: ["brush"], marker: ["marker"], scrawl: ["scrawl", "scribble", "rock salt", "reenie", "marker"], scribble: ["scribble", "scrawl"], calligraphy: ["calligraphy", "brush"] };
// Writing systems: the catalog's subset names that start with it (a family has the script when it lists the subset).
const SUBSET_WORDS = { japanese: "japanese", kanji: "japanese", kana: "japanese", korean: "korean", hangul: "korean", chinese: "chinese", arabic: "arabic", hebrew: "hebrew", thai: "thai",
  cyrillic: "cyrillic", russian: "cyrillic", greek: "greek", devanagari: "devanagari", hindi: "devanagari", vietnamese: "vietnamese" };
const WEIGHT_WORDS = {
  bold: (weights) => Math.max(...weights) >= 700, heavy: (weights) => Math.max(...weights) >= 800, extra: (weights) => Math.max(...weights) >= 800, ultra: (weights) => Math.max(...weights) >= 800,
  black: (weights) => Math.max(...weights) >= 900, thin: (weights) => Math.min(...weights) <= 300, light: (weights) => Math.min(...weights) <= 300,
};
const WEIGHT_LABELS = { bold: "700+", heavy: "800+", extra: "800+", ultra: "800+", black: "900", thin: "300-", light: "300-" };
// condensed and narrow only appear in a family's name: they rank a category's families, or with no category word pick by name.
const NAME_WORDS = ["condensed", "narrow", "mono"];
const FILLER_WORDS = ["a", "an", "and", "the", "with", "very", "or", "of", "font", "fonts", "typeface", "type"];

/**
 * {categories, weights, names, styles, boost, scripts, ignored, single} for a search that holds a
 * class, style or script word (2+ words, or one such word alone: "brush", "japanese"), else null.
 */
function lookOf(term) {
  // "sans serif" and "sans-serif" are one category; "extra light" is a light weight, not a heavy one.
  const words = term.toLowerCase().replace(/sans[\s-]*serif/g, "sansserif").replace(/\b(?:extra|ultra)[\s-]*(light|thin)\b/g, "$1").match(/[a-z]+/g) ?? [];
  // "japanese script" names a writing system; "script" alone is a handwriting face.
  const scripts = [...new Set(words.filter((word) => SUBSET_WORDS[word]).map((word) => SUBSET_WORDS[word]))];
  const kept = scripts.length ? words.filter((word) => word !== "script") : words;
  const known = (word) => CLASS_WORDS[word] || NAME_WORDS.includes(word) || STYLE_NAMES[word] || SUBSET_WORDS[word];
  if (!kept.some(known)) return null;
  const categories = [...new Set(kept.filter((word) => CLASS_WORDS[word]).map((word) => CLASS_WORDS[word]))];
  const weights = kept.filter((word) => WEIGHT_WORDS[word]);
  const names = kept.filter((word) => NAME_WORDS.includes(word));
  const styles = kept.filter((word) => STYLE_NAMES[word]);
  const boost = kept.flatMap((word) => BOOST_NAMES[word] ?? []);
  const ignored = kept.filter((word) => !known(word) && !WEIGHT_WORDS[word] && !FILLER_WORDS.includes(word));
  return { categories, weights, names, styles, boost, scripts, ignored, single: words.length === 1 };
}

// library {topic:"fonts", search:"condensed bold sans"}: catalog families of that kind, by their category, weights, style words and scripts.
async function lookFamilies({ categories, weights, names, styles = [], boost = [], scripts = [], ignored }, term, catalog) {
  const { families: all, offline } = await catalog.list({ limit: 2500 });
  const hasName = (family, word) => family.family.toLowerCase().includes(word);
  const hasAny = (family, parts) => parts.some((part) => hasName(family, part));
  // With no category word, the name words pick the families (every category is searched). A style
  // word (stencil, slab) always needs its name part; a script needs that subset in the family.
  const matches = all.filter((family) => (categories.length ? categories.includes(family.category) : names.every((word) => hasName(family, word)))
    && weights.every((word) => WEIGHT_WORDS[word](family.weights))
    && styles.every((word) => hasAny(family, STYLE_NAMES[word]))
    && scripts.every((script) => (family.subsets ?? []).some((subset) => subset.startsWith(script))));
  const own = new Set(KINO_OWN_FAMILIES);
  const named = (family) => names.filter((word) => hasName(family, word)).length + Number(hasAny(family, boost));
  // Best fit first: name words, then families kino does not pick itself, then more weights, then A to Z.
  matches.sort((a, b) => named(b) - named(a) || own.has(a.family) - own.has(b.family) || b.weights.length - a.weights.length || a.family.localeCompare(b.family));
  const range = (family) => (family.weights[0] === family.weights.at(-1) ? `${family.weights[0]}` : `${family.weights[0]}-${family.weights.at(-1)}`);
  const kind = [...(categories.length ? categories : ["all categories"]), ...weights.map((word) => WEIGHT_LABELS[word]), ...styles, ...scripts].join(", ");
  const listed = matches.slice(0, LISTED);
  const label = (family) => `${family.family} ${range(family)}${own.has(family.family) ? " [kino's own]" : ""}`;
  return [
    `catalog${offline ? " (offline: cached list)" : ""}, look ${JSON.stringify(term)} (${kind}, ${matches.length} match${ignored.length ? `; ignored: ${ignored.join(", ")}` : ""}): ${listed.map(label).join(", ") || "none match; use fewer words"}${matches.length > LISTED ? ` +${matches.length - LISTED} more` : ""}`,
    "Compare by eye with the reference strip; set_font {layerIds, family, weight} downloads the one you pick."
    + (listed.some((family) => own.has(family.family)) ? ` [kino's own] fonts are flagged by check unless a style line at a saved reference's moment names them (notes brief, style lines).` : ""),
  ].join("\n");
}

/**
 * library {topic:"fonts", search}: installed families and catalog families whose name has
 * `search`, or, when `search` is one character, the fonts that really draw it.
 */
export async function fontsLibraryText(search, { fonts, catalog }) {
  const term = String(search ?? "").trim();
  if (textGraphemes(term).length === 1) {
    const { fonts: found, catalogError } = await fontsWithCharacters([term], { fonts, catalog, limit: 5 });
    if (!found.length) return nothingFound([term], catalogError);
    return [`fonts with ${JSON.stringify(term)} (glyphs checked): ${found.map((font) => `${fontLabel(font)} ${font.fontSource}`).join(", ")}`,
      `To draw only ${JSON.stringify(term)} in one, give it a textStyleRanges range {start, end, style:{fontFamily, fontWeight, fontSource}} with update_layer; check's missing_glyphs fix is that op.`].join("\n");
  }
  const lower = term.toLowerCase();
  const installed = [...new Set(fonts.entries().map((face) => face.family))].filter((family) => !lower || family.toLowerCase().includes(lower));
  const { families, total = families.length, offline } = await catalog.list({ search: term, limit: LISTED });
  // No family name holds the whole search, but its words describe a look ("condensed bold sans").
  const wanted = lookOf(term);
  if (wanted && total === 0 && !installed.length) return lookFamilies(wanted, term, catalog);
  // One class, style or script word alone ("brush", "stencil", "japanese") names a look, not a family: the look's families, best fit first.
  if (wanted?.single && !families.some((family) => family.family.toLowerCase() === lower))
    return [...(installed.length ? [`installed: ${installed.slice(0, LISTED).join(", ")}${installed.length > LISTED ? ` +${installed.length - LISTED} more` : ""}`] : []), await lookFamilies(wanted, term, catalog)].join("\n");
  // A few families that only contain the words ("brush script" in "Nanum Brush Script") are not a name: the look is offered too.
  const partial = wanted && total > 0 && total <= 3 && !installed.length && !families.some((family) => family.family.toLowerCase().startsWith(lower));
  const more = (shown, count) => count > shown ? ` +${count - shown} more` : "";
  const narrow = 'search a name (such as "Roboto") or one character (such as "∞") to narrow.';
  return [
    `installed: ${installed.slice(0, LISTED).join(", ") || "none match"}${more(Math.min(LISTED, installed.length), installed.length)}`,
    `catalog${offline ? " (offline: cached list)" : ""}: ${families.map((family) => `${family.family} ${family.weights.join("/")}`).join(", ") || "none match"}${more(families.length, total)}${total > families.length ? `; ${narrow}` : ""}`,
    "set_font {layerIds, family, weight} downloads a catalog font when needed.",
    ...(partial ? [await lookFamilies(wanted, term, catalog)] : []),
  ].join("\n");
}
