// The outline-glow text look: hollow letters (a dark interior, a lit outline) with a glow that
// spreads only from the outline. It is plain layer fields (fill, strokes, shadows), so every field
// stays editable afterward; this only picks consistent values for them.
//
//   outlineGlow({stroke, fill, glow, width}) -> fields for add_layer or update_layer on a text layer
//   stroke  outline color        (default #1F7A29)
//   fill    interior color       (default #0A1F0C; a fill near the ground reads as hollow)
//   glow    halo color           (default #2BD43A)
//   width   outline width in px  (default 5 at a 175 px font, scaled with the font size)
//   fontSize  the layer's font size, used only to scale width and the halo (default 175)
//
// Where each default comes from (.scratch/studies/hand-lettering): the 5 px width at 175 px is the
// study's final pass. The colors are the reference's own: its stroke runs #1e6a25 with brighter spots
// and its interior is #0a1f0c (result.md); its lit letters measured at most G 69 of 255 at 854 px, while
// the study's #3FC448 stroke with #22FF44 glow measured about 3x brighter, the "accents too bright"
// gap of the synthesis. The halo is the reference's "tight, low strength" glow: blur and opacities
// were tuned by measuring frames against it (a guess at the general case; change them freely).
export const OUTLINE_GLOW_DEFAULTS = Object.freeze({ stroke: "#1F7A29", fill: "#0A1F0C", glow: "#2BD43A", width: 5, fontSize: 175 });
const HALO = Object.freeze([{ blur: 0.05, opacity: 0.5 }, { blur: 0.12, opacity: 0.2 }]);

const KEYS = ["stroke", "fill", "glow", "width"];

/**
 * Layer properties with an `outlineGlow` shorthand ({stroke?, fill?, glow?, width?} or true)
 * replaced by the fill, strokes and shadows it stands for. Fields given beside it win, so
 * `{outlineGlow: true, fill: "#000"}` is the look with another interior. `fontSize` is the size
 * to scale for when the properties hold none (the layer's own, or a new text layer's 48).
 * Throws a plain Error.
 */
export function withOutlineGlow(properties, fontSize) {
  const { outlineGlow: look, ...rest } = properties;
  if (look === undefined || look === null || look === false) return rest;
  if (look !== true && (typeof look !== "object" || Array.isArray(look))) throw new Error("outlineGlow is true or {stroke?, fill?, glow?, width?}: colors are hex, width is pixels.");
  const extra = look === true ? [] : Object.keys(look).filter((key) => !KEYS.includes(key));
  if (extra.length) throw new Error(`outlineGlow has no ${extra.join(", ")}; it takes ${KEYS.join(", ")}.`);
  const given = look === true ? {} : look;
  for (const key of ["stroke", "fill", "glow"]) if (given[key] !== undefined && typeof given[key] !== "string") throw new Error(`outlineGlow ${key} is a hex color such as "#1F7A29".`);
  if (given.width !== undefined && !(typeof given.width === "number" && given.width > 0 && given.width <= 200)) throw new Error("outlineGlow width is pixels, above 0 and up to 200.");
  const size = typeof rest.fontSize === "number" ? rest.fontSize : fontSize;
  return { ...outlineGlow({ ...given, fontSize: size }), ...rest };
}

export function outlineGlow({ stroke, fill, glow, width, fontSize } = {}) {
  const size = fontSize ?? OUTLINE_GLOW_DEFAULTS.fontSize;
  const scale = size / OUTLINE_GLOW_DEFAULTS.fontSize;
  const line = width ?? Math.max(1, Math.round(OUTLINE_GLOW_DEFAULTS.width * scale * 10) / 10);
  const color = glow ?? OUTLINE_GLOW_DEFAULTS.glow;
  return {
    fill: fill ?? OUTLINE_GLOW_DEFAULTS.fill,
    strokes: [{ color: stroke ?? OUTLINE_GLOW_DEFAULTS.stroke, width: line, join: "round" }],
    shadows: HALO.map(({ blur, opacity }) => ({ color, x: 0, y: 0, blur: Math.max(1, Math.round(size * blur)), opacity })),
  };
}
