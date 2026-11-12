// The outline-glow text look: hollow letters (a dark interior, a bright outline) with a glow that
// spreads only from the outline. It is plain layer fields (fill, strokes, shadows), so every field
// stays editable afterward; this only picks consistent values for them.
//
//   outlineGlow({stroke, fill, glow, width}) -> fields for add_layer or update_layer on a text layer
//   stroke  outline color        (default #3FC448, the hand-lettering study's round-6 outline green)
//   fill    interior color       (default #0A260E, the study's round-6 dark green; a fill the same
//                                 as the ground reads as hollow)
//   glow    halo color           (default #22FF44, the study's glow color)
//   width   outline width in px  (default 5 at a 175 px font, from the study; scales with the font
//                                 size, so pass fontSize to scale it)
//   fontSize  the layer's font size, used only to scale width and the halo (default 175)
//
// Where each default comes from: the colors and the 5 px width at 175 px are the final pass of
// .scratch/studies/hand-lettering (the scrawl title). The halo's two blurs (about 0.035 and 0.1 of the
// font size) and their opacities are guesses that look like that study's glow effect (radius 6,
// strength 0.9 in round 6); change them freely.
export const OUTLINE_GLOW_DEFAULTS = Object.freeze({ stroke: "#3FC448", fill: "#0A260E", glow: "#22FF44", width: 5, fontSize: 175 });

const KEYS = ["stroke", "fill", "glow", "width"];

/**
 * Layer properties with an `outlineGlow` shorthand ({stroke?, fill?, glow?, width?} or true)
 * replaced by the fill, strokes and shadows it stands for. Fields given beside it win, so
 * `{outlineGlow: true, fill: "#000"}` is the look with another interior. Throws a plain Error.
 */
export function withOutlineGlow(properties) {
  const { outlineGlow: look, ...rest } = properties;
  if (look === undefined || look === null || look === false) return rest;
  if (look !== true && (typeof look !== "object" || Array.isArray(look))) throw new Error("outlineGlow is true or {stroke?, fill?, glow?, width?}: colors are hex, width is pixels.");
  const extra = look === true ? [] : Object.keys(look).filter((key) => !KEYS.includes(key));
  if (extra.length) throw new Error(`outlineGlow has no ${extra.join(", ")}; it takes ${KEYS.join(", ")}.`);
  const given = look === true ? {} : look;
  for (const key of ["stroke", "fill", "glow"]) if (given[key] !== undefined && typeof given[key] !== "string") throw new Error(`outlineGlow ${key} is a hex color such as "#3FC448".`);
  if (given.width !== undefined && !(typeof given.width === "number" && given.width > 0 && given.width <= 200)) throw new Error("outlineGlow width is pixels, above 0 and up to 200.");
  return { ...outlineGlow({ ...given, fontSize: rest.fontSize }), ...rest };
}

export function outlineGlow({ stroke, fill, glow, width, fontSize } = {}) {
  const size = fontSize ?? OUTLINE_GLOW_DEFAULTS.fontSize;
  const scale = size / OUTLINE_GLOW_DEFAULTS.fontSize;
  const line = width ?? Math.max(1, Math.round(OUTLINE_GLOW_DEFAULTS.width * scale * 10) / 10);
  const color = glow ?? OUTLINE_GLOW_DEFAULTS.glow;
  return {
    fill: fill ?? OUTLINE_GLOW_DEFAULTS.fill,
    strokes: [{ color: stroke ?? OUTLINE_GLOW_DEFAULTS.stroke, width: line, join: "round" }],
    shadows: [
      { color, x: 0, y: 0, blur: Math.round(size * 0.035), opacity: 0.85 },
      { color, x: 0, y: 0, blur: Math.round(size * 0.1), opacity: 0.4 },
    ],
  };
}
