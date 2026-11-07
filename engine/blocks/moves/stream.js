// Text that streams and settles, is rewritten, or decodes: three moves on any of your text
// layers, in any font.
//
// stream: words (or letters) arrive one after another, soft and in a hot color; the newest two
// or three carry the color and the earlier ones settle to the text's own color (a request
// streams in amber and settles to ink, or the newest words are gray, settling to white left to
// right).
// rewrite: the old words blur out and the new ones stream in where they stood ("Project spec"
// blurs away and "Optimistic loading refactor" writes on fast).
// decode: the letters show as random letters that settle left to right (in), or switch off into
// random letters and go (out). The random
// letters keep each letter's case (digits stay digits), so they are glyphs any Latin font has;
// other scripts shuffle the text's own letters.
import { layoutText, resizeTextLayer, textUnits } from "../../textLayout.js";
import { readSeconds } from "../build.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

// A unit arrives over this long: from clear and soft to sharp.
const ARRIVE = 0.18;
// How many units keep the hot color after they arrive before they settle.
const HOT_UNITS = 2;
// A dim stream ("from":"dim") arrives at this opacity, like gray over any background.
const DIM = 0.4;
// The old text blurs out over this long; the new starts this far into it.
const BLUR_OUT = 0.25;
const OVERLAP = 0.12;
// The fastest a dur may squeeze a stream: past this the words cannot be read.
const MOST_WORDS = 12;
const MOST_LETTERS = 80;
const readTime = (text) => Math.max(readSeconds(text), 20 / 30);

const COLOR = /^#[0-9a-f]{6}$/i;
const fromField = { kind: "text", max: 9, about: "the color the newest units carry: accent (default), accent2, dim (part opacity, gray over any background) or a #RRGGBB color" };
const unitField = { kind: "choice", values: ["words", "letters"], about: "what streams in: words (default) or letters" };
const rateField = { kind: "number", low: 1, high: 80, about: "units a second (default 4 for words, 30 for letters)" };

/** A text layer as it stands at `time`, without its animations, to copy or measure. */
function standing(ctx, layerId, time) {
  const { animations: _animations, move: _move, ...state } = ctx.stateAt(layerId, time);
  return resizeTextLayer({ ...state, type: "text" }, ctx.fonts);
}

/**
 * The first time, at most `back` seconds before `time`, from which `layerId` shows without a
 * break (checked each frame); `time` itself when it does not show then.
 */
function visibleSince(ctx, layerId, time, back) {
  const shows = (at) => { const state = ctx.stateAt(layerId, at); return state.visible !== false && (state.opacity ?? 1) > 0; };
  if (!shows(time)) return time;
  let since = time;
  const floor = Math.max(0, time - back);
  while (since > floor && shows(Math.max(floor, since - 1 / 30))) since = Math.max(floor, since - 1 / 30);
  return since;
}

/** The hot color for `from`, or null for a dim stream (opacity, not color). */
function hotColor(ctx, from) {
  const value = from ?? "accent";
  if (value === "dim") return null;
  if (value === "accent" || value === "accent2") return ctx.style.colors[value];
  if (COLOR.test(value)) return value.toUpperCase();
  throw new Error(`${ctx.move} from: "${value}" is not accent, accent2, dim or a #RRGGBB color.`);
}

/**
 * Streams `target` (a layer ID, or a layer this move added) in unit by unit from `start`.
 * `state` is the layer as it stands (to count its units and read its color). Each unit arrives
 * soft in the hot color, keeps it while HOT_UNITS more arrive, then settles to the layer's own
 * fill. Returns when the last unit has settled. `until` (or null) speeds the rate up to fit.
 */
function streamOn(ctx, target, state, { from, unit = "words", rate, start, until = null, role = "text" }) {
  // Counted the way the renderer indexes them: with letters, every space has its own turn too.
  const count = Math.max(1, textUnits(layoutText(state, ctx.fonts), unit).length);
  let every = 1 / (rate ?? (unit === "letters" ? 30 : 4));
  const settle = (step) => Math.max(0.2, step * 1.5);
  const length = (step) => step * (count - 1 + HOT_UNITS) + settle(step);
  if (until !== null && start + length(every) > until) {
    // Solved for the step, settle's 0.2 s floor included; rounded down so it never runs over.
    const room = until - start;
    const turns = count - 1 + HOT_UNITS;
    const linear = room / (turns + 1.5);
    const fitted = Math.max(0.01, Math.floor((linear * 1.5 >= 0.2 ? linear : (room - 0.2) / turns) * 1e4) / 1e4);
    // Past a readable rate the words only flicker: refuse with the dur that reads, so a refused
    // edit saves nothing and the agent lengthens dur (or starts earlier) instead.
    const most = unit === "letters" ? MOST_LETTERS : MOST_WORDS;
    if (1 / fitted > most) {
      const needs = (perSecond) => Math.ceil((start + length(1 / perSecond) - ctx.start) * 10) / 10;
      throw new Error(`${ctx.move} would stream ${round(1 / fitted, 1)} ${unit} a second to fit dur ${ctx.dur} s (at most ${most} read); give dur ${needs(most)} s or more (${needs(1 / every)} s at ${round(1 / every, 1)} a second), or start it earlier.`);
    }
    ctx.note(`streamed ${round(1 / fitted, 1)} ${unit} a second to fit dur ${ctx.dur} s`);
    every = fitted;
  }
  const shared = { unit, stagger: round(every, 4), order: "forward" };
  const own = typeof state.fill === "string" ? state.fill : null;
  let hot = hotColor(ctx, from);
  if (hot && !own) {
    ctx.note(`${state.name ?? "the text"} has a gradient fill, so it streams dim instead of from a color`);
    hot = null;
  }
  const soft = Math.max(2, Math.round(6 * ctx.scale));
  if (ctx.reduced) {
    ctx.animate(target, "in", motion({ name: "Fade in", kind: "in", start, duration: 0.3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), role);
    return round(start + 0.3);
  }
  // The layer's own opacity is where it settles (a secondary line at 0.6 stays at 0.6).
  const full = state.opacity ?? 1;
  const arriveTo = hot ? { opacity: full, blur: 0, fill: hot } : { opacity: round(DIM * full, 3), blur: 0 };
  ctx.animate(target, "arrive", { ...motion({ name: "Stream in", kind: "in", start, duration: ARRIVE, easing: CURVES.arrive, from: { ...arriveTo, opacity: 0, blur: soft }, to: arriveTo }), ...shared }, role);
  ctx.animate(target, "settle", { ...motion({ name: "Settle", start: start + every * HOT_UNITS, duration: settle(every), easing: CURVES.fade,
    from: hot ? { fill: hot } : { opacity: arriveTo.opacity }, to: hot ? { fill: own } : { opacity: full } }), ...shared }, role);
  return round(start + length(every));
}

export const stream = {
  name: "stream",
  about: "your text streams in word by word, the newest words hot, settling to the text's color",
  fits: "an AI answer or a line being written live",
  tags: ["type-words"],
  length: 2,
  fields: {
    layer: { kind: "layer", required: true, about: "your text layer (any font; its own fill is the settled color)" },
    from: fromField,
    unit: unitField,
    rate: rateField,
  },
  example: { layer: "prompt", from: "accent", at: 0.3 },
  setup: "a text layer in its final place and color; stream hides its words until each one arrives",
  build(ctx, input) {
    const layer = ctx.layer(input.layer);
    if (layer.type !== "text") throw new Error(`stream layer: ${input.layer} is a ${layer.type}; give a text layer.`);
    const state = standing(ctx, layer.id, ctx.start);
    const done = streamOn(ctx, layer.id, state, { ...input, start: ctx.start, until: ctx.dur === null ? null : ctx.end });
    return { end: ctx.dur !== null ? ctx.end : done };
  },
};

export const rewrite = {
  name: "rewrite",
  about: "your text blurs out and new words stream in where it stood",
  fits: "a title renamed, a draft replaced by the final line",
  tags: ["type-swap", "type-words"],
  length: 2.4,
  fields: {
    layer: { kind: "layer", required: true, about: "your text layer showing the old words" },
    new: { kind: "text", required: true, max: 120, about: "the new words" },
    old: { kind: "text", max: 120, about: "old words to show first; default: the layer's own text (either is held long enough to read)" },
    from: fromField,
    unit: unitField,
    rate: rateField,
  },
  example: { layer: "prompt", new: "Optimistic loading refactor", unit: "letters", at: 0.3 },
  setup: "a text layer with the old words; the new words take a copy of it (same font, size, color and alignment)",
  build(ctx, input) {
    const layer = ctx.layer(input.layer);
    if (layer.type !== "text") throw new Error(`rewrite layer: ${input.layer} is a ${layer.type}; give a text layer.`);
    let state = standing(ctx, layer.id, ctx.start);
    // The new words always draw, at the layer's own opacity, even when the old ones are hidden now.
    const drawn = { visible: true, opacity: layer.opacity ?? 1 };
    const words = String(input.new).replace(/\s+/g, " ").trim();
    const until = ctx.dur === null ? null : ctx.end;
    if (!ctx.shownAt(layer.id, ctx.start)) {
      // The old words are gone already (type-on's hold ended): nothing blurs out, the new words stream from the start.
      ctx.note(`${input.layer} is not showing at ${ctx.start} s, so the new words stream in at once; to blur the old words out, start rewrite while they show (type-on until)`);
      const copy = resizeTextLayer({ ...state, ...drawn, text: words }, ctx.fonts);
      const made = ctx.add("new", { ...copy, allowOverlap: true }, { above: layer.id });
      const done = streamOn(ctx, made, copy, { ...input, start: ctx.start, until });
      return { end: ctx.dur !== null ? ctx.end : done };
    }
    // The old words stay long enough to read before they go, counted from when they first show.
    const ownRead = readTime(state.text ?? "");
    let outAt = round(Math.max(ctx.start, visibleSince(ctx, layer.id, ctx.start, ownRead) + ownRead));
    if (input.old && input.old !== state.text) {
      ctx.animate(layer.id, "old", { name: "Old words", kind: "change-text", start: ctx.start, text: input.old, overlap: false, out: null, in: null }, "text");
      state = resizeTextLayer({ ...state, text: input.old }, ctx.fonts);
      outAt = round(ctx.start + readTime(input.old));
    }
    const soft = Math.max(4, Math.round(14 * ctx.scale));
    if (ctx.reduced) ctx.animate(layer.id, "out", motion({ name: "Fade out", kind: "out", start: outAt, duration: BLUR_OUT, easing: CURVES.fade, from: { opacity: state.opacity ?? 1 }, to: { opacity: 0 } }), "text");
    else ctx.animate(layer.id, "out", motion({ name: "Blur out", kind: "out", start: outAt, duration: BLUR_OUT, easing: CURVES.leave, from: { opacity: state.opacity ?? 1, blur: 0 }, to: { opacity: 0, blur: soft } }), "text");
    ctx.animate(layer.id, "hide", hide(outAt + BLUR_OUT), "text");
    // The new words keep the old box's alignment anchor (resizeTextLayer moves auto-size text about it).
    const copy = resizeTextLayer({ ...state, ...drawn, text: words }, ctx.fonts);
    const made = ctx.add("new", { ...copy, allowOverlap: true }, { above: layer.id });
    const done = streamOn(ctx, made, copy, { ...input, start: round(outAt + (ctx.reduced ? BLUR_OUT : OVERLAP)), until });
    return { end: ctx.dur !== null ? ctx.end : done };
  },
};

// ---- decode -------------------------------------------------------------------------------
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "0123456789";

/** A random stand-in for `character`: same case, a digit for a digit, else one of the text's own letters. */
function standIn(character, own, rng) {
  if (!character.trim()) return character;
  if (/[A-Z]/.test(character)) return rng.pick([...UPPER]);
  if (/[a-z]/.test(character)) return rng.pick([...LOWER]);
  if (/[0-9]/.test(character)) return rng.pick([...DIGITS]);
  return rng.pick(own);
}

/**
 * `text` with its first `settled` letters (of `length`) as they are and the rest random (in),
 * or its first `settled` random and the rest as they are (out).
 */
export function scrambledText(text, settled, rng, mode = "in") {
  const characters = [...text];
  const own = characters.filter((character) => character.trim());
  return characters.map((character, index) => {
    const real = mode === "in" ? index < settled : index >= settled;
    return real ? character : standIn(character, own, rng);
  }).join("");
}

/**
 * The real text goes full just before the random letters hide at `end`, so no frame shows
 * neither (the decode move hands over this way).
 */
export function settleUnder(ctx, layer, end, opacity = 1, role) {
  ctx.animate(layer, "in", motion({ name: "Settled", kind: "in", start: end - 0.002, duration: 0.001, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity } }), role);
}

export const decode = {
  name: "decode",
  about: "your text decodes from random letters left to right (in), or switches off into them (out)",
  fits: "a mono label, heading or wordmark that should feel computed",
  tags: ["type-letters", "type-swap"],
  length: 0.6,
  fields: {
    layer: { kind: "layer", required: true, about: "your text layer (any font; letters keep their case, so the random ones are glyphs the font has)" },
    mode: { kind: "choice", values: ["in", "out"], about: "in (default): settles into the words; out: switches off into random letters and goes" },
  },
  example: { layer: "prompt", mode: "in", at: 0.3 },
  setup: "a text layer in its final place; the random letters are a decor copy above it, so the gates read your layer, not the noise",
  build(ctx, input) {
    const layer = ctx.layer(input.layer);
    if (layer.type !== "text") throw new Error(`decode layer: ${input.layer} is a ${layer.type}; give a text layer.`);
    const state = standing(ctx, layer.id, ctx.start);
    const text = String(state.text ?? "");
    const letters = [...text].length;
    if (!text.trim()) throw new Error(`decode layer: ${input.layer} has no letters.`);
    const out = input.mode === "out";
    // 0.4 s for a short label, up to 1 s for a long line; a step every 0.05 s.
    const length = ctx.dur ?? round(Math.max(0.4, Math.min(1, letters * 0.025)));
    const end = round(ctx.start + length);
    if (ctx.reduced) {
      ctx.animate(layer.id, out ? "out" : "in", motion({ name: out ? "Fade out" : "Fade in", kind: out ? "out" : "in", start: ctx.start, duration: Math.min(0.3, length), easing: CURVES.fade, from: { opacity: out ? state.opacity ?? 1 : 0 }, to: { opacity: out ? 0 : state.opacity ?? 1 } }), "text");
      if (out) ctx.animate(layer.id, "hide", hide(end), "text");
      return { end };
    }
    const steps = Math.max(4, Math.min(20, Math.round(length / 0.05)));
    const at = (step) => Math.floor((letters * step) / steps);
    // The random letters are decoration, not copy: a decor copy of the layer shows them and
    // hands over to the layer itself the moment the last one settles (in), or takes over from it
    // at the start (out). Auto-size text measures each step again about its alignment anchor.
    const noise = ctx.add("noise", { ...state, role: "decor", text: scrambledText(text, 0, ctx.rng, out ? "out" : "in"), allowOverlap: true }, { above: layer.id });
    for (let step = 1; step < steps; step += 1)
      ctx.animate(noise, `step${step}`, { name: "Decode", kind: "change-text", start: round(ctx.start + (length * step) / steps), text: scrambledText(text, at(step), ctx.rng, out ? "out" : "in"), overlap: false, out: null, in: null });
    if (out) {
      ctx.animate(layer.id, "hide", hide(ctx.start), "text");
      ctx.animate(noise, "show", show(ctx.start));
      ctx.animate(noise, "out", motion({ name: "Fade out", kind: "out", start: end - 0.1, duration: 0.1, easing: CURVES.fade, from: { opacity: state.opacity ?? 1 }, to: { opacity: 0 } }));
      ctx.animate(noise, "hide", hide(end));
    } else {
      ctx.animate(noise, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.08, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: state.opacity ?? 1 } }));
      ctx.animate(noise, "hide", hide(end));
      settleUnder(ctx, layer.id, end, state.opacity ?? 1, "text");
    }
    return { end };
  },
};

// ---- assemble -----------------------------------------------------------------------------
// The letters start scattered (each its own seeded offset, turn and size, soft and clear) and
// fly together into the word with expo-out, one a moment after the other, so the word reads as
// it forms ("Move it." flies together, or letters rise, unblur and light one by one). out
// reverses it. One animation on your layer with a per-letter
// scatter (engine/textTiming.js), so any font works and the gates read your own text.
const SPREAD_KEYS = { x: { low: 0, high: 2000 }, y: { low: 0, high: 2000 }, angle: { low: 0, high: 180 }, scale: { low: 0, high: 1.5 } };
// Each letter travels this long; the stagger spreads the letters over at most MOST_SPREAD seconds.
const LETTER_SECONDS = 0.7;
const LETTER_STEP = 0.03;
const FADE = 0.06;
const MOST_SPREAD = 0.45;

export const assemble = {
  name: "assemble",
  about: "your text's letters fly together from scattered places into the word, or apart (out)",
  fits: "a short word or line coming together: a name, a promise, \"Move it.\"",
  tags: ["type-letters"],
  length: 1,
  fields: {
    layer: { kind: "layer", required: true, about: "your text layer in its final place (any font; best under about 20 letters)" },
    spread: { kind: "amounts", keys: SPREAD_KEYS, about: "how far apart the letters start: {x, y} pixels (default about one letter height), angle degrees (default 25), scale (default 0.5: from half to 1.5 times)" },
    mode: { kind: "choice", values: ["in", "out"], about: "in (default): flies together; out: flies apart and goes" },
  },
  example: { layer: "prompt", spread: { x: 60, y: 80, angle: 30, scale: 0.5 }, at: 0.3 },
  setup: "a text layer in its final place; the move's seed picks the scatter (another seed, another one)",
  build(ctx, input) {
    const layer = ctx.layer(input.layer);
    if (layer.type !== "text") throw new Error(`assemble layer: ${input.layer} is a ${layer.type}; give a text layer.`);
    const state = standing(ctx, layer.id, ctx.start);
    if (!String(state.text ?? "").trim()) throw new Error(`assemble layer: ${input.layer} has no letters.`);
    const out = input.mode === "out";
    const count = Math.max(1, textUnits(layoutText(state, ctx.fonts), "letters").length);
    // Fitted to dur when given: each letter keeps most of it, the stagger the rest.
    const each = ctx.dur === null ? LETTER_SECONDS : Math.max(0.2, Math.min(LETTER_SECONDS, ctx.dur * 0.65));
    const room = ctx.dur === null ? MOST_SPREAD : Math.max(0, ctx.dur - each);
    const step = count > 1 ? Math.floor(Math.min(LETTER_STEP, room / (count - 1)) * 1e4) / 1e4 : 0;
    const end = round(ctx.start + each + step * (count - 1));
    const opacity = state.opacity ?? 1;
    if (ctx.reduced) {
      ctx.animate(layer.id, out ? "out" : "in", motion({ name: out ? "Fade out" : "Fade in", kind: out ? "out" : "in", start: ctx.start, duration: 0.3, easing: CURVES.fade, from: { opacity: out ? opacity : 0 }, to: { opacity: out ? 0 : opacity } }), "text");
      if (out) ctx.animate(layer.id, "hide", hide(round(ctx.start + 0.3)), "text");
      return { end: round(ctx.start + 0.3) };
    }
    const size = (state.fontSize ?? 64) * Math.abs(state.scaleY ?? 1);
    const spread = { x: size * 0.9, y: size, angle: 25, scale: 0.5, ...input.spread };
    const soft = Math.max(2, Math.round(Math.min(12, size * 0.12)));
    const rest = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1, blur: 0 };
    const away = { ...rest, blur: soft };
    // The move's seed picks the scatter, so another seed gives another one.
    const scatter = { x: round(spread.x, 1), y: round(spread.y, 1), rotation: round(spread.angle, 1), scale: round(spread.scale, 3), seed: Math.floor(ctx.rng.next() * 1e6) };
    const letters = { unit: "letters", textAnchor: "letters", stagger: step, order: "forward" };
    ctx.animate(layer.id, out ? "out" : "in", { ...motion({ name: out ? "Fly apart" : "Assemble", kind: out ? "out" : "in", start: ctx.start, duration: each,
      easing: out ? CURVES.leave : CURVES.settle, from: out ? rest : away, to: out ? away : rest }), ...letters, scatter }, "text");
    // Each letter shows in its first FADE seconds, so the scatter is seen (the letters are all
    // there, apart, on the first frame); out fades it in its last FADE seconds.
    ctx.animate(layer.id, out ? "fade-out" : "fade-in", { ...motion({ name: out ? "Fade out" : "Fade in", kind: out ? "out" : "in", start: out ? ctx.start + each - FADE : ctx.start, duration: FADE,
      easing: CURVES.fade, from: { opacity: out ? opacity : 0 }, to: { opacity: out ? 0 : opacity } }), ...letters }, "text");
    if (out) ctx.animate(layer.id, "hide", hide(end), "text");
    return { end: ctx.dur !== null ? ctx.end : end };
  },
};
