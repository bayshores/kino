// word-panel: a word set on a made object instead of over the picture as a caption.
//
// Bar edits place the hook word as a thing in the shot (subaru-aura bar studies): a road sign in
// a TV set ("TRUST", 16.0 s, a stencil word on a diamond sign turned about -20 degrees), a rotated
// serif word on a black editorial panel (6.38 s, turned 90 degrees), a poster word behind the
// subject (19.42 s), "Earth" inside a planet disc (7.30 s). They come on with the cut and leave with
// it or slide off. This move builds the panel part: a made shape (a box, a sign with a border, a
// strip across the frame) sized from the word's own laid-out box plus a printed padding, word and
// panel in one group turned together. With subject the group stands between the clip and its
// cut-out (the edit makes the cut-out or reuses one), and the receipt gives the share of each
// letter the subject's box covers (the cut-out's measured subjectPath), as facts.
//
// Every value kino picks is printed with where it came from: the panel color from the shot's
// measured hue (or its grade), else the look's accent; the turn and padding are starting guesses
// (seeded), said so in the notes. Nothing here runs unless the agent names the move.
import { createLayer } from "../../model.js";
import { layoutText, resizeTextLayer, textUnits } from "../../textLayout.js";
import { hslToHex, shotHue } from "./backdrop.js";
import { CURVES, contrast, hide, motion, round, show } from "./kit.js";

const SHAPES = ["box", "sign", "strip"];
// Starting guesses (not measured): padding in font sizes across and up/down, and the turn range.
const PAD_X = 0.3;
const PAD_Y = 0.18;
const TURN = [3, 9];
const COVERED = 0.6;
const STEP = 1 / 30;

/**
 * The share of each letter's box the subject's box covers, worst over [from, to]:
 * letters [{text, box: [x, y, w, h]}] in scene px; path [[t, x0, y0, x1, y1]] in shares of `layer`
 * (cutout-operation.mjs subjectPath). Returns [{text, share, at}] (share 0 to 1, at the scene
 * second of the worst sample), or null when there is no path.
 */
export function letterCover(letters, path, layer, from, to) {
  if (!Array.isArray(path) || !path.length) return null;
  const inside = path.filter(([t]) => t >= from - 1e-6 && t <= to + 1e-6);
  const samples = inside.length ? inside : [path.reduce((best, sample) => (Math.abs(sample[0] - from) < Math.abs(best[0] - from) ? sample : best), path[0])];
  return letters.map(({ text, box: [x, y, w, h] }) => {
    let worst = { share: 0, at: samples[0][0] };
    for (const [t, x0, y0, x1, y1] of samples) {
      const sx0 = layer.x + x0 * layer.width, sx1 = layer.x + x1 * layer.width;
      const sy0 = layer.y + y0 * layer.height, sy1 = layer.y + y1 * layer.height;
      const overlap = Math.max(0, Math.min(x + w, sx1) - Math.max(x, sx0)) * Math.max(0, Math.min(y + h, sy1) - Math.max(y, sy0));
      const share = w * h > 0 ? overlap / (w * h) : 0;
      if (share > worst.share) worst = { share, at: t };
    }
    return { text, share: round(worst.share, 2), at: round(worst.at, 2) };
  });
}

/** Each drawn letter of a laid-out text layer as {text, box} in scene px, turned `turn` degrees about `pivot`. */
function letterBoxes(word, fonts, turn, pivot) {
  const layout = layoutText(word, fonts);
  const cos = Math.cos((turn * Math.PI) / 180), sin = Math.sin((turn * Math.PI) / 180);
  return textUnits(layout, "letters").filter((unit) => unit.text.trim() && unit.glyphs.length).map((unit) => {
    const line = layout.lines[unit.lineIndex];
    const left = Math.min(...unit.glyphs.map((glyph) => glyph.x)), right = Math.max(...unit.glyphs.map((glyph) => glyph.x + (glyph.advance ?? 0)));
    const top = line.y - line.ascent, height = line.ascent + line.descent;
    // The letter's center turned with the group; its size kept (a box check, not the drawn outline).
    const cx = word.x + (left + right) / 2 - pivot[0], cy = word.y + top + height / 2 - pivot[1];
    const tx = pivot[0] + cx * cos - cy * sin, ty = pivot[1] + cx * sin + cy * cos;
    const w = right - left;
    return { text: unit.text, box: [tx - w / 2, ty - height / 2, w, height] };
  });
}

/** The first time after `start` a layer stops showing (checked a frame at a time), or the scene's end. */
function shownUntil(ctx, layerId, start) {
  for (let time = start + STEP; time < ctx.sceneDuration; time += STEP) if (!ctx.shownAt(layerId, time)) return round(time, 3);
  return round(ctx.sceneDuration, 3);
}

export const wordPanel = {
  name: "word-panel",
  needsAt: true,
  about: "your word set on a made object: a turned box, a sign with a border or a strip across the frame, sized from the word's own laid-out box, word and panel turned together as one group; with subject the group stands behind the person (the clip's cut-out, made or reused) and the receipt gives each letter's covered share",
  fits: "a hook word that belongs to the shot as a thing (a sign, a label, a plate, a word behind the subject), not a caption over it",
  tags: ["type-cut"],
  length: 1.2,
  shortest: 0.2,
  fields: {
    textLayer: { kind: "layer", required: true, about: "your text layer: its words, font, size and place; hidden while the move draws it on the panel" },
    shape: { kind: "choice", values: SHAPES, about: "box: a filled box; sign: a box with a border in the word's color; strip: a band across the frame through the word (default: the seed picks)" },
    turn: { kind: "number", low: -90, high: 90, about: "degrees the word and panel turn together (default: the seed picks 3 to 9 either way, a starting guess)" },
    pad: { kind: "number", low: 0, high: 2, about: "room around the word's box in font sizes across (up and down is 0.6 of it; default 0.3, a starting guess)" },
    color: { kind: "color", auto: true, about: "the panel's color (default auto: the hue measured on layer's picture or its grade, else the look's accent)" },
    ink: { kind: "color", about: "the word's color on the panel (default: of your text's color and the look's text and background colors, the one with the most contrast on the panel)" },
    layer: { kind: "layer", about: "the shot the panel belongs to: its measured hue colors the panel, and with no dur the panel leaves when the shot does" },
    subject: { kind: "layer", cutout: { of: "layer" }, about: "the subject cut-out of layer (or the clip itself: the edit cuts it out or reuses its cut-out): the panel goes between them" },
    enter: { kind: "choice", values: ["cut", "slam"], about: "cut: on at once with the move (default); slam: lands from 1.25x over 0.18 s. Reduced motion fades it on" },
  },
  example: { textLayer: "prompt", shape: "sign", at: 0.5, dur: 1.2 },
  setup: "prompt, a text layer (for subject: layer, a full-frame clip, and subject: the clip)",
  build(ctx, input) {
    const yours = ctx.layer(input.textLayer, "textLayer");
    if (yours.type !== "text") throw new Error(`word-panel textLayer: ${yours.id} is a ${yours.type}; give a text layer.`);
    const shot = input.layer ? ctx.layer(input.layer, "layer") : null;
    const subject = input.subject ? ctx.layer(input.subject, "subject") : null;
    if (subject && shot && ctx.order(subject.id) < ctx.order(shot.id)) throw new Error(`word-panel subject: ${subject.id} is under ${shot.id}; the cut-out must be above the clip (cut_out puts it there).`);
    const t = ctx.start;
    const end = ctx.dur === null && shot && ctx.shownAt(shot.id, t) ? shownUntil(ctx, shot.id, t) : ctx.end;
    if (shot && ctx.dur === null) ctx.note(`leaves at ${end} s, where ${shot.id} stops showing (send dur to choose)`);

    // The word as laid out: its box is what the panel is sized from.
    const { id: _id, name: _name, animations: _own, move: _move, parentId: _parent, pin: _pin, ...look } = resizeTextLayer(yours, ctx.fonts);
    const fontSize = look.fontSize ?? 40;
    const shapePick = ctx.rng.pick(SHAPES);
    const turnPick = round(ctx.rng.between(TURN[0], TURN[1]) * (ctx.rng.next() < 0.5 ? -1 : 1), 1);
    const shape = input.shape ?? shapePick;
    const turn = input.turn ?? turnPick;
    const padShare = input.pad ?? PAD_X;
    const padX = Math.round(fontSize * padShare), padY = Math.round(fontSize * padShare * (PAD_Y / PAD_X));
    const wordBox = { x: look.x, y: look.y, width: look.width, height: look.height };
    const center = [wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2];
    // A strip runs past both edges of the frame however it turns (the frame's diagonal and some).
    const reach = Math.ceil(Math.hypot(ctx.frame.width, ctx.frame.height) * 1.1);
    const panelBox = shape === "strip"
      ? { x: Math.round(center[0] - reach / 2), y: Math.round(wordBox.y - padY), width: reach, height: Math.round(wordBox.height + 2 * padY) }
      : { x: Math.round(wordBox.x - padX), y: Math.round(wordBox.y - padY), width: Math.round(wordBox.width + 2 * padX), height: Math.round(wordBox.height + 2 * padY) };

    // Colors: measured from the shot when it has a hue, else the look's accent; printed either way.
    let panelColor = typeof input.color === "string" && input.color !== "auto" ? input.color : null;
    let colorFrom = panelColor ? "your color" : null;
    if (!panelColor) {
      const found = shot ? shotHue(ctx, shot) : null;
      panelColor = found ? hslToHex({ h: found.hue, s: 0.7, l: 0.5 }) : ctx.color("panel", "accent");
      colorFrom = found ? `${shot.id}'s hue from ${found.from} (${Math.round(found.hue)}°) at saturation 0.7, lightness 0.5 (a guess)` : `the look's accent${shot ? ` (no hue measured on ${shot.id})` : ""}`;
    }
    const inks = [input.ink, look.fill, ctx.style.colors.text, ctx.style.colors.bg].filter((color) => typeof color === "string" && /^#[0-9a-f]{6}/i.test(color));
    const ink = input.ink ?? inks.reduce((best, color) => (contrast(color, panelColor) > contrast(best, panelColor) ? color : best), inks[0]);
    ctx.note(`panel ${shape} ${panelBox.width}x${panelBox.height} px: the word's box ${Math.round(wordBox.width)}x${Math.round(wordBox.height)} px plus ${padX} px across and ${padY} px up and down (pad ${padShare} of the ${fontSize} px font${input.pad === undefined ? ", a starting guess" : ""})`);
    ctx.note(`panel color ${panelColor}: ${colorFrom}; word ${ink} at ${round(contrast(ink, panelColor), 2)}:1 on it`);
    ctx.note(`turned ${turn}°${input.turn === undefined ? " (seed pick, a starting guess)" : ""}`);

    // One group, turned about its own center, holding the panel and the word.
    const groupBox = panelBox;
    const place = subject ? { below: subject.id } : { above: yours.id };
    const group = ctx.add("group", createLayer("group", { name: "Word panel", ...groupBox, rotation: turn, role: "decor", allowOverlap: true }), place);
    const border = shape === "sign" ? Math.max(2, Math.round(fontSize * 0.07)) : 0;
    ctx.add("panel", createLayer("rectangle", { name: "Panel", x: 0, y: 0, width: groupBox.width, height: groupBox.height, fill: panelColor,
      radius: shape === "sign" ? Math.round(fontSize * 0.12) : 0, stroke: ink, strokeWidth: border, role: "decor", allowOverlap: true }), "top", group);
    ctx.add("word", { ...look, x: round(wordBox.x - groupBox.x, 1), y: round(wordBox.y - groupBox.y, 1), fill: ink, rotation: 0, role: yours.role ?? "headline", allowOverlap: true }, "top", group);

    // Yours is hidden while the move draws it, and back after if it showed then.
    const back = ctx.shownAt(yours.id, end);
    ctx.animate(yours.id, "hide", hide(t), "textLayer");
    if (back) ctx.animate(yours.id, "show", show(end), "textLayer");

    const tags = ["type-cut"];
    if (ctx.reduced) ctx.animate(group, "in", motion({ name: "Fade in", kind: "in", start: t, duration: Math.min(0.2, (end - t) / 3), easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    else if (input.enter === "slam") {
      const grown = { x: groupBox.x - groupBox.width * 0.125, y: groupBox.y - groupBox.height * 0.125 };
      ctx.animate(group, "in", motion({ name: "Slam", kind: "in", start: t, duration: Math.min(0.18, (end - t) / 2), easing: CURVES.arrive,
        from: { opacity: 0, x: round(grown.x, 1), y: round(grown.y, 1), scaleX: 1.25, scaleY: 1.25 }, to: { opacity: 1, x: groupBox.x, y: groupBox.y, scaleX: 1, scaleY: 1 } }));
      tags.splice(0, 1, "type-pop");
    } else ctx.animate(group, "in", motion({ name: "Cut on", kind: "in", start: t, duration: 0.001, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(group, "hide", hide(end));

    if (subject) {
      tags.push("type-behind");
      const covered = letterCover(letterBoxes(look, ctx.fonts, turn, [groupBox.x + groupBox.width / 2, groupBox.y + groupBox.height / 2]), subject.subjectPath, subject, t, end);
      if (covered) {
        ctx.note(`covered by ${subject.id}'s box (worst moment per letter): ${covered.map((letter) => `${letter.text} ${Math.round(letter.share * 100)}%`).join(", ")}`);
        const hidden = covered.filter((letter) => letter.share > COVERED);
        if (hidden.length) ctx.note(`over ${COVERED * 100}% covered: ${hidden.map((letter) => `${letter.text} at ${letter.at} s`).join(", ")}`);
      } else ctx.note(`${subject.id} has no measured subject box, so the covered share is not known (look at the frames)`);
    }
    return { end, tags };
  },
};
