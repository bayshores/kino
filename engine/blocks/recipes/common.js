// Small pieces several recipes share: pixel sizes that follow the frame, the headline size for a
// text's length, a logo (picture or wordmark), a pill with text centred in it, and a card.
import { alignIn, imageLayer, shapeLayer, textLayer, textWidth } from "../build.js";

/** `pixels` in a 1080-short-side frame, scaled to this frame. */
export const px = (ctx, pixels) => Math.max(1, Math.round(pixels * ctx.style.scale));

/** The type step a headline of this length starts at: short ones get the display size. */
export function headlineStep(text) {
  const length = String(text ?? "").length;
  return length <= 16 ? "display" : length <= 34 ? "h1" : "h2";
}

/**
 * A copy field kino no longer draws. It is still accepted, so old projects and agents are not
 * refused; the runner leaves it out and says so in the receipt (recipe.js).
 */
export const RETIRED_KICKER = { key: "kicker", retired: "kicker left out: a small label stacked over a headline reads as a template" };

/** The settings' align, or a seeded pick from `choices`. An align the recipe cannot use is an error. */
export function alignOf(ctx, settings, choices = ["left", "center"]) {
  ctx.used?.add("align");
  if (settings?.align !== undefined) {
    if (!choices.includes(settings.align)) throw new Error(`${ctx.recipe} align is ${choices.join(" or ")}${choices.length === 1 ? " only" : ""}.`);
    return settings.align;
  }
  return ctx.rng.pick(choices);
}

/** A seeded pick of an entrance style, unless the settings name one of `choices`. */
export function styleOf(ctx, settings, choices) {
  ctx.used?.add("enter");
  if (settings?.enter !== undefined) {
    const offered = [...new Set(choices)];
    if (!offered.includes(settings.enter)) throw new Error(`${ctx.recipe} enter is one of ${offered.join(", ")}.`);
    return settings.enter;
  }
  return ctx.rng.pick(choices);
}

/**
 * The brand's logo (or the given picture) fitted in `box`, or a wordmark text when there is no
 * picture. Returns the layer, or null when there is neither.
 */
export function logoLayer(ctx, { picture, word, box, align = "center", step = "display" }) {
  if (picture) return alignIn(imageLayer(ctx, { media: picture, box, role: "logo", name: "Logo" }), box, align);
  if (!word) return null;
  return textLayer(ctx, { part: "logo", text: word, role: "logo", step, box, align, maxLines: 2, name: "Wordmark" });
}

/**
 * A rounded pill (decor) with `text` centred in it. The text keeps `role`; its colour is the
 * background colour on an accent pill, so it reads clearly. Returns {pill, label}, both placed
 * with the pill's left edge at box.x (move them with shiftX).
 */
export function pillWithText(ctx, { text, role, step = "body", box, fill = "accent", color = "bg", padX = 44, padY = 20, uppercase = false }) {
  const inner = { x: box.x, y: box.y, width: Math.max(10, box.width - 2 * px(ctx, padX)), height: box.height };
  const label = textLayer(ctx, { part: role, text, role, step, box: inner, align: "center", color, maxLines: 1, uppercase });
  const width = Math.min(inner.width, textWidth(ctx, label) + 6);
  label.width = width;
  const pill = shapeLayer(ctx, {
    box: { x: box.x, y: box.y, width: width + 2 * px(ctx, padX), height: label.height + 2 * px(ctx, padY) },
    color: fill, radius: Math.round((label.height + 2 * px(ctx, padY)) / 2), role: "decor", name: "Pill",
  });
  label.x = pill.x + px(ctx, padX);
  label.y = pill.y + px(ctx, padY);
  return { pill, label };
}

/** Moves layers sideways by dx pixels. */
export function shiftX(layers, dx) {
  for (const layer of layers) if (layer) layer.x = Math.round(layer.x + dx);
}

/** The box around some layers. */
export function boundsOf(layers) {
  const list = layers.filter(Boolean);
  const x = Math.min(...list.map((layer) => layer.x));
  const y = Math.min(...list.map((layer) => layer.y));
  return { x, y, width: Math.max(...list.map((layer) => layer.x + layer.width)) - x, height: Math.max(...list.map((layer) => layer.y + layer.height)) - y };
}

/** A card (decor) around `box` with `pad` pixels of room. */
export function cardAround(ctx, box, { pad = 48, color = "surface", radius = 28 } = {}) {
  const room = px(ctx, pad);
  return shapeLayer(ctx, { box: { x: box.x - room, y: box.y - room, width: box.width + 2 * room, height: box.height + 2 * room }, color, radius: px(ctx, radius), role: "decor", name: "Card" });
}

/** A number written with thousands separators and at most `decimals` decimals. */
export function formatNumber(value, decimals = null) {
  const places = decimals ?? (String(value).split(".")[1]?.length ?? 0);
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: Math.min(places, 4), maximumFractionDigits: Math.min(places, 4) });
}
