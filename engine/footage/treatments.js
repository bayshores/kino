// The one-word treatments of compose {footage}: each sets the captions, the camera, the set of
// transitions and how dense the cutting is, together, so a cut never mixes a calm caption with a
// glitch hit. The project's deck (engine/deck.js) then varies the edit inside the treatment: its
// cards go first, and its seed picks among the rest, so two projects never get the same edit.
//
//   transitions  the kinds used where shots change (a cut everywhere else), first ones likelier
//   density      the share of shot changes that get a designed transition (the rest are cuts)
//   beats        how many beats a shot without speech lasts: [shortest, longest]
//   camera       how a shot moves while it holds: slow-push, drift, parallax (for a card over
//                its blurred copy); no step on a beat number
//   captions     words per caption: calm 4 to 6, talk 3 to 5, high 2 to 3 (caption-words energy)
//   title        push-through-type (a giant word the camera flies into), blur-in or letters
//   hits         what may land on the song's measured drop (the first one only): rgb-split
//                (rgb-split-hit), flash
import { seeded } from "../blocks/build.js";

export const FOOTAGE_TREATMENTS = Object.freeze({
  calm: Object.freeze({ line: "slow and clean: long holds, soft dissolves, calm captions", transitions: ["dissolve", "blur-through", "fade-black"], density: 0.45, beats: [4, 8], camera: ["slow-push", "drift"], captions: "calm", title: "blur-in", hits: [] }),
  story: Object.freeze({ line: "a told story: shots on the phrase, shape wipes and dissolves, talk captions", transitions: ["dissolve", "mask-wipe", "zoom-through", "push-transition"], density: 0.4, beats: [2, 4], camera: ["drift", "slow-push", "parallax"], captions: "talk", title: "letters", hits: [] }),
  punchy: Object.freeze({ line: "fast and bright: cuts on the beat, whips and zooms, short captions", transitions: ["whip-pan", "zoom-through", "flash"], density: 0.5, beats: [1, 2], camera: ["slow-push", "drift"], captions: "high", title: "push-through-type", hits: ["rgb-split"] }),
  loud: Object.freeze({ line: "raw energy: a glitch or flash cut and a color split, only on a real drop", transitions: ["glitch-hit", "flash", "whip-pan", "zoom-through"], density: 0.6, beats: [1, 2], camera: ["drift", "slow-push"], captions: "high", title: "push-through-type", hits: ["rgb-split", "flash"] }),
});
export const TREATMENT_NAMES = Object.freeze(Object.keys(FOOTAGE_TREATMENTS));

// The type and colors of an edit made without a brand kit: two pairs per treatment (headline,
// then captions and small text), never a common default font; the seed picks the pair and the accent.
const TYPE_PAIRS = {
  calm: [[{ family: "Fraunces", weight: 600 }, { family: "DM Sans", weight: 500 }], [{ family: "Cormorant Garamond", weight: 600 }, { family: "Karla", weight: 600 }]],
  story: [[{ family: "Instrument Serif", weight: 400 }, { family: "Manrope", weight: 600 }], [{ family: "DM Serif Display", weight: 400 }, { family: "Work Sans", weight: 500 }]],
  punchy: [[{ family: "Space Grotesk", weight: 700 }, { family: "Space Grotesk", weight: 500 }], [{ family: "Archivo", weight: 800 }, { family: "Archivo", weight: 600 }]],
  loud: [[{ family: "Anton", weight: 400 }, { family: "Space Mono", weight: 700 }], [{ family: "Bebas Neue", weight: 400 }, { family: "IBM Plex Mono", weight: 600 }]],
};
const ACCENTS = {
  calm: ["#E8D2A6", "#B9D3C2", "#D8B4A0"],
  story: ["#F2B544", "#E8846B", "#8FC1E3"],
  punchy: ["#FF5A36", "#FFD23F", "#3DDC97"],
  loud: ["#C6FF3D", "#FF2E88", "#36E2F2"],
};

/** A brand kit for an edit made without one: {fonts, colors, motion} from the treatment and seed. */
export function footageBrand(name, seed) {
  const rng = seeded(seed * 17 + 11);
  const pairs = TYPE_PAIRS[name] ?? TYPE_PAIRS.story;
  const accents = ACCENTS[name] ?? ACCENTS.story;
  const fonts = pairs[Math.floor(rng.next() * pairs.length) % pairs.length];
  const accent = accents[Math.floor(rng.next() * accents.length) % accents.length];
  return {
    fonts: fonts.map((font) => ({ ...font })),
    colors: { bg: "#0A0A0C", surface: "#17171B", text: "#F5F3EE", accent, accent2: accents[(accents.indexOf(accent) + 1) % accents.length] },
    motion: name === "calm" ? "calm" : name === "story" ? "smooth" : "snappy",
  };
}
const ALIASES = {
  chill: "calm", soft: "calm", slow: "calm", clean: "calm", elegant: "calm", dreamy: "calm", minimal: "calm",
  doc: "story", documentary: "story", narrative: "story", talk: "story", explainer: "story", interview: "story",
  fast: "punchy", hype: "punchy", energetic: "punchy", upbeat: "punchy", bold: "punchy", trailer: "punchy",
  glitch: "loud", glitchy: "loud", raw: "loud", aggressive: "loud", noisy: "loud", rough: "loud",
};

/** The treatment a word names (its name or a near word), or null. */
export function treatmentNamed(word) {
  const text = String(word ?? "").trim().toLowerCase();
  if (FOOTAGE_TREATMENTS[text]) return text;
  return ALIASES[text] ?? null;
}

/** The treatment a brief's picked direction reads as ({idea, move, rhythm}), or null. */
export function treatmentFromPick(pick) {
  if (!pick) return null;
  const text = `${pick.idea ?? ""} ${pick.move ?? ""} ${pick.rhythm ?? ""}`.toLowerCase();
  const votes = { calm: 0, story: 0, punchy: 0, loud: 0 };
  for (const word of text.match(/[a-z]+/g) ?? []) if (ALIASES[word] || FOOTAGE_TREATMENTS[word]) votes[ALIASES[word] ?? word] += 1;
  if (/whip|zoom|beat|cut fast|drop/.test(text)) votes.punchy += 1;
  if (/glitch|flash|rgb|split/.test(text)) votes.loud += 1;
  if (/dissolve|hold|breath|quiet/.test(text)) votes.calm += 1;
  if (/story|voice|said|interview|tell/.test(text)) votes.story += 1;
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * The treatment for an edit when none is given: from the material (speech-led → story, a fast
 * song → punchy, a slow one → calm, a deck with loud cards → loud), the seed choosing between the
 * two best fits so two projects of the same material differ.
 */
export function guessTreatment({ speechShare = 0, bpm = null, deck = null, seed = 1 }) {
  const cards = new Set([...(deck?.cards ?? []).map((card) => card.tag), deck?.setPiece?.name].filter(Boolean));
  const score = { calm: 1, story: 1, punchy: 1, loud: 0.6 };
  if (speechShare >= 0.4) score.story += 2;
  if (bpm && bpm >= 115) { score.punchy += 1.5; score.loud += 1; }
  if (bpm && bpm < 95) score.calm += 1.5;
  if (!bpm) score.calm += 0.5;
  for (const tag of ["glitch-hit", "rgb-split", "flash", "shake"]) if (cards.has(tag)) score.loud += 0.8;
  for (const tag of ["whip-pan", "zoom-through", "speed-ramp"]) if (cards.has(tag)) score.punchy += 0.6;
  for (const tag of ["dissolve", "drift", "slow-push", "blur-through"]) if (cards.has(tag)) score.calm += 0.5;
  for (const tag of ["mask-wipe", "parallax", "type-words"]) if (cards.has(tag)) score.story += 0.4;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  // The seed picks the runner-up now and then (when it is close), so the same footage varies.
  const rng = seeded(seed * 7 + 3);
  return ranked[1][1] >= ranked[0][1] - 1 && rng.next() < 0.35 ? ranked[1][0] : ranked[0][0];
}

// What each deck card becomes in a footage edit (engine/techniques.js tags).
const TRANSITION_CARDS = new Set(["dissolve", "fade-black", "blur-through", "zoom-through", "whip-pan", "mask-wipe", "glitch-hit", "flash", "push-transition"]);
const CAMERA_CARDS = new Set(["slow-push", "drift", "parallax"]);
const HIT_CARDS = { "rgb-split": "rgb-split", flash: "flash", shake: "rgb-split", "glitch-hit": "rgb-split" };
const TITLE_CARDS = { "type-giant": "push-through-type", "type-letters": "letters", "type-blur-in": "blur-in", "type-mask-rise": "blur-in", "type-fade": "blur-in", "type-pop": "letters", "type-slide": "letters", "type-kinetic": "push-through-type" };

/**
 * The style of one edit: the treatment's choices with the deck's cards first, ordered by the
 * seed. Returns {name, line, transitions, density, beats, camera, captions, title, hits,
 * speedRamp, freeze, setPiece, cardsUsed:[tags this edit builds]}.
 */
export function editStyle(name, deck, seed) {
  const base = FOOTAGE_TREATMENTS[name];
  const rng = seeded(seed * 13 + 5);
  const cards = (deck?.cards ?? []).map((card) => card.tag);
  const shuffle = (list) => list.map((value) => ({ value, key: rng.next() })).sort((a, b) => a.key - b.key).map((entry) => entry.value);
  const used = new Set();
  const deckTransitions = cards.filter((tag) => TRANSITION_CARDS.has(tag));
  for (const tag of deckTransitions) used.add(tag);
  // The deck's transitions first, then the treatment's own in a seeded order (at most 3 kinds).
  const transitions = [...new Set([...deckTransitions, ...shuffle([...base.transitions])])].slice(0, Math.max(3, deckTransitions.length));
  const deckCamera = cards.filter((tag) => CAMERA_CARDS.has(tag));
  for (const tag of deckCamera) used.add(tag);
  const camera = [...new Set([...deckCamera, ...shuffle([...base.camera])])];
  let title = base.title;
  const titleCard = cards.find((tag) => TITLE_CARDS[tag]);
  if (titleCard) { title = TITLE_CARDS[titleCard]; used.add(titleCard); }
  const hits = [...base.hits];
  for (const tag of cards) if (HIT_CARDS[tag]) { if (!hits.includes(HIT_CARDS[tag])) hits.push(HIT_CARDS[tag]); used.add(tag); }
  if (cards.includes("type-words")) used.add("type-words");
  if (cards.includes("depth-blur")) used.add("depth-blur");
  if (cards.includes("motion-blur")) used.add("motion-blur");
  const speedRamp = cards.includes("speed-ramp");
  if (speedRamp) used.add("speed-ramp");
  const freeze = cards.includes("freeze-frame");
  if (freeze) used.add("freeze-frame");
  const setPiece = deck?.setPiece?.kind === "move" ? deck.setPiece.name : null;
  return {
    name, line: base.line, transitions, density: base.density, beats: base.beats, camera, captions: base.captions, title, hits,
    speedRamp, freeze, setPiece, cardsUsed: [...used],
  };
}
