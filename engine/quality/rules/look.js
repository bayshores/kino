// Generic-look warnings: gradient_text, neon_on_dark, pure_frame, default_font, gradient_banding.
import { coversFrame, readingTexts } from "../analysis.js";
import { hexRgba, isGradient, luminance, paintColors } from "../model.js";

// Fonts so common that a video set in them looks like a default. A brand kit that names one
// (A4) makes it a choice instead.
export const DEFAULT_FONTS = ["inter", "roboto", "arial", "helvetica", "helvetica neue", "open sans", "montserrat", "poppins", "lato", "system-ui", "sf pro", "sf pro display", "sf pro text", "segoe ui", "noto sans"];

/** Hue (0–360), saturation and lightness (0–1) of a hex color. */
export function hslOf(color) {
  const rgba = hexRgba(color);
  if (!rgba) return null;
  const [r, g, b] = rgba.slice(0, 3).map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, saturation, lightness };
}

const isNeon = (color) => {
  const hsl = hslOf(color);
  if (!hsl || hsl.saturation < 0.7 || hsl.lightness < 0.4 || hsl.lightness > 0.7) return false;
  return (hsl.hue >= 170 && hsl.hue <= 200) || (hsl.hue >= 225 && hsl.hue <= 290);
};

// The paint seen behind everything: the scene background, or a solid layer covering the frame.
// What fills the whole frame: the scene's background and full-frame items. A tool that also
// lists the background as an item (kino's #scene-background) gives it once, as that item.
function backdrops(model) {
  const list = [];
  const samePaint = (item) => JSON.stringify(item.fill) === JSON.stringify(model.background);
  if (model.background && !model.items.some((item) => samePaint(item) && coversFrame(model, item))) list.push({ paint: model.background, item: null });
  for (const item of model.items) if (!item.isMask && item.fill && coversFrame(model, item) && item.kind !== "image" && item.kind !== "video") list.push({ paint: item.fill, item });
  return list;
}

const meanLuminance = (paint) => {
  const colors = paintColors(paint).map(hexRgba).filter(Boolean);
  return colors.length ? colors.reduce((sum, rgba) => sum + luminance(rgba), 0) / colors.length : null;
};

export function gradientText(model, ctx) {
  // A move's own sheen (push-through-type's glossy word) is a designed set piece, not a default.
  return readingTexts(model).filter((item) => isGradient(item.fill) && !item.move).map((item) => ({
    rule: "gradient_text", severity: "warn", itemId: item.id, measured: "gradient fill", required: "solid text colour",
    message: `${ctx.name(item)} has gradient-filled text, a common generic look that also lowers contrast.`,
    fix: { kind: "item", itemId: item.id, properties: { fill: paintColors(item.fill)[0] } },
  }));
}

export function neonOnDark(model, ctx) {
  const dark = backdrops(model).some(({ paint }) => (meanLuminance(paint) ?? 1) < 0.05);
  if (!dark) return [];
  const neon = new Map();
  for (const item of model.items) {
    if (item.isMask) continue;
    const colors = [...paintColors(item.fill), ...(item.shadow?.color ? [item.shadow.color] : [])];
    for (const color of colors) if (isNeon(color)) neon.set(color.toLowerCase().slice(0, 7), item);
  }
  if (!neon.size) return [];
  const [first] = neon.values();
  return [{
    rule: "neon_on_dark", severity: "warn", itemId: first.id, measured: [...neon.keys()].slice(0, 4).join(", "), required: "not neon on near-black",
    message: `${ctx.sceneName} uses neon ${[...neon.keys()].slice(0, 3).join(", ")} on a near-black background, the common "hacker" dark look.`,
    fix: { kind: "hint", text: "Use a warmer or less saturated accent, or a lighter background." },
  }];
}

export function pureFrame(model, ctx) {
  const findings = [];
  for (const { paint, item } of backdrops(model)) {
    if (typeof paint !== "string") continue;
    const rgba = hexRgba(paint);
    if (!rgba || rgba[3] < 255) continue;
    const black = rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 0;
    const white = rgba[0] === 255 && rgba[1] === 255 && rgba[2] === 255;
    if (!black && !white) continue;
    // A scene background hidden the whole time by a full-frame image does not show.
    if (!item && model.items.some((other) => other.opaque && coversFrame(model, other) && other.samples.opacity.every((value) => value >= 0.99))) continue;
    const better = black ? "#0b0b0c" : "#fafaf7";
    findings.push({
      rule: "pure_frame", severity: "warn", itemId: item?.id, measured: black ? "#000000" : "#ffffff", required: "off-black or off-white",
      message: `${item ? ctx.name(item) : `${ctx.sceneName}'s background`} fills the frame with pure ${black ? "black" : "white"}, which looks flat and ${black ? "crushes" : "glares"} on most screens.`,
      fix: item ? { kind: "item", itemId: item.id, properties: { fill: better }, auto: true } : { kind: "scene", properties: { background: better }, auto: true },
    });
  }
  return findings;
}

const familyOf = (fontFamily) => String(fontFamily ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

export function defaultFont(model, ctx) {
  const named = new Set((ctx.brandFonts ?? []).map((font) => familyOf(font)));
  const byFamily = new Map();
  for (const item of readingTexts(model)) {
    const family = familyOf(item.fontFamily);
    if (!DEFAULT_FONTS.includes(family) || named.has(family)) continue;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(item);
  }
  return [...byFamily].map(([family, items]) => ({
    rule: "default_font", severity: "warn", itemId: items[0].id, itemIds: items.map((item) => item.id), measured: items[0].fontFamily, required: "a chosen font",
    message: `${items.length} text layer${items.length === 1 ? "" : "s"} (${items.slice(0, 3).map((item) => ctx.name(item)).join(", ")}) use${items.length === 1 ? "s" : ""} ${items[0].fontFamily}, a common default font.`,
    fix: { kind: "hint", text: `Pick a typeface for the brand, or waive default_font if ${items[0].fontFamily} is the brand's font.` },
  }));
}

export function gradientBanding(model, ctx) {
  const findings = [];
  for (const { paint, item } of backdrops(model)) {
    if (!isGradient(paint)) continue;
    const colors = paintColors(paint).map(hexRgba).filter(Boolean);
    if (colors.length < 2) continue;
    const lights = colors.map(luminance);
    if (Math.max(...lights) >= 0.2 || new Set(colors.map((rgba) => rgba.slice(0, 3).join())).size < 2) continue;
    findings.push({
      rule: "gradient_banding", severity: "warn", itemId: item?.id, measured: "dark full-frame gradient", required: "dithered or solid",
      message: `${item ? ctx.name(item) : `${ctx.sceneName}'s background`} is a dark gradient across the whole frame, so it shows bands in 8-bit colour wherever it is not dithered: drafts, look frames, Lottie, dither:false, and project manage exports without dither:true. A final render dithers by default, which breaks up most bands, though video compression can bring some back.`,
      fix: { kind: "hint", text: "Use a solid colour, a lighter gradient, or a gradient across a smaller area." },
    });
  }
  return findings;
}
