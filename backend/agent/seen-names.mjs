// What an agent sees in a reference ("glow", "subtitles", "speed ramp", "shake") turned into the
// kino names that make it: effects, moves and ops, each with the call that reads its rules.
// library {topic:"search"} puts these lines first; the guide topics that mention the words follow.
import { EFFECTS } from "../../engine/effects/catalog.js";
import { MOVE_NAMES } from "../../engine/blocks/moves/index.js";

// Plain words for a look and the kino names that make it. Keys are lower case, words joined by
// one space. A key of several words matches where the query holds those words in a row; a key of
// one word matches the whole query or one of its words, except a LOOSE word.
const SEEN_AS = {
  glow: ["glow", "accent-hit"], bloom: ["glow"], halo: ["glow"], neon: ["glow", "outline_text", "rim-light"], halation: ["scene-background", "glow"],
  particles: ["embers", "sparks", "dust"], particle: ["embers", "sparks", "dust"], sparkles: ["sparks", "embers"],
  ash: ["embers", "dust"], fire: ["embers", "sparks"], smoke: ["fog"], haze: ["fog"],
  subtitles: ["add_captions", "caption-words"], subtitle: ["add_captions", "caption-words"], captions: ["add_captions", "caption-words"],
  caption: ["add_captions", "caption-words"], lyrics: ["add_captions", "caption-words"],
  "cut out": ["cut_out"], cutout: ["cut_out"], silhouette: ["cut_out"], matte: ["cut_out"], "background removal": ["cut_out"],
  "speed ramp": ["speed-ramp", "clip-speed"], ramp: ["speed-ramp", "clip-speed"], "slow motion": ["speed-ramp", "clip-speed"],
  "slow mo": ["speed-ramp", "clip-speed"], slowmo: ["speed-ramp", "clip-speed"], "time remap": ["speed-ramp", "clip-speed"],
  "fast forward": ["clip-speed"], reverse: ["clip-speed"],
  shake: ["shake", "impact-accent", "wiggle"], "camera shake": ["shake", "impact-accent", "wiggle"], handheld: ["shake"], jolt: ["shake", "impact-accent"], hit: ["impact-accent", "punch-in"],
  flash: ["impact-accent", "flash", "overexpose"], strobe: ["impact-accent"], "white flash": ["overexpose", "impact-accent", "flash"],
  overexposed: ["overexpose"], overexposure: ["overexpose"], "burn out": ["overexpose"], "blown out": ["overexpose"], wash: ["overexpose"], "white out": ["overexpose"], exposure: ["overexpose", "color-grade"],
  "light rays": ["light-rays"], "god rays": ["light-rays"], rays: ["light-rays"], beams: ["light-rays"],
  "lens flare": ["lens-flare"], flare: ["lens-flare", "light-shape"], "light leak": ["light-leaks", "light-leak"],
  // Made lights (light-shape): plate, streak and ring words the recreate directors used (GAPS item 4).
  "glow plate": ["light-shape"], "light bar": ["light-shape"],
  halo: ["light-shape", "glow"], "ring light": ["light-shape"], "light ring": ["light-shape"], bloom: ["glow", "overexpose", "light-shape"], "lit plate": ["light-shape"],
  "color grade": ["color_filter", "color-grade", "color-wheels"], grade: ["color_filter", "color-grade", "color-wheels"],
  grading: ["color_filter", "color-grade"],
  // Plain words for the settings of color-grade and hue-saturation (the ceiling studies guessed
  // "color-correct" and "brightness" as effect names).
  "color correct": ["color-grade", "color-wheels", "hue-saturation"], "color correction": ["color-grade", "color-wheels", "hue-saturation"],
  correction: ["color-grade", "color-wheels"], brightness: ["color-grade", "color-wheels"], brighten: ["color-grade", "overexpose"], darken: ["color-grade", "vignette"],
  contrast: ["color-grade", "curves"], saturation: ["hue-saturation", "color-grade"], saturate: ["hue-saturation"], desaturate: ["hue-saturation"],
  levels: ["curves", "color-grade"], gamma: ["color-wheels", "curves"],
  tint: ["white-balance", "color_filter", "hue-saturation"],
  "green tint": ["white-balance", "color_filter", "color-wheels"], green: ["white-balance", "color-wheels", "hue-saturation"], desaturated: ["hue-saturation", "keep-color"], "black and white": ["hue-saturation", "keep-color"],
  repeat: ["beat-repeat"], stutter: ["beat-repeat"], "replay on beats": ["beat-repeat"], "repeat on beats": ["beat-repeat"], echo: ["beat-repeat", "inward-echoes"],
  glitch: ["glitch", "smear", "rgb-split-hit", "rgb-shift"], "glitch transition": ["smear", "glitch", "shatter"],
  smear: ["smear", "whip-pan"], drag: ["smear"], "pixel drag": ["smear"], datamosh: ["smear"], mosh: ["smear"],
  shatter: ["shatter"], shattered: ["shatter"], glass: ["shatter", "fluted-glass"], "broken glass": ["shatter"], break: ["shatter"], shards: ["shatter"],
  "rgb split": ["rgb-split-hit", "rgb-shift"], "chromatic aberration": ["rgb-shift"],
  "split screen": ["split-screen"], splitscreen: ["split-screen"], "side by side": ["split-screen"], panes: ["split-screen"], composite: ["split-screen", "picture-in-picture"],
  "picture in picture": ["picture-in-picture"], pip: ["picture-in-picture"], inset: ["picture-in-picture"],
  grain: ["grain", "scene-background"], vignette: ["vignette", "scene-background"], blur: ["zoom-blur", "directional-blur"], "freeze frame": ["freeze-shutter"],
  // Words for the effects that reports called missing (finish, depth, rim, streaks, highlight, typed
  // text); each leads to a name kino has (the test checks) or, with no maker, to NO_MAKER below.
  "film grain": ["grain", "scene-background"], "dark edges": ["vignette"], "darken edges": ["vignette"], edges: ["vignette"], "dark corners": ["vignette"], "darker edges": ["vignette"], corners: ["vignette"], tunnel: ["vignette"],
  "depth of field": ["focus-band", "lift-focus"], dof: ["focus-band", "lift-focus"], "tilt shift": ["focus-band"], tiltshift: ["focus-band"], "shallow focus": ["focus-band", "lift-focus"],
  "focus blur": ["focus-band", "lift-focus"], "lens blur": ["focus-band"], "background blur": ["focus-band", "lift-focus"], "rack focus": ["focus-band", "lift-focus"],
  rim: ["rim-light", "glow", "cut_out"], "rim light": ["rim-light", "glow", "cut_out"], "rim lighting": ["rim-light", "glow", "cut_out"], "edge light": ["rim-light", "glow", "cut_out"], backlight: ["glow", "light-rays"],
  streak: ["speed-lines", "light-shape", "rain", "light-rays"], "light streak": ["light-shape", "lens-flare", "light-rays"], anamorphic: ["lens-flare"], "lens streak": ["lens-flare"],
  "soft glow": ["glow"], dreamy: ["glow", "fog"],
  scrawl: ["text-ranges", "set_font", "outline_text"], brush: ["set_font", "outline_text"], handwritten: ["set_font", "outline_text"], handwriting: ["set_font", "outline_text"],
  "hand lettering": ["text-ranges", "set_font", "outline_text"], marker: ["set_font", "outline_text"], graffiti: ["set_font", "outline_text"], stencil: ["set_font"], blackletter: ["set_font"],
  typed: ["type-on", "voice-type"], typing: ["type-on", "voice-type"], typewriter: ["type-on", "set_font"], "type on": ["type-on"],
  highlight: ["type-on", "accent-hit", "luma-highlight", "caption-words"], highlighter: ["accent-hit", "luma-highlight"],
  // A look over the whole frame is one scene field (finish, letterbox); the effect does one layer.
  letterbox: ["scene-background"], letterboxed: ["scene-background"], "black bars": ["scene-background"], "cinema bars": ["scene-background"], "cinematic bars": ["scene-background"],
  "lifted blacks": ["scene-background", "color-look"], "film look": ["scene-background", "color-look"], "frame finish": ["scene-background"],
  soften: ["scene-background"], diffusion: ["scene-background"], "soft focus": ["scene-background"], haze: ["scene-background", "fog"], hazy: ["scene-background", "fog"], mist: ["scene-background", "fog"],
  // Type, color and composite looks (the on-screen kinds a reference shows besides cuts and sound).
  font: ["set_font"], fonts: ["set_font"], typeface: ["set_font"], lettering: ["set_font"], typography: ["set_font"],
  // Matching a reference's lettering: library {topic:"fonts", like} (GAPS item 1).
  "match font": ["set_font"], "font match": ["set_font"], "same font": ["set_font"], "identify font": ["set_font"], "dot matrix": ["set_font"], "pixel font": ["set_font"], "rounded font": ["set_font"],
  electric: ["rim-light"],
  // Line art of footage (edge-lines) and a subject's edge as a drawn path (cut_out output "outline").
  edge: ["edge-lines", "rim-light", "cut_out"], edges: ["edge-lines", "rim-light", "cut_out"], "edge detect": ["edge-lines", "cut_out"], "find edges": ["edge-lines", "cut_out"],
  "line art": ["edge-lines", "cut_out"], contour: ["edge-lines", "cut_out"], contours: ["edge-lines", "cut_out"], sketch: ["edge-lines"], trace: ["trace_image", "cut_out", "edge-lines"],
  // A picture's flat colors as vector shapes (trace_image): a drawn prop, a logo, a brush word.
  vectorize: ["trace_image"], vector: ["trace_image"], "image trace": ["trace_image"], "trace image": ["trace_image"], wordmark: ["trace_image"],
  "logo shape": ["trace_image"], "drawn shape": ["trace_image"], "hand drawn": ["trace_image"], "brush lettering": ["trace_image", "set_font"], posterize: ["trace_image"],
  "subject outline": ["cut_out", "rim-light"], "outline path": ["cut_out"], "trace outline": ["cut_out", "rim-light"],
  outline: ["outline_text", "rim-light", "glow", "cut_out"], outlined: ["outline_text", "rim-light", "glow", "cut_out"], stroke: ["outline_text", "glow", "cut_out"],
  "typed highlight": ["type-on"], jitter: ["text-ranges"], "hand set": ["text-ranges"],
  hollow: ["layer-style"], "outline glow": ["layer-style", "glow"], "glow outline": ["layer-style", "glow"],
  "glowing outline": ["layer-style", "glow"], "neon text": ["layer-style", "glow"], "neon outline": ["layer-style", "glow"],
  "baseline shift": ["text-ranges"], "letter rotation": ["text-ranges"], "rotated letters": ["text-ranges"],
  duotone: ["duotone"], tritone: ["tritone"],
  "text behind": ["masked-type", "cut_out"], "behind text": ["masked-type", "cut_out"],
  "3d": ["card-flip", "3d-orbit"], "3d text": ["card-flip", "3d-orbit"], "3d type": ["card-flip", "3d-orbit"],
  streaks: ["streaks", "speed-lines", "rain", "light-rays"], streak: ["streaks", "lens-flare", "speed-lines"],
  "code rain": ["streaks", "rain"], constellation: ["dust"], "connect the dots": ["dust"], "particle links": ["dust"], "light streak": ["lens-flare", "streaks"], "light streaks": ["streaks", "lens-flare"], anamorphic: ["lens-flare"],
  "zoom burst": ["zoom-blur", "radial-repeat-blur"],
  "speed lines": ["speed-lines", "impact-lines"], "motion lines": ["speed-lines"], "action lines": ["impact-lines", "speed-lines"],
  "impact lines": ["impact-lines"], "focus lines": ["impact-lines"], "radial lines": ["impact-lines"], "anime lines": ["impact-lines", "speed-lines"], "manga lines": ["impact-lines", "speed-lines"],
  "punch in": ["punch-in"], punchin: ["punch-in"], "zoom punch": ["punch-in"], "snap zoom": ["punch-in"], "crash zoom": ["punch-in"],
  invert: ["invert"], inverted: ["invert"], negative: ["invert"], "inverted colors": ["invert"],
  "two color split": ["split-fields"], "color split": ["split-fields"], "split fields": ["split-fields"], "color fields": ["split-fields"], "two tone split": ["split-fields"],
  "brush edge": ["shape-modifiers", "split-fields", "shape-wipe"], "rough edge": ["shape-modifiers", "split-fields", "shape-wipe"], "ragged edge": ["shape-modifiers", "shape-wipe"],
  "torn edge": ["shape-modifiers", "shape-wipe"], "jagged edge": ["shape-modifiers", "shape-wipe"], "dry brush": ["shape-modifiers", "split-fields"], "brush wipe": ["shape-wipe", "split-fields"], "brush mask": ["shape-modifiers", "shape-wipe"],
  // The project's frame rate (update_project {fps}, project create {fps}).
  "frame rate": ["update_project"], framerate: ["update_project"], fps: ["update_project"], "frames per second": ["update_project"], "23.976": ["update_project"], "on frame": ["update_project"],
  "film burn": ["film-burn"], burn: ["film-burn"], "light burn": ["film-burn"], "film damage": ["film-burn", "grain"], "old film": ["film-burn", "grain", "vignette"],
};
// Looks kino has no maker for yet. Asked for alone, they print a line that says so (and what to do)
// instead of a name that only sounds close.
const NO_MAKER = ["halftone", "dirt texture", "paper texture", "lightning", "electric arc"];
// Looks with no maker of their own that still have a way to build them from kino's parts.
const NO_MAKER_HOW = {
  lightning: "a jagged path layer (add_layer path) with the glow effect and a few quick opacity steps; sparks adds the specks",
  "electric arc": "a jagged path layer (add_layer path) with the glow effect and a few quick opacity steps",
};
export { SEEN_AS };
// Common words that mean a look only on their own: "green" alone is a tint, but "green screen" is
// a cut-out and "repeat text" is not a footage stutter. Inside a longer query they lead nowhere.
// "edges" and "corners" alone are a vignette, but "rounded corners" or "jagged edges" are not.
// Words every kino answer uses: they never pick a name just by being a part of it (layer-style).
const GENERIC = new Set(["layer", "text", "style", "ranges", "scene"]);
const LOOSE = new Set(["green", "repeat", "ramp", "reverse", "hit", "grade", "tint", "flash", "fire", "ash", "rays", "beams", "echo", "blur", "flare", "matte", "grain", "burn", "negative", "inverted", "edges", "corners", "tunnel"]);

// The last line of look {mode:"reference"}: what the agent sees there, as a lookup.
export const REFERENCE_LOOKUP = 'to make what you see (kinds: type, overlay, composite, color, made, frame, spoken, plain): library {topic:"search", search:"<your words: font, glow, cut-out, split screen, duotone, outline>"}';

/**
 * A second lookup line for a studied reference whose title has the subject's origin word
 * (`found` is next-call.mjs originFootage's answer), else "": the footage search that finds it.
 */
export function originReferenceLine(found, title) {
  const has = found && (String(title ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).includes(found.word);
  return has ? `to find the footage it shows: library {topic:"footage", search:${JSON.stringify(found.query)}}` : "";
}

// Guide topics that hold each effect group's rules.
const GROUP_TOPIC = { Light: "light", Generate: "particles", Color: "color", Blur: "blur" };
/** The guide topic that holds the rules of an effect group (effects for the groups without their own). */
export const ruleTopicOf = (group) => GROUP_TOPIC[group] ?? "effects";
// Guide topics an agent reads instead of an op, effect or move (clip speed is layer properties).
const TOPICS = { "clip-speed": "layer properties mediaSpeed and speed animations",
  "text-ranges": "textStyleRanges (rotation, baselineShift, fill) and the layer field jitter",
  "shape-modifiers": "layer property roughenSize on a mask shape or path (a rough dry-brush edge; roughenDetail, roughenSeed, roughenBoil)",
  "layer-style": "layer properties fill, strokes, shadows and outlineGlow (hollow letters with a glowing outline)",
  "scene-background": 'the whole frame in one op: {op:"update_scene", properties:{finish:true, letterbox:2.35}} (grain, lifted blacks, halation, vignette, bars)' };
// An op whose call needs a lookup first: a font is picked by its look.
const OP_USE = { set_font: 'library {topic:"fonts", search:"<the look: brush, handwritten, marker, stencil, slab, blackletter, condensed bold sans, a script such as japanese>"} (or like:"<picture path>", region:[x,y,w,h]: faces measured like its letters) then set_font {layerIds, family, weight}' };

/** The line for a look kino has no maker for yet ("speed lines"), else "". */
export function noMakerLine(query) {
  const text = ` ${String(query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const phrase = NO_MAKER.find((entry) => text.includes(` ${entry} `));
  return phrase ? `no kino name for "${phrase}" yet: ${NO_MAKER_HOW[phrase] ? `build it from ${NO_MAKER_HOW[phrase]}` : "build it from shapes and draw-on"}, or say it is missing` : "";
}

/** The call that reads a name's rules, and what the name is; null for a name kino does not have. */
export function readCallFor(name, { ops = [] } = {}) {
  const effect = EFFECTS.find((entry) => entry.key === name);
  if (effect) return { kind: "effect", use: `add_animation {layer, effect:"${name}"}`, read: `fields: library {topic:"effects", name:"${name}"}; rules: library {topic:"rules", name:"${ruleTopicOf(effect.group)}"}` };
  if (MOVE_NAMES.includes(name)) return { kind: "move", use: `move {name:"${name}", …}`, read: `library {topic:"moves", name:"${name}"}` };
  if (ops.includes(name)) return { kind: "op", use: OP_USE[name] ?? `${name} {…}`, read: `library {topic:"op", name:"${name}"}` };
  if (TOPICS[name]) return { kind: "topic", use: TOPICS[name], read: `library {topic:"rules", name:"${name}"}` };
  return null;
}

/**
 * The kino names that make what `query` describes, best first: a name equal to the query, then
 * the names its words stand for (SEEN_AS), then names that hold one of its words. One line each.
 */
export function seenNames(query, { ops = [], limit = 5 } = {}) {
  return seenNameList(query, { ops }).slice(0, limit).map((name) => {
    const call = readCallFor(name, { ops });
    return `${name} (${call.kind}: ${call.use}; ${call.read})`;
  });
}

/** The bare kino names of seenNames, best first, all of them (the deck reads labels with it; "cut_out" is always an op here). */
export function seenNameList(query, { ops = ["cut_out", "keep_line", "trace_image"] } = {}) {
  // Punctuation and case do not count ("Bloom!" is bloom; "cut_out" and "cut-out" are cut out).
  const text = String(query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!text) return [];
  const words = text.split(" ").filter((word) => word.length > 2);
  const joined = text.replace(/ /g, "-");
  const all = [...EFFECTS.map((entry) => entry.key), ...MOVE_NAMES, ...ops, ...Object.keys(TOPICS)];
  const found = [];
  const add = (name) => { if (!found.includes(name) && readCallFor(name, { ops })) found.push(name); };
  for (const name of all) if (name === joined || name === text.replace(/ /g, "_")) add(name);
  for (const name of SEEN_AS[text] ?? []) add(name);
  for (const key of Object.keys(SEEN_AS)) if (key.includes(" ") && ` ${text} `.includes(` ${key} `)) for (const name of SEEN_AS[key]) add(name);
  for (const word of words.filter((entry) => !LOOSE.has(entry))) for (const name of SEEN_AS[word] ?? []) add(name);
  // Else a word that is a whole part of a name ("leaks" in light-leaks).
  // Ops are left out here: the search's ops line already lists the ops that hold a word.
  if (!found.length && !noMakerLine(text)) for (const word of words.filter((entry) => entry.length > 3 && !LOOSE.has(entry) && !GENERIC.has(entry))) for (const name of all.filter((entry) => !ops.includes(entry))) if (name.split("-").includes(word)) add(name);
  return found;
}
