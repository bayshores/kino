// The material a video is made from, as the person gave it: their message, a README, a script,
// a transcript. Saved with the source op as document.sources = [{ name, text }]. check's
// own_words rule names on-screen words that are in none of them, so copy the agent made up is
// easy to see (and to keep on purpose).
import { isRecord } from "./numbers.js";

export const SOURCE_LIMITS = Object.freeze({ count: 12, name: 60, text: 8000 });

/** Keeps document.sources in shape when a document is read: entries that do not fit are left out. */
export function normalizeSources(document) {
  if (!Array.isArray(document.sources)) { delete document.sources; return document; }
  const names = new Set();
  const kept = [];
  for (const entry of document.sources) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.text !== "string") continue;
    const name = entry.name.trim().slice(0, SOURCE_LIMITS.name);
    const text = entry.text.slice(0, SOURCE_LIMITS.text);
    if (!name || !text.trim() || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    kept.push({ name, text });
    if (kept.length === SOURCE_LIMITS.count) break;
  }
  if (kept.length) document.sources = kept;
  else delete document.sources;
  return document;
}

// Words that say nothing about where copy came from.
const STOP_WORDS = new Set(("the and for with you your our are was were has have had not but its it's this that these those "
  + "from into onto over under than then them they their there here what when where who why how all any each every some "
  + "more most less very just can will would could should may might one two out off now get got let lets make makes "
  + "made new use uses used via per about after before again also only own same such too yes").split(" "));

/**
 * The words of a text that carry its meaning, lowercased: words of 3 letters or more that are
 * not stop words, and every number (74%, 9, 11:21). Apostrophes stay inside words.
 */
export function contentWords(text) {
  const words = String(text ?? "").toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'%:.-]*/gu) ?? [];
  return words
    .map((word) => word.replace(/[.:'-]+$/, ""))
    .filter((word) => /\d/.test(word) || (word.length >= 3 && !STOP_WORDS.has(word)));
}

/** Every content word in the sources, and each word's stem (plural s, ing, ed dropped). */
export function sourceVocabulary(sources = []) {
  const words = new Set();
  for (const { text } of sources) for (const word of contentWords(text)) { words.add(word); words.add(stem(word)); }
  return words;
}

/** A rough stem, so "cameras" matches "camera" and "texting" matches "text". */
export function stem(word) {
  if (/\d/.test(word) || word.length < 5) return word;
  return word.replace(/(?:ing|ed|es|s)$/, "");
}
