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
export function materialOf(document, { madeFrom = "" } = {}) {
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
  };
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
export function dealDeck({ projectId, reroll = 0, style = null, material = { known: false }, recent = [], moves = [] }) {
  const seed = dealSeed(projectId, reroll);
  const rng = seeded(scramble(seed));
  const avoids = new Set(style?.avoids ?? []);
  const backed = (style?.backed ?? []).filter((tag) => !avoids.has(tag));
  const guessed = new Set(style?.guessed ?? []);
  const recentSet = new Set(recent);
  const weightOf = (tag) => baseWeight(tag, material) * (guessed.has(tag) ? GUESSED_WEIGHT : 1) * (recentSet.has(tag) ? RECENT_WEIGHT : 1);
  const open = (group, taken) => dealableTags(group).filter((tag) => !avoids.has(tag) && !taken.has(tag) && fits(tag, material)
    // No type-heavy card for a footage edit without words.
    && !(group === "type" && material?.known && !material.text && (NEEDS[tag] ?? []).includes("text")));

  const cards = [];
  const taken = new Set();
  const add = (tag, why) => { cards.push({ tag, group: techniqueOf(tag).group, why }); taken.add(tag); };
  // 0. Around the signature (the spec has moments or signatures): its technique is dealt first,
  // moments[0].tag, else a set piece; the rest of the hand is the seeded glue around it.
  const around = Boolean(style?.moments?.length || style?.signatures?.length);
  let setPiece = null;
  if (around) {
    const tag = (style.moments ?? []).map((moment) => moment.tag).find((entry) => techniqueOf(entry) && !avoids.has(entry));
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
  // 3. The set piece, when the signature did not deal one.
  if (!setPiece) setPiece = drawSetPiece(false);
  return { seed, reroll, cards, setPiece };

  // At most one set piece: a move when the library exists, else split-screen when it fits. For
  // the signature (`force`) there always is one when anything fits: a set-piece technique last.
  function drawSetPiece(force) {
    // A set piece built on a loud accent is never dealt either (engine/techniques.js LOUD_TAGS).
    const usable = moves.filter((move) => moveFits(move, material) && !(move.tags ?? []).some((tag) => avoids.has(tag) || LOUD_TAGS.includes(tag)));
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
  for (const card of deck?.cards ?? []) (shown(card.tag) ? used : unused).push(card.tag);
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
  next.cards.sort((a, b) => DECK_GROUPS.indexOf(a.group) - DECK_GROUPS.indexOf(b.group));
  return next;
}
