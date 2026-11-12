// word-panel: a word set on a made object instead of over the picture as a caption.
//
// Reference edits place the hook word as a thing in the shot (studied frame by frame): a road sign in
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
import { cutoutShares } from "../../subjectRoom.js";
import { enabledAnimations } from "../../animationEnabled.js";
import { fileSecond, headsNear } from "./silhouette.js";

const SHAPES = ["box", "sign", "strip"];
// Starting guesses (not measured): padding in font sizes across and up/down, and the turn range.
const PAD_X = 0.3;
const PAD_Y = 0.18;
const TURN = [3, 9];
const COVERED = 0.6;
const STEP = 1 / 30;

/**
 * The share of each letter's box the subject's box covers, worst over [from, to]:
 * letters [{text, box: [x, y, w, h]}] in scene px; the cut-out `layer`'s subjectPath ([[t, x0, y0,
 * x1, y1]] in shares of its box, cutout-operation.mjs), read at from, at to and at each sample
 * between (straight between samples), else its subjectBox. Returns [{text, share, at}] (share 0 to
 * 1, at the scene second of the worst moment, inside [from, to]), or null when it has neither.
 */
export function letterCover(letters, layer, from, to) {
  const path = Array.isArray(layer.subjectPath) ? layer.subjectPath : [];
  const times = [from, ...path.map(([t]) => t).filter((t) => t > from && t < to), to];
  const samples = times.map((t) => [t, ...(cutoutShares(layer, t) ?? [])]).filter((sample) => sample.length === 5);
  if (!samples.length) return null;
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

/** A laid-out text layer's drawn box in scene px: from its leftmost to its rightmost line, top line to bottom (not its text box). */
function drawnBox(word, fonts) {
  const layout = layoutText(word, fonts);
  if (!layout.lines.length) return { x: word.x, y: word.y, width: word.width, height: word.height };
  const left = Math.min(...layout.lines.map((line) => line.x)), right = Math.max(...layout.lines.map((line) => line.x + line.width));
  const top = word.verticalAlign === "bottom" ? layout.height - layout.naturalHeight : word.verticalAlign === "middle" ? (layout.height - layout.naturalHeight) / 2 : 0;
  return { x: word.x + left, y: word.y + top, width: right - left, height: layout.naturalHeight };
}

/**
 * The largest share of a face or head box on `clip` (mark_subject part face/head, else the scan's
 * faces and pose heads, silhouette.js headsNear) that the panel `box` turned `turn` degrees about
 * its center covers, every 1/6 s over [from, to]: {share, at, from} or null when none is known.
 */
export function faceCover(ctx, clip, box, turn, from, to) {
  const samples = ctx.samples(clip.id);
  const cos = Math.cos((-turn * Math.PI) / 180), sin = Math.sin((-turn * Math.PI) / 180);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const inside = (x, y) => {
    const dx = x - cx, dy = y - cy;
    return Math.abs(dx * cos - dy * sin) <= box.width / 2 && Math.abs(dx * sin + dy * cos) <= box.height / 2;
  };
  let worst = null;
  for (let time = from; time <= to + 1e-6; time += 1 / 6) {
    const heads = headsNear(clip, samples, fileSecond(clip, time));
    for (const [hx, hy, hw, hh] of heads?.boxes ?? []) {
      const x0 = clip.x + hx * clip.width, y0 = clip.y + hy * clip.height, w = hw * clip.width, h = hh * clip.height;
      let hits = 0;
      for (let i = 0; i < 12; i += 1) for (let j = 0; j < 12; j += 1) if (inside(x0 + ((i + 0.5) / 12) * w, y0 + ((j + 0.5) / 12) * h)) hits += 1;
      const share = hits / 144;
      if (!worst || share > worst.share) worst = { share, at: round(time, 2), from: heads.from };
    }
  }
  return worst;
}

/** The first time after `start` a layer stops showing (checked a frame at a time), or the scene's end. */
function shownUntil(ctx, layerId, start) {
  for (let time = start + STEP; time < ctx.sceneDuration; time += STEP) if (!ctx.shownAt(layerId, time)) return round(time, 3);
  return round(ctx.sceneDuration, 3);
}

export const wordPanel = {
  name: "word-panel",
  needsAt: true,
  about: "your word set on a made object: a turned box, a sign with a border or a strip across the frame, sized from the word's own box and turned with it as one group; with subject it stands behind the person (the clip's cut-out, made or reused) and the receipt gives each letter's covered share",
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

    // The word as laid out: its drawn box (the lines' own width, not the text box) is what the panel is sized from.
    const { id: _id, name: _name, animations: _own, move: _move, parentId: _parent, pin: _pin, ...look } = resizeTextLayer(yours, ctx.fonts);
    const fontSize = look.fontSize ?? 40;
    const others = ctx.sceneMoves().filter((entry) => entry.name === "word-panel");
    // Each placement in a scene gets its own seed pick (the seed alone gave every placement the same turn).
    const placement = others.length;
    const shapePick = SHAPES[(SHAPES.indexOf(ctx.rng.pick(SHAPES)) + placement) % SHAPES.length];
    const spread = (ctx.rng.next() + placement * 0.618) % 1;
    const turnPick = round((TURN[0] + spread * (TURN[1] - TURN[0])) * (ctx.rng.next() < 0.5 ? -1 : 1) * (placement % 2 ? -1 : 1), 1);
    const shape = input.shape ?? shapePick;
    const turn = input.turn ?? turnPick;
    const padShare = input.pad ?? PAD_X;
    const padX = Math.round(fontSize * padShare), padY = Math.round(fontSize * padShare * (PAD_Y / PAD_X));
    const wordBox = drawnBox(look, ctx.fonts);
    const center = [wordBox.x + wordBox.width / 2, wordBox.y + wordBox.height / 2];
    // A strip runs past both edges of the frame however it turns (the frame's diagonal and some).
    const reach = Math.ceil(Math.hypot(ctx.frame.width, ctx.frame.height) * 1.1);
    const panelBox = shape === "strip"
      // Centered on the frame (centered on a word near one edge, it ended inside the frame at the other).
      ? { x: Math.round(ctx.frame.width / 2 - reach / 2), y: Math.round(wordBox.y - padY), width: reach, height: Math.round(wordBox.height + 2 * padY) }
      : { x: Math.round(wordBox.x - padX), y: Math.round(wordBox.y - padY), width: Math.round(wordBox.width + 2 * padX), height: Math.round(wordBox.height + 2 * padY) };
    // The word's own text box, fitted to its lines and centered: no empty room at one side.
    const fitted = { ...look, x: round(center[0] - (Math.ceil(wordBox.width) + 2) / 2, 1), y: round(wordBox.y, 1), width: Math.ceil(wordBox.width) + 2, height: Math.ceil(wordBox.height), textAlign: "center", verticalAlign: "top", textResize: "height" };

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
    const padSaid = `pad ${padShare} of the ${fontSize} px font${input.pad === undefined ? ", a starting guess" : ""}`;
    ctx.note(shape === "strip"
      ? `panel strip ${panelBox.width}x${panelBox.height} px across the frame; word centered up and down on it where you placed it, its drawn box ${Math.round(wordBox.width)}x${Math.round(wordBox.height)} px (your text box ${Math.round(look.width)}x${Math.round(look.height)}), ${padY} px above and below (${padSaid})`
      : `panel ${shape} ${panelBox.width}x${panelBox.height} px; word centered in it, its drawn box ${Math.round(wordBox.width)}x${Math.round(wordBox.height)} px (your text box ${Math.round(look.width)}x${Math.round(look.height)}), inset ${padX} px left and right, ${padY} px top and bottom (${padSaid})`);
    ctx.note(`panel color ${panelColor}: ${colorFrom}; word ${ink} at ${round(contrast(ink, panelColor), 2)}:1 on it`);
    ctx.note(`turned ${turn}°${input.turn === undefined ? ` (seed pick for placement ${placement + 1} in this scene, a starting guess: nothing in the shot measured for it)` : ""}`);
    const side = (box) => { const middle = (box.x + box.width / 2) / ctx.frame.width; return middle < 0.4 ? "left" : middle > 0.6 ? "right" : "center"; };
    if (others.length) {
      // How many placements already share this one's turn, size and side (each placement's group as it is now).
      const groups = others.map((entry) => ctx.sceneLayers().find((layer) => layer.id === `${entry.id}-group`)).filter(Boolean);
      const alike = groups.filter((group) => Math.abs((group.rotation ?? 0) - turn) < 1 && Math.abs(group.width / panelBox.width - 1) < 0.1 && Math.abs(group.height / panelBox.height - 1) < 0.1 && side(group) === side(panelBox));
      ctx.note(`word-panel placements in this scene: ${others.length + 1}; ${alike.length} already share this one's turn ${turn}°, size ${panelBox.width}x${panelBox.height} px and side (${side(panelBox)})${alike.length ? `: ${alike.map((group) => group.id.replace(/-group$/, "")).join(", ")}` : ""}`);
    }

    // One group, turned about its own center, holding the panel and the word.
    const groupBox = panelBox;
    const place = subject ? { below: subject.id } : { above: yours.id };
    const group = ctx.add("group", createLayer("group", { name: "Word panel", ...groupBox, rotation: turn, role: "decor", allowOverlap: true }), place);
    const border = shape === "sign" ? Math.max(2, Math.round(fontSize * 0.07)) : 0;
    ctx.add("panel", createLayer("rectangle", { name: "Panel", x: 0, y: 0, width: groupBox.width, height: groupBox.height, fill: panelColor,
      radius: shape === "sign" ? Math.round(fontSize * 0.12) : 0, stroke: ink, strokeWidth: border, role: "decor", allowOverlap: true }), "top", group);
    ctx.add("word", { ...fitted, x: round(fitted.x - groupBox.x, 1), y: round(fitted.y - groupBox.y, 1), fill: ink, rotation: 0, role: yours.role ?? "headline", allowOverlap: true }, "top", group);

    // Yours is the word's source. With no show or hide steps of its own it is hidden from 0 s, so
    // the word shows only with its panel (deleting the move's group takes this hide away again).
    // With steps of its own it is hidden while the move draws it, and back after if it showed then.
    const steps = enabledAnimations(yours.animations ?? []).filter((step) => step?.kind === "show" || step?.kind === "hide");
    if (!steps.length) {
      ctx.animate(yours.id, "hide", hide(0), "textLayer");
      ctx.note(`${yours.id} (the word's source) hidden from 0 s: the word shows only with the panel, ${t} to ${end} s`);
    } else {
      const back = ctx.shownAt(yours.id, end);
      ctx.animate(yours.id, "hide", hide(t), "textLayer");
      if (back) ctx.animate(yours.id, "show", show(end), "textLayer");
      if (back) ctx.note(`${yours.id} shows again at ${end} s (its own show and hide steps)`);
    }

    const tags = ["type-cut"];
    if (ctx.reduced) ctx.animate(group, "in", motion({ name: "Fade in", kind: "in", start: t, duration: Math.min(0.2, (end - t) / 3), easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    else if (input.enter === "slam") {
      // A group scales about its own center (render.js pivot), so the box stays put while it lands.
      ctx.animate(group, "in", motion({ name: "Slam", kind: "in", start: t, duration: Math.min(0.18, (end - t) / 2), easing: CURVES.arrive,
        from: { opacity: 0, scaleX: 1.25, scaleY: 1.25 }, to: { opacity: 1, scaleX: 1, scaleY: 1 } }));
      tags.splice(0, 1, "type-pop");
    } else ctx.animate(group, "in", motion({ name: "Cut on", kind: "in", start: t, duration: 0.001, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(group, "hide", hide(end));

    // The face or head box on the shot (a mark, else the scan) under the panel, worst moment.
    const clip = shot ? (shot.type === "video" ? shot : ctx.clipsOf(shot.id)[0]) : subject?.cutoutOf ? ctx.sceneLayers().find((layer) => layer.id === subject.cutoutOf) : null;
    if (clip?.type === "video") {
      const face = faceCover(ctx, clip, groupBox, turn, t, end);
      if (face) ctx.note(`covers ${Math.round(face.share * 100)}% of the face or head box (${face.from}) at ${face.at} s${subject ? ` (behind ${subject.id})` : ""}`);
      else ctx.note(`no face or head box marked or scanned on ${clip.id} from ${t} to ${end} s (mark_subject part "face" adds one)`);
    }

    if (subject) {
      tags.push("type-behind");
      const covered = letterCover(letterBoxes(fitted, ctx.fonts, turn, [groupBox.x + groupBox.width / 2, groupBox.y + groupBox.height / 2]), subject, t, end);
      if (covered) {
        ctx.note(`covered by ${subject.id}'s box (worst moment per letter): ${covered.map((letter) => `${letter.text} ${Math.round(letter.share * 100)}%`).join(", ")}`);
        const hidden = covered.filter((letter) => letter.share > COVERED);
        if (hidden.length) ctx.note(`over ${COVERED * 100}% covered: ${hidden.map((letter) => `${letter.text} at ${letter.at} s`).join(", ")}`);
      } else ctx.note(`${subject.id} has no measured subject box, so the covered share is not known (look at the frames)`);
    }
    return { end, tags };
  },
};
