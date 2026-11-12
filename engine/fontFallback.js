import { fontIgnorableCharacter, parseCatalogFontSource, unicodeRangeContains } from "./fontCatalogSource.js";

const scriptFamilies = [
  ["Arabic", "noto-sans-arabic"], ["Hebrew", "noto-sans-hebrew"],
  ["Devanagari", "noto-sans-devanagari"], ["Bengali", "noto-sans-bengali"],
  ["Gurmukhi", "noto-sans-gurmukhi"], ["Gujarati", "noto-sans-gujarati"],
  ["Oriya", "noto-sans-oriya"], ["Tamil", "noto-sans-tamil"],
  ["Telugu", "noto-sans-telugu"], ["Kannada", "noto-sans-kannada"],
  ["Malayalam", "noto-sans-malayalam"], ["Sinhala", "noto-sans-sinhala"],
  ["Thai", "noto-sans-thai"], ["Lao", "noto-sans-lao"],
  ["Tibetan", "noto-serif-tibetan"], ["Myanmar", "noto-sans-myanmar"],
  ["Khmer", "noto-sans-khmer"], ["Ethiopic", "noto-sans-ethiopic"],
  ["Georgian", "noto-sans-georgian"], ["Armenian", "noto-sans-armenian"],
  ["Hangul", "noto-sans-kr"], ["Hiragana", "noto-sans-jp"], ["Katakana", "noto-sans-jp"],
].map(([script, id]) => ({ test: new RegExp(`\\p{Script_Extensions=${script}}`, "u"), id }));

/** Presentation selectors and whole emoji sequences stay with their grapheme. */
export function isEmojiGrapheme(text) {
  if (text.includes("\ufe0e")) return false;
  return /\p{Emoji_Presentation}/u.test(text) || /^[#*0-9]\ufe0f?\u20e3$/u.test(text) ||
    (text.includes("\ufe0f") && /\p{Emoji}/u.test(text)) ||
    (text.includes("\u200d") && /\p{Extended_Pictographic}/u.test(text));
}

// Han characters are shared by Chinese, Japanese and Korean fonts. The line's own other script picks
// the form tried first (kana: Japanese, Hangul: Korean, neither: Simplified Chinese); the other CJK
// families follow, so a computer that has only one of them installed still draws the characters
// that family has, instead of boxes. Whether a family really has each character is checked per face.
function hanFamilies(context) {
  const first = /\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}/u.test(context) ? "noto-sans-jp"
    : /\p{Script_Extensions=Hangul}/u.test(context) ? "noto-sans-kr" : "noto-sans-sc";
  return [first, ...["noto-sans-sc", "noto-sans-tc", "noto-sans-hk", "noto-sans-jp", "noto-sans-kr"].filter((id) => id !== first)];
}

/** Catalog candidates, in order. Their actual subset coverage is checked before use. */
export function fallbackCatalogIds(grapheme, context = grapheme) {
  if (!grapheme || /^[\s\p{Default_Ignorable_Code_Point}\p{Control}]+$/u.test(grapheme)) return [];
  if (isEmojiGrapheme(grapheme)) return ["noto-color-emoji"];
  const script = scriptFamilies.find(({ test }) => test.test(grapheme));
  if (script) return [script.id, "noto-sans"];
  if (/\p{Script_Extensions=Han}/u.test(grapheme)) return hanFamilies(context);
  if (/[\p{Script_Extensions=Latin}\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}]/u.test(grapheme))
    return ["noto-sans"];
  return ["noto-sans-symbols-2", "noto-sans-symbols", "noto-sans"];
}

export function faceCoversCodePoints(face, text) {
  return [...text].every((character) => fontIgnorableCharacter(character) ||
    ((!face.ranges || unicodeRangeContains(face.ranges, character.codePointAt(0))) &&
      face.font.hasGlyphForCodePoint(character.codePointAt(0))));
}

/** Computed fallbacks use public catalog faces, never another uploaded font. */
export function fallbackFaces(faces, grapheme, context) {
  const ids = fallbackCatalogIds(grapheme, context);
  return faces.filter((face) => {
    const source = parseCatalogFontSource(face.src);
    return source && ids.includes(source.id) && face.style === "normal";
  }).sort((left, right) => {
    const a = parseCatalogFontSource(left.src), b = parseCatalogFontSource(right.src);
    return ids.indexOf(a.id) - ids.indexOf(b.id) || Math.abs(left.weight - 400) - Math.abs(right.weight - 400) ||
      left.src.localeCompare(right.src, "en", { numeric: true }) || left.id.localeCompare(right.id);
  });
}
