// The library screen's catalog (frontend/dashboard/library.jsx): everything an agent can use, by
// kind (moves, effects, animations, layer styles, recipes, looks, video formats) and by what it does (the
// technique groups of engine/techniques.js). Each entry has one line on what it is, when it fits,
// and the ops that build a short sample of it (sampleOps), which the service runs on an empty
// scene so the screen can play it.
import { PRESETS } from "../../engine/animation.js";
import { LOOKS } from "../../engine/blocks/looks.js";
import { MOVES, MOVE_NAMES } from "../../engine/blocks/moves/index.js";
import { RECIPES, TRANSITIONS } from "../../engine/blocks/recipes/index.js";
import { VIDEO_FORMATS } from "../../engine/blocks/videoFormats.js";
import { EFFECTS, effectDefaults } from "../../engine/effects/catalog.js";
import { COLOR_LOOK_NAMES } from "../../engine/effects/colorLook.js";
import { TECHNIQUES, TECHNIQUE_GROUPS, techniqueOf } from "../../engine/techniques.js";

export const SAMPLE_FRAME = Object.freeze({ width: 960, height: 540 });

export const LIBRARY_KINDS = Object.freeze([
  { kind: "move", label: "moves" }, { kind: "effect", label: "effects" }, { kind: "animation", label: "animations" },
  { kind: "style", label: "layer styles" }, { kind: "recipe", label: "recipes" }, { kind: "look", label: "looks" },
  { kind: "format", label: "video formats" },
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
  grain: ["grain"], vignette: ["vignette"], "speed-lines": ["speed-lines"], "impact-lines": ["speed-lines"], "film-burn": ["light-sweep"],
};
// Lines for effects no technique tag describes.
const EFFECT_LINES = {
  invert: ["invert: every color flipped to its negative (keepHue swaps only light and dark)", "one frame or beat of a hit, a shock, a flashback"],
  "color-ranges": ["color ranges: turn, saturate or lighten one hue range (reds, blues, ...) and lift or sink highlights and shadows; grays stay gray",
    "one color pushed or muted, sky or foliage shifted, a brand color matched"],
  "color-look": [`color look: a ready-made grade, ${COLOR_LOOK_NAMES[0]} by default (${COLOR_LOOK_NAMES.join(", ")}), with amount 0..1`,
    "one grade over footage or a whole group; amount below 1 for a lighter touch"],
  field: ["field: a math expression of u, v (0..1 across the layer), t (seconds), seed, a, b, c per point; use alpha cuts where it is below threshold (here a noise dissolve), displace moves pixels, color tints",
    "a dissolve or wipe in any pattern, a wave or ripple, rings or stripes of color; animate threshold or a, b, c"],
};
// One entry per setting value, each with its own still ("color-look ember" is color-look with look ember).
const EFFECT_VARIANTS = {
  "color-look": COLOR_LOOK_NAMES.slice(1).map((look) => ({ name: `color-look ${look}`, parameters: { look },
    line: `color look ${look}: color-look with look "${look}" (amount 0..1)` })),
  field: [
    { name: "field rings", parameters: { use: "color", expression: "0.5 + 0.5*sin(length((u - 0.5)*1.78, v - 0.5)*tau*6 - t*4)", color: "#FF7D3D" },
      line: "field rings: field with use color, rings of color moving out from the middle (expression of length and t)" },
    { name: "field wave", parameters: { use: "displace", expression: "0", expressionY: "sin(u*tau*2 + t*3)", amount: 16 },
      line: "field wave: field with use displace, expression 0 and expressionY a sine of u and t: the layer waves up and down" },
  ],
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

// Masks with maskInvert or maskMode (engine/maskVisibility.js), each with its sample (MASK_SAMPLES).
const MASKS = {
  "knockout-type": { line: "knockout type: a big word cut out of the shot, the next shot showing through its letters (create_mask with a text mask, maskInvert true)",
    fits: "a title over footage that keeps the picture moving behind it", tags: ["type-giant"] },
  "logo-cut": { line: "logo cut: a picture logo's own shape, by its see-through parts, shows the next shot (create_mask with a picture mask, maskMode alpha)",
    fits: "a logo filled with footage", tags: [] },
};

// The wipe preset's shapes (engine/wipe.js), each sampled on the next shot over the last.
const WIPES = {
  wipe: { line: "wipe: a straight edge sweeps across at any angle, hard or soft, with an optional colored edge band (preset-wipe angle, softness, edgeWidth, edgeColor)",
    parameters: { angle: 30, softness: 8, edgeWidth: 16, edgeColor: "#FF7D3D" } },
  "wipe-radial": { line: "radial wipe: an oval in the layer's proportions grows from a center (preset-wipe shape radial, centerX, centerY)",
    parameters: { shape: "radial", softness: 30 } },
  "wipe-iris": { line: "iris wipe: a circle opens from any point (preset-wipe shape iris, centerX, centerY)",
    parameters: { shape: "iris", centerX: 0.3, centerY: 0.4, softness: 0, edgeWidth: 10, edgeColor: "#FFFFFF" } },
  "wipe-clock": { line: "clock wipe: a hand sweeps around a point (preset-wipe shape clock, angle where it starts, centerX, centerY)",
    parameters: { shape: "clock", softness: 6 } },
};

// Layer styles: static layer fields, not animations. Stacked shadows (shadows, engine/stackedShadows.js).
const SHADOW_STACKS = {
  "shadow-long": { line: "long shadow: the layer field shadows holds hard copies stepping out one way (add_layer or update_layer; a Shadow animation moves only the single shadow)",
    shadows: Array.from({ length: 24 }, (_, index) => ({ color: "#8A3414", x: 2 * (index + 1), y: 2 * (index + 1), blur: 0 })),
    fill: "#FFF4E6", ground: "#FF7D3D" },
  "shadow-neon": { line: "neon glow: the layer field shadows, one color at no offset, tight to wide blur, under a pale word",
    shadows: [{ color: "#FF2BD6", x: 0, y: 0, blur: 4 }, { color: "#FF2BD6", x: 0, y: 0, blur: 16 }, { color: "#FF2BD6", x: 0, y: 0, blur: 40, opacity: 0.9 }, { color: "#7A1BFF", x: 0, y: 0, blur: 90, opacity: 0.8 }],
    fill: "#FFE6FA", ground: "#0D0716" },
};

// Stacked strokes (layer field strokes, engine/stackedStrokes.js), drawn like the shadow stacks.
const STROKE_STACKS = {
  "stroke-double": { line: "double outline: the layer field strokes stacks outside outlines on the letters, wide first, like a sticker",
    strokes: [{ color: "#FFFFFF", width: 26, align: "outside", join: "round" }, { color: "#141414", width: 11, align: "outside", join: "round" }],
    fill: "#FFE14D", ground: "#2E5BFF" },
  "stroke-neon": { line: "neon tube: fill off, the layer field strokes in one color from wide and faint to a thin white core",
    strokes: [{ color: "#26F0FF", width: 16, opacity: 0.25, join: "round" }, { color: "#26F0FF", width: 8, opacity: 0.6, join: "round" }, { color: "#E8FFFF", width: 2.5, join: "round" }],
    fillEnabled: false, shadows: [{ color: "#26F0FF", blur: 24, opacity: 0.7 }], ground: "#05121A" },
};

// Shape modifiers (engine/shapeModifiers.js): layer fields that change a shape's outline. Each
// sample grows its field from 0, as the numbers animate.
const SHAPE_STYLES = {
  "zigzag-badge": { field: "zigzagSize", line: "zig zag: the layer fields zigzagSize, zigzagCount (teeth per side) and zigzagPoints corner|smooth turn a shape's edge into teeth or a wave, like a sale sticker",
    layerType: "ellipse", properties: { fill: "#FFE14D", zigzagSize: 14, zigzagCount: 9 }, word: "#141414", ground: "#2E5BFF" },
  "offset-outline": { field: "offsetAmount", line: "offset path: the layer field offsetAmount grows a shape's outline (below 0 shrinks it), offsetJoin miter|round|bevel shapes the corners; a grown copy under a star is a sticker border",
    layerType: "star", properties: { fill: "#FFFFFF", offsetAmount: 22, offsetJoin: "round" }, top: "#FF7D3D", ground: "#141414" },
  "round-corners": { field: "roundCorners", line: "round corners: the layer field roundCorners (px) rounds every sharp corner of a star or path, a soft badge or blob",
    layerType: "star", properties: { fill: "#FF7D3D", spikes: 6, starThickness: 0.6, roundCorners: 26 }, ground: "#FFF4E0" },
  "bloat-flower": { field: "bloatAmount", line: "pucker/bloat: the layer field bloatAmount -1..1 bows a shape's sides out (a star turns into a flower) or, below 0, pinches them into spikes",
    layerType: "star", properties: { fill: "#FF5C8A", spikes: 8, starThickness: 0.7, bloatAmount: 0.3 }, ground: "#FFF0F4" },
  "twist-swirl": { field: "twistAngle", line: "twist: the layer field twistAngle (degrees) turns a shape's far points around twistX, twistY (px from the middle) more than near ones, a swirl",
    layerType: "star", properties: { fill: "#26F0FF", spikes: 8, starThickness: 0.25, twistAngle: 120 }, ground: "#05121A" },
};

// Text loops (layer field textLoop, engine/textLoop.js): letters keep moving between the in and out.
// Each sample fades the word in by letters, loops, then fades it out.
const TEXT_LOOPS = {
  "text-wave": { line: "text wave: the text layer field textLoop {style:\"wave\", amount px, speed, stagger s} lifts letters in sequence between the in and out animations",
    loop: { style: "wave", amount: 24, speed: 0.8, stagger: 0.09 }, text: "wavelength", fill: "#141414", ground: "#FFE14D" },
  "text-float": { line: "text float: textLoop {style:\"float\", amount, speed, seed} bobs each letter on its own pace and phase, calm and out of step",
    loop: { style: "float", amount: 16, speed: 0.6 }, text: "drifting", fill: "#E8FFFF", ground: "#05121A" },
  "text-pulse": { line: "text pulse: textLoop {style:\"pulse\", amount %, speed, stagger} grows and shrinks each letter about its own center, a beat running through the word",
    loop: { style: "pulse", amount: 22, speed: 1, stagger: 0.12 }, text: "heartbeat", fill: "#FFF4E6", ground: "#FF5C8A" },
  "text-jitter": { line: "text jitter: textLoop {style:\"jitter\", amount px, speed jumps/s, seed} hops each letter to a seeded spot and tilt, hand-drawn boil",
    loop: { style: "jitter", amount: 6, speed: 8 }, text: "restless", fill: "#F4F2EE", ground: "#2E5BFF" },
};

let built = null;

/** Every entry, the kinds with their counts and the technique groups. Built once. */
export function libraryCatalog() {
  if (built) return built;
  const entries = [];
  for (const name of MOVE_NAMES) entries.push(entry("move", name, MOVES[name].about, MOVES[name].fits, [...(MOVES[name].tags ?? [])]));
  for (const [name, variant] of Object.entries(MOVE_VARIANTS)) entries.push(entry("move", name, variant.line, MOVES[variant.move].fits, [...(MOVES[variant.move].tags ?? [])]));
  for (const effect of EFFECTS) {
    const tags = EFFECT_TAGS[effect.key] ?? [];
    const settings = Object.values(effect.parameters ?? {}).map((parameter) => parameter.label.toLowerCase());
    const [line, fits] = EFFECT_LINES[effect.key] ?? [];
    entries.push(entry("effect", effect.key, line ?? firstLine(tags)?.line ?? `${effect.group.toLowerCase()} effect${settings.length ? `: ${settings.slice(0, 3).join(", ")}` : ""}`, fits ?? firstLine(tags)?.fits, tags));
    for (const variant of EFFECT_VARIANTS[effect.key] ?? []) entries.push(entry("effect", variant.name, variant.line, fits, tags));
  }
  for (const preset of PRESETS) {
    const tags = ANIMATION_TAGS[preset.id] ?? [];
    entries.push(entry("animation", preset.id, `${preset.name.toLowerCase()}: ${PRESET_KIND_WORDS[preset.kind] ?? preset.kind}`, firstLine(tags)?.fits, tags));
  }
  for (const [name, { line }] of Object.entries(SHADOW_STACKS)) entries.push({ ...entry("style", name, line, "a title or logo that needs depth or glow", []), field: "shadows" });
  for (const [name, { line }] of Object.entries(STROKE_STACKS)) entries.push({ ...entry("style", name, line, "a title or sticker word that must stand out", []), field: "strokes" });
  for (const [name, { line, field }] of Object.entries(SHAPE_STYLES)) entries.push({ ...entry("style", name, line, "a badge, sticker or shape that needs a bolder edge", []), field });
  for (const [name, { line }] of Object.entries(WIPES)) entries.push(entry("animation", name, line, "a reveal of one layer, or the next shot over the last", ["mask-wipe"]));
  for (const [name, { line }] of Object.entries(TEXT_LOOPS)) entries.push({ ...entry("animation", name, line, "a title that holds on screen and should stay alive", ["type-kinetic"]), field: "textLoop" });
  for (const [name, { line, fits, tags }] of Object.entries(MASKS)) entries.push(entry("technique", name, line, fits, tags));
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
  // A radial burst: one ray drawn 12 times around a point 120 px below its middle (engine/repeater.js).
  repeat: rect("ray", { x: W / 2 - 9, y: H / 2 - 175, width: 18, height: 110, radius: 9, fill: "#FF7D3D",
    repeatCopies: 12, repeatRotation: 30, repeatAnchorY: 120, repeatEndOpacity: 0.4 }),
};
// A move's sample on other input than its example, as its own entry (push-through-type on a logo picture).
const MOVE_VARIANTS = {
  "push-through-type on a logo": { move: "push-through-type", line: "push-through-type with layer: the camera pushes into a picture logo's solid part (its see-through parts are measured) and the next shot shows inside it",
    layers: () => [SHOT_A, picture("logo", { x: W / 2 - 150, y: H / 2 - 150, width: 300, height: 300 })], fields: { layer: "logo", next: "shot-a", at: 0.3 } },
  "light-sweep on a logo": { move: "light-sweep", line: "light-sweep with a picture layer: a leaning band of light crosses a picture logo only where it is not see-through",
    layers: () => [SHOT_A, picture("logo", { x: W / 2 - 150, y: H / 2 - 150, width: 300, height: 300 })], fields: { layer: "logo", angle: 20, color: "#FFFFFF", at: 0.3 }, share: 0.5 },
  "accent-hit on a logo": { move: "accent-hit", line: "accent-hit with a picture layer: a picture logo flashes to one color only where it is not see-through, with a glow",
    layers: () => [SHOT_A, picture("logo", { x: W / 2 - 150, y: H / 2 - 150, width: 300, height: 300 })], fields: { layer: "logo", color: "#7FE3FF", hold: 0.3, at: 0.3 }, share: 0.3 },
  "glitch with torn bands": { move: "glitch", line: "glitch with blocks: bands of the shot torn sideways for two frames before the cut, the colors split the same way",
    layers: () => [SHOT_B, SHOT_A], fields: { from: "shot-a", to: "shot-b", blocks: 5, strength: 0.8, at: 0.3 }, share: 0.42 },
  "caption-words with a word box": { move: "caption-words", line: "caption-words with activeBackground and activeScale: the said word grows on a colored box that slides from word to word, the rest dimmed",
    layers: () => [SHOT_A], fields: { words: [{ text: "so", at: 0.4 }, { text: "we gave", at: 1.2 }, { text: "it eyes.", at: 2.2, end: 3.4 }], highlight: "active",
      fill: "#FFFFFF", accent: "#111111", activeBackground: "#FFD84A", activeScale: 1.08, saidOpacity: 0.6, unsaidOpacity: 0.6, at: 0.3 } },
  "card-tilt up": { move: "card-tilt", line: "card-tilt with direction up: the shot tips back over its top edge and slides up as the next tips in from below",
    layers: () => [SHOT_B, SHOT_A], fields: { from: "shot-a", to: "shot-b", direction: "up", at: 0.3 }, share: 0.45 },
  "whip-pan at an angle": { move: "whip-pan", line: "whip-pan with angle and smear: both shots fly along a slant, smeared along it, copies of them tiling the corners",
    layers: () => [SHOT_B, SHOT_A], fields: { from: "shot-a", to: "shot-b", angle: -30, smear: 0.35, at: 0.3 }, share: 0.4 },
  "mask-through-shape with a thick ring": { move: "mask-through-shape", line: "mask-through-shape with ring and accent: a wide colored ring rides the growing shape's edge",
    layers: () => [SHOT_A, SHOT_B], fields: { to: "shot-b", from: "shot-a", shape: "diamond", ring: 16, accent: "#FFD84A", at: 0.3 }, share: 0.5 },
};
// Where an animation's card is caught when not by its kind: the burst once every copy is out.
const PRESET_STILL = { repeat: 1.5 };
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
  "color-grade": { stops: 0.7, contrast: 1.2, saturation: 0.6 },
  vignette: { amount: 0.85 },
  "color-ranges": { orangeHue: -60, orangeSaturation: 0.5, yellowHue: -40, blueHue: 40, blueSaturation: -0.6, shadows: 0.4, highlights: -0.3 },
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

// The masks: the top shot is masked, the other shows where it is cut away.
const MASK_SAMPLES = {
  "knockout-type": () => ({ ops: [SHOT_B, { op: "add_layer", layerType: "text", name: "word", properties: { text: "CITY", fontSize: 260, fontWeight: 900, fill: "#FFFFFF", textResize: "width-height", x: 165, y: 40 } }, SHOT_A, { op: "create_mask", layers: ["word", "shot-a"], maskLayerId: "word", name: "knockout", maskInvert: true },
    anim("knockout", "scale", 0.2, 2.2, { from: 1, to: 1.06, easing: "smooth" })], duration: 3, still: 1.6 }),
  "logo-cut": () => ({ ops: [rect("ground", { x: 0, y: 0, width: W, height: H, fill: "#14161A" }), picture("logo", { x: W / 2 - 180, y: H / 2 - 180, width: 360, height: 360 }), SHOT_A,
    { op: "create_mask", layers: ["logo", "shot-a"], maskLayerId: "logo", name: "logo cut", maskMode: "alpha" }], duration: 3, still: 1.6 }),
};

/** The ops that build a short sample of one entry on an empty 960 × 540 scene, its length and the
 *  moment its card shows; null when the entry has no sample (a video format is a whole video). */
export function sampleOps(kind, name) {
  if (kind === "move" && MOVE_VARIANTS[name]) {
    const { move, layers, fields: { at, ...fields }, share = 0.68 } = MOVE_VARIANTS[name];
    return { ops: [...layers(), { op: "move", name: move, id: "piece", at, ...fields }], duration: 6, still: Math.min(5, at + 1.2), share };
  }
  if (kind === "move" && MOVES[name]) {
    const { at = 0.3, ...fields } = { ...MOVES[name].example, ...MOVE_EXTRA[name] };
    // Only the layers the example names, over the warm shot when it names no picture.
    const named = JSON.stringify(fields);
    const layers = MOVE_SET.filter((op) => named.includes(`"${op.name}"`));
    if (!layers.some((op) => op === SHOT_A || op === SHOT_B || op === CLIP)) layers.unshift(SHOT_A);
    return { ops: [...layers, { op: "move", name, id: "piece", at, ...fields }], duration: 6, still: Math.min(5, at + 1.2), ...(MOVE_STILL[name] ? { share: MOVE_STILL[name] } : {}) };
  }
  if (kind === "effect") {
    const variant = Object.values(EFFECT_VARIANTS).flat().find((item) => item.name === name);
    if (variant) name = name.split(" ")[0];
    const effect = EFFECTS.find((item) => item.key === name);
    if (!effect) return null;
    const lut = name === "lut" ? { lut: src("look") } : {};
    const from = { ...effectDefaults(name, { neutral: true }), ...lut, ...variant?.parameters };
    // On the picture and the word (particles and vignette once, on the picture). A ranged effect shows only
    // from its start to its end, so the still is inside that span, past the ramp up.
    const layers = effect.group === "Generate" || PICTURE_ONLY.has(name) ? ["shot-a"] : ["shot-a", "word"];
    const effects = layers.map((layer) => ({ op: "add_animation", layer, effect: name, start: 0.3, duration: 2.4, easing: "smooth", from, parameters: { ...effectDefaults(name), ...lut, ...EFFECT_STRONG[name], ...variant?.parameters } }));
    return { ops: [SHOT_A, WORD(), ...effects], duration: 3, still: 2.2 };
  }
  if (kind === "style" && (SHADOW_STACKS[name] || STROKE_STACKS[name])) {
    const { line, ground, ...style } = SHADOW_STACKS[name] ?? STROKE_STACKS[name];
    const word = WORD("kino", 150);
    return { ops: [rect("ground", { x: 0, y: 0, width: W, height: H, fill: ground }), { ...word, properties: { ...word.properties, ...style } }], duration: 2.6, still: 1.6 };
  }
  if (kind === "style" && SHAPE_STYLES[name]) {
    const { field, layerType, properties, word, top, ground } = SHAPE_STYLES[name];
    const box = { x: W / 2 - 150, y: H / 2 - 150, width: 300, height: 300 };
    const grow = { op: "add_animation", layer: "shape", start: 0.2, duration: 1, easing: "smooth", from: { [field]: 0 }, to: { [field]: properties[field] } };
    const over = top ? [{ op: "add_layer", layerType, name: "top", properties: { ...box, fill: top } }] : [];
    const label = word ? [{ ...WORD("NEW", 96), properties: { ...WORD("NEW", 96).properties, fill: word } }] : [];
    return { ops: [rect("ground", { x: 0, y: 0, width: W, height: H, fill: ground }), { op: "add_layer", layerType, name: "shape", properties: { ...box, ...properties } }, ...over, ...label, grow], duration: 2.6, still: 1.6 };
  }
  if (kind === "animation" && TEXT_LOOPS[name]) {
    const { loop, text, fill, ground } = TEXT_LOOPS[name];
    const word = WORD(text, 110);
    const fade = (preset, start) => anim("word", preset, start, 0.5, { unit: "letters", stagger: 0.06 });
    return { ops: [rect("ground", { x: 0, y: 0, width: W, height: H, fill: ground }), { ...word, properties: { ...word.properties, x: 60, width: W - 120, height: 160, textAlign: "center", fill, textLoop: loop } },
      fade("preset-fade", 0.1), { ...fade("preset-fade", 3.6), mode: "out" }], duration: 4.4, still: 1.9 };
  }
  if (kind === "animation" && WIPES[name])
    return { ops: [SHOT_A, SHOT_B, anim("shot-b", "preset-wipe", 0.4, 1.6, { mode: "in", parameters: WIPES[name].parameters, easing: "smooth" })], duration: 2.6, still: 0.95 };
  if (kind === "animation") {
    const preset = PRESETS.find((item) => item.id === name);
    if (!preset) return null;
    if (name === "speed") return { ops: [CLIP, { op: "add_animation", layer: "clip", preset: "speed", start: 0, duration: 3, from: 1, to: 3 }], duration: 3, still: 2 };
    const layer = PRESET_LAYER[name] ?? WORD();
    const start = preset.kind === "out" || INSTANT.has(name) ? 1.2 : 0.4;
    const animation = { op: "add_animation", layer: layer.name, preset: name, start, ...(INSTANT.has(name) ? {} : { duration: 0.8 }) };
    // An entrance is caught late in its move, an exit early, a change near its middle.
    const still = PRESET_STILL[name] ?? (INSTANT.has(name) ? 1.6 : preset.kind === "out" ? 1.5 : preset.kind === "in" ? 0.95 : 0.85);
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
  if (kind === "technique" && MASK_SAMPLES[name]) return MASK_SAMPLES[name]();
  if (kind === "technique" && TECHNIQUE_SAMPLES[name]) return TECHNIQUE_SAMPLES[name]();
  return null;
}
