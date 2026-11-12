// The person's own words against what each move or effect says it is for. Run 8 asked for an
// "aura" edit; the energy-aura move says "aura" in its own about text and was never named in 1,253
// transcript lines (.scratch/run8/trace/effects.md section 4). This finds such a move from any
// ask's words, for the deck's deal and the moves list: plain word matching, no model.

// Words too plain to point at one move. A guess, kept short: the `most` rule below does the
// real filtering (a word several entries share names none of them).
const PLAIN = new Set(["about", "after", "again", "also", "back", "before", "being", "best", "both", "come", "could",
  "each", "edit", "even", "every", "from", "give", "have", "here", "into", "just", "like", "look", "make", "made",
  "more", "most", "much", "need", "only", "over", "some", "such", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "very", "want", "what", "when", "where", "which", "while", "with", "would", "your",
  "video", "clip", "clips", "shot", "shots", "second", "seconds", "please", "something", "really",
  "the", "and", "for", "our", "new", "its", "you", "can", "get", "has", "his", "her", "one", "two", "all", "any", "but",
  "not", "out", "own", "how", "why", "who", "use", "via", "per", "way", "let", "too", "off", "now", "lot", "bit", "yet",
  "are", "was", "him", "she", "they", "my", "end", "big", "few", "set", "put", "add", "app"]);

// Lowercase words of 3 or more letters ("fog"), plain words left out, each once.
export function askWords(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z][a-z']*[a-z]/g) ?? [];
  return [...new Set(words.map((word) => word.replace(/'s$/, "")).filter((word) => word.length >= 3 && !PLAIN.has(word)))];
}

// A word and its plural or -ing form count as the same word ("glitch", "glitches", "glitching").
const forms = (word) => [word, `${word}s`, `${word}es`, `${word}ing`, word.replace(/(es|s|ing)$/, "")];

/**
 * Which entries the ask's words name: [{word, name, named?}], one per entry, in the ask's word order.
 * named: the word is in the entry's own name ("aura" -> energy-aura, "shatter" -> shatter), the
 * strong match; without it the word is only in the about or fits text, where adjectives match loosely
 * (measured on four asks: "calm" -> logo-settle, "slow" -> count-up, "trailer" -> voice-type).
 * entries: [{name, text}] (a move's about and fits, an effect's label). A word found in more than
 * `most` entries is too common to point at one and is skipped (3: a guess, so a general word
 * such as "title" or "light" does not steer the deal).
 */
export function askMatches(text, entries, { most = 3 } = {}) {
  // An entry's own name counts as its words too (shatter, fog).
  const wordsOf = (text) => new Set(String(text).toLowerCase().match(/[a-z]+/g) ?? []);
  const tokens = entries.map((entry) => ({ name: entry.name, own: wordsOf(entry.name), words: wordsOf(`${entry.name} ${entry.text ?? ""}`) }));
  const found = [];
  const named = new Set();
  for (const word of askWords(text)) {
    const variants = forms(word).filter((form) => form.length >= 3);
    const hits = tokens.filter((entry) => variants.some((form) => entry.words.has(form)));
    if (!hits.length || hits.length > most) continue;
    for (const hit of hits) {
      if (named.has(hit.name)) continue;
      named.add(hit.name);
      found.push({ word, name: hit.name, ...(variants.some((form) => hit.own.has(form)) ? { named: true } : {}) });
    }
  }
  return found;
}

/** The one line an answer shows: `for your words: "aura" -> energy-aura; "glitch" -> rgb-split`; "" with none. */
export function askLine(found) {
  return found.length ? `for your words: ${found.map((entry) => `"${entry.word}" -> ${entry.name}`).join("; ")}` : "";
}
