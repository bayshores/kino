// variants {vary:"deck"}: a composed scene made again with another deck's cards (engine/deck.js),
// so the person can compare openings dealt from different decks side by side.
//
// What each card changes in a composition, when it can:
//   transition  push-transition and mask-wipe become every beat's transition
//   type        type-words, type-letters, type-slide, type-pop, type-fade and type-mask-rise
//               become the beats' entrance (enter), on the beats whose recipe offers it
//   camera      slow-push and drift move each large picture slowly (40% of the frame or more)
//   texture     particles and light-sweep lay an effect over the frame; rgb-split and
//               motion-blur hit each headline as it enters
// The deck's seed is the composition's seed, so the layout changes too. A card a composition
// cannot show (a dissolve between text beats, a set piece before the moves library) is listed as
// left to build, never faked.
import { createLayer } from "../model.js";
import { effectDefinition } from "../effects/catalog.js";
import { round } from "../numbers.js";

const DRIFT = [0.37, 0, 0.63, 1];
const HIT = [0.16, 1, 0.3, 1];

export const DECK_TRANSITIONS = Object.freeze({ "push-transition": "push", "mask-wipe": "mask-wipe" });
export const DECK_ENTRANCES = Object.freeze({ "type-words": "rise", "type-letters": "letters", "type-slide": "slide-left", "type-pop": "pop", "type-fade": "fade", "type-mask-rise": "lines" });
const OVERLAYS = Object.freeze({ particles: "dust", "light-sweep": "light-leaks" });
const HEADLINE_HITS = Object.freeze({ "rgb-split": "rgb-shift", "motion-blur": "zoom-blur" });

/**
 * The composition input with the deck's seed, transition and entrance. Returns { input, applied }
 * (applied: the card tags it used).
 */
export function deckComposition(input, deck) {
  const tags = (deck.cards ?? []).map((card) => card.tag);
  const transition = tags.map((tag) => DECK_TRANSITIONS[tag]).find(Boolean);
  const enter = tags.map((tag) => DECK_ENTRANCES[tag]).find(Boolean);
  const applied = tags.filter((tag) => (transition && DECK_TRANSITIONS[tag] === transition) || (enter && DECK_ENTRANCES[tag] === enter));
  const beats = input.beats.map((beat, index) => ({
    ...beat,
    ...(transition && index > 0 ? { transition } : {}),
    ...(enter ? { enter } : {}),
    ...(beat.seed !== undefined ? { seed: deck.seed + index } : {}),
  }));
  return { input: { ...input, seed: deck.seed, beats }, applied };
}

/**
 * Composes with `compose(input)`; a beat whose recipe does not offer the deck's entrance keeps
 * its own (the refusal names the beat). Returns { result, input }.
 */
export function composeLenient(input, compose) {
  let current = input;
  for (let attempt = 0; attempt <= current.beats.length; attempt += 1) {
    try {
      return { result: compose(current), input: current };
    } catch (error) {
      // The beat is error.beat, or named in the message ("beat 4 (cta-end): …").
      const index = Number.isInteger(error.beat) ? error.beat : Number(/beat (\d+)/.exec(error.message)?.[1]) - 1;
      if (!Number.isInteger(index) || !/\benter\b/.test(error.message) || current.beats[index]?.enter === undefined) throw error;
      current = { ...current, beats: current.beats.map((beat, position) => (position === index ? (({ enter, ...rest }) => rest)(beat) : beat)) };
    }
  }
  return { result: compose(current), input: current };
}

/**
 * The camera and texture cards on the made layers: slow moves on large pictures, an effect layer
 * over the frame, a hit on each headline's entrance. Changes `layers` in place and returns
 * { layers: the new layers to add on top, applied }.
 */
export function deckFinish(layers, deck, { frame, duration, id, taken = new Set() }) {
  const tags = (deck.cards ?? []).map((card) => card.tag);
  const applied = [];
  const added = [];
  const freeId = (base) => {
    let name = base;
    for (let number = 2; taken.has(name); number += 1) name = `${base}-${number}`;
    taken.add(name);
    return name;
  };
  const animate = (layer, key, animation) => {
    const motion = animation.kind === "effect" ? {} : { unit: "layer", stagger: 0, order: "forward" };
    layer.animations = [...(layer.animations ?? []), { id: freeId(`${layer.id}.${key}`), ...motion, ...animation }];
  };
  const area = frame.width * frame.height;
  const large = layers.filter((layer) => (layer.type === "image" || layer.type === "video") && layer.width * layer.height >= 0.4 * area);

  // Camera: a slow push (6% over the scene) or a drift (3% of the width) on each large picture.
  const camera = tags.find((tag) => tag === "slow-push" || tag === "drift");
  if (camera && large.length) {
    for (const layer of large) {
      const grow = 1.06;
      // The camera takes the place of the picture's own hold drift (engine/blocks/hold.js); its exit
      // then starts from where the picture rests again.
      const hold = (layer.animations ?? []).find((animation) => String(animation.id ?? "").endsWith(".hold"));
      if (hold) {
        const [dx, dy] = [(hold.to.x ?? 0) - (hold.from.x ?? 0), (hold.to.y ?? 0) - (hold.from.y ?? 0)];
        layer.animations = layer.animations.filter((animation) => animation !== hold);
        for (const exit of layer.animations.filter((animation) => animation.kind === "out"))
          for (const side of [exit.from, exit.to]) {
            if (side?.x !== undefined) side.x = round(side.x - dx);
            if (side?.y !== undefined) side.y = round(side.y - dy);
          }
      }
      animate(layer, camera, {
        name: camera === "slow-push" ? "Slow push" : "Drift", kind: "custom", start: 0, duration: round(duration), easing: DRIFT,
        from: camera === "slow-push" ? { scaleX: 1, scaleY: 1 } : { scaleX: grow, scaleY: grow, x: layer.x },
        to: camera === "slow-push" ? { scaleX: grow, scaleY: grow } : { scaleX: grow, scaleY: grow, x: Math.round(layer.x - frame.width * 0.03) },
      });
    }
    applied.push(camera);
  }
  // Texture over the frame: drifting dust or light leaks, never over 60% opacity.
  for (const tag of tags.filter((entry) => OVERLAYS[entry])) {
    const layer = createLayer("rectangle", {
      id: freeId(`${id}-${tag}`), name: tag === "particles" ? "Dust" : "Light leaks", x: 0, y: 0, width: frame.width, height: frame.height,
      fillEnabled: false, strokeWidth: 0, blendMode: "screen", opacity: 0.6, role: "decor", allowOverlap: true,
    });
    animate(layer, "fx", { name: layer.name, kind: "effect", effect: OVERLAYS[tag], start: 0, duration: round(duration), easing: DRIFT, to: {} });
    added.push(layer);
    applied.push(tag);
  }
  // A short hit on each headline as it enters.
  for (const tag of tags.filter((entry) => HEADLINE_HITS[entry])) {
    const headlines = layers.filter((layer) => layer.type === "text" && ["headline", "hero"].includes(layer.role));
    for (const layer of headlines) {
      const entrance = (layer.animations ?? []).find((animation) => animation.kind === "in");
      if (!entrance) continue;
      // Strong at the start of the entrance, gone by its end (nothing kept after).
      animate(layer, tag, { name: tag === "rgb-split" ? "RGB split" : "Zoom blur", kind: "effect", effect: HEADLINE_HITS[tag], start: entrance.start, duration: 0.3, easing: HIT,
        from: { amount: 0.3 }, to: { amount: 0 }, ...(effectDefinition(HEADLINE_HITS[tag]).kind === "ranged" ? { keepStill: "off" } : {}) });
    }
    if (headlines.length) applied.push(tag);
  }
  return { layers: added, applied };
}
