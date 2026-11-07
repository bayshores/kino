// type-on: your text layer is typed into place letter by letter with a caret after the last
// letter, and an input box that grows with the text (a prompt typed at about 12 then 20 letters a
// second into an input box, a thin caret right after the last letter; the caret blinks in an
// empty search bar, stays solid while a word is typed, then blinks again).
//
// The letters share one animation on your layer (unit letters, a delay per letter). The caret is
// a thin bar placed with the text layout's glyph advances: it steps to the right edge of each
// letter as it appears, and to the next line when the text wraps. `field` (your box under the
// text) widens and deepens so the text keeps the room it had on the left. A cue per word
// (`<id>.1`, `<id>.2`, ...) and `<id>.typed` give a key sound a place to sit.
import { createLayer } from "../../model.js";
import { layoutText, resizeTextLayer, textUnits } from "../../textLayout.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

// macOS blinks a caret about every 0.53 s; it stays solid while keys are pressed.
const BLINK = 0.53;
// Most letters a single type-on takes (each letter is a caret step).
const MOST_LETTERS = 120;
// Each keystroke takes 1/cps, nudged up to 25% either way so the typing never ticks like a clock.
const JITTER = 0.25;
// A letter cuts on over this long (a soft edge on the cut, like a screen redraw).
const LETTER_IN = 0.03;

const isSpace = (text) => /^\s+$/u.test(text);

/**
 * When each letter unit of `units` appears, in seconds after the first: one keystroke (1/cps,
 * jittered by `next()`) per letter or space, and `wordPause` more after each space.
 * Returns {times, length}: length is when the last letter appears.
 */
export function keyTimes(units, { cps = 12, wordPause = 0.08, next = () => 0.5 } = {}) {
  const times = [];
  let time = 0;
  units.forEach((unit, index) => {
    if (index > 0) {
      time += (1 / cps) * (1 + JITTER * (next() * 2 - 1));
      if (isSpace(units[index - 1].text)) time += wordPause;
    }
    times.push(round(time));
  });
  return { times, length: times.at(-1) ?? 0 };
}

/**
 * Where the caret stands after each letter unit, in the text box's own pixels: the right edge
 * of the unit's glyphs (their x plus advance), on its line. `before` is where it stands before
 * the first letter. Lines come from layoutText; a unit with no glyph (a space at a wrap) keeps
 * the last place moved by a quarter of the font size.
 */
export function caretStops(layout, units) {
  const fontSize = layout.fontSize;
  const lineOf = (unit) => layout.lines[unit.lineIndex] ?? layout.lines[0];
  const first = units[0];
  const firstLine = lineOf(first);
  const left = first?.glyphs.length ? Math.min(...first.glyphs.map((glyph) => glyph.x)) : firstLine.x;
  const before = { x: left, baseline: firstLine.y };
  let last = before;
  const stops = units.map((unit) => {
    const line = lineOf(unit);
    const stop = unit.glyphs.length
      ? { x: Math.max(...unit.glyphs.map((glyph) => glyph.x + (glyph.advance ?? 0))), baseline: line.y }
      : { x: last.baseline === line.y ? last.x + fontSize * 0.25 : line.x, baseline: line.y };
    last = stop;
    return stop;
  });
  return { before, stops };
}

export const typeOn = {
  name: "type-on",
  about: "your text layer is typed on letter by letter with a caret after the last letter; an input box can grow with it",
  fits: "a prompt typed into a search bar, chat or command box; a name typed into a field",
  tags: ["type-letters"],
  length: 2,
  fields: {
    layer: { kind: "layer", required: true, about: "your text layer to type (left-aligned types like a real field)" },
    cps: { kind: "number", low: 2, high: 60, about: "letters a second (default 12; launch films type 10 to 20)" },
    wordPause: { kind: "number", low: 0, high: 1, about: "extra seconds after each space (default 0.08)" },
    caret: { kind: "choice", values: [true, false], about: "a thin caret after the last letter, solid while typing, blinking before and after (default true)" },
    field: { kind: "layer", about: "your box under the text (a search bar, a chat input): it widens and deepens as the text needs room" },
    keyCues: { kind: "choice", values: [true, false], about: "a cue at each word (<id>.1, <id>.2, ...) and <id>.typed at the last letter, for key sounds (default true)" },
    wait: { kind: "number", low: 0, high: 3, about: "seconds the caret blinks in the empty field before the first letter (default 0.5)" },
    hold: { kind: "number", low: 0, high: 6, about: "seconds the caret blinks after the last letter (default 1.6: solid, off, on)" },
    until: { kind: "number", low: 0, high: 600, about: "scene seconds the typed text and caret go (default: after the hold, or sooner when a caption comes on; the scene's length keeps them)" },
  },
  example: { layer: "prompt", field: "prompt-field", cps: 14, at: 0.3 },
  setup: "a left-aligned text layer (the prompt) on top of a rounded box (the field); set role:\"ui\" on the prompt text (it is the product's own UI, so type_min allows small type); type-on hides the letters until they are typed",
  build(ctx, input) {
    const layer = ctx.layer(input.layer);
    if (layer.type !== "text") throw new Error(`type-on layer: ${input.layer} is a ${layer.type}; give a text layer.`);
    const state = resizeTextLayer({ ...ctx.stateAt(layer.id, ctx.start), type: "text" }, ctx.fonts);
    const layout = layoutText(state, ctx.fonts);
    const units = textUnits(layout, "letters");
    const letters = units.filter((unit) => !isSpace(unit.text)).length;
    if (!letters) throw new Error(`type-on layer: ${input.layer} has no letters to type.`);
    if (units.length > MOST_LETTERS) throw new Error(`type-on types at most ${MOST_LETTERS} letters; ${input.layer} has ${units.length}. Split the text, or show the rest at once.`);
    const caretOn = input.caret !== false;
    // A dur too short for the wait shortens the wait, so the letters still type before the end.
    const wait = caretOn ? Math.min(input.wait ?? 0.5, ctx.dur === null ? Infinity : ctx.dur * 0.25) : 0;
    const hold = caretOn ? input.hold ?? 1.6 : 0;

    // When each letter appears. A dur shorter than the typing speeds the typing up to fit.
    const cps = input.cps ?? 12;
    let keys = keyTimes(units, { cps, wordPause: input.wordPause ?? 0.08, next: ctx.rng.next });
    const room = ctx.dur === null ? Infinity : ctx.dur - wait - LETTER_IN - 0.05;
    if (keys.length > room) {
      // The pauses scale too, so the same words still read as words.
      const share = Math.max(0.05, room) / keys.length;
      keys = { times: keys.times.map((time) => round(time * share)), length: round(keys.length * share) };
      ctx.note(`typed at about ${round(cps / share, 1)} letters a second to fit dur ${ctx.dur} s`);
    }
    const typeAt = round(ctx.start + wait);
    const typedAt = round(typeAt + keys.length);
    let end = ctx.dur !== null ? ctx.end : round(typedAt + LETTER_IN + hold);
    if (input.until !== undefined) {
      if (input.until <= typedAt + LETTER_IN) throw new Error(`type-on until: ${input.until} s is before the last letter is typed (${round(typedAt + LETTER_IN)} s).`);
      end = round(Math.min(input.until, ctx.sceneDuration));
    } else {
      // The line goes when a caption comes on after it is typed (the next thing said), at the latest after the hold.
      const caption = ctx.topLayers().find((other) => other.id !== layer.id && other.type === "text" && other.role === "caption"
        && !ctx.shownAt(other.id, typedAt) && Array.from({ length: Math.ceil((end - typedAt) / 0.1) }, (_, index) => typedAt + 0.1 * (index + 1)).some((time) => time < end && ctx.shownAt(other.id, time)));
      if (caption) {
        for (let time = typedAt; time < end; time = round(time + 0.05)) if (ctx.shownAt(caption.id, time)) { end = Math.max(round(typedAt + LETTER_IN + 0.3), time); break; }
        ctx.note(`the typed line goes at ${end} s, when ${caption.id} comes on`);
      }
    }

    // The letters: hidden until typed, each cutting on at its keystroke.
    ctx.animate(layer.id, "letters", { ...motion({ name: "Type on", kind: "in", start: typeAt, duration: LETTER_IN, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }),
      unit: "letters", textAnchor: "letters", delays: keys.times }, "text");

    // The caret: a bar from the ascender to below the baseline, the text's own color.
    const { before, stops } = caretStops(layout, units);
    const fontSize = layout.fontSize;
    const width = Math.max(2, Math.round(fontSize * 0.07));
    const height = Math.round(fontSize * 1.18);
    const gap = Math.max(1, fontSize * 0.04);
    const at = (stop) => ({ x: round(state.x + stop.x + gap, 1), y: round(state.y + stop.baseline - fontSize * 0.92, 1) });
    if (caretOn) {
      const start = at(before);
      // A gradient fill gives the caret its first stop's color.
      const paint = typeof layer.fill === "string" ? layer.fill : layer.fill?.stops?.[0]?.color ?? ctx.style.colors.text ?? "#FFFFFF";
      const caret = ctx.add("caret", createLayer("rectangle", { x: start.x, y: start.y, width, height, radius: Math.round(width / 2), fill: String(paint).slice(0, 7), role: "ui", allowOverlap: true }), { above: layer.id });
      ctx.animate(caret, "show", show(ctx.start));
      let from = start;
      stops.forEach((stop, index) => {
        const to = at(stop);
        if (to.x === from.x && to.y === from.y) return;
        ctx.animate(caret, `k${index + 1}`, motion({ name: "Caret", start: typeAt + keys.times[index], duration: LETTER_IN, easing: CURVES.arrive, from, to }));
        from = to;
      });
      // Blinking while it waits for the first key and after the last, solid in between.
      const blink = (from, until, name) => {
        let count = 0;
        // Only whole blinks: a caret never flashes on for a moment just before it goes.
        for (let off = from + BLINK; off + BLINK * 2 <= until + 0.02; off += BLINK * 2) {
          count += 1;
          ctx.animate(caret, `${name}-off${count}`, hide(off));
          ctx.animate(caret, `${name}-on${count}`, show(off + BLINK));
        }
      };
      blink(ctx.start, typeAt, "wait");
      blink(typedAt, end, "idle");
      ctx.animate(caret, "hide", hide(end));
    }

    // The typed line goes with the caret (until keeps it longer; the scene's length keeps it on),
    // and the field with them: an emptied box left on screen reads as a glitch.
    if (end < ctx.sceneDuration - 1e-6) {
      ctx.animate(layer.id, "gone", hide(end), "text");
      if (input.field !== undefined) ctx.animate(input.field, "gone", hide(end), "field");
    }

    // The field keeps the room it gives the text on the left on the right and below as well.
    if (input.field !== undefined) {
      const field = ctx.stateAt(ctx.layer(input.field, "field").id, ctx.start);
      const start = at(before);
      const inset = Math.max(fontSize * 0.5, start.x - gap - field.x);
      const below = Math.max(fontSize * 0.3, field.y + field.height - (start.y + height));
      const need = (stop) => {
        const point = at(stop);
        return { width: round(Math.max(field.width, point.x + width + inset - field.x), 1), height: round(Math.max(field.height, point.y + height + below - field.y), 1) };
      };
      let size = { width: field.width, height: field.height };
      const steps = [];
      stops.forEach((stop, index) => {
        const next = need(stop);
        if (next.width === size.width && next.height === size.height) return;
        steps.push({ time: typeAt + keys.times[index], from: size, to: next });
        size = next;
      });
      steps.forEach((step, index) => {
        // Each step eases out before the next one starts, so two never pull at the box at once.
        const room = (steps[index + 1]?.time ?? step.time + 0.3) - step.time;
        ctx.animate(input.field, `grow${index + 1}`, motion({ name: "Grow", start: step.time, duration: Math.max(0.02, Math.min(0.18, room)), easing: CURVES.arrive, from: step.from, to: step.to }), "field");
      });
      if (steps.length) ctx.note(`${input.field} grows to ${size.width} x ${size.height}`);
    }

    // Cues: the first letter of each word, and the last letter.
    const cues = [];
    if (input.keyCues !== false) {
      units.forEach((unit, index) => {
        if (isSpace(unit.text) || (index > 0 && !isSpace(units[index - 1].text))) return;
        cues.push({ name: `${ctx.id}.${cues.length + 1}`, time: round(typeAt + keys.times[index]) });
      });
      cues.push({ name: `${ctx.id}.typed`, time: typedAt });
    }
    return { end, cues };
  },
};
