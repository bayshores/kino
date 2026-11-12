// place_sounds with words: a short sound the project already holds (the person's import) whose name
// or credit has every one of the words is used before the built-in library; when the library has
// nothing, one that has some of the words is; otherwise the answer names the nearest library kinds
// and the exact sound-finder call, filled in with the same words.

const SKIP = new Set(["the", "and", "for", "with", "from", "sound", "sounds", "effect", "effects", "sfx", "audio"]);
const stem = (word) => word.replace(/(es|s|ing|ed)$/, "") || word;
const wordsOf = (text) => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The media record of a short sound (10 s or less) whose name, credit or tags hold the most of
 * `text`'s words, or null. Sounds from the library itself are not looked at (the library search
 * has its own say), nor files in `skip` (media ids the scene already plays as a bed or a voice).
 * With `all`, only a sound that has every word counts.
 */
export function heldSoundFor(text, media, { skip = new Set(), all = false } = {}) {
  const asked = wordsOf(text).filter((word) => word.length >= 3 && !SKIP.has(word)).map(stem);
  if (!asked.length) return null;
  let best = null;
  for (const item of media ?? []) {
    if (!String(item.mime ?? item.type ?? "").startsWith("audio") || skip.has(item.id)) continue;
    if (Number(item.duration) > 10 || /^(sfx|music):/.test(String(item.credit?.id ?? ""))) continue;
    const tags = Array.isArray(item.tags) ? item.tags.join(" ") : item.tags;
    const have = new Set(wordsOf([item.name, item.credit?.title, item.credit?.id, item.credit?.line, tags].join(" ")).map(stem));
    const score = asked.filter((word) => have.has(word)).length;
    if (score > 0 && (!all || score === asked.length) && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

/** The not_found answer: nearest library kinds, then the sound finder filled in with the same words. */
export function missingSoundText(words, nearest, searchOn) {
  const asked = JSON.stringify(words);
  const near = nearest.length ? ` Nearest library kinds: ${nearest.join(", ")} (library {topic:"sounds", search:${JSON.stringify(nearest[0])}}).` : "";
  const finders = `library {topic:"inspire", search:${asked}, kind:"sounds"}${searchOn ? ` or library {topic:"sounds", name:"openverse", search:${asked}}` : ""}`;
  return `place_sounds: no library sound for ${asked}.${near} To find one: ${finders}, then project {action:"import", file:"<its id>"} and place_sounds {at, sound:"<its name>"}.`;
}
