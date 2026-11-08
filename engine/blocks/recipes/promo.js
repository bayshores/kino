// Promo recipes: logo-sting, headline-reveal, device-slide, feature-callout, screen-detail, callout, price-pop, cta-end.
// Each build() returns its layers in drawing order (first is lowest) with when each enters; the
// runner (recipe.js) names them, times them and adds the exits.
import { createLayer } from "../../model.js";
import { alignIn, column, imageLayer, paint, shapeLayer, textLayer, textWidth, withAlpha } from "../build.js";
import { isPortraitFrame, safeArea, slotBox } from "../formats.js";
import { looksLikeScreen, looksLikeScreenClip, readableClipWidth } from "../../imageFacts.js";
import { alignOf, boundsOf, cardAround, headlineStep, logoLayer, pillWithText, px, RETIRED_KICKER, shiftX, styleOf } from "./common.js";

export const logoSting = {
  name: "logo-sting",
  group: "promo",
  about: "the logo lands in the middle, an accent rule draws under it, then an optional tagline",
  copy: [
    { key: "text", max: 24, about: "a wordmark, used when there is no logo picture" },
    { key: "tagline", max: 48, about: "a short line under the logo" },
  ],
  media: "optional",
  slots: { landscape: "B2:E5", portrait: "A2:F5", square: "A2:F5" },
  build(ctx, { copy, box, media, settings }) {
    const picture = media[0] ?? ctx.logo?.media ?? null;
    const word = picture ? null : copy.text ?? ctx.logo?.text ?? null;
    if (!picture && !word) throw new Error("logo-sting needs a logo: media (an uploaded picture), copy.text (a wordmark), or a brand with a logo.");
    const mark = logoLayer(ctx, { picture, word, box: { ...box, width: picture ? box.width * 0.62 : box.width, height: box.height * (copy.tagline ? 0.42 : 0.55) } });
    alignIn(mark, box, "center");
    const markWidth = mark.type === "text" ? textWidth(ctx, mark) : mark.width;
    const rule = shapeLayer(ctx, { box: { x: 0, y: 0, width: Math.max(px(ctx, 96), Math.round(markWidth * 0.32)), height: Math.max(4, px(ctx, 6)) }, color: "accent", radius: px(ctx, 3), role: "decor", name: "Accent rule" });
    alignIn(rule, box, "center");
    const tagline = copy.tagline ? textLayer(ctx, { part: "tagline", text: copy.tagline, role: "subhead", step: "body", box: { ...box, height: box.height * 0.3 }, align: "center", maxLines: 2 }) : null;
    column(box, [{ layer: mark }, { layer: rule, gap: px(ctx, 40) }, tagline && { layer: tagline, gap: px(ctx, 30) }], { valign: "middle" });
    const markStyle = picture ? styleOf(ctx, settings, ["scale", "pop", "fade-up"]) : styleOf(ctx, settings, ["letters", "rise", "slam"]);
    return {
      parts: [
        { part: null, layer: mark, enter: { style: markStyle, at: 0, kind: markStyle === "letters" ? "letters" : "logo" } },
        { part: "rule", layer: rule, enter: { style: "grow-x", anchor: "center", after: null, gap: -0.12, kind: "medium" } },
        tagline && { part: "tagline", layer: tagline, enter: { style: "fade-up", after: "rule", gap: -0.1 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }, ...(tagline ? [{ type: "before", other: "tagline" }] : [])],
    };
  },
};

export const headlineReveal = {
  name: "headline-reveal",
  group: "promo",
  about: "a headline enters word by word or line by line, with an optional line under it",
  copy: [
    { key: "text", required: true, max: 70, about: "the headline" },
    { key: "sub", max: 110, about: "a supporting line under the headline" },
    RETIRED_KICKER,
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F4", square: "A2:F5" },
  build(ctx, { copy, box, settings }) {
    const align = alignOf(ctx, settings);
    const head = textLayer(ctx, { part: "headline", text: copy.text, role: "headline", step: headlineStep(copy.text), box: { ...box, height: box.height * (copy.sub ? 0.6 : 0.82) }, align, maxLines: 3 });
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "subhead", step: "body", box: { ...box, height: box.height * 0.28 }, align, maxLines: 3 }) : null;
    column(box, [{ layer: head }, sub && { layer: sub, gap: px(ctx, 30) }], { valign: "middle" });
    const headStyle = styleOf(ctx, settings, ["rise", "lines", "fade-up", "slam"]);
    return {
      parts: [
        { part: null, layer: head, enter: { style: headStyle, at: 0 } },
        sub && { part: "sub", layer: sub, enter: { style: "fade-up", after: null, gap: -0.2 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }, ...(sub ? [{ type: "before", other: "sub" }] : [])],
    };
  },
};

/** A soft ellipse of accent light (decor) behind `picture`, about 1.5 times its width, gone before its edge. */
function stageLight(ctx, picture) {
  const width = Math.round(picture.width * 1.5);
  const height = Math.round(Math.max(picture.height * 1.6, width * 0.8));
  const accent = paint(ctx.style, "accent");
  return shapeLayer(ctx, {
    type: "ellipse", role: "decor", name: "Stage light",
    box: { x: picture.x + picture.width / 2 - width / 2, y: picture.y + picture.height / 2 - height / 2, width, height },
    color: { type: "radial", angle: 0, stops: [{ offset: 0, color: withAlpha(accent, 0.34) }, { offset: 0.45, color: withAlpha(accent, 0.14) }, { offset: 0.76, color: withAlpha(accent, 0) }, { offset: 1, color: withAlpha(accent, 0) }] },
  });
}

// A screenshot or screen recording (or any picture given a region) pushes slowly into its region
// while it holds (recipe.js); region: false keeps it still. Returns the picture's facts, or null.
function screenOf(ctx, picture, settings) {
  ctx.used.add("region");
  return picture && settings.region !== false && (settings.region || isScreen(picture)) ? picture : null;
}
const isScreen = (file) => (file.kind === "video" ? looksLikeScreenClip(file) : looksLikeScreen(file));
const isScreenClip = (file) => file.kind === "video" && looksLikeScreenClip(file);

// The most output px a file px before the hold's push (1.18x) takes it past soft_upscale's 1.3x.
const SHARP_MOST = 1.1;
const clampTo = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * A screen recording drawn at `scale` (output px a file px) inside `box`, panned so the middle of
 * `region` (% of the clip) sits as near the box's middle as covering it allows. Returns the clip's box.
 */
function panned(file, box, scale, region) {
  const [w, h] = [Math.round(file.width * scale), Math.round(file.height * scale)];
  const [mx, my] = [(w * (region[0] + region[2] / 2)) / 100, (h * (region[1] + region[3] / 2)) / 100];
  const x = Math.round(clampTo(box.x + box.width / 2 - mx, box.x + box.width - w, box.x));
  const y = Math.round(clampTo(box.y + box.height / 2 - my, box.y + box.height - h, box.y));
  return { box: { x, y, width: w, height: h } };
}

export const deviceSlide = {
  name: "device-slide",
  group: "promo",
  about: "a product picture slides in large (the hero), with an optional headline beside or above it",
  copy: [
    { key: "text", max: 60, about: "a headline beside the picture" },
    { key: "sub", max: 90, about: "a line under the headline" },
  ],
  media: "required",
  hero: true,
  slots: {},
  build(ctx, { copy, media, settings }) {
    const frame = ctx.frame;
    const safe = safeArea(frame);
    const portrait = isPortraitFrame(frame);
    const hasText = Boolean(copy.text || copy.sub);
    const wide = frame.width > frame.height * 1.2;
    // Where the words and the picture go. A slot given in the settings holds the picture.
    let textBox = null;
    let pictureBox;
    if (settings.slot) pictureBox = slotBox(frame, settings.slot);
    // A wide picture alone in a tall frame runs to the frame's sides, so it leads (promo_basics
    // wants a hero over 30% of the frame; inside the safe area a 16:10 shot covers about 21%).
    else if (!hasText && portrait && media[0].width > media[0].height) pictureBox = { x: 0, y: safe.y, width: frame.width, height: safe.height };
    else if (!hasText) pictureBox = slotBox(frame, "full");
    else if (wide) { textBox = slotBox(frame, "A2:B5"); pictureBox = slotBox(frame, "C1:F6"); }
    else {
      textBox = slotBox(frame, portrait ? "A1:F2" : "A1:F2");
      const top = textBox.y + textBox.height + px(ctx, 24);
      // In a tall frame the picture may run to the frame's sides so it is large enough to lead.
      pictureBox = portrait ? { x: 0, y: top, width: frame.width, height: Math.round(frame.height * 0.42) } : { x: safe.x, y: top, width: safe.width, height: safe.y + safe.height - top };
    }
    if (settings.slot && hasText) textBox = slotBox(frame, wide ? "A2:B5" : "A1:F2");
    let picture = imageLayer(ctx, { media: media[0], box: pictureBox, role: "hero", name: media[0].name ?? "Product" });
    // A screen recording drawn too small to read (screen_unreadable) becomes a window onto its busy
    // part, the clip inside drawn large enough to read. The playing clip is the window's motion: it holds still.
    let inside = null;
    // 6% past the bar, so a scene's own drift or a scale never takes it under.
    const need = isScreenClip(media[0]) && settings.region !== false ? Math.min(1.06 * readableClipWidth(media[0], frame), SHARP_MOST * media[0].width) : 0;
    if (need > picture.width * 1.05) {
      const pan = panned(media[0], picture, need / media[0].width, settings.region || media[0].busy || [30, 30, 40, 40]);
      inside = imageLayer(ctx, { media: media[0], box: pan.box, role: "decor", name: `${picture.name} (detail)` });
      picture = createLayer("group", { name: picture.name, x: picture.x, y: picture.y, width: picture.width, height: picture.height, clipContent: true, radius: px(ctx, 14), role: "hero" });
    }
    const align = wide ? "left" : "center";
    const head = copy.text ? textLayer(ctx, { part: "headline", text: copy.text, role: "headline", step: wide ? "h2" : headlineStep(copy.text), box: { ...textBox, height: textBox.height * (copy.sub ? 0.62 : 1) }, align, maxLines: wide ? 4 : 2 }) : null;
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "subhead", step: "body", box: { ...textBox, height: textBox.height * (copy.text ? 0.34 : 1) }, align, maxLines: 3 }) : null;
    if (textBox) column(textBox, [head && { layer: head }, sub && { layer: sub, gap: px(ctx, 24) }], { valign: wide ? "middle" : "bottom" });
    const pictureStyle = styleOf(ctx, settings, ["slide-left", "fade-up", "scale"]);
    // A picture that fills under 40% of the frame (a wide product in a tall frame) stands in a
    // soft pool of accent light, so it is not a small island on an empty frame.
    const glow = picture.width * picture.height < 0.4 * frame.width * frame.height ? stageLight(ctx, picture) : null;
    return {
      parts: [
        glow && { part: "light", layer: glow, enter: { style: "fade", at: 0, kind: "large" } },
        { part: null, layer: picture, enter: { style: pictureStyle, at: 0, kind: "large", easing: "hero" }, ...(inside ? { still: true } : { screen: screenOf(ctx, media[0], settings) }) },
        inside && { part: "detail", layer: inside, child: true, enter: { style: "scale", with: null, gap: 0, kind: "large", easing: "hero" } },
        // The words enter another way than the picture, so the parts never all fade up alike.
        head && { part: "headline", layer: head, enter: { style: pictureStyle === "fade-up" ? "lines" : "fade-up", with: null, gap: 0.25 } },
        sub && { part: "sub", layer: sub, enter: head ? { style: "fade-up", after: "headline", gap: -0.2 } : { style: "fade-up", with: null, gap: 0.3 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }],
    };
  },
};

export const featureCallout = {
  name: "feature-callout",
  group: "promo",
  about: "a card with an accent mark, a feature name and a line about it, and an optional picture; hero: true makes the card fill its slot as the scene's hero",
  copy: [
    { key: "text", required: true, max: 40, about: "the feature's name" },
    { key: "sub", max: 110, about: "a line about the feature" },
  ],
  media: "optional",
  slots: { landscape: "B2:E5", portrait: "A2:F5", square: "A2:F5" },
  build(ctx, { copy, box, media, settings }) {
    // hero: the card fills its slot (or the safe area, when the slot is under a third of the
    // frame) and is the scene's hero, for a promo with no product picture.
    ctx.used.add("hero");
    const hero = settings.hero === true;
    const frameArea = ctx.frame.width * ctx.frame.height;
    const heroBox = hero && box.width * box.height < 0.34 * frameArea ? safeArea(ctx.frame) : box;
    const pad = px(ctx, hero ? 72 : 52);
    const outer = hero ? heroBox : box;
    const inner = { x: outer.x + pad, y: outer.y + pad, width: outer.width - 2 * pad, height: outer.height - 2 * pad };
    const wide = inner.width > inner.height * 1.3;
    const pictureShare = media[0] ? 0.42 : 0;
    const pictureBox = media[0] ? (wide ? { ...inner, width: inner.width * pictureShare } : { ...inner, height: inner.height * pictureShare }) : null;
    const words = media[0]
      ? (wide ? { ...inner, x: inner.x + inner.width * pictureShare + px(ctx, 36), width: inner.width * (1 - pictureShare) - px(ctx, 36) } : { ...inner, y: inner.y + inner.height * pictureShare + px(ctx, 28), height: inner.height * (1 - pictureShare) - px(ctx, 28) })
      : inner;
    const picture = media[0] ? imageLayer(ctx, { media: media[0], box: pictureBox, name: media[0].name ?? "Feature picture" }) : null;
    const align = alignOf(ctx, settings, ["left"]);
    const mark = shapeLayer(ctx, { box: { x: words.x, y: 0, width: px(ctx, 64), height: Math.max(4, px(ctx, 8)) }, color: "accent", radius: px(ctx, 4), role: "decor", name: "Accent mark" });
    const title = textLayer(ctx, { part: "title", text: copy.text, role: "subhead", step: hero ? headlineStep(copy.text) : "h2", box: { ...words, height: words.height * (copy.sub ? 0.45 : 0.8) }, align, maxLines: 2 });
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "body", step: "body", box: { ...words, height: words.height * 0.45 }, align, maxLines: 4 }) : null;
    const stack = column(words, [{ layer: mark }, { layer: title, gap: px(ctx, 28) }, sub && { layer: sub, gap: px(ctx, 20) }], { valign: "middle" });
    const content = boundsOf([picture, mark, title, sub]);
    const card = hero
      ? shapeLayer(ctx, { box: heroBox, color: "surface", radius: px(ctx, 28), role: "hero", name: "Card", stroke: "accent", strokeWidth: Math.max(2, px(ctx, 3)) })
      : cardAround(ctx, { x: inner.x, y: Math.min(content.y, stack.y), width: inner.width, height: Math.max(content.height, stack.height) }, { pad: 52 });
    return {
      parts: [
        { part: null, layer: card, enter: { style: styleOf(ctx, settings, ["scale", "fade-up"]), at: 0, kind: "large" } },
        // A screenshot pushes into its region while the card drifts, never past the card's edge.
        picture && { part: "picture", layer: picture, enter: { style: "fade-up", with: null, gap: 0.15 }, screen: screenOf(ctx, media[0], settings), room: "card" },
        { part: "mark", layer: mark, enter: { style: "grow-x", after: null, gap: -0.2, kind: "small" } },
        { part: "title", layer: title, enter: { style: "fade-up", with: "mark", gap: 0.05 } },
        sub && { part: "sub", layer: sub, enter: { style: "fade-up", after: "title", gap: -0.15 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by", part: "title" }, { type: "inside_frame", part: "title" }],
    };
  },
};

// The text color that reads best on `fill`: the look's text or background color, or white or black.
function textOn(ctx, fill) {
  const luma = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a, b) => (Math.max(luma(a), luma(b)) + 0.05) / (Math.min(luma(a), luma(b)) + 0.05);
  const options = [ctx.style.colors.text, ctx.style.colors.bg, "#FFFFFF", "#0B0B0C"].filter((hex) => /^#[0-9a-f]{6}/i.test(hex ?? ""));
  return options.reduce((best, hex) => (contrast(hex, fill) > contrast(best, fill) + 0.5 ? hex : best));
}

export const callout = {
  name: "callout",
  group: "promo",
  about: "a focus box over footage: four corner brackets around box [x, y, w, h] (frame pixels; else the slot) and a label on a plate sized to it, above the box (below or inside when the safe area has no room). color: the plate (hex or a look color), corner: bracket length. It keeps still on what it marks",
  copy: [{ key: "text", required: true, max: 40, about: "the label, such as Keys found" }],
  slots: { landscape: "C2:D4", portrait: "B3:E4", square: "C2:D4" },
  // It marks a place in the footage, so it does not drift while it is read (no hold motion).
  still: true,
  build(ctx, { copy, box, settings }) {
    for (const key of ["box", "color", "corner"]) ctx.used.add(key);
    const target = settings.box ? { x: settings.box[0], y: settings.box[1], width: settings.box[2], height: settings.box[3] } : box;
    const { frame } = ctx;
    if (target.x + target.width <= 0 || target.y + target.height <= 0 || target.x >= frame.width || target.y >= frame.height)
      throw new Error(`callout box [${settings.box?.join(", ")}] is outside the ${frame.width}×${frame.height} frame.`);
    const safe = safeArea(frame);
    // Brackets: an L at each corner, two thin bars each, white so they read on any footage.
    const thick = Math.max(2, px(ctx, 4));
    const arm = Math.round(Math.min(settings.corner ?? Math.max(px(ctx, 24), Math.min(px(ctx, 96), Math.min(target.width, target.height) * 0.2)), Math.min(target.width, target.height) / 2));
    const [left, top, right, bottom] = [target.x, target.y, target.x + target.width, target.y + target.height];
    const bars = [
      ["tl-h", left, top, arm, thick], ["tl-v", left, top, thick, arm],
      ["tr-h", right - arm, top, arm, thick], ["tr-v", right - thick, top, thick, arm],
      ["bl-h", left, bottom - thick, arm, thick], ["bl-v", left, bottom - arm, thick, arm],
      ["br-h", right - arm, bottom - thick, arm, thick], ["br-v", right - thick, bottom - arm, thick, arm],
    ].map(([part, x, y, width, height]) => ({ part, layer: shapeLayer(ctx, { box: { x, y, width, height }, color: "#FFFFFF", radius: Math.floor(thick / 2), role: "decor", name: `Bracket ${part}` }) }));
    // The label is measured, and the plate is sized to it.
    const fill = paint(ctx.style, settings.color ?? "accent");
    if (!/^#[0-9a-f]{6}/i.test(fill)) throw new Error(`callout color "${settings.color}" is not a hex color or one of the look's colors (${Object.keys(ctx.style.colors).join(", ")}).`);
    const [padX, padY, gap] = [px(ctx, 18), px(ctx, 8), px(ctx, 12)];
    const label = textLayer(ctx, { part: "label", text: copy.text, role: "label", step: "label", box: { x: 0, y: 0, width: safe.width - 2 * padX, height: frame.height * 0.2 }, align: "left", color: textOn(ctx, fill), maxLines: 1, weight: 600 });
    label.width = textWidth(ctx, label) + 6;
    const plate = shapeLayer(ctx, { box: { x: 0, y: 0, width: label.width + 2 * padX, height: label.height + 2 * padY }, color: fill, radius: px(ctx, 10), role: "decor", name: "Label plate" });
    // Above the box; below it when the safe area has no room above; else inside its top.
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const above = top - gap - plate.height;
    const below = bottom + gap;
    const inside = above < safe.y && below + plate.height > safe.y + safe.height;
    plate.y = Math.round(above >= safe.y ? above : !inside ? below : clamp(top + thick + gap, safe.y, safe.y + safe.height - plate.height));
    plate.x = Math.round(clamp(inside ? left + thick + gap : left, safe.x, safe.x + safe.width - plate.width));
    label.x = plate.x + padX;
    label.y = plate.y + padY;
    const bounds = boundsOf([...bars.map((bar) => bar.layer), plate]);
    const group = createLayer("group", { name: `Callout: ${copy.text}`, ...bounds });
    return {
      parts: [
        // The box locks on (lands from larger), then the plate grows out and the label fades in.
        { part: null, layer: group, enter: { style: styleOf(ctx, settings, ["slam", "scale"]), at: 0, kind: "medium" }, exit: "fade" },
        ...bars.map((bar) => ({ ...bar, child: true, enter: { style: "fade", with: null, gap: 0, kind: "small" } })),
        { part: "plate", layer: plate, child: true, enter: { style: "grow-x", after: null, gap: -0.1, kind: "small" } },
        { part: "label", layer: label, child: true, enter: { style: "fade", after: "plate", gap: -0.12 } },
      ],
      assertions: [{ type: "visible_by", part: "label" }, { type: "inside_frame", part: "label" }],
    };
  },
};

export const pricePop = {
  name: "price-pop",
  group: "promo",
  about: "a price pops in large in the accent colour, with a label chip above and a line under it",
  copy: [
    { key: "price", required: true, max: 16, about: "the price, such as $29 or €9/mo" },
    { key: "text", max: 48, about: "what the price buys" },
    { key: "label", max: 24, about: "a chip above the price, such as Launch price" },
  ],
  slots: { landscape: "B2:E5", portrait: "A1:F4", square: "A2:F5" },
  build(ctx, { copy, box, settings }) {
    if (!/\d/.test(copy.price)) throw new Error("price-pop: copy.price needs a number, such as $29.");
    const align = alignOf(ctx, settings, ["center", "left"]);
    const chip = copy.label ? pillWithText(ctx, { text: copy.label, role: "caption", step: "label", box: { ...box, height: box.height * 0.18 }, padX: 30, padY: 12, uppercase: true }) : null;
    const price = textLayer(ctx, { part: "price", text: copy.price, role: "headline", step: "display", size: Math.round(ctx.style.type.display * 1.25), box: { ...box, height: box.height * 0.5 }, align, color: "accent", maxLines: 1 });
    const line = copy.text ? textLayer(ctx, { part: "text", text: copy.text, role: "subhead", step: "body", box: { ...box, height: box.height * 0.25 }, align, maxLines: 2 }) : null;
    column(box, [chip && { layer: chip.pill }, { layer: price, gap: px(ctx, 24) }, line && { layer: line, gap: px(ctx, 20) }], { valign: "middle" });
    if (chip) {
      chip.label.y = chip.pill.y + px(ctx, 12);
      const dx = align === "center" ? box.x + (box.width - chip.pill.width) / 2 - chip.pill.x : 0;
      shiftX([chip.pill, chip.label], dx);
    }
    return {
      parts: [
        // The price comes first (people read the headline first); the chip lands just after.
        { part: null, layer: price, enter: { style: "pop", at: 0, kind: "headline" } },
        line && { part: "text", layer: line, enter: { style: "fade-up", after: null, gap: -0.15 } },
        chip && { part: "chip", layer: chip.pill, enter: line ? { style: "scale", with: "text", gap: 0, kind: "small" } : { style: "scale", with: null, gap: 0.18, kind: "small" } },
        chip && { part: "label", layer: chip.label, enter: { style: "fade", with: "chip", gap: 0 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const ctaEnd = {
  name: "cta-end",
  group: "promo",
  about: "the call to action in an accent button, with an optional address or line under it, over the video's own shot (media: it fills the frame, dimmed, and pushes in; blurred if too small to stay sharp); it stays to the end",
  copy: [
    { key: "text", required: true, max: 28, about: "the call to action, such as Start free" },
    { key: "sub", max: 48, about: "an address or a short line, such as kino.app" },
  ],
  media: "optional",
  slots: { landscape: "B3:E5", portrait: "A2:F4", square: "A2:F5" },
  build(ctx, { copy, box, media }) {
    const { pill, label } = pillWithText(ctx, { text: copy.text, role: "cta", step: "h2", box: { ...box, height: box.height * 0.45 }, padX: 56, padY: 26 });
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "cta", step: "body", box: { ...box, height: box.height * 0.25 }, align: "center", maxLines: 2 }) : null;
    column(box, [{ layer: pill }, sub && { layer: sub, gap: px(ctx, 34) }], { valign: "middle" });
    shiftX([pill, label], box.x + (box.width - pill.width) / 2 - pill.x);
    label.y = pill.y + px(ctx, 26);
    // The end over the video's own shot (template_end): it fills the frame, dimmed, and pushes in.
    const file = media[0] ?? null;
    const behind = file ? fullFrame(ctx, file) : [];
    return {
      parts: [
        ...behind,
        { part: "button", layer: pill, enter: { style: "scale", at: file ? 0.2 : 0, kind: "medium" } },
        { part: null, layer: label, enter: { style: "fade-up", with: "button", gap: 0.08 } },
        sub && { part: "sub", layer: sub, enter: { style: "fade-up", after: null, gap: -0.1 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};


/**
 * A picture or clip covering the frame under a dim veil, as recipe parts; it pushes into its middle
 * (a screen's busy part) while it holds. A screen recording is drawn large enough to read; a file
 * too small to cover the frame sharp is blurred into a backdrop instead of drawn soft.
 */
function fullFrame(ctx, file) {
  const { frame } = ctx;
  const [width, height] = [file.width || frame.width, file.height || frame.height];
  const sized = { ...file, width, height };
  const cover = Math.max(frame.width / width, frame.height / height);
  const scale = Math.max(cover, isScreenClip(sized) ? readableClipWidth(sized, frame) / width : 0);
  const region = isScreen(sized) && Array.isArray(file.busy) ? file.busy : [35, 35, 30, 30];
  const { box } = panned(sized, { x: 0, y: 0, width: frame.width, height: frame.height }, scale, region);
  const shot = imageLayer(ctx, { media: file, box, role: "background", name: file.name ?? "Shot" });
  // It pushes about the frame's middle (the region is panned there), so no corner travels fast.
  const focus = [(100 * (frame.width / 2 - box.x)) / box.width, (100 * (frame.height / 2 - box.y)) / box.height, 0, 0];
  if (file.width > 0 && scale > SHARP_MOST) shot.blur = Math.max(18, px(ctx, 24));
  // Under half opaque, so the shot still reads through it.
  const veil = shapeLayer(ctx, { box: { x: 0, y: 0, width: frame.width, height: frame.height }, color: "#0B0B0C73", role: "decor", name: "Dim" });
  return [
    { part: "shot", layer: shot, enter: { style: "fade", at: 0, kind: "large" }, screen: file, focus, still: true, exit: "fade" },
    { part: "dim", layer: veil, enter: { style: "fade", with: "shot", gap: 0, kind: "large" }, still: true, exit: "fade" },
  ];
}

// A UI detail lift: a screenshot fills the frame and the camera pushes into
// one region of it while the rest dims and softens and the region lifts a little on a shadow.
export const screenDetail = {
  name: "screen-detail",
  group: "promo",
  about: "a screenshot fills the frame; the camera pushes into one region (region [x, y, w, h] in % of the picture, else its busiest part) while the rest dims and blurs and the region lifts slightly",
  copy: [],
  media: "required",
  hero: true,
  slots: {},
  // Its parts keep still apart from the push (recipe.js), so the lifted copy stays on its region.
  still: true,
  hold: 1.6,
  build(ctx, { media, settings }) {
    ctx.used.add("region");
    const { frame } = ctx;
    const file = media[0];
    const region = settings.region || file.busy || [30, 30, 40, 40];
    // The picture covers the frame (its edges leave the frame as it pushes in).
    const cover = Math.max(frame.width / file.width, frame.height / file.height);
    const [w, h] = [Math.round(file.width * cover), Math.round(file.height * cover)];
    // It pans so the region's middle is as near the frame's middle as the cover allows (a wide
    // screen in a tall frame shows the part that matters), and the lifted part stays in the safe area.
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const shot = {
      x: Math.round(clamp(frame.width / 2 - (w * (region[0] + region[2] / 2)) / 100, frame.width - w, 0)),
      y: Math.round(clamp(frame.height / 2 - (h * (region[1] + region[3] / 2)) / 100, frame.height - h, 0)), width: w, height: h,
    };
    const picture = createLayer("image", { name: file.name ?? "Screen", src: file.src, ...shot, role: "hero" });
    const safe = safeArea(frame);
    const x0 = clamp(shot.x + (w * region[0]) / 100, safe.x, safe.x + safe.width - 40);
    const y0 = clamp(shot.y + (h * region[1]) / 100, safe.y, safe.y + safe.height - 40);
    const x1 = clamp(shot.x + (w * (region[0] + region[2])) / 100, x0 + 40, safe.x + safe.width);
    const y1 = clamp(shot.y + (h * (region[1] + region[3])) / 100, y0 + 40, safe.y + safe.height);
    const box = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    // The lifted card and its shadow push about the same point as the picture (the region's
    // middle, even when the card is held inside the safe area), so the lifted copy stays on it.
    const middle = [shot.x + (w * (region[0] + region[2] / 2)) / 100, shot.y + (h * (region[1] + region[3] / 2)) / 100];
    const focus = [(100 * (middle[0] - box.x)) / box.width, (100 * (middle[1] - box.y)) / box.height, 0, 0];
    const veil = shapeLayer(ctx, { box: { x: 0, y: 0, width: frame.width, height: frame.height }, color: "#0B0B0C99", role: "decor", name: "Dim" });
    const radius = px(ctx, 14);
    const lift = 1.06;
    const plate = shapeLayer(ctx, { box, color: "#000000", radius, role: "decor", name: "Lift shadow" });
    Object.assign(plate, { scaleX: lift, scaleY: lift, shadow: { color: "#00000099", x: 0, y: px(ctx, 24), blur: px(ctx, 64) } });
    const card = createLayer("group", { name: "Detail", ...box, clipContent: true, radius, scaleX: lift, scaleY: lift, role: "decor" });
    const copy = createLayer("image", { name: "Detail picture", src: file.src, ...shot, role: "decor" });
    const grow = { kind: "custom", easing: [0.16, 1, 0.3, 1], from: { scaleX: 1, scaleY: 1 }, to: { scaleX: lift, scaleY: lift } };
    const soft = { kind: "custom", easing: [0.45, 0, 0.55, 1], from: { blur: 0 }, to: { blur: px(ctx, 12) } };
    return {
      parts: [
        // Every part fades out in place over about the same time, so nothing slips off its region
        // and the bright card does not blink out before the picture (luma_jump).
        { part: "screen", layer: picture, enter: { style: "scale", at: 0, kind: "large" }, screen: file, focus: region, exit: "fade" },
        { part: "dim", layer: veil, enter: { style: "fade", after: "screen", gap: 0.35, kind: "large" } },
        { part: "shadow", layer: plate, enter: { style: "fade", with: "dim", gap: 0, kind: "large" }, screen: file, focus },
        { part: null, layer: card, enter: { style: "fade", with: "dim", gap: 0, kind: "large" }, screen: file, focus },
        { part: "detail", layer: copy, child: true, enter: { style: "fade", with: null, gap: 0, kind: "small" } },
      ],
      extras: [
        { part: "screen", name: "soften", with: "dim", gap: 0, animation: { ...soft, name: "Soften", duration: 1 } },
        { part: "shadow", name: "lift", with: "shadow", gap: 0, animation: { ...grow, name: "Lift", duration: 0.6 } },
        { part: null, name: "lift", with: null, gap: 0, animation: { ...grow, name: "Lift", duration: 0.6 } },
      ],
      assertions: [{ type: "visible_by" }],
    };
  },
};

export const PROMO_RECIPES = [logoSting, headlineReveal, deviceSlide, featureCallout, screenDetail, callout, pricePop, ctaEnd];
