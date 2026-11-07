// A catalog face is a group of Unicode subset files at one pinned package version.
// Documents name this local face URL; the byte URLs are supplied by the local service.
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

export function catalogFontSource({ id, version, weight, style }) {
  if (!ID.test(id) || !VERSION.test(version) || version.includes("..") ||
      !Number.isInteger(weight) || weight < 1 || weight > 1000 || !["normal", "italic"].includes(style))
    throw new Error("The catalog font face is invalid.");
  return `/api/fonts/fs-${id}--${version}--${weight}-${style}.ttf`;
}

export function parseCatalogFontSource(source) {
  const match = /^\/api\/fonts\/fs-([a-z0-9][a-z0-9-]{0,99})--(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)--(\d{1,4})-(normal|italic)\.ttf$/.exec(String(source ?? ""));
  if (!match) return null;
  const face = { id: match[1], version: match[2], weight: Number(match[3]), style: match[4] };
  try { return catalogFontSource(face) === source ? face : null; }
  catch { return null; }
}

export function parseUnicodeRange(value) {
  if (typeof value !== "string" || value.length > 100_000) throw new Error("Invalid font Unicode range.");
  return value.split(",").map((part) => {
    const match = /^U\+([\dA-F?]{1,6})(?:-([\dA-F]{1,6}))?$/i.exec(part.trim());
    if (!match || (match[1].includes("?") && (match[2] || !/^[\dA-F]*\?+$/i.test(match[1]))))
      throw new Error("Invalid font Unicode range.");
    const start = parseInt(match[1].replaceAll("?", "0"), 16);
    const end = parseInt(match[2] ?? match[1].replaceAll("?", "F"), 16);
    if (start > end || end > 0x10ffff) throw new Error("Invalid font Unicode range.");
    return [start, end];
  });
}

export const unicodeRangeContains = (ranges, codePoint) => ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
export const fontIgnorableCharacter = (character) => /^[\p{Default_Ignorable_Code_Point}\p{Control}]$/u.test(character);

/**
 * Choose the default subset first, then only the extra subsets this text uses. Text with
 * characters no subset has is refused; the error lists them all in `characters` (code
 * FONT_MISSING_CHARACTERS) so a caller can look for fonts that have them.
 */
export function fontSubsetsForText({ subsets, defSubset, unicodeRange }, text = "") {
  const names = [...new Set(subsets)];
  if (!names.length) throw new Error("This font has no subsets.");
  const first = names.includes(defSubset) ? defSubset : names[0];
  const ordered = [first, ...names.filter((name) => name !== first)];
  const ranges = new Map(ordered.map((name) => [name, parseUnicodeRange(unicodeRange?.[name] ?? "")]));
  const chosen = new Set([first]);
  const missing = [];
  for (const character of String(text).normalize("NFC")) {
    if (fontIgnorableCharacter(character)) continue;
    const point = character.codePointAt(0);
    if ([...chosen].some((name) => unicodeRangeContains(ranges.get(name), point))) continue;
    const name = ordered.find((subset) => unicodeRangeContains(ranges.get(subset), point));
    if (name) chosen.add(name);
    else if (!missing.includes(character)) missing.push(character);
  }
  if (missing.length) {
    const listed = missing.slice(0, 5).map((character) => JSON.stringify(character)).join(", ");
    throw Object.assign(new Error(`This font does not include ${listed}. Choose a family that supports this text.`),
      { code: "FONT_MISSING_CHARACTERS", characters: missing });
  }
  return [...chosen];
}
