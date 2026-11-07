// place_broll {sceneId, speechId, layerIds, about, lead?, transcript, shots}: B-roll timed to the
// spoken concept. Each clip goes where
// the voice says its words, starting `lead` seconds before the word, and lasts while the idea stays
// on topic: to the end of that sentence, through the next sentences that repeat one of its words,
// and never past the next clip's start. A clip whose words are never said is left as it was and
// reported. The clip's file starts on one of its own shots (backend/shot-detection.mjs), the first
// that is long enough and not used by another clip of the same file.
import { speechPieces, speechWords, checkSpeechLayer, checkTranscript, plainWord } from "./speech.js";
import { round } from "./numbers.js";

const LEAD = 0.2; // seconds the picture comes in before the word
const TAIL = 0.15; // seconds it stays after the sentence's last word
const MIN_LENGTH = 1; // a cutaway shorter than this reads as a flash
const WINDOW = 6; // words around a match in which the clip's other words count
const STOP = new Set(["the", "and", "for", "with", "that", "this", "our", "your", "you", "are", "was", "were", "from", "into", "onto", "its", "his", "her", "their", "them", "they", "then", "than", "but", "not", "all", "any", "out", "about", "over", "just", "very", "some", "has", "have", "had", "can", "will", "who", "what", "when", "where", "how", "why", "of", "at", "on", "in", "to", "a", "an", "is", "it", "be", "as", "by", "or", "so", "we", "i"]);

function fail(message) {
  throw Object.assign(new Error(`place_broll: ${message}`), { operationType: "place_broll" });
}

/** "Cities'" and "city", "running" and "run" meet: lower case, no punctuation, simple endings off. */
export function stem(text) {
  let word = plainWord(text).replace(/'s?$/, "");
  for (const [ending, swap] of [["ies", "y"], ["ing", ""], ["ed", ""], ["es", ""], ["s", ""]]) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) { word = word.slice(0, -ending.length) + swap; break; }
  }
  return word.replace(/(.)\1$/, "$1"); // running → runn → run
}

/** The words of `about` that can be matched: no small or common words. */
export function conceptStems(about) {
  return [...new Set(String(about).split(/\s+/).map((part) => plainWord(part)).filter((part) => part.length >= 3 && !STOP.has(part)).map(stem))];
}

const endsSentence = (text) => /[.?!]["')\]]*$/.test(String(text).trim());

/**
 * The best place for a clip: the spoken word (index into `words`) where most of its concept words
 * are said within WINDOW words, earliest on a tie, outside the `taken` stretches. null if none.
 */
function bestMatch(words, stems, taken) {
  let best = null;
  for (const [at, word] of words.entries()) {
    if (!stems.includes(stem(word.text))) continue;
    if (taken.some((span) => word.start >= span.start - 1e-6 && word.start < span.end - 1e-6)) continue;
    const near = new Map();
    for (const item of words.slice(at, at + WINDOW)) if (stems.includes(stem(item.text)) && !near.has(stem(item.text))) near.set(stem(item.text), plainWord(item.text));
    if (!best || near.size > best.score) best = { at, score: near.size, said: [...near.values()] };
  }
  return best;
}

/** Where the idea stops: the sentence's last word, then on through sentences that repeat a concept word. */
function topicEnd(words, at, stems) {
  let end = at;
  while (end < words.length - 1 && !endsSentence(words[end].text)) end += 1;
  for (;;) {
    let next = end + 1;
    if (next >= words.length) break;
    let last = next;
    while (last < words.length - 1 && !endsSentence(words[last].text)) last += 1;
    if (!words.slice(next, last + 1).some((item) => stems.includes(stem(item.text)))) break;
    end = last;
  }
  return words[end].end + TAIL;
}

/** The file second to start a clip on: a shot long enough for `need` seconds, unused by this file. */
function pickShot(shots, need, used) {
  const usable = (shots ?? []).filter((shot, number) => !used.has(number));
  if (!usable.length) return null;
  const fits = usable.find((shot) => shot.end - shot.start >= need) ?? usable.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const number = shots.indexOf(fits);
  used.add(number);
  return { number: number + 1, start: fits.start + (number > 0 ? 0.04 : 0) }; // a frame past the cut, so no flash of the shot before
}

export function applyPlaceBroll(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) fail(`scene ${operation.sceneId} was not found.`);
  const voice = scene.layers.find((item) => item.id === operation.speechId);
  const pieces = checkSpeechLayer(scene, voice, "place_broll");
  const transcript = checkTranscript(operation.transcript, "place_broll");
  const ids = operation.layerIds ?? [];
  const about = operation.about ?? [];
  if (!ids.length || ids.length !== about.length || ids.length > 50) fail('clips is {"<layer>":"<the words it shows>"}, 1 to 50 clips.');
  const lead = operation.lead ?? LEAD;
  if (typeof lead !== "number" || lead < 0 || lead > 1) fail("lead is the seconds a clip comes in before its word, 0 to 1.");
  const words = speechWords(scene, speechPieces(scene, voice), transcript).filter((word) => !word.unclear);
  const taken = [], placed = [], unmatched = [];
  for (const [number, id] of ids.entries()) {
    const layer = scene.layers.find((item) => item.id === id);
    if (!layer) fail(`layer ${id} is not in this scene.`);
    if (layer.type !== "video") fail(`"${layer.name}" is a ${layer.type} layer; B-roll is a video layer.`);
    if (pieces.includes(layer)) fail(`"${layer.name}" is the voice; B-roll is another layer.`);
    const stems = conceptStems(about[number]);
    if (!stems.length) fail(`"${about[number]}" has no words to listen for (give a few words the voice says, like "coffee beans").`);
    const match = bestMatch(words, stems, taken);
    if (!match) { unmatched.push({ layer, about: about[number] }); continue; }
    const word = words[match.at];
    const start = Math.max(0, word.start - lead);
    taken.push({ start, end: topicEnd(words, match.at, stems) });
    placed.push({ layer, word, start, topic: taken.at(-1).end, said: match.said });
  }
  placed.sort((a, b) => a.start - b.start);
  const usedShots = new Map();
  const report = [];
  for (const [number, item] of placed.entries()) {
    const next = placed[number + 1]?.start ?? Infinity;
    const end = Math.min(scene.duration, next, Math.max(item.topic, item.start + MIN_LENGTH));
    const length = round(end - item.start);
    const { layer } = item;
    if (!usedShots.has(layer.src)) usedShots.set(layer.src, new Set());
    const shots = operation.shots?.[layer.id];
    const shot = pickShot(shots, length * (layer.mediaSpeed ?? 1), usedShots.get(layer.src));
    layer.mediaStart = round(item.start);
    layer.mediaDuration = length;
    layer.mediaFreeze = "none";
    if (shot) layer.mediaOffset = round(shot.start);
    report.push(`${layer.name} ${round(item.start)}–${round(end)} s on "${item.word.text.trim()}" (word ${item.word.index}${item.said.length > 1 ? `, also ${item.said.slice(1).join(", ")}` : ""}), ${shot ? `shot ${shot.number} from ${round(shot.start)} s` : "shots unknown: file start kept"}`);
  }
  return {
    placed: report,
    ...(unmatched.length ? { unmatched: unmatched.map((item) => `${item.layer.name}: no word of "${item.about}" is said; left as it was`) } : {}),
  };
}
