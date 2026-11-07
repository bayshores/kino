// The project's own names (a product, people, places) from its brief, for whisper's prompt:
// whisper spells a name it has just "read" in the prompt, and hears "Zuri" instead of "David".
//
// A name is a word written with a capital where a plain word would not have one: after another
// word in a sentence ("guides Zuri's user"), with a capital inside it (LiDAR) or in capitals in
// a text that is not all capitals (GPU). A word after a full stop, a bracket, a symbol or at the
// start is not counted from that place, and a label in capitals (MODEL, SAY) names nothing. A
// headline in Title Case ("Find Your Closest Bakery") capitalizes plain words, so there only
// words with a capital inside or in capitals count.

const MAX_NAMES = 12;
const NOT_NAMES = new Set(["i", "im", "ive", "id", "ill", "ok", "okay", "tv", "vs"]);

/** The name-like words of `texts` (strings), the 12 most used, each written as first seen. */
export function namesIn(texts) {
  const found = new Map(); // lowercase -> {text, count, first}
  let order = 0;
  for (const text of texts) {
    if (typeof text !== "string" || !text.trim()) continue;
    const letters = text.replace(/[^\p{L}]/gu, "");
    const shouted = letters.replace(/[^\p{Lu}]/gu, "").length > 0.6 * letters.length;
    // Title Case: most words of 3 or more letters after the first start with a capital.
    const long = (text.match(/\p{L}+/gu) ?? []).slice(1).filter((word) => word.length >= 3);
    const titled = long.length >= 2 && long.filter((word) => /^\p{Lu}/u.test(word)).length > 0.6 * long.length;
    for (const match of text.matchAll(/\p{L}[\p{L}\p{N}]*(?:['’]\p{L}+)?/gu)) {
      const afterWord = /[\p{L}\p{N},;]\s+$/u.test(text.slice(Math.max(0, match.index - 3), match.index));
      // Part of an identifier, a path or an address (BRAIN_URL, os.getenv, a/b) is code, not a name.
      const end = match.index + match[0].length;
      if (/[_./\\=]/.test(text[match.index - 1] ?? "") || /[_/\\=(]|\.\p{L}/u.test(text.slice(end, end + 2))) continue;
      const word = match[0].replace(/['’]s$/i, "");
      // Codes such as T08 or 4090 are not said as names.
      if (word.length < 2 || word.length > 24 || /\p{N}/u.test(word)) continue;
      const capital = /^\p{Lu}/u.test(word);
      const innerCapital = /^\p{L}+$/u.test(word) && /\p{Ll}/u.test(word) && /\p{Lu}/u.test(word.slice(1));
      const allCapitals = !shouted && word.length <= 6 && /^\p{Lu}+$/u.test(word);
      if (!(innerCapital || allCapitals || (capital && afterWord && !shouted && !titled))) continue;
      const key = word.toLowerCase();
      if (NOT_NAMES.has(key.replace(/['’]/g, ""))) continue;
      const entry = found.get(key) ?? { text: word, count: 0, first: order += 1 };
      entry.count += 1;
      found.set(key, entry);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.first - b.first).slice(0, MAX_NAMES).map((entry) => entry.text);
}

/**
 * A project's names for whisper: the name-like words of the brief (its fields' text and the
 * person's own words, its answered questions) and its style spec, at most 12, in alphabetical
 * order, so the same brief always gives the same prompt (and the same saved transcript).
 * On-screen text is left out: it can be decor (a log, a screen of code) whose labels (SAY, Turn)
 * are not names, and it changes with every edit.
 */
export function projectNames(brief = null) {
  const told = [];
  for (const field of Object.values(brief?.fields ?? {})) told.push(field?.text, field?.quote);
  for (const entry of brief?.log ?? []) told.push(entry?.q, entry?.a);
  const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);
  told.push(...strings(brief?.style ?? null));
  return namesIn(told).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
}

/**
 * The names whisper hears the voice of the layers playing `src` with. A voice cut_speech cut
 * keeps reading the transcript its cuts were made on: its cut words (`cutWords`) are positions in
 * that transcript, and another transcript (heard with other names) can have other words at those
 * positions. That transcript's names are on the voice's first piece (`heardWith`); a voice cut
 * before names were told to whisper has none, so it reads the transcript made without names.
 * Any other voice is heard with the project's names. Answers {names, pinned}.
 */
export function speechNamesFor(document, brief, src) {
  const cut = (document?.scenes ?? []).flatMap((scene) => scene.layers ?? []).find((layer) => layer.src === src && layer.cutWords?.length);
  if (cut) return { names: Array.isArray(cut.heardWith) ? cut.heardWith : [], pinned: true };
  return { names: projectNames(brief), pinned: false };
}
