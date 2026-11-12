// The Light effects: glow (bloom, halation), light rays (god rays) and lens flare. Each is a
// ranged effect, so it covers the whole scene unless given a start and duration, and animates
// from `from` to its parameters (numbers and colours blend; style and source switch halfway).
// glow.js, lightRays.js and lensFlare.js say how each one is drawn.
import { MAX_GLOW_PASSES, GLOW_DEFAULTS, renderGlow } from "./glow.js";
import { MAX_RAY_LENGTH, renderLightRays } from "./lightRays.js";
import { FLARE_STYLES, renderLensFlare } from "./lensFlare.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const color = (label, value) => ({ type: "color", label, default: value });
const choice = (label, value, options) => ({ type: "enum", label, default: value, options });

const brightParts = () => ({
  threshold: number("Threshold", GLOW_DEFAULTS.threshold, 0, 1, 0.01),
  softness: number("Softness", GLOW_DEFAULTS.softness, 0, 1, 0.01),
  color: color("Color", "#FFFFFF"),
  colorMix: number("Color Mix", 0, 0, 1, 0.01),
});

export const LIGHT_EFFECTS = [
  { key: "glow", label: "Glow", group: "Light", kind: "ranged", render: renderGlow,
    parameters: {
      strength: number("Strength", 1, 0, 8, 0.05),
      radius: number("Radius", 24, 0, 400, 1, "px"),
      passes: number("Passes", 1, 1, MAX_GLOW_PASSES, 1, "", { integer: true }),
      ...brightParts(),
    } },
  { key: "light-rays", label: "Light Rays", group: "Light", kind: "ranged", render: renderLightRays,
    parameters: {
      strength: number("Strength", 1, 0, 8, 0.05),
      length: number("Length", 0.4, 0, MAX_RAY_LENGTH, 0.01),
      decay: number("Decay", 0.6, 0, 1, 0.01),
      centerX: number("Center X", 0.5, -1, 2, 0.01, "layer fraction"),
      centerY: number("Center Y", 0.5, -1, 2, 0.01, "layer fraction"),
      source: choice("Source", "bright", [["bright", "Bright parts"], ["behind", "Light behind"]]),
      lightSize: number("Light Size", 0.4, 0, 4, 0.01, "layer fraction"),
      ...brightParts(),
    } },
  { key: "lens-flare", label: "Lens Flare", group: "Light", kind: "ranged", render: renderLensFlare,
    parameters: {
      style: choice("Style", "glint", FLARE_STYLES.map((style) => [style, style[0].toUpperCase() + style.slice(1)])),
      x: number("Light X", 0.3, -1, 2, 0.01, "layer fraction"),
      y: number("Light Y", 0.3, -1, 2, 0.01, "layer fraction"),
      strength: number("Strength", 1, 0, 4, 0.05),
      size: number("Size", 1, 0.05, 4, 0.01),
      angle: number("Angle", 0, -360, 360, 1, "°"),
      color: color("Color", "#FFC890"),
      // Optional: left out, each style keeps its own (lensFlare.js STYLE_DEFAULTS).
      // Ghosts scales the ghost and ring reflections (0 turns them off).
      ghosts: number("Ghosts", 1, 0, 2, 0.01, "", { optional: true }),
      // Softness blurs the streaks across their thickness (0 hard edges).
      softness: number("Softness", 0, 0, 1, 0.01, "", { optional: true }),
      // Thickness and length scale the streaks (length 1 on the streak style spans the picture).
      thickness: number("Thickness", 1, 0.1, 6, 0.01, "", { optional: true }),
      length: number("Length", 1, 0.1, 3, 0.01, "", { optional: true }),
    } },
];

// Reduced motion. A Light animation shorter than CALM_LIGHT_SECONDS that is not held on both
// sides shows only for that moment, or changes the picture's brightness quickly in and out, like
// a glow flashing on a beat. For people who ask their system for reduced motion the dashboard
// preview draws these calmly (render.js `calmLight`); exports always draw the real thing.
export const CALM_LIGHT_SECONDS = 1;
const LIGHT_KEYS = new Set(LIGHT_EFFECTS.map((effect) => effect.key));

/**
 * The layer's animations with each short Light burst calmed: one that ends switched off
 * (keepStill off) is left out; one held at its start (keepStill start) stays at its starting
 * values until it ends; one held at its end (keepStill end) shows its end values from its start.
 * Short animations held on both sides change once, so they stay as they are. Returns the same
 * array when nothing changes.
 */
export function calmLightAnimations(animations) {
  if (!Array.isArray(animations)) return animations;
  let changed = false;
  const calmed = animations.flatMap((animation) => {
    // A group made with group_animations: calm its members (their starts are relative to the group).
    if (animation?.kind === "composed") {
      const members = calmLightAnimations(animation.animations);
      if (members === animation.animations) return [animation];
      changed = true;
      return [{ ...animation, animations: members }];
    }
    if (animation?.kind !== "effect" || !LIGHT_KEYS.has(animation.effect) || !(animation.duration < CALM_LIGHT_SECONDS)) return [animation];
    const hold = animation.keepStill ?? "both";
    if (hold === "both") return [animation];
    changed = true;
    if (hold === "off") return [];
    const { from, ...rest } = animation;
    return [{ ...rest, to: hold === "start" ? { ...animation.to, ...from } : animation.to }];
  });
  return changed ? calmed : animations;
}
