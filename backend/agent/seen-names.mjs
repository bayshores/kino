// What an agent sees in a reference ("glow", "subtitles", "speed ramp", "shake") turned into the
// kino names that make it: effects, moves and ops, each with the call that reads its rules.
// library {topic:"search"} puts these lines first; the guide topics that mention the words follow.
import { EFFECTS } from "../../engine/effects/catalog.js";
import { MOVE_NAMES } from "../../engine/blocks/moves/index.js";

// Plain words for a look and the kino names that make it. Keys are lower case, words joined by
// one space. A key of several words matches where the query holds those words in a row; a key of
// one word matches the whole query or one of its words, except a LOOSE word.
const SEEN_AS = {
  glow: ["glow", "accent-hit"], bloom: ["glow"], halo: ["glow"], neon: ["glow"], halation: ["glow"],
  particles: ["embers", "sparks", "dust"], particle: ["embers", "sparks", "dust"], sparkles: ["sparks", "embers"],
  ash: ["embers", "dust"], fire: ["embers", "sparks"], smoke: ["fog"], haze: ["fog"],
  subtitles: ["add_captions", "caption-words"], subtitle: ["add_captions", "caption-words"], captions: ["add_captions", "caption-words"],
  caption: ["add_captions", "caption-words"], lyrics: ["add_captions", "caption-words"],
  "cut out": ["cut_out"], cutout: ["cut_out"], silhouette: ["cut_out"], matte: ["cut_out"], "background removal": ["cut_out"],
  "speed ramp": ["speed-ramp", "clip-speed"], ramp: ["speed-ramp", "clip-speed"], "slow motion": ["speed-ramp", "clip-speed"],
  "slow mo": ["speed-ramp", "clip-speed"], slowmo: ["speed-ramp", "clip-speed"], "time remap": ["speed-ramp", "clip-speed"],
  "fast forward": ["clip-speed"], reverse: ["clip-speed"],
  shake: ["impact-accent", "wiggle"], "camera shake": ["impact-accent", "wiggle"], jolt: ["impact-accent"], hit: ["impact-accent"],
  flash: ["impact-accent", "flash"], strobe: ["impact-accent"], "white flash": ["impact-accent", "flash"],
  "light rays": ["light-rays"], "god rays": ["light-rays"], rays: ["light-rays"], beams: ["light-rays"],
  "lens flare": ["lens-flare"], flare: ["lens-flare"], "light leak": ["light-leaks", "light-leak"],
  "color grade": ["color_filter", "color-grade", "color-wheels"], grade: ["color_filter", "color-grade", "color-wheels"],
  grading: ["color_filter", "color-grade"], tint: ["white-balance", "color_filter", "hue-saturation"],
  "green tint": ["white-balance", "color_filter", "color-wheels"], green: ["white-balance", "color-wheels", "hue-saturation"], desaturated: ["hue-saturation", "keep-color"], "black and white": ["hue-saturation", "keep-color"],
  repeat: ["beat-repeat"], stutter: ["beat-repeat"], "replay on beats": ["beat-repeat"], "repeat on beats": ["beat-repeat"], echo: ["beat-repeat", "inward-echoes"],
  glitch: ["glitch", "rgb-split-hit", "rgb-shift"], "rgb split": ["rgb-split-hit", "rgb-shift"], "chromatic aberration": ["rgb-shift"],
  "split screen": ["split-screen"], splitscreen: ["split-screen"], "side by side": ["split-screen"], panes: ["split-screen"], composite: ["split-screen", "picture-in-picture"],
  "picture in picture": ["picture-in-picture"], pip: ["picture-in-picture"], inset: ["picture-in-picture"],
  grain: ["grain"], vignette: ["vignette"], blur: ["zoom-blur", "directional-blur"], "freeze frame": ["freeze-shutter"],
};
// Common words that mean a look only on their own: "green" alone is a tint, but "green screen" is
// a cut-out and "repeat text" is not a footage stutter. Inside a longer query they lead nowhere.
const LOOSE = new Set(["green", "repeat", "ramp", "reverse", "hit", "grade", "tint", "flash", "fire", "ash", "rays", "beams", "echo", "blur", "flare", "matte", "grain"]);

// The last line of look {mode:"reference"}: what the agent sees there, as a lookup.
export const REFERENCE_LOOKUP = 'to make what you see: library {topic:"search", search:"<what you saw: glow, particles, subtitles, cut-out, speed ramp, shake>"}';

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
// Guide topics an agent reads instead of an op, effect or move (clip speed is layer properties).
const TOPICS = { "clip-speed": "layer properties mediaSpeed and speed animations" };

/** The call that reads a name's rules, and what the name is; null for a name kino does not have. */
export function readCallFor(name, { ops = [] } = {}) {
  const effect = EFFECTS.find((entry) => entry.key === name);
  if (effect) return { kind: "effect", use: `add_animation {layer, effect:"${name}"}`, read: `library {topic:"rules", name:"${GROUP_TOPIC[effect.group] ?? "effects"}"}` };
  if (MOVE_NAMES.includes(name)) return { kind: "move", use: `move {name:"${name}", …}`, read: `library {topic:"moves", name:"${name}"}` };
  if (ops.includes(name)) return { kind: "op", use: `${name} {…}`, read: `library {topic:"op", name:"${name}"}` };
  if (TOPICS[name]) return { kind: "topic", use: TOPICS[name], read: `library {topic:"rules", name:"${name}"}` };
  return null;
}

/**
 * The kino names that make what `query` describes, best first: a name equal to the query, then
 * the names its words stand for (SEEN_AS), then names that hold one of its words. One line each.
 */
export function seenNames(query, { ops = [], limit = 5 } = {}) {
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
  if (!found.length) for (const word of words.filter((entry) => entry.length > 3 && !LOOSE.has(entry))) for (const name of all.filter((entry) => !ops.includes(entry))) if (name.split("-").includes(word)) add(name);
  return found.slice(0, limit).map((name) => {
    const call = readCallFor(name, { ops });
    return `${name} (${call.kind}: ${call.use}; ${call.read})`;
  });
}
