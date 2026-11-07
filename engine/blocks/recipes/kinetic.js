// Logo and kinetic-type recipes: logo-build, wordmark-type, word-stack, split-reveal.
import { alignIn, column, imageLayer, shapeLayer, textLayer, textWidth } from "../build.js";
import { alignOf, headlineStep, px, styleOf } from "./common.js";

export const logoBuild = {
  name: "logo-build",
  group: "kinetic",
  about: "an accent ring draws round, the logo pops into it, then an optional name rises under it",
  copy: [{ key: "text", max: 24, about: "the brand's name under the logo" }],
  media: "optional",
  slots: { landscape: "B1:E6", portrait: "A1:F5", square: "A1:F6" },
  build(ctx, { copy, box, media }) {
    const picture = media[0] ?? ctx.logo?.media ?? null;
    if (!picture) throw new Error("logo-build needs a logo picture (media, or a brand with a logo picture). For a text logo use wordmark-type.");
    const size = Math.round(Math.min(box.width * 0.8, box.height * (copy.text ? 0.6 : 0.8)));
    const ring = shapeLayer(ctx, { type: "ellipse", box: { x: 0, y: 0, width: size, height: size }, color: "accent", role: "decor", name: "Ring", stroke: "accent", strokeWidth: Math.max(3, px(ctx, 8)) });
    ring.fillEnabled = false;
    const name = copy.text ? textLayer(ctx, { part: "name", text: copy.text, role: "logo", step: "h1", box: { ...box, height: box.height * 0.25 }, align: "center", maxLines: 1 }) : null;
    column(box, [{ layer: ring }, name && { layer: name, gap: px(ctx, 40) }], { valign: "middle" });
    alignIn(ring, box, "center");
    const inside = Math.round(size * 0.56);
    const logo = imageLayer(ctx, { media: picture, box: { x: ring.x + (size - inside) / 2, y: ring.y + (size - inside) / 2, width: inside, height: inside }, role: "logo", name: "Logo" });
    return {
      parts: [
        { part: "ring", layer: ring, enter: { style: "draw", at: 0, kind: "headline" } },
        { part: null, layer: logo, enter: { style: "pop", after: "ring", gap: -0.25, kind: "logo" } },
        name && { part: "name", layer: name, enter: { style: "rise", after: null, gap: -0.1 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const wordmarkType = {
  name: "wordmark-type",
  group: "kinetic",
  about: "a wordmark types on letter by letter, then an accent cursor appears after it",
  copy: [{ key: "text", required: true, max: 24, about: "the wordmark" }],
  slots: { landscape: "A2:F5", portrait: "A2:F5", square: "A2:F5" },
  build(ctx, { copy, box }) {
    const word = textLayer(ctx, { part: "word", text: copy.text, role: "logo", step: "display", box: { ...box, width: box.width * 0.9, x: box.x + box.width * 0.05 }, align: "center", valign: "middle", maxLines: 1 });
    const used = textWidth(ctx, word);
    const height = Math.round(word.fontSize * 0.86);
    const cursor = shapeLayer(ctx, { box: { x: word.x + (word.width + used) / 2 + px(ctx, 12), y: word.y + (word.height - height) / 2, width: Math.max(4, px(ctx, 12)), height }, color: "accent", role: "decor", name: "Cursor" });
    return {
      parts: [
        { part: null, layer: word, enter: { style: "type", at: 0 } },
        { part: "cursor", layer: cursor, enter: { style: "fade", after: null, gap: -0.05, kind: "small" } },
      ],
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const wordStack = {
  name: "word-stack",
  group: "kinetic",
  about: "2 to 5 words stack up one line each, sliding in from alternate sides; the last is in the accent colour",
  copy: [{ key: "words", required: true, list: 5, min: 2, max: 16, about: "the words, one per line" }],
  slots: { landscape: "A1:F6", portrait: "A1:F5", square: "A1:F6" },
  build(ctx, { copy, box, settings }) {
    const align = alignOf(ctx, settings, ["left", "center"]);
    const words = copy.words;
    const gap = px(ctx, 8);
    const share = { ...box, height: (box.height - gap * (words.length - 1)) / words.length };
    const size = Math.min(...words.map((word) => textLayer(ctx, { part: "word", text: word, role: "headline", step: "display", size: Math.round(ctx.style.type.display * 1.2), box: share, align, maxLines: 1, uppercase: true }).fontSize));
    const layers = words.map((word, index) => textLayer(ctx, { part: `word-${index + 1}`, text: word, role: "headline", step: "display", size, box: share, align, maxLines: 1, uppercase: true, color: index === words.length - 1 ? "accent" : "text" }));
    column(box, layers.map((layer) => ({ layer })), { gap, valign: "middle" });
    const firstSide = ctx.rng.next() < 0.5 ? "slide-left" : "slide-right";
    const nudges = [0, 0.2, -0.1, 0.3, 0.1];
    return {
      parts: layers.map((layer, index) => {
        const last = index === layers.length - 1;
        const side = index % 2 === 0 ? firstSide : firstSide === "slide-left" ? "slide-right" : "slide-left";
        const enter = index === 0 ? { style: side, at: 0, kind: "headline" } : { style: last ? "slam" : side, after: index === 1 ? null : `word-${index}`, gap: -0.28, kind: "headline", nudge: nudges[index] };
        return { part: index === 0 ? null : `word-${index + 1}`, layer, enter };
      }),
      assertions: [{ type: "visible_by", part: `word-${words.length}` }, { type: "inside_frame" }, { type: "before", other: `word-${words.length}` }],
    };
  },
};

export const splitReveal = {
  name: "split-reveal",
  group: "kinetic",
  about: "an accent line draws out from the middle; the headline rises above it and an optional line drops below it",
  copy: [
    { key: "text", required: true, max: 32, about: "the headline above the line" },
    { key: "sub", max: 48, about: "a line under it" },
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F5", square: "A1:F6" },
  build(ctx, { copy, box, settings }) {
    const head = textLayer(ctx, { part: "headline", text: copy.text, role: "headline", step: headlineStep(copy.text), box: { ...box, height: box.height * (copy.sub ? 0.55 : 0.7) }, align: "center", maxLines: 2 });
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "subhead", step: "body", box: { ...box, height: box.height * 0.25 }, align: "center", maxLines: 2 }) : null;
    const line = shapeLayer(ctx, { box: { x: 0, y: 0, width: Math.round(box.width * 0.86), height: Math.max(4, px(ctx, 6)) }, color: "accent", radius: px(ctx, 3), role: "decor", name: "Split line" });
    column(box, [{ layer: head }, { layer: line, gap: px(ctx, 30) }, sub && { layer: sub, gap: px(ctx, 30) }], { valign: "middle" });
    alignIn(line, box, "center");
    return {
      parts: [
        { part: "line", layer: line, enter: { style: "grow-x", anchor: "center", at: 0, kind: "medium" } },
        { part: null, layer: head, enter: { style: styleOf(ctx, settings, ["fade-up", "rise"]), with: "line", gap: 0.18 } },
        sub && { part: "sub", layer: sub, enter: { style: "fade-down", with: null, gap: 0.12 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

// A title card (the most used title layout in social templates): a small kicker
// line above, big centered tight uppercase type that types on by letter (enter "type") or by
// word (enter "rise"), and a detail line below that fades up once the title is written.
export const titleType = {
  name: "title-type",
  group: "kinetic",
  about: "a small kicker above, a big centered tight uppercase title typing on by letter or word, a detail line below",
  copy: [
    { key: "text", required: true, max: 32, about: "the title" },
    { key: "kicker", max: 24, about: "a small line above the title" },
    { key: "sub", max: 60, about: "a detail line under the title" },
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F5", square: "A1:F6" },
  build(ctx, { copy, box, settings }) {
    const kicker = copy.kicker ? textLayer(ctx, { part: "kicker", text: copy.kicker, role: "caption", step: "label", box: { ...box, height: box.height * 0.12 }, align: "center", maxLines: 1, uppercase: true, weight: 600 }) : null;
    const head = textLayer(ctx, { part: "headline", text: copy.text, role: "headline", step: "display", size: Math.round(ctx.style.type.display * 1.15), box: { ...box, height: box.height * (copy.sub ? 0.55 : 0.7) }, align: "center", maxLines: 2, uppercase: true, lineHeight: 0.95 });
    // Tight tracking reads as condensed type in any family (a condensed brand font is tighter still).
    head.letterSpacing = -2;
    const sub = copy.sub ? textLayer(ctx, { part: "sub", text: copy.sub, role: "subhead", step: "body", box: { ...box, height: box.height * 0.22 }, align: "center", maxLines: 2 }) : null;
    column(box, [kicker && { layer: kicker }, { layer: head, gap: px(ctx, 18) }, sub && { layer: sub, gap: px(ctx, 28) }], { valign: "middle" });
    const enter = styleOf(ctx, settings, ["type", "rise"]);
    return {
      parts: [
        kicker && { part: "kicker", layer: kicker, enter: { style: "fade-down", at: 0 } },
        { part: null, layer: head, enter: kicker ? { style: enter, after: "kicker", gap: -0.2 } : { style: enter, at: 0 } },
        sub && { part: "sub", layer: sub, enter: { style: "fade-up", after: null, gap: 0.05 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }, ...(sub ? [{ type: "before", other: "sub" }] : [])],
    };
  },
};

export const KINETIC_RECIPES = [logoBuild, wordmarkType, wordStack, splitReveal, titleType];
