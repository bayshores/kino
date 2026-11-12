// The deck: kino deals each project a seeded hand of techniques (engine/techniques.js) and, when
// the moves library exists, one move as a set piece. Models asked for an edit all pick the same
// "typical" choices, and an agent cannot raise its own temperature, so kino supplies the
// randomness: the hand is a constraint the agent builds with.
//
// How a hand is drawn (dealDeck):
//   0. with an idea's signature (style.moments or style.signatures), its technique first:
//      moments[0].tag, else a set piece; the cards after it are the seeded glue around it;
//   1. wanted tags of a backed style spec first (engine/styleSpec.js): the references chose them;
//   2. only cards the material fits (materialOf): no device cards without a phone or a screen
//      recording, no type-heavy cards for footage without text, no speed ramp without video;
//   3. away from the techniques this machine's last few projects were dealt or used (novelty),
//      except a project that shares media or the story with this one (sharesMaterial);
//   4. never the known default edit: plain cards (cut, type-cut, hold) and rhythm cards are never
//      dealt, and at most one of the default set (type-pop, slow-push) is;
//   5. never a loud accent (flash, glitch-hit, shake, rgb-split), as a card or a set piece: each
//      needs a measured moment, not a deal.
// The same project, reroll count, spec, material and recent history always give the same hand.
//
// Plain data in and out: backend/agent/deck.mjs saves the hand in the project's agent state.
import { seeded } from "./blocks/build.js";
import { LOUD_TAGS, PLAIN_TAGS, TECHNIQUES, techniqueOf } from "./techniques.js";

export const DECK_GROUPS = Object.freeze(["transition", "camera", "type", "texture"]);
// Cards the agent may swap out per deal, each with a reason.
export const SWAP_LIMIT = 2;
// What an agent makes when left alone: hard cuts, text that pops or cuts in, a kick on every beat
// and a slow push. A hand never holds more than one of them.
export const DEFAULT_SET = Object.freeze(["cut", "type-cut", "type-pop", "beat-kick", "slow-push"]);
// The most technique cards in a hand (one or two per group).
const MOST_CARDS = 6;
const RECENT_WEIGHT = 0.2;
const GUESSED_WEIGHT = 2;

// What a card needs from the material. A card whose need is missing is not dealt.
//   video     a video clip (speed and time tricks)
//   pictures  a video or a picture (depth and split screens)
//   twoPictures  two different pictures side by side
//   device    a phone or a screen recording (UI set pieces)
//   text      words on screen (type-heavy cards)
//   numbers   a number in the words (a counter)
const NEEDS = Object.freeze({
  "speed-ramp": ["video"],
  "freeze-frame": ["video"],
  "depth-blur": ["pictures"],
  "split-screen": ["twoPictures"],
  // Every reveal of words needs words: a footage edit without text is never dealt one.
  "type-fade": ["text"],
  "type-slide": ["text"],
  "type-pop": ["text"],
  "type-mask-rise": ["text"],
  "type-giant": ["text"],
  "type-kinetic": ["text"],
  "type-letters": ["text"],
  "type-words": ["text"],
  "type-swap": ["text"],
  "type-counter": ["text", "numbers"],
  "accent-hit": ["text"],
  "swipe-cards": ["device"],
  "device-in-scene": ["device"],
  "screen-zoom": ["device"],
  "status-line": ["device"],
  "logo-match-move": ["pictures"],
  "tile-ring": ["pictures"],
  "clip-field": ["twoPictures"],
});
// Made cards: the one-call treatments (a cut-out, a heard line, light on an edge, a designed hit),
// dealt only on evidence: a fact kino measured in the footage (`fact`, which must hold) or a
// technique the project's labeled references show (`evidence` of dealDeck). Never on a plain
// draw: every one of them needs a subject or a moment to sit on. `needs` are material keys;
// `loud` ones (a flash or a glitch) come only from references, the same rule as LOUD_TAGS: a
// reference showing it is the motivating evidence. `call` is the ready call a card line names.
export const MADE_CARDS = Object.freeze([
  // A cut-out needs a subject: a face kino found or a box the agent marked (run 6 labeled three
  // cut-out frames and built none: .scratch/ceiling/trace-run6.md section 1).
  { name: "cut_out", kind: "op", needs: ["cutOut"], fact: "subject", line: "the subject cut out of a clip: an outline, a silhouette, words behind it", call: '{op:"cut_out", layer:"<clip>", output:"outline"}' },
  // A heard line needs saved lines (run 6 muted every clip although import listed lines: section 2).
  { name: "keep_line", kind: "op", needs: ["lines"], fact: "lines", line: "one line a clip says, heard under the song", call: '{op:"keep_line", layer:"<clip>", line:"<its words>", duck:"<song>"}' },
  { name: "rim-light", kind: "effect", needs: ["cutOut"], fact: "subject", line: "light along the subject's edge", call: '{op:"add_animation", layer:"<clip>", effect:"rim-light"}' },
  { name: "backdrop-flash", kind: "move", needs: ["subject"], loud: true, line: "the subject stays, the picture behind it flashes", call: '{op:"move", name:"backdrop-flash", layer:"<clip>", at:<s>}' },
  { name: "edge-lines", kind: "effect", needs: ["video"], line: "the footage drawn as line art", call: '{op:"add_animation", layer:"<clip>", effect:"edge-lines"}' },
  { name: "split-fields", kind: "move", needs: ["pictures"], line: "the frame split into two color fields for a beat", call: '{op:"move", name:"split-fields", layer:"<clip>", at:<s>}' },
  { name: "overexpose", kind: "move", needs: ["pictures"], loud: true, line: "the picture burns out to white and back", call: '{op:"move", name:"overexpose", layer:"<clip>", at:<s>}' },
  { name: "smear", kind: "move", needs: ["video"], loud: true, line: "the picture smears into the next shot", call: '{op:"move", name:"smear", layer:"<clip>", at:<s>}' },
  { name: "shatter", kind: "move", needs: ["pictures"], loud: true, line: "the picture breaks into shards", call: '{op:"move", name:"shatter", layer:"<clip>", at:<s>}' },
  { name: "scene-background", kind: "finish", needs: ["pictures"], line: "a finish over the whole frame: grain, lifted blacks, halation, bars", call: '{op:"update_scene", properties:{finish:true}}' },
]);
const MADE_BY_NAME = new Map(MADE_CARDS.map((card) => [card.name, card]));
export const madeCardOf = (name) => MADE_BY_NAME.get(name);
// At most this many made cards a hand (a guess: one or two treatments on top of the glue cards).
const MOST_MADE = 2;
// The deck never copies a reference: at most this many cards come from labels, and at most
// LABELS_PER_REF from one reference (the part's rule: at most half of a hand of 6 or more).
const MOST_LABELED = 3;
const LABELS_PER_REF = 2;
// How much likelier a card is when a reference shows it or a measured fact asks for it (a guess).
const EVIDENCE_WEIGHT = 3;
// Transitions kino reads at a change of full-frame picture: likelier when there are pictures.
const BETWEEN_PICTURES = new Set(["dissolve", "fade-black", "blur-through", "zoom-through", "whip-pan", "mask-wipe", "push-transition"]);

/** A whole number from 1 to 9999 that is the same for a project id every time (FNV-1a). */
export function projectSeed(projectId) {
  let hash = 0x811c9dc5;
  for (const character of String(projectId ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 9999) + 1;
}

// Seeds next to each other (a reroll adds 1) should give unrelated hands: mix the bits first
// (the finalizer of MurmurHash3), then seed the random source with the result.
function scramble(seed) {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) || 1;
}

/** The seed of a project's deal: its project seed plus the reroll count. */
export const dealSeed = (projectId, reroll = 0) => projectSeed(projectId) + reroll;

const PHONE_WORDS = /\b(phone|iphone|android|device|mockup|screen ?recording|screen ?rec|screenshots?|app)\b/i;
const VIDEO_WORDS = /\.(mp4|mov|m4v|webm|mkv)\b|\b(footage|clips?|video|recording|filmed|b-roll)\b/i;
const PICTURE_WORDS = /\.(png|jpe?g|webp|gif|heic)\b|\b(photos?|pictures?|images?|stills?|screenshots?)\b/i;
const SOUND_WORDS = /\.(mp3|wav|m4a|aac|flac)\b|\b(music|song|track|beat|voice ?over|narration|sound)\b/i;
const TEXT_WORDS = /\b(captions?|titles?|text|words|lyrics|subtitles?|headline|copy)\b/i;

/** The footage a document shows (video and image layer sources), sorted. Sound is left out: a shared SFX or music bed is not shared material. */
export function mediaKeys(document) {
  const files = (document?.scenes ?? []).flatMap((scene) => (scene.layers ?? []).filter((layer) => ["video", "image"].includes(layer.type) && layer.src).map((layer) => String(layer.src)));
  return [...new Set(files)].sort();
}

/**
 * True when a recent project ({media, story}) is kin to this one ({media, story}): more than half
 * of the smaller one's footage is shared (one reused logo is not enough), or it tells the same
 * story (the brief's message, compared loosely). The deal does not steer away from kin: a remake
 * keeps its original's techniques on the table.
 */
export function sharesMaterial(recent, own) {
  const mine = new Set(own?.media ?? []);
  const theirs = new Set(recent?.media ?? []);
  const shared = [...theirs].filter((file) => mine.has(file)).length;
  if (shared * 2 > Math.min(mine.size, theirs.size)) return true;
  return Boolean(own?.story) && own.story === recent?.story;
}

/**
 * What the project is made of, read from its document and the brief's made_from line:
 * { known, fromLayers, video, pictures, pictureCount, text, numbers, sound, device }. `known` is false while
 * there is nothing to read (an empty project, no made_from): then nothing is filtered.
 */
export function materialOf(document, { madeFrom = "", facts = {} } = {}) {
  const words = String(madeFrom ?? "");
  const scenes = (document?.scenes ?? []).filter((scene) => scene.isComponent !== true && !(scene.variant && scene.variant.of !== scene.id));
  const layers = scenes.flatMap((scene) => (scene.layers ?? []).map((layer) => ({ layer, scene })));
  const ofType = (type) => layers.filter(({ layer }) => layer.type === type);
  const texts = ofType("text").map(({ layer }) => String(layer.text ?? "")).filter((text) => text.trim());
  const sources = (document?.sources ?? []).map((source) => String(source?.text ?? source?.name ?? ""));
  const pictures = [...ofType("video"), ...ofType("image")];
  // A tall picture that does not fill the frame reads as a phone screen.
  const tall = pictures.some(({ layer, scene }) => layer.height >= 1.8 * layer.width && layer.width * layer.height < 0.9 * scene.width * scene.height);
  const named = layers.some(({ layer }) => PHONE_WORDS.test(String(layer.name ?? "")));
  const video = ofType("video").length > 0 || VIDEO_WORDS.test(words);
  const pictureCount = new Set(pictures.map(({ layer }) => layer.src || layer.id)).size || (PICTURE_WORDS.test(words) || VIDEO_WORDS.test(words) ? 1 : 0);
  // What kino measured about the footage (the service reads saved files only, never a new decode):
  // facts.faceClips the files with a face, facts.lines the lines the clips say (saved transcripts),
  // facts.darkClips the files that are dark. A box the agent marked (mark_subject) is a subject too.
  const marked = new Set(pictures.filter(({ layer }) => layer.subjectBoxes?.src === layer.src && layer.subjectBoxes.boxes?.length).map(({ layer }) => layer.src));
  const subjectClips = Math.max(marked.size, Number(facts.faceClips) || 0);
  const factKeys = {
    ...(subjectClips ? { subject: true, subjectClips, cutOut: pictureCount > 0 } : {}),
    ...(Number(facts.lines) > 0 ? { lines: Number(facts.lines) } : {}),
    ...(Number(facts.darkClips) > 0 ? { dark: Number(facts.darkClips) } : {}),
  };
  return {
    known: layers.length > 0 || words.trim() !== "",
    // Read from built layers (not only from the brief's words): the deck stays put from then on.
    fromLayers: layers.length > 0,
    video,
    pictures: pictureCount > 0,
    pictureCount,
    text: texts.length > 0 || sources.some((text) => text.trim()) || TEXT_WORDS.test(words),
    // A number in the words (not in a file name such as skate2.mp4).
    numbers: [...texts, ...sources, words.replace(/\S+\.[a-z0-9]{2,4}\b/gi, "")].some((text) => /\d/.test(text)),
    sound: ofType("audio").length > 0 || Boolean(document?.rhythm?.bpm) || SOUND_WORDS.test(words),
    device: tall || named || PHONE_WORDS.test(words),
    // Present only when measured, so the material of a project without them is unchanged.
    ...factKeys,
  };
}

/** The names of made cards a scene shows: effects, moves, cut-outs, kept lines and a finish (deckUse counts them). */
export function madeNamesIn(scene) {
  const names = new Set();
  for (const layer of scene?.layers ?? []) {
    if (layer.move?.name) names.add(layer.move.name);
    if (layer.cutoutOf) names.add("cut_out");
    for (const animation of layer.animations ?? []) {
      if (animation?.effect) names.add(animation.effect);
      if (animation?.name === "Line up") names.add("keep_line");
    }
  }
  if (scene?.finish) names.add("scene-background");
  return [...names];
}

/** The material in a few words for the status line: "video, text, sound". */
export function materialWords(material) {
  if (!material?.known) return "no material yet";
  const words = [material.video ? "video" : material.pictures ? "pictures" : "", material.device ? "phone" : "", material.text ? "text" : "", material.sound ? "sound" : ""].filter(Boolean);
  return words.join(", ") || "shapes only";
}

// True when the material has what a card needs. Unknown material fits everything.
function fits(tag, material) {
  if (!material?.known) return true;
  return (NEEDS[tag] ?? []).every((need) => (need === "twoPictures" ? material.pictureCount >= 2 : Boolean(material[need])));
}

// How likely a card is, before novelty and the spec.
function baseWeight(tag, material) {
  if (!material?.known) return 1;
  let weight = 1;
  if (BETWEEN_PICTURES.has(tag) && !material.pictures) weight *= 0.5;
  if (tag === "orbit-3d" && material.device) weight *= 1.5;
  return weight;
}

// A move's main need: its first technique tag's, and a device for a phone move.
function moveFits(move, material) {
  if (!material?.known) return true;
  // What the move itself needs (footage moves: a video clip), beyond its first tag.
  if ((move.needs ?? []).some((need) => !material[need])) return false;
  const tags = move.tags ?? [];
  if (tags.some((tag) => (NEEDS[tag] ?? []).includes("device")) || /phone|device|screen/.test(move.name)) {
    if (!material.device) return false;
  }
  return !tags.length || fits(tags[0], material);
}

// Picks one entry from [{value, weight}] with the random source, or null when none is left.
function pickWeighted(rng, entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return null;
  let point = rng.next() * total;
  for (const entry of entries) {
    point -= entry.weight;
    if (point <= 0) return entry.value;
  }
  return entries.at(-1).value;
}

/** The tags a group may deal: ones check can find, that are not plain and not kept out of the deal. */
export const dealableTags = (group) => TECHNIQUES.filter((entry) => entry.group === group && entry.detect && entry.deal !== false && !PLAIN_TAGS.includes(entry.tag)).map((entry) => entry.tag);

/**
 * Deals a hand. `style` is styleContext(spec) or null; `recent` the tags (and move names) of the
 * last few other projects; `moves` the moves library ([{name, tags, fits}], empty before it
 * exists, engine/blocks/moves). Returns { seed, reroll, cards:[{tag, group, why}], setPiece:{kind, name, tags, why?}|null }.
 * why: "spec" (a backed wanted tag), "deal" (drawn), "signature" (dealt first for the signature).
 */
export function dealDeck({ projectId, reroll = 0, style = null, material = { known: false }, recent = [], moves = [], evidence = [], asked = [] }) {
  const seed = dealSeed(projectId, reroll);
  const rng = seeded(scramble(seed));
  const avoids = new Set(style?.avoids ?? []);
  const backed = (style?.backed ?? []).filter((tag) => !avoids.has(tag));
  const guessed = new Set(style?.guessed ?? []);
  const recentSet = new Set(recent);
  // evidence: [{name, refs:[ids]}], what the labeled references show (backend/agent/deck.mjs
  // labelEvidence). A label card is dealt only while the caps allow (MOST_LABELED, LABELS_PER_REF).
  const seen = new Map(evidence.filter((entry) => entry?.name && entry.refs?.length && !avoids.has(entry.name)).map((entry) => [entry.name, entry.refs]));
  const perRef = new Map();
  let labeled = 0;
  const labelOpen = (name) => seen.has(name) && labeled < MOST_LABELED && seen.get(name).every((ref) => (perRef.get(ref) ?? 0) < LABELS_PER_REF);
  const countLabel = (name) => { labeled += 1; for (const ref of seen.get(name)) perRef.set(ref, (perRef.get(ref) ?? 0) + 1); };
  const weightOf = (tag) => baseWeight(tag, material) * (guessed.has(tag) ? GUESSED_WEIGHT : 1) * (recentSet.has(tag) ? RECENT_WEIGHT : 1) * (labelOpen(tag) ? EVIDENCE_WEIGHT : 1);
  const open = (group, taken) => dealableTags(group).filter((tag) => !avoids.has(tag) && !taken.has(tag) && fits(tag, material)
    // No type-heavy card for a footage edit without words.
    && !(group === "type" && material?.known && !material.text && (NEEDS[tag] ?? []).includes("text")));

  const cards = [];
  const taken = new Set();
  const add = (tag, why) => {
    // A drawn card the references show is a label card: it says so, and counts against the caps.
    if (why === "deal" && labelOpen(tag)) {
      cards.push({ tag, group: techniqueOf(tag).group, why: "seen", refs: seen.get(tag).length });
      countLabel(tag);
    } else cards.push({ tag, group: techniqueOf(tag).group, why });
    taken.add(tag);
  };
  // 0. Around the signature (the spec has moments or signatures): its technique is dealt first,
  // moments[0].tag, else a set piece; the rest of the hand is the seeded glue around it.
  const around = Boolean(style?.moments?.length || style?.signatures?.length);
  let setPiece = null;
  if (around) {
    // A loud accent (LOUD_TAGS) or a card the deal never draws is no signature either: a set piece instead.
    const dealable = (entry) => !LOUD_TAGS.includes(entry) && (!DECK_GROUPS.includes(techniqueOf(entry).group) || dealableTags(techniqueOf(entry).group).includes(entry));
    const tag = (style.moments ?? []).map((moment) => moment.tag).find((entry) => techniqueOf(entry) && !avoids.has(entry) && dealable(entry));
    if (tag && DECK_GROUPS.includes(techniqueOf(tag).group)) add(tag, "signature");
    else if (tag) setPiece = { kind: "technique", name: tag, tags: [tag] };
    else setPiece = drawSetPiece(true);
    if (setPiece) {
      setPiece.why = "signature";
      for (const entry of setPiece.tags) taken.add(entry);
    }
  }
  // 1. The spec's backed wants, up to 2 per group, in a seeded order.
  const wanted = backed.filter((tag) => DECK_GROUPS.includes(techniqueOf(tag)?.group) && dealableTags(techniqueOf(tag).group).includes(tag));
  const shuffled = wanted.map((tag) => ({ tag, key: rng.next() })).sort((a, b) => a.key - b.key).map((entry) => entry.tag);
  for (const tag of shuffled) {
    const group = techniqueOf(tag).group;
    if (!taken.has(tag) && cards.filter((card) => card.group === group).length < 2 && cards.length < MOST_CARDS) add(tag, "spec");
  }
  // 2. One card for every group that has none, then one more in a seeded group.
  const defaults = () => cards.filter((card) => DEFAULT_SET.includes(card.tag) && card.why !== "spec").length;
  const draw = (group) => {
    const candidates = open(group, taken)
      // At most one card of the default set (a spec card does not count).
      .filter((tag) => !(DEFAULT_SET.includes(tag) && defaults() >= 1));
    return pickWeighted(rng, candidates.map((tag) => ({ value: tag, weight: weightOf(tag) })));
  };
  for (const group of DECK_GROUPS) {
    if (cards.some((card) => card.group === group)) continue;
    const tag = draw(group);
    if (tag) add(tag, "deal");
  }
  if (cards.length < Math.min(MOST_CARDS, 5)) {
    // Words get a second card only when the project has words.
    const groups = DECK_GROUPS.filter((group) => cards.filter((card) => card.group === group).length < 2 && open(group, taken).length
      && !(group === "type" && material?.known && !material.text));
    const group = groups.length ? groups[Math.floor(rng.next() * groups.length) % groups.length] : null;
    const tag = group ? draw(group) : null;
    if (tag) add(tag, "deal");
  }
  cards.sort((a, b) => DECK_GROUPS.indexOf(a.group) - DECK_GROUPS.indexOf(b.group));
  // 3. Made cards, on evidence only (MADE_CARDS): a measured fact that holds, or a reference label.
  for (let index = 0; index < MOST_MADE; index += 1) {
    const candidates = MADE_CARDS.filter((card) => !taken.has(card.name) && !avoids.has(card.name) && card.needs.every((need) => material?.[need]))
      .map((card) => ({ card, fact: Boolean(card.fact && material?.[card.fact]) && !card.loud, label: labelOpen(card.name) }))
      .filter((entry) => entry.fact || entry.label);
    const picked = pickWeighted(rng, candidates.map((entry) => ({ value: entry, weight: (entry.label ? EVIDENCE_WEIGHT * seen.get(entry.card.name).length : 0) + (entry.fact ? EVIDENCE_WEIGHT : 0) })));
    if (!picked) break;
    const { card, label } = picked;
    // A label wins the why when both hold: the reference is the stronger reason to build it.
    if (label) {
      cards.push({ tag: card.name, group: "made", why: "seen", refs: seen.get(card.name).length });
      countLabel(card.name);
    } else cards.push({ tag: card.name, group: "made", why: "fact", fact: card.fact });
    taken.add(card.name);
  }
  // 4. The set piece, when the signature did not deal one.
  if (!setPiece) setPiece = drawSetPiece(false);
  // At most half the hand from labels: a small hand drops its last label made card.
  const fromLabels = () => cards.filter((card) => card.why === "seen").length;
  while (fromLabels() * 2 > cards.length + (setPiece ? 1 : 0)) {
    const last = cards.findLastIndex((card) => card.why === "seen" && card.group === "made");
    if (last < 0) break;
    cards.splice(last, 1);
  }
  return { seed, reroll, cards, setPiece };

  // At most one set piece: a move when the library exists, else split-screen when it fits. For
  // the signature (`force`) there always is one when anything fits: a set-piece technique last.
  function drawSetPiece(force) {
    // A set piece built on a loud accent is never dealt either (engine/techniques.js LOUD_TAGS).
    const usable = moves.filter((move) => moveFits(move, material) && !(move.tags ?? []).some((tag) => avoids.has(tag) || LOUD_TAGS.includes(tag)));
    // asked: [{word, name}], the moves the person's own words name (engine/askWords.js). One of
    // them that fits the material is the set piece, so a word in the ask finds its move.
    const named = asked.filter((entry) => usable.some((move) => move.name === entry.name));
    if (named.length) {
      const entry = named[Math.floor(rng.next() * named.length) % named.length];
      const move = usable.find((item) => item.name === entry.name);
      return { kind: "move", name: move.name, tags: [...(move.tags ?? [])], word: entry.word };
    }
    if (usable.length) {
      const name = pickWeighted(rng, usable.map((move) => ({
        value: move.name,
        weight: (recentSet.has(move.name) ? RECENT_WEIGHT : 1) * ((move.tags ?? []).some((tag) => backed.includes(tag)) ? 4 : 1) * ((move.tags ?? []).some((tag) => taken.has(tag)) ? 0.3 : 1),
      })));
      const move = usable.find((entry) => entry.name === name);
      return { kind: "move", name: move.name, tags: [...(move.tags ?? [])] };
    }
    if (!avoids.has("split-screen") && fits("split-screen", material) && material?.known && (force || backed.includes("split-screen") || rng.next() < 0.5))
      return { kind: "technique", name: "split-screen", tags: ["split-screen"] };
    if (!force) return null;
    const tag = pickWeighted(rng, dealableTags("set-piece").filter((entry) => !avoids.has(entry) && fits(entry, material))
      .map((entry) => ({ value: entry, weight: recentSet.has(entry) ? RECENT_WEIGHT : 1 })));
    return tag ? { kind: "technique", name: tag, tags: [tag] } : null;
  }
}

/** Every card's name: technique tags, then the set piece's name. */
export const cardNames = (deck) => [...(deck?.cards ?? []).map((card) => card.tag), ...(deck?.setPiece ? [deck.setPiece.name] : [])];

/** The hand in one line: "deck (seed 4821): dissolve, drift, type-words, light-sweep, set piece: zoom-through; swaps left 2". */
export function deckLine(deck) {
  if (!deck) return "";
  const left = SWAP_LIMIT - (deck.swaps?.length ?? 0);
  const cards = (deck.cards ?? []).map((card) => card.tag);
  const piece = deck.setPiece ? `, ${deck.setPiece.why === "signature" ? "signature" : "set piece"}: ${deck.setPiece.name}` : "";
  return `deck (seed ${deck.seed}): ${cards.join(", ")}${piece}; swaps left ${left}`;
}

/**
 * Which cards a video uses, from techniqueCounts of check ({tag: count}): { used, unused }.
 * A move counts as used when the scene holds it (`movesUsed`, from the layers a move makes) or
 * the video shows any technique it is tagged with.
 */
export function deckUse(deck, counts = {}, movesUsed = []) {
  const shown = (tag) => (counts[tag] ?? 0) > 0;
  const used = [];
  const unused = [];
  // A made card is used when the scene holds it (madeNamesIn, passed with the moves).
  for (const card of deck?.cards ?? []) (shown(card.tag) || (card.group === "made" && movesUsed.includes(card.tag)) ? used : unused).push(card.tag);
  if (deck?.setPiece) ((deck.setPiece.tags ?? []).some(shown) || movesUsed.includes(deck.setPiece.name) ? used : unused).push(deck.setPiece.name);
  return { used, unused };
}

/**
 * The problem with a swap {out, in, why}, or null. `moves` lists the move names that exist.
 * A card may be swapped for any technique check can find (not plain, not in the hand) or a move.
 */
export function swapProblem(deck, swap, { moves = [], avoids = [] } = {}) {
  if (!swap || typeof swap !== "object" || Array.isArray(swap)) return 'swap is {out:"<card>", in:"<technique or move>", why:"<reason>"}.';
  const extra = Object.keys(swap).filter((key) => !["out", "in", "why"].includes(key));
  if (extra.length) return `swap takes out, in and why, not ${extra.join(", ")}.`;
  const names = cardNames(deck);
  if ((deck.swaps?.length ?? 0) >= SWAP_LIMIT) return `This deal has used its ${SWAP_LIMIT} swaps. Build with the hand, or deal again: notes {action:"deck", reroll:true}.`;
  if (typeof swap.why !== "string" || swap.why.trim().length < 3 || swap.why.trim().length > 120) return "swap needs why: 3 to 120 characters on why this card does not fit the video (it is kept with the deck).";
  if (!names.includes(swap.out)) return `${JSON.stringify(swap.out)} is not in the hand; the cards are ${names.join(", ")}.`;
  const incoming = String(swap.in ?? "");
  const isMove = moves.includes(incoming);
  const entry = techniqueOf(incoming);
  if (!isMove && !entry) return `${JSON.stringify(swap.in)} is not a technique or a move; library {topic:"techniques"} lists them.`;
  if (!isMove && (!entry.detect || PLAIN_TAGS.includes(incoming) || entry.group === "rhythm")) return `${incoming} cannot be a card: ${PLAIN_TAGS.includes(incoming) || entry.group === "rhythm" ? "it is a plain default or a rhythm, not a designed choice" : "check cannot find it in a document yet"}.`;
  if (names.includes(incoming)) return `${incoming} is already in the hand.`;
  // One set piece a hand: a move comes in for the set piece only.
  if (isMove && deck.setPiece && deck.setPiece.name !== swap.out) return `The hand's set piece is ${deck.setPiece.name}; a move swaps it out (out:"${deck.setPiece.name}").`;
  if (avoids.includes(incoming)) return `The style spec avoids ${incoming}.`;
  return null;
}

/** The deck after a checked swap: the card replaced in place, the swap logged. */
export function applySwap(deck, swap, { moves = [], at = null } = {}) {
  const next = { ...deck, cards: [...deck.cards], swaps: [...(deck.swaps ?? []), { out: swap.out, in: swap.in, why: swap.why.trim(), ...(at ? { at } : {}) }] };
  const move = moves.find((entry) => entry.name === swap.in);
  const incoming = move ? { kind: "move", name: move.name, tags: [...(move.tags ?? [])] } : null;
  if (deck.setPiece?.name === swap.out) {
    next.setPiece = incoming ?? { kind: "technique", name: swap.in, tags: [swap.in] };
    if (!incoming && techniqueOf(swap.in).group !== "set-piece") {
      // A technique in place of the set piece is a card of its own group.
      next.setPiece = null;
      next.cards.push({ tag: swap.in, group: techniqueOf(swap.in).group, why: "swap" });
    }
    return next;
  }
  const index = next.cards.findIndex((card) => card.tag === swap.out);
  if (incoming) {
    next.cards.splice(index, 1);
    next.setPiece = incoming;
  } else next.cards[index] = { tag: swap.in, group: techniqueOf(swap.in).group, why: "swap" };
  // Made cards stay last (their group is not one of DECK_GROUPS).
  const order = (card) => (card.group === "made" ? DECK_GROUPS.length : DECK_GROUPS.indexOf(card.group));
  next.cards.sort((a, b) => order(a) - order(b));
  return next;
}
