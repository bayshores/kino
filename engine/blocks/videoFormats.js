// Whole-video formats: a named, designer-tuned video the agent fills with typed slots (text,
// lists, pictures or screen recordings, a logo, music, a brand kit). Each format is a plan for
// compose (engine/blocks/compose.js): a fixed frame, look, feel and video type, and a list of beats
// with set lengths, transitions and named music cues. The numbers come from measured social
// promo templates: they open calm, hold one
// hero shot up to 5.5 s, keep about a third of the time as readable holds and end at about twice
// the opening energy (a cut-on-motion into the end card); social promos run 13 to 15 s, vertical.
// Each format has typed inputs with counts and lengths, a fixed aspect and length, and a
// finished example.

const text = (max, extra = {}) => ({ kind: "text", max, ...extra });
const list = (min, max, each, extra = {}) => ({ kind: "list", min, max, each, ...extra });
const media = (extra = {}) => ({ kind: "media", ...extra });
const mediaList = (min, max, extra = {}) => ({ kind: "media-list", min, max, ...extra });
// Every format takes these: the logo (a picture) or the name as a wordmark, music and a brand kit.
const COMMON = {
  logo: media({ hint: "logo picture (or give name)" }),
  name: text(24, { hint: "product or brand name; the wordmark when there is no logo" }),
  music: { kind: "music", hint: "an imported song; plays under the whole video" },
  brand: { kind: "brand", hint: "a brand kit (set_brand); the only kit when left out" },
};
// The opening logo beat: the picture, else the name as a wordmark.
const opener = (slots, dur, extra = {}) => ({ recipe: "logo-sting", dur, cue: "open", ...(slots.logo ? { media: slots.logo } : { text: slots.name }), ...extra });
const ending = (slots, dur) => ({ recipe: "cta-end", text: slots.cta, ...(slots.site ? { sub: slots.site } : {}), dur, transition: "cut-on-motion", cue: "outro" });

export const VIDEO_FORMATS = Object.freeze({
  "product-launch": {
    title: "Product launch film", aspects: ["16:9"], length: "30 s", look: "editorial", feel: "smooth", type: "promo",
    about: "logo, headline, one 5.5 s hero hold on the product, 3 feature cards, price, end card",
    slots: {
      ...COMMON, headline: text(70, { required: true }), sub: text(110), product: media({ required: true, hint: "product picture or screenshot" }),
      features: list(3, 3, 40, { required: true }), shots: mediaList(0, 3, { hint: "a picture for each feature" }), price: text(16), cta: text(28, { required: true }), site: text(48),
    },
    plan(slots) {
      const features = slots.features.map((feature, index) => ({ recipe: "feature-callout", text: feature, ...(slots.shots?.[index] ? { media: slots.shots[index] } : {}), dur: slots.price ? 3.6 : 4.6, transition: "push", cue: `feature-${index + 1}` }));
      return [
        opener(slots, 2.6),
        { recipe: "headline-reveal", text: slots.headline, ...(slots.sub ? { sub: slots.sub } : {}), kicker: "New", dur: 4.4, cue: "headline" },
        { recipe: "device-slide", media: slots.product, dur: 5.5, transition: "mask-wipe", cue: "hero" },
        ...features,
        ...(slots.price ? [{ recipe: "price-pop", price: slots.price, text: "Launch price", dur: 3.2, transition: "push", cue: "price" }] : []),
        ending(slots, 3.5),
      ];
    },
    example: { name: "Orbit", headline: "Plan the week in one view", sub: "Shared calendars for busy teams", product: "product.png", features: ["Smart scheduling", "One shared link", "Focus hours"], price: "$29", cta: "Try Orbit free", site: "orbit.app" },
  },
  "app-demo": {
    title: "App demo from screens", aspects: ["16:9", "9:16"], length: "14 s, plus 4.2 s a step", look: "crisp", feel: "smooth", type: "promo",
    about: "logo, what the app does, one step per recording (each on screen 4.2 s, readable), end card",
    slots: {
      ...COMMON, headline: text(70, { required: true }), recordings: mediaList(1, 3, { required: true, hint: "screen recordings or screenshots, one per step" }),
      steps: list(1, 3, 60, { required: true, hint: "one caption per recording" }), cta: text(28, { required: true }), site: text(48),
    },
    plan(slots) {
      if (slots.steps.length !== slots.recordings.length) throw new Error(`app-demo needs one step for each recording: ${slots.recordings.length} recordings, ${slots.steps.length} steps.`);
      return [
        opener(slots, 2.6),
        { recipe: "headline-reveal", text: slots.headline, dur: 3.4, cue: "headline" },
        ...slots.recordings.map((recording, index) => ({ recipe: "device-slide", media: recording, text: slots.steps[index], dur: 4.2, ...(index ? { transition: "push" } : {}), cue: `step-${index + 1}` })),
        ending(slots, 3.2),
      ];
    },
    example: { name: "Orbit", headline: "Book a meeting in 10 seconds", recordings: ["calendar.png", "invite.png"], steps: ["Pick a free slot", "Send one link"], cta: "Get Orbit", site: "orbit.app" },
  },
  "social-promo": {
    title: "Social promo, vertical", aspects: ["9:16"], length: "15 to 17 s (the copy decides)", look: "bold", feel: "snappy", type: "promo",
    about: "hook first, logo, 4 s product hero, quick word run, offer, end card",
    slots: {
      ...COMMON, hook: text(40, { required: true }), product: media({ required: true, hint: "product picture or screenshot" }),
      words: list(2, 4, 16, { required: true, hint: "short benefit words, one beat each" }), offer: text(16, { hint: "a price or a discount, such as -20%" }), cta: text(28, { required: true }), site: text(48),
    },
    plan(slots) {
      const words = slots.offer ? 2.2 : 3.0;
      const beats = [
        { recipe: "hook-slam", text: slots.hook, dur: 2.6, cue: "hook" },
        opener(slots, 2.4, { transition: "cut-on-motion" }),
        { recipe: "device-slide", media: slots.product, dur: 3.6, transition: "mask-wipe", cue: "hero" },
        { recipe: "word-stack", words: slots.words, dur: words, transition: "push", cue: "words" },
        ...(slots.offer ? [{ recipe: "price-pop", price: slots.offer, dur: 2.0, transition: "push", cue: "offer" }] : []),
      ];
      return [...beats, ending(slots, Math.round((15 - beats.reduce((sum, beat) => sum + beat.dur, 0)) * 100) / 100)];
    },
    example: { name: "Orbit", hook: "Stop double-booking", product: "product.png", words: ["Plan", "Focus", "Ship"], offer: "-20%", cta: "Try Orbit free", site: "orbit.app" },
  },
  "feature-announcement": {
    title: "Feature announcement", aspects: ["16:9", "9:16", "1:1"], length: "15 s (20 s with benefits)", look: "editorial", feel: "smooth", type: "promo",
    about: "logo, the feature as a headline, the feature on screen (5 s hero), up to 3 benefits, end card",
    slots: {
      ...COMMON, feature: text(70, { required: true }), detail: text(110), kicker: text(24, { hint: 'default "New"' }), shot: media({ required: true, hint: "screenshot of the feature" }),
      benefits: list(0, 3, 48), cta: text(28, { required: true }), site: text(48),
    },
    plan(slots) {
      return [
        opener(slots, 2.6),
        { recipe: "headline-reveal", text: slots.feature, ...(slots.detail ? { sub: slots.detail } : {}), kicker: slots.kicker ?? "New", dur: 3.6, cue: "headline" },
        { recipe: "device-slide", media: slots.shot, dur: 5.0, transition: "mask-wipe", cue: "hero" },
        ...(slots.benefits?.length ? [{ recipe: "step-list", items: slots.benefits, dur: 4.0, transition: "push", cue: "benefits" }] : []),
        ending(slots, 3.4),
      ];
    },
    example: { name: "Orbit", feature: "Focus hours are here", detail: "Orbit guards your deep work from meetings", shot: "product.png", benefits: ["Blocks meetings for you", "Syncs with your team", "One click to set"], cta: "Update Orbit", site: "orbit.app" },
  },
  testimonial: {
    title: "Testimonial or quote", aspects: ["1:1", "16:9", "9:16", "4:5"], length: "11 s (15 s with a number)", look: "editorial", feel: "calm", type: "other",
    about: "logo, the quote held 5.5 s with who said it, an optional number, end card",
    slots: {
      ...COMMON, quote: text(66, { required: true, hint: "the words, without quote marks" }), person: text(48, { required: true, hint: "name, and role or company" }),
      number: { kind: "number", hint: "a result, such as 40" }, number_label: text(48), number_suffix: text(6), cta: text(28, { required: true }), site: text(48),
    },
    plan(slots) {
      return [
        opener(slots, 2.6),
        { recipe: "headline-reveal", text: `“${slots.quote}”`, sub: slots.person, dur: 5.5, cue: "quote" },
        ...(typeof slots.number === "number" ? [{ recipe: "number-counter", value: slots.number, ...(slots.number_label ? { label: slots.number_label } : {}), ...(slots.number_suffix ? { suffix: slots.number_suffix } : {}), dur: 3.2, transition: "push", cue: "number" }] : []),
        ending(slots, 3.2),
      ];
    },
    example: { name: "Orbit", quote: "We stopped double-booking in the first week", person: "Maya Lin, Head of Ops at Fieldwork", number: 40, number_label: "fewer meetings a month", number_suffix: "%", cta: "Try Orbit free", site: "orbit.app" },
  },
});
export const VIDEO_FORMAT_NAMES = Object.freeze(Object.keys(VIDEO_FORMATS));

const describeSlot = (key, slot) => {
  const kind = slot.kind === "text" ? `text ≤${slot.max}` : slot.kind === "list" ? `${slot.min === slot.max ? slot.min : `${slot.min}-${slot.max}`} texts ≤${slot.each}` : slot.kind === "media-list" ? `${slot.min}-${slot.max} media` : slot.kind;
  return `${key}${slot.required ? "" : "?"} (${kind}${slot.hint ? `: ${slot.hint}` : ""})`;
};

function checkSlot(name, key, slot, value) {
  const where = `${name} slot ${key}`;
  if (slot.kind === "text") {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${where} is text.`);
    if (value.length > slot.max) throw new Error(`${where} is ${value.length} characters, at most ${slot.max}.`);
  } else if (slot.kind === "list") {
    if (!Array.isArray(value) || value.length < slot.min || value.length > slot.max) throw new Error(`${where} is a list of ${slot.min === slot.max ? slot.min : `${slot.min} to ${slot.max}`} texts.`);
    value.forEach((entry, index) => { if (typeof entry !== "string" || !entry.trim() || entry.length > slot.each) throw new Error(`${where}[${index}] is text of 1 to ${slot.each} characters.`); });
  } else if (slot.kind === "media-list") {
    if (!Array.isArray(value) || value.length < slot.min || value.length > slot.max || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${where} is a list of ${slot.min} to ${slot.max} imported media names.`);
  } else if (slot.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where} is a number.`);
  } else if (typeof value !== "string" || !value.trim()) throw new Error(`${where} is the name of ${slot.kind === "brand" ? "a brand kit" : "an imported file"}.`);
}

/**
 * Checks a format's slots and turns them into a compose input plus the music and cue names.
 * Returns {compose: {format, duration, look, feel, type, brand?, beats}, music, cues:[{name, beat}]}.
 * Throws a plain message naming the slot for each problem.
 */
export function expandVideoFormat(name, slots = {}, { aspect } = {}) {
  const definition = VIDEO_FORMATS[name];
  if (!definition) throw new Error(`Unknown format "${name}". Formats: ${VIDEO_FORMAT_NAMES.join(", ")}.`);
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) throw new Error(`slots is an object: ${Object.keys(definition.slots).join(", ")}.`);
  for (const key of Object.keys(slots)) if (!definition.slots[key]) throw new Error(`${name} has no slot "${key}". Slots: ${Object.keys(definition.slots).join(", ")}.`);
  for (const [key, slot] of Object.entries(definition.slots)) {
    const value = slots[key];
    if (value === undefined || value === null) {
      if (slot.required) throw new Error(`${name} needs slot ${key}: ${describeSlot(key, slot)}.`);
      continue;
    }
    checkSlot(name, key, slot, value);
  }
  if (!slots.logo && !slots.name) throw new Error(`${name} needs logo (a picture) or name (the wordmark).`);
  const chosen = aspect ?? definition.aspects[0];
  if (!definition.aspects.includes(chosen)) throw new Error(`${name} comes in ${definition.aspects.join(", ")}, not ${chosen}.`);
  const planned = definition.plan(slots);
  const cues = [];
  const beats = planned.map(({ cue, ...beat }, index) => {
    if (cue) cues.push({ name: cue, beat: index });
    return beat;
  });
  const duration = Math.round(beats.reduce((sum, beat) => sum + beat.dur, 0) * 100) / 100;
  // The last beat holds to the end, so its own dur is left to compose (the total sets it).
  const { dur: _last, ...last } = beats.at(-1);
  return {
    compose: { format: chosen, duration, look: definition.look, feel: definition.feel, type: definition.type, ...(slots.brand ? { brand: slots.brand } : {}), beats: [...beats.slice(0, -1), last] },
    music: slots.music ?? null, cues,
  };
}

/**
 * Builds an expanded format with `build(compose)` (composeScene, or the edit's compose). Copy
 * longer than a beat's planned length makes that beat (and the whole video) longer instead of
 * failing: the plan is the pace, the copy's reading time is the floor. Returns {made, compose}.
 */
export async function buildVideoFormat(expanded, build) {
  const compose = structuredClone(expanded.compose);
  for (let tries = 0; ; tries += 1) {
    try { return { made: await build(compose), compose }; }
    catch (error) {
      if (tries > compose.beats.length + 1) throw error;
      const beat = compose.beats[error.beat];
      if (Number.isFinite(error.least) && beat?.dur !== undefined) {
        compose.duration = Math.round((compose.duration + error.least - beat.dur) * 1000) / 1000;
        beat.dur = error.least;
      } else if (Number.isFinite(error.needed)) compose.duration = Math.ceil(error.needed * 100) / 100;
      else throw error;
    }
  }
}

/** library {topic:"formats"}: every format in one line, or one format's slots and example op. */
export function videoFormatsText(name) {
  if (!name) {
    return [
      'formats: whole videos with a fixed shape, length, structure, pacing and type. format {name, slots:{…}, aspect?, scene?, id?, seed?} builds one; library {topic:"formats", name} gives its slots and an example.',
      ...VIDEO_FORMAT_NAMES.map((key) => { const f = VIDEO_FORMATS[key]; return `${key}: ${f.title}, ${f.aspects.join(" or ")}, ${f.length}: ${f.about}.`; }),
    ].join("\n");
  }
  const definition = VIDEO_FORMATS[name];
  if (!definition) throw new Error(`Unknown format "${name}". Formats: ${VIDEO_FORMAT_NAMES.join(", ")}.`);
  return [
    `${name}: ${definition.title}. ${definition.aspects.join(" or ")} (aspect picks; the first is the default), ${definition.length}, look ${definition.look}, feel ${definition.feel}${definition.type === "other" ? "" : `, a ${definition.type}`}. ${definition.about}.`,
    `slots: ${Object.entries(definition.slots).map(([key, slot]) => describeSlot(key, slot)).join(", ")}. Media slots take imported pictures or videos by name; logo or name is needed.`,
    `cues: music and sound cues at each section (at:"cue:hero"), for SFX on what moves.`,
    `example: ${JSON.stringify({ op: "format", name, slots: definition.example })}`,
  ].join("\n");
}
