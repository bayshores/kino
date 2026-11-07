// Vertical-video recipes: hook-slam, caption-pop, tip-card, progress-bar, follow-cta. They are
// laid out for 9:16 first (inside the safe area that phone apps leave clear) and also work in
// 16:9 and 1:1.
import { alignIn, column, imageLayer, shapeLayer, textLayer, textWidth } from "../build.js";
import { alignOf, cardAround, formatNumber, pillWithText, px, shiftX, styleOf } from "./common.js";

export const hookSlam = {
  name: "hook-slam",
  group: "vertical",
  about: "a short, very large hook slams in over the first second, underlined in the accent colour",
  copy: [
    { key: "text", required: true, max: 40, about: "the hook, a few words" },
    { key: "kicker", max: 24, about: "a small label above the hook" },
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F4", square: "A1:F5" },
  build(ctx, { copy, box, settings }) {
    const align = alignOf(ctx, settings, ["center", "left"]);
    ctx.used?.add("uppercase");
    const upper = settings.uppercase ?? ctx.rng.next() < 0.5;
    const kicker = copy.kicker ? textLayer(ctx, { part: "kicker", text: copy.kicker, role: "caption", step: "label", box: { ...box, height: box.height * 0.14 }, align, color: "accent", maxLines: 1, uppercase: true, weight: 700 }) : null;
    const hook = textLayer(ctx, { part: "hook", text: copy.text, role: "headline", step: "display", size: Math.round(ctx.style.type.display * 1.1), box: { ...box, height: box.height * 0.78 }, align, maxLines: 4, uppercase: upper });
    const bar = shapeLayer(ctx, { box: { x: 0, y: 0, width: Math.min(hook.width, Math.max(px(ctx, 120), Math.round(textWidth(ctx, hook) * 0.4))), height: Math.max(6, px(ctx, 12)) }, color: "accent", radius: px(ctx, 6), role: "decor", name: "Underline" });
    column(box, [kicker && { layer: kicker }, { layer: hook, gap: px(ctx, 20) }, { layer: bar, gap: px(ctx, 30) }], { valign: "middle" });
    alignIn(bar, box, align);
    const style = styleOf(ctx, settings, ["slam", "slam", "rise"]);
    return {
      parts: [
        { part: null, layer: hook, enter: { style, at: 0 } },
        kicker && { part: "kicker", layer: kicker, enter: { style: "fade-down", with: null, gap: 0.15 } },
        { part: "bar", layer: bar, enter: { style: "grow-x", anchor: align === "center" ? "center" : "left", after: null, gap: -0.1, kind: "medium" } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const captionPop = {
  name: "caption-pop",
  group: "vertical",
  about: "a spoken-style caption pops in word by word on a dark box low in the safe area",
  copy: [{ key: "text", required: true, max: 90, about: "the caption" }],
  slots: { landscape: "B5:E6", portrait: "A4:F6", square: "A5:F6" },
  build(ctx, { copy, box }) {
    const pad = px(ctx, 26);
    const inner = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad };
    const caption = textLayer(ctx, { part: "caption", text: copy.text, role: "caption", step: "h2", box: inner, align: "center", maxLines: 3, weight: 700 });
    caption.y = Math.round(inner.y + inner.height - caption.height);
    const used = Math.min(caption.width, textWidth(ctx, caption) + 4);
    const back = shapeLayer(ctx, { box: { x: box.x + (box.width - used) / 2 - pad, y: caption.y - pad * 0.7, width: used + 2 * pad, height: caption.height + pad * 1.4 }, color: "surface", radius: px(ctx, 18), role: "decor", name: "Caption box", opacity: 0.92 });
    return {
      parts: [
        { part: "box", layer: back, enter: { style: "fade", at: 0, kind: "medium" } },
        { part: null, layer: caption, enter: { style: "rise", with: "box", gap: 0.05 } },
      ],
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const tipCard = {
  name: "tip-card",
  group: "vertical",
  about: "a card with a numbered chip (Tip 3) and the tip itself",
  copy: [
    { key: "title", required: true, max: 24, about: "the chip, such as Tip 3" },
    { key: "text", required: true, max: 120, about: "the tip" },
  ],
  slots: { landscape: "B2:E5", portrait: "A2:F5", square: "A2:F5" },
  build(ctx, { copy, box, settings }) {
    const pad = px(ctx, 52);
    const inner = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad };
    const align = alignOf(ctx, settings, ["left"]);
    const { pill, label } = pillWithText(ctx, { text: copy.title, role: "caption", step: "label", box: { ...inner, height: inner.height * 0.2 }, padX: 28, padY: 12, uppercase: true });
    const tip = textLayer(ctx, { part: "tip", text: copy.text, role: "body", step: "h2", box: { ...inner, height: inner.height * 0.72 }, align, maxLines: 6 });
    const stack = column(inner, [{ layer: pill }, { layer: tip, gap: px(ctx, 32) }], { valign: "middle" });
    label.y = pill.y + px(ctx, 12);
    // The card is as wide as its words (balanced lines are often narrower than the slot), and
    // sits in the middle of the slot.
    const width = Math.max(tip.width, pill.width);
    shiftX([pill, label, tip], (inner.width - width) / 2);
    const card = cardAround(ctx, { ...stack, x: inner.x + (inner.width - width) / 2, width }, { pad: 52 });
    return {
      parts: [
        { part: "card", layer: card, enter: { style: styleOf(ctx, settings, ["scale", "fade-up", "slide-left"]), at: 0, kind: "large" } },
        { part: "chip", layer: pill, enter: { style: "scale", with: "card", gap: 0.2, kind: "small" } },
        { part: "label", layer: label, enter: { style: "fade", with: "chip", gap: 0.05 } },
        { part: null, layer: tip, enter: { style: "fade-up", after: "chip", gap: -0.05 } },
      ],
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const progressBar = {
  name: "progress-bar",
  group: "vertical",
  about: "a labelled bar fills to a percentage while the number counts up",
  copy: [
    { key: "text", required: true, max: 40, about: "what the bar measures" },
    { key: "value", number: true, about: "the percentage it fills to, 1 to 100 (100 when left out)" },
  ],
  slots: { landscape: "B3:E4", portrait: "A3:F4", square: "A3:F4" },
  build(ctx, { copy, box }) {
    const value = copy.value ?? 100;
    if (value < 1 || value > 100) throw new Error("progress-bar: copy.value must be from 1 to 100.");
    const percent = textLayer(ctx, { part: "percent", text: `${formatNumber(value)}%`, role: "caption", step: "h2", box: { ...box, width: box.width * 0.34, x: box.x + box.width * 0.66, height: box.height * 0.5 }, align: "right", color: "accent", maxLines: 1, weight: 700 });
    const label = textLayer(ctx, { part: "label", text: copy.text, role: "body", step: "body", box: { ...box, width: box.width * 0.62, height: box.height * 0.5 }, align: "left", maxLines: 2 });
    const trackHeight = Math.max(10, px(ctx, 26));
    const rowHeight = Math.max(label.height, percent.height);
    const top = Math.round(box.y + (box.height - rowHeight - px(ctx, 28) - trackHeight) / 2);
    label.y = top + rowHeight - label.height;
    percent.y = top + rowHeight - percent.height;
    const trackY = top + rowHeight + px(ctx, 28);
    const track = shapeLayer(ctx, { box: { x: box.x, y: trackY, width: box.width, height: trackHeight }, color: "surface", radius: Math.round(trackHeight / 2), role: "decor", name: "Track" });
    const fill = shapeLayer(ctx, { box: { x: box.x, y: trackY, width: Math.max(trackHeight, Math.round(box.width * value / 100)), height: trackHeight }, color: "accent", radius: Math.round(trackHeight / 2), role: "decor", name: "Fill" });
    return {
      parts: [
        { part: "label", layer: label, enter: { style: "fade-up", at: 0 } },
        { part: "track", layer: track, enter: { style: "fade", with: "label", gap: 0.1, kind: "medium" } },
        { part: "fill", layer: fill, enter: { style: "grow-x", after: "track", gap: -0.05, kind: "headline" } },
        { part: null, layer: percent, enter: { style: "fade", with: "fill", gap: 0, kind: "text" } },
      ],
      extras: [{ part: null, name: "count", with: "fill", animation: { name: "Count up", kind: "counter", duration: 0, easing: null, from: 0, to: value, step: value >= 10 ? 1 : 0.1, out: null, in: null }, follow: "fill" }],
      assertions: [{ type: "visible_by" }, { type: "inside_frame", part: "label" }],
    };
  },
};

export const followCta = {
  name: "follow-cta",
  group: "vertical",
  about: "the logo, a follow line and the handle in an accent pill; it stays to the end",
  copy: [
    { key: "text", required: true, max: 32, about: "the line, such as Follow for daily tips" },
    { key: "handle", required: true, max: 32, about: "the account, such as @kino" },
  ],
  media: "optional",
  slots: { landscape: "B2:E5", portrait: "A2:F5", square: "A2:F5" },
  build(ctx, { copy, box, media }) {
    const picture = media[0] ?? ctx.logo?.media ?? null;
    const mark = picture ? alignIn(imageLayer(ctx, { media: picture, box: { ...box, height: box.height * 0.26 }, role: "logo", name: "Logo" }), box, "center") : null;
    const line = textLayer(ctx, { part: "text", text: copy.text, role: "cta", step: "h1", box: { ...box, height: box.height * 0.4 }, align: "center", maxLines: 3 });
    const { pill, label } = pillWithText(ctx, { text: copy.handle, role: "cta", step: "body", box: { ...box, height: box.height * 0.2 }, padX: 40, padY: 18 });
    column(box, [mark && { layer: mark }, { layer: line, gap: px(ctx, 40) }, { layer: pill, gap: px(ctx, 40) }], { valign: "middle" });
    shiftX([pill, label], box.x + (box.width - pill.width) / 2 - pill.x);
    label.y = pill.y + px(ctx, 18);
    return {
      parts: [
        mark && { part: "logo", layer: mark, enter: { style: "pop", at: 0, kind: "logo" } },
        { part: null, layer: line, enter: mark ? { style: "rise", after: "logo", gap: -0.2 } : { style: "rise", at: 0 } },
        { part: "button", layer: pill, enter: { style: "scale", after: null, gap: -0.1, kind: "medium" } },
        { part: "handle", layer: label, enter: { style: "fade", with: "button", gap: 0.06 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const VERTICAL_RECIPES = [hookSlam, captionPop, tipCard, progressBar, followCta];
