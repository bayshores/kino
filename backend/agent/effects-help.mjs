// library {topic:"effects"}: every effect of the catalog (engine/effects/catalog.js) in one short
// answer, grouped by what it does; with a name, that effect's fields, ranges and defaults. Before
// this the topic answered "No saved text effects" (those are library {topic:"text-effects"} now),
// and agents read engine source for the fields or reported grain, vignette, focus-band, duotone
// and tritone as missing.
import { EFFECTS, MIX_DOCUMENTATION, fieldRange } from "../../engine/effects/catalog.js";
import { ruleTopicOf, seenNames } from "./seen-names.mjs";

// What each effect is, in a few words (one line each; the fields come from the catalog itself).
const HINTS = {
  grain: "film grain", vignette: "darker edges", duotone: "two-color grade, dark to light", tritone: "three-color grade: shadows, mids, highlights",
  "luma-highlight": "tint or boost the brightest parts", "rgb-shift": "red, green and blue split apart", "speed-lines": "thin streaks racing across",
  "impact-lines": "wedges pointing in from the edges", "film-burn": "hot glow eating in from an edge", dithering: "retro dot-pattern posterize",
  "dot-grid": "picture drawn as a grid of dots", "noise-mask": "noise holes, a dissolve", pixelate: "big square pixels", "threshold-color": "hard two-tone cut at a brightness",
  invert: "negative", curves: "tone curves per channel", lut: "a .cube grade file", "hue-saturation": "turn hue, saturate, lighten", "white-balance": "warmer or cooler, tint",
  "color-wheels": "lift, gamma, gain by tone", "keep-color": "gray out all but one hue", "color-ranges": "shift one hue range", "color-look": "a ready-made grade",
  glow: "bloom around bright parts or edges", "light-rays": "beams from a point", "lens-flare": "ghosts, rings and an anamorphic streak",
  "directional-blur": "smear along an angle", "zoom-blur": "smear toward a point", "spin-blur": "smear around a point", "focus-band": "sharp band, blur outside it: depth of field, tilt-shift",
  embers: "rising sparks of fire", sparks: "bright flying sparks", snow: "falling flakes", dust: "drifting specks; links joins them into a constellation or network", rain: "falling streaks", bokeh: "soft out-of-focus lights", fog: "drifting haze", "light-leaks": "warm color washes",
  bulge: "pinch or swell, a lens bump", displacement: "push pixels along an axis", "fluid-warp": "liquid wobble", "fluted-glass": "ribbed glass slices", "noise-warp": "organic wobble, heat shimmer",
  ripple: "rings spreading from a point", "edge-fill": "stretch or mirror the edge pixels outward", mirror: "reflect one half", kaleidoscope: "mirrored wedges", field: "any pattern from a math expression: dissolve, wipe, wave",
  "3d-orbit": "tilt and turn in 3D", "card-flip": "flip like a card", "color-grade": "exposure, brightness, contrast, saturation", "color-remover": "key out one color, a green screen",
  "grid-scroll-x": "tiled copies scrolling sideways", "grid-scroll-y": "tiled copies scrolling up or down", "inward-echoes": "shrinking echoes toward a point", "noise-tile": "tiled drifting noise cutouts",
  "radial-repeat-blur": "repeated spinning smear from a point", wiggle: "random shake",
};

// Catalog groups shown by what they do, in the order an agent most often needs them.
const SECTIONS = [["Post FX", "finish, grades, graphic looks"], ["Color", "grades"], ["Light", "glow, rays, flares"], ["Blur", "blur and focus"],
  ["Generate", "particles, fog"], ["Distortion", "warp and pattern"], ["Utility", "grade, key, tiling, 3D"]];

export const EFFECT_KEYS = EFFECTS.map((effect) => effect.key);
export const plainKey = (name) => String(name ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
const sameWords = (key) => key.replaceAll("-", " ");

/** The whole catalog, one line per group: { text, data }. */
export function effectsListText() {
  const lines = SECTIONS.map(([group, what]) => {
    const effects = EFFECTS.filter((effect) => effect.group === group);
    return `${group} (${what}): ${effects.map((effect) => `${effect.key}${effect.kind === "value" ? "*" : ""} ${HINTS[effect.key] ? `(${HINTS[effect.key]})` : ""}`.trim()).join(", ")}`;
  });
  const text = [
    `effects: ${EFFECTS.length}. Add one with add_animation {layer, effect:"<name>", parameters:{…}, start?, duration?}; library {topic:"effects", name:"<effect>"} gives its fields, ranges and defaults. * is one timed change (0.8 s unless you set duration); the rest run over the layer's whole time. Looking for a look by its plain name (vignette, outline, neon, streak): library {topic:"search", search:"<word>"}. Saved text effects: library {topic:"text-effects"}.`,
    ...lines,
  ].join("\n");
  return { text, data: { effects: EFFECTS.map(({ key, group, kind }) => ({ name: key, group, kind })) } };
}

/** One effect's fields, ranges and defaults: { text, data }, or null when `name` is no effect or word for one. */
export function effectDetailText(name) {
  const asked = plainKey(name);
  let key = EFFECTS.find((effect) => effect.key === asked)?.key;
  let alsoNamed = [];
  let note = "";
  if (!key) {
    // A plain word for it ("vignette", "neon", "depth of field"): the effects the search names.
    const found = seenNames(String(name ?? ""), { limit: 8 }).map((line) => line.split(" (")[0]).filter((entry) => EFFECTS.some((effect) => effect.key === entry));
    if (!found.length) return null;
    [key, ...alsoNamed] = found;
    note = `("${name}" read as ${key}${alsoNamed.length ? `; also ${alsoNamed.join(", ")}` : ""})\n`;
  }
  const effect = EFFECTS.find((entry) => entry.key === key);
  const fields = Object.entries(effect.parameters).filter(([field]) => field !== "mix");
  const first = fields.find(([, field]) => field.type === "number" && !field.optional) ?? fields[0];
  const example = first ? `, parameters:{${first[0]}:${JSON.stringify(first[1].default)}}` : "";
  const timing = effect.kind === "value"
    ? `a timed change: ${effect.duration} s by default (duration), from the start you give; from:{…} sets where it begins`
    : "runs over the layer's whole time; start and duration limit it to a window (keepStill both holds the first and last frame outside it)";
  const lines = fields.map(([field, definition]) => `  ${field} ${definition.type}${fieldRange(definition)}${definition.required ? " required" : ` default ${JSON.stringify(definition.default)}`}${Object.hasOwn(definition, "initial") ? ` initial ${JSON.stringify(definition.initial)}` : ""}`);
  const text = [
    `${note}${key} (${effect.label}, ${effect.group}): ${HINTS[key] ?? sameWords(key)}`,
    `use: add_animation {layer:"<layer>", effect:"${key}"${example}}; ${timing}`,
    "fields:", ...lines,
    `${MIX_DOCUMENTATION}.`,
    `rules and recipes: library {topic:"rules", name:"${ruleTopicOf(effect.group)}"}`,
  ].join("\n");
  return { text, data: { effect: key, group: effect.group, kind: effect.kind, parameters: Object.fromEntries(fields.map(([field, definition]) => [field, { type: definition.type, default: definition.default, ...(definition.min === undefined ? {} : { min: definition.min, max: definition.max }) }])) } };
}
