// The library screen's catalog (frontend/dashboard/library.jsx): everything an agent can use, by
// kind (moves, effects, animations, recipes, looks, video formats) and by what it does (the
// technique groups of engine/techniques.js). Each entry has one line on what it is, when it fits,
// and the ops that build a short sample of it (sampleOps), which the service runs on an empty
// scene so the screen can play it.
import { PRESETS } from "../../engine/animation.js";
import { LOOKS } from "../../engine/blocks/looks.js";
import { MOVES, MOVE_NAMES } from "../../engine/blocks/moves/index.js";
import { RECIPES, TRANSITIONS } from "../../engine/blocks/recipes/index.js";
import { VIDEO_FORMATS } from "../../engine/blocks/videoFormats.js";
import { EFFECTS, effectDefaults } from "../../engine/effects/catalog.js";
import { TECHNIQUES, TECHNIQUE_GROUPS, techniqueOf } from "../../engine/techniques.js";

export const SAMPLE_FRAME = Object.freeze({ width: 960, height: 540 });

export const LIBRARY_KINDS = Object.freeze([
  { kind: "move", label: "moves" }, { kind: "effect", label: "effects" }, { kind: "animation", label: "animations" },
  { kind: "recipe", label: "recipes" }, { kind: "look", label: "looks" }, { kind: "format", label: "video formats" },
]);

const GROUP_WORDS = {
  transition: ["transitions", "how one shot becomes the next"],
  camera: ["camera", "how the frame moves"],
  type: ["type", "how words come on screen"],
  texture: ["texture", "what is laid over the picture"],
  "set-piece": ["set pieces", "bigger moments built from several layers"],
  rhythm: ["rhythm", "when things land"],
};

// Technique tags for the kinds that do not carry their own (moves do: move.tags).
const ANIMATION_TAGS = {
  "fade-in": ["type-fade"], "fade-out": ["type-fade"], "slide-up": ["type-slide"], "slide-down": ["type-slide"], "slide-left": ["type-slide"],
  "slide-right": ["type-slide"], "grow-in": ["type-pop"], "shrink-out": ["type-pop"], scale: ["type-pop"], "blur-in": ["type-blur-in"],
  "blur-out": ["type-blur-in"], counter: ["type-counter"], "change-text": ["type-swap"], "letter-spacing": ["type-kinetic"],
  "line-height": ["type-kinetic"], move: ["drift"], tilt: ["orbit-3d"], "rotate-in": ["type-kinetic"], trim: ["draw-on"], hide: ["type-cut"], show: ["type-cut"],
};
const EFFECT_TAGS = {
  "directional-blur": ["motion-blur"], "zoom-blur": ["motion-blur", "zoom-through"], "spin-blur": ["motion-blur"], "rgb-shift": ["rgb-split"],
  embers: ["particles"], sparks: ["particles"], snow: ["particles"], dust: ["particles"], rain: ["particles"], bokeh: ["particles"], fog: ["particles"],
  "light-leaks": ["light-sweep"], "light-rays": ["light-sweep"], "lens-flare": ["light-sweep"], glow: ["light-sweep"],
  "3d-orbit": ["orbit-3d"], "card-flip": ["orbit-3d"], wiggle: ["shake"], "focus-band": ["depth-blur"],
  grain: ["grain"], vignette: ["vignette"],
};
const RECIPE_TAGS = {
  "hook-slam": ["type-giant"], "caption-pop": ["type-pop"], "number-counter": ["type-counter"], "price-pop": ["type-pop"], "title-type": ["type-letters"],
  "wordmark-type": ["type-letters"], "split-reveal": ["type-mask-rise"], "headline-reveal": ["type-mask-rise"], "connector-draw": ["draw-on"],
  "line-chart-draw": ["draw-on"], "word-stack": ["type-kinetic"], "device-slide": ["device-in-scene"], "screen-detail": ["screen-zoom"],
  "cut-on-motion": ["cut"], push: ["push-transition"], "mask-wipe": ["mask-wipe"],
};

const words = (name) => String(name).replaceAll("-", " ");
const groupsOf = (tags) => [...new Set(tags.map((tag) => techniqueOf(tag)?.group).filter(Boolean))];
const firstLine = (tags) => tags.map((tag) => techniqueOf(tag)).find(Boolean);
const PRESET_KIND_WORDS = { in: "brings a layer in", out: "takes a layer out", custom: "changes one property over time", hide: "hides a layer at a moment", show: "shows a layer at a moment" };

function entry(kind, name, line, fits, tags) {
  return { id: `${kind}:${name}`, kind, name, words: words(name), line, fits: fits ?? "", tags, groups: groupsOf(tags) };
}

let built = null;

/** Every entry, the kinds with their counts and the technique groups. Built once. */
export function libraryCatalog() {
  if (built) return built;
  const entries = [];
  for (const name of MOVE_NAMES) entries.push(entry("move", name, MOVES[name].about, MOVES[name].fits, [...(MOVES[name].tags ?? [])]));
  for (const effect of EFFECTS) {
    const tags = EFFECT_TAGS[effect.key] ?? [];
    const settings = Object.values(effect.parameters ?? {}).map((parameter) => parameter.label.toLowerCase());
    entries.push(entry("effect", effect.key, firstLine(tags)?.line ?? `${effect.group.toLowerCase()} effect${settings.length ? `: ${settings.slice(0, 3).join(", ")}` : ""}`, firstLine(tags)?.fits, tags));
  }
  for (const preset of PRESETS) {
    const tags = ANIMATION_TAGS[preset.id] ?? [];
    entries.push(entry("animation", preset.id, `${preset.name.toLowerCase()}: ${PRESET_KIND_WORDS[preset.kind] ?? preset.kind}`, firstLine(tags)?.fits, tags));
  }
  for (const recipe of [...Object.values(RECIPES), ...Object.values(TRANSITIONS)])
    entries.push(entry("recipe", recipe.name, recipe.about, recipe.group ? `${recipe.group} videos` : "a change between two beats", RECIPE_TAGS[recipe.name] ?? []));
  for (const look of Object.values(LOOKS)) entries.push(entry("look", look.name, look.about, "", []));
  for (const [name, format] of Object.entries(VIDEO_FORMATS))
    entries.push({ ...entry("format", name, format.about, `${format.aspects.join(", ")} · ${format.length}`, []), words: format.title.toLowerCase() });
  // Techniques kino finds and makes with plain edits (a cut, a dissolve) but no entry above carries.
  const carried = new Set(entries.flatMap((item) => item.tags));
  for (const technique of TECHNIQUES)
    if (technique.detect && !carried.has(technique.tag)) entries.push(entry("technique", technique.tag, technique.line, technique.fits, [technique.tag]));
  const kinds = LIBRARY_KINDS.map((kind) => ({ ...kind, count: entries.filter((item) => item.kind === kind.kind).length }));
  const groups = TECHNIQUE_GROUPS.map((group) => ({ group, label: GROUP_WORDS[group][0], line: GROUP_WORDS[group][1], count: entries.filter((item) => item.groups.includes(group)).length }));
  built = { entries, kinds, groups, total: kinds.reduce((sum, kind) => sum + kind.count, 0) };
  return built;
}

const { width: W, height: H } = SAMPLE_FRAME;
// The pictures, clip and color look the samples use, drawn once by library-media.mjs into the
// media folder under these fixed names. A new drawing needs a new name (the last digits).
const mediaId = (n, extension) => `6b696e6f-0000-4000-8000-${String(n).padStart(12, "0")}.${extension}`;
export const LIBRARY_MEDIA = Object.freeze([
  { name: "shot-a", id: mediaId(101, "png"), mime: "image/png", width: 1920, height: 1080 },
  { name: "shot-b", id: mediaId(102, "png"), mime: "image/png", width: 1920, height: 1080 },
  { name: "screen-a", id: mediaId(103, "png"), mime: "image/png", width: 600, height: 1200 },
  { name: "screen-b", id: mediaId(104, "png"), mime: "image/png", width: 600, height: 1200 },
  { name: "screen-c", id: mediaId(105, "png"), mime: "image/png", width: 600, height: 1200 },
  { name: "logo", id: mediaId(106, "png"), mime: "image/png", width: 512, height: 512 },
  { name: "clip", id: mediaId(107, "mp4"), mime: "video/mp4", width: 960, height: 540, duration: 4 },
  { name: "look", id: mediaId(108, "cube"), mime: "text/plain", width: 0, height: 0 },
].map((item) => Object.freeze({ ...item, src: `/api/media/${item.id}` })));
const src = (name) => LIBRARY_MEDIA.find((item) => item.name === name).src;
const rect = (name, properties) => ({ op: "add_layer", layerType: "rectangle", name, properties });
const picture = (name, properties = {}) => ({ op: "add_layer", layerType: "image", name, properties: { src: src(name), x: 0, y: 0, width: W, height: H, ...properties } });
const SHOT_A = picture("shot-a");
const SHOT_B = picture("shot-b");
const CLIP = { op: "add_layer", layerType: "video", name: "clip", properties: { src: src("clip"), x: 0, y: 0, width: W, height: H, mediaSourceDuration: 4 } };
const WORD = (text = "kino", size = 120) => ({ op: "add_layer", layerType: "text", name: "word", properties: { text, fontSize: size, fontWeight: 800, fill: "#F4F2EE", x: W / 2 - text.length * size * 0.3, y: H / 2 - size * 0.6 } });
// The layers the moves' library examples name (engine/moves.test.js has the same set).
const MOVE_SET = [
  SHOT_B, SHOT_A, CLIP,
  rect("phone", { x: W / 2 - 75, y: H * 0.19, width: 150, height: 326, radius: 24, fill: "#C9CCD0" }),
  rect("app-card", { x: W * 0.08, y: H * 0.1, width: W * 0.3, height: W * 0.18, radius: 18, fill: "#2A2D33" }),
  rect("prompt-field", { x: W * 0.1, y: H * 0.45, width: W * 0.45, height: 64, radius: 16, fill: "#1A1D22" }),
  { op: "add_layer", layerType: "text", name: "prompt", properties: { text: "Find issues with loading", fontSize: 30, fill: "#EDEEF0", x: W * 0.1 + 24, y: H * 0.45 + 14 } },
  { op: "add_layer", layerType: "path", name: "underline", properties: { x: W * 0.3, y: H * 0.7, width: W * 0.4, height: 24, path: "M0 12 C120 0 240 24 384 12", fillEnabled: false, stroke: "#FFFFFF", strokeWidth: 6 } },
];
// Each recipe's sample words.
const RECIPE_COPY = {
  "logo-sting": { text: "kino", tagline: "made for motion" }, "headline-reveal": { text: "Set it up in seconds", sub: "no account, no setup" },
  "feature-callout": { text: "Live preview", sub: "every change as it lands" }, callout: { text: "Keys found" },
  "price-pop": { price: "$9/mo", text: "every feature", label: "Launch price" }, "cta-end": { text: "Start free today", sub: "kino.app" },
  "hook-slam": { text: "Stop scrolling" }, "caption-pop": { text: "this changes everything" }, "tip-card": { title: "Tip 3", text: "Name every layer" },
  "progress-bar": { text: "Rendering", value: 70 }, "follow-cta": { text: "Follow for daily tips", handle: "@kino" },
  "step-list": { items: ["Import", "Direct", "Render"], title: "How it works" }, "diagram-build": { items: ["Brief", "Board", "Edit"], title: "The loop" },
  "connector-draw": { from: "Agent", to: "kino", label: "ten tools" },
  "bar-chart-grow": { bars: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }, { label: "Wed", value: 8 }], suffix: "k" },
  "line-chart-draw": { points: [2, 4, 3, 7, 9], suffix: "k" }, "number-counter": { value: 98, suffix: "%", label: "faster renders" },
  "wordmark-type": { text: "kino" }, "word-stack": { words: ["make", "it", "move"] }, "split-reveal": { text: "Built for motion", sub: "by agents" },
  "title-type": { text: "Chapter one", sub: "the brief" }, "device-slide": { text: "Your day at a glance", sub: "every plan in one place" },
};
// The picture each recipe that takes one uses.
const RECIPE_MEDIA = { "device-slide": "screen-a", "screen-detail": "screen-b", "logo-build": "logo" };
// The layer each animation preset needs, when a word is not it.
const PRESET_LAYER = {
  arc: { op: "add_layer", layerType: "ellipse", name: "ring", properties: { x: W / 2 - 110, y: H / 2 - 110, width: 220, height: 220, fill: "#FF7D3D" } },
  corners: rect("card", { x: W / 2 - 160, y: H / 2 - 100, width: 320, height: 200, fill: "#FF7D3D" }),
  "star-shape": { op: "add_layer", layerType: "star", name: "star", properties: { x: W / 2 - 110, y: H / 2 - 110, width: 220, height: 220, fill: "#FF7D3D" } },
  trim: { op: "add_layer", layerType: "path", name: "line", properties: { x: W * 0.2, y: H / 2, width: W * 0.6, height: 40, path: "M0 20 C190 0 380 40 576 20", fillEnabled: false, stroke: "#FFFFFF", strokeWidth: 8 } },
  counter: WORD("98%"),
};
const INSTANT = new Set(["hide", "show", "change-text"]);
// Where in a move its card is caught, when not the middle: slice's bands cover the whole frame at
// its middle, so its card shows them half way in.
const MOVE_STILL = { slice: 0.3 };
// Fields a move's sample adds to its library example: the sample's own logo picture.
const MOVE_EXTRA = { "logo-match-move": { picture: "logo" }, "logo-settle": { picture: "logo" } };
// The middle of an entrance or a transition (where it shows most), or the end of a change.
const anim = (layer, preset, start, duration, extra = {}) => ({ op: "add_animation", layer, preset, start, ...(duration ? { duration } : {}), ...extra });
// Effects whose defaults barely change a picture: settings strong enough to see on a card.
const EFFECT_STRONG = {
  curves: { master: [[0, 0], [0.25, 0.08], [0.75, 0.92], [1, 1]], blue: [[0, 0.18], [1, 0.82]] },
  "white-balance": { temperature: -100, tint: 70 },
  "color-wheels": { liftBlue: 0.35, liftGreen: 0.15, gainRed: 0.25, gamma: 1.2 },
  "noise-mask": { threshold: 0.5 },
  "color-grade": { exposure: 1.6, contrast: 1.2, saturation: 0.6 },
  vignette: { amount: 0.85 },
};
// Effects shown on the picture only: a vignette on the word would shade the word's own box.
const PICTURE_ONLY = new Set(["vignette"]);
// Each transition recipe on the two shots, full frame, as it changes beats (recipes/transitions.js):
// push slides the first out left and the next in from the right; cut-on-motion carries both
// upward with a blur; mask-wipe sweeps an accent bar with the next shot behind it.
const slide = (layer, mode, direction, start, extra = {}) => anim(layer, `preset-${extra.id ?? "slide"}`, start, extra.duration ?? 0.6, { mode, parameters: { direction, distance: 100, ...extra.parameters }, easing: "smooth" });
const TRANSITION_SAMPLES = {
  push: () => ({ ops: [SHOT_B, SHOT_A, slide("shot-a", "out", "right", 1), slide("shot-b", "in", "left", 1)], duration: 2.6, still: 1.22 }),
  "cut-on-motion": () => ({ ops: [SHOT_A, SHOT_B, slide("shot-a", "out", "down", 1, { id: "blur-slide", duration: 0.35, parameters: { blur: 30 } }), anim("shot-b", "hide", 0), anim("shot-b", "show", 1.3),
    slide("shot-b", "in", "up", 1.3, { id: "blur-slide", duration: 0.4, parameters: { blur: 30 } })], duration: 2.6, still: 1.5, strip: [0.9, 1.2, 1.45, 1.8] }),
  "mask-wipe": () => ({ ops: [SHOT_A, SHOT_B, rect("bar", { x: -140, y: 0, width: 120, height: H, fill: "#FF7D3D" }),
    anim("shot-b", "preset-wipe", 1, 0.6, { mode: "in", parameters: { direction: "right", softness: 0 }, easing: "smooth" }),
    { op: "add_animation", layer: "bar", animation: { kind: "custom", start: 1, duration: 0.6, easing: "smooth", from: { x: -140 }, to: { x: W + 20 } } }], duration: 2.6, still: 1.2 }),
};
// Plain edits made from the two shots.
const TECHNIQUE_SAMPLES = {
  dissolve: () => ({ ops: [SHOT_A, SHOT_B, anim("shot-b", "fade-in", 0.8, 1.2)], duration: 3, still: 1.4 }),
  "fade-black": () => ({ ops: [SHOT_A, SHOT_B, anim("shot-a", "fade-out", 0.6, 0.8), anim("shot-b", "fade-in", 1.6, 0.8), anim("shot-b", "hide", 0), anim("shot-b", "show", 1.6)], duration: 3, still: 1.2 }),
  "split-screen": () => ({ ops: [picture("shot-a", { width: W / 2 - 6, height: H / 2 - 4, x: 0, y: H / 4 }), picture("shot-b", { width: W / 2 - 6, height: H / 2 - 4, x: W / 2 + 6, y: H / 4 }),
    anim("shot-a", "slide-right", 0.2, 0.6), anim("shot-b", "slide-left", 0.2, 0.6)], duration: 3, still: 1.4 }),
  "beat-cut": () => ({ ops: [SHOT_A, SHOT_B, ...[0.5, 1, 1.5, 2].map((at, index) => anim("shot-b", index % 2 ? "hide" : "show", at)), anim("shot-b", "hide", 0)], duration: 2.6, still: 0.7, strip: [0.3, 0.7, 1.2, 1.7] }),
  syncopated: () => ({ ops: [SHOT_A, SHOT_B, ...[0.5, 0.75, 1.5, 1.75].map((at, index) => anim("shot-b", index % 2 ? "hide" : "show", at)), anim("shot-b", "hide", 0)], duration: 2.6, still: 0.6, strip: [0.3, 0.6, 0.9, 1.6] }),
  hold: () => ({ ops: [SHOT_A, anim("shot-a", "scale", 0, 3, { from: 1, to: 1.04 })], duration: 3, still: 1.5 }),
};

/** The ops that build a short sample of one entry on an empty 960 × 540 scene, its length and the
 *  moment its card shows; null when the entry has no sample (a video format is a whole video). */
export function sampleOps(kind, name) {
  if (kind === "move" && MOVES[name]) {
    const { at = 0.3, ...fields } = { ...MOVES[name].example, ...MOVE_EXTRA[name] };
    // Only the layers the example names, over the warm shot when it names no picture.
    const named = JSON.stringify(fields);
    const layers = MOVE_SET.filter((op) => named.includes(`"${op.name}"`));
    if (!layers.some((op) => op === SHOT_A || op === SHOT_B || op === CLIP)) layers.unshift(SHOT_A);
    return { ops: [...layers, { op: "move", name, id: "piece", at, ...fields }], duration: 6, still: Math.min(5, at + 1.2), ...(MOVE_STILL[name] ? { share: MOVE_STILL[name] } : {}) };
  }
  if (kind === "effect") {
    const effect = EFFECTS.find((item) => item.key === name);
    if (!effect) return null;
    const lut = name === "lut" ? { lut: src("look") } : {};
    const from = { ...effectDefaults(name, { neutral: true }), ...lut };
    // On the picture and the word (particles and vignette once, on the picture). A ranged effect shows only
    // from its start to its end, so the still is inside that span, past the ramp up.
    const layers = effect.group === "Generate" || PICTURE_ONLY.has(name) ? ["shot-a"] : ["shot-a", "word"];
    const effects = layers.map((layer) => ({ op: "add_animation", layer, effect: name, start: 0.3, duration: 2.4, easing: "smooth", from, parameters: { ...effectDefaults(name), ...lut, ...EFFECT_STRONG[name] } }));
    return { ops: [SHOT_A, WORD(), ...effects], duration: 3, still: 2.2 };
  }
  if (kind === "animation") {
    const preset = PRESETS.find((item) => item.id === name);
    if (!preset) return null;
    if (name === "speed") return { ops: [CLIP, { op: "add_animation", layer: "clip", preset: "speed", start: 0, duration: 3, from: 1, to: 3 }], duration: 3, still: 2 };
    const layer = PRESET_LAYER[name] ?? WORD();
    const start = preset.kind === "out" || INSTANT.has(name) ? 1.2 : 0.4;
    const animation = { op: "add_animation", layer: layer.name, preset: name, start, ...(INSTANT.has(name) ? {} : { duration: 0.8 }) };
    // An entrance is caught late in its move, an exit early, a change near its middle.
    const still = INSTANT.has(name) ? 1.6 : preset.kind === "out" ? 1.5 : preset.kind === "in" ? 0.95 : 0.85;
    return { ops: [SHOT_B, layer, animation], duration: 2.6, still };
  }
  if (kind === "recipe" && TRANSITIONS[name]) return TRANSITION_SAMPLES[name]?.() ?? null;
  if (kind === "recipe" && RECIPES[name]) {
    const recipe = RECIPES[name];
    const media = RECIPE_MEDIA[name];
    if (recipe.media === "required" && !media) return null;
    return { ops: [{ op: "recipe", name, id: "piece", at: 0.2, copy: RECIPE_COPY[name] ?? {}, ...(media ? { media } : {}) }], duration: 6, still: 2.6 };
  }
  if (kind === "look" && LOOKS[name]) {
    const look = LOOKS[name];
    return { ops: [rect("ground", { x: 0, y: 0, width: W, height: H, fill: look.colors.bg }), { op: "recipe", name: "headline-reveal", id: "piece", at: 0.2, look: name, copy: RECIPE_COPY["headline-reveal"] }], duration: 3, still: 2 };
  }
  if (kind === "technique" && TECHNIQUE_SAMPLES[name]) return TECHNIQUE_SAMPLES[name]();
  return null;
}
