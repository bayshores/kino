// roll: a run of words, pictures or clips that speeds up and lands on the one that matters
// (feature names cut faster and faster beside "NEW", land on the product name and the two words
// slide together; a wheel of app names turns three frames an item and slows on the last; swipes
// every 3 s, then 1, then 0.5).
//
// The time each item shows goes from `first` to `last` along `ramp`; the land then holds. Each
// item writes a cue (`<id>.1`, `<id>.2`, ... `<id>.land`) so a tick or a hit can sit on it.
import { createLayer } from "../../model.js";
import { layoutText } from "../../textLayout.js";
import { textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

export const RAMPS = Object.freeze(["expo", "linear", "none"]);

/**
 * Seconds each of `count` items shows, from `first` to `last`: expo shrinks by the same ratio
 * each step (a long first look, then a run of quick ones), linear by the same amount, none keeps
 * every one at `first`.
 */
export function rampTimes(count, first, last, ramp = "expo") {
  if (count <= 0) return [];
  if (count === 1 || ramp === "none") return Array.from({ length: count }, () => round(first));
  return Array.from({ length: count }, (_, index) => {
    const share = index / (count - 1);
    return round(ramp === "linear" ? first + (last - first) * share : first * (last / first) ** share);
  });
}

const LAND_HOLD = 2;
// The wheel: the middle item at full size; its neighbors smaller and dim; two away, gone.
const NEIGHBOR_SCALE = 0.68;
const NEIGHBOR_OPACITY = 0.32;
// The wheel slows into the land (its last step takes about four times a fast one).
const WHEEL_LAND = 0.55;

/** A word, or an uploaded picture when one has that name. */
function itemOf(ctx, text) {
  try {
    return { kind: "picture", text, picture: ctx.picture(text) };
  } catch {
    return { kind: "word", text };
  }
}

export const roll = {
  name: "roll",
  about: "words, pictures or clips cut faster and faster in one place, then land on one and hold (or turn as a wheel)",
  fits: "a list that builds to the product's name; a montage into the payoff",
  tags: ["roll"],
  length: 4,
  fields: {
    items: { kind: "texts", min: 2, most: 24, max: 60, about: "words, or names of uploaded pictures, in the order they roll" },
    layers: { kind: "layers", min: 2, most: 24, about: "your own layers (clips, pictures, groups) shown in turn where they are (swap only)" },
    land: { kind: "text", max: 60, about: "the word, picture or layer it lands on and holds (default the last one)" },
    lead: { kind: "text", max: 40, about: "a word that stays left of the rolling words (\"NEW\"); on the land the two slide together into one line (swap, words)" },
    layout: { kind: "choice", values: ["swap", "wheel"], about: "swap: each item cuts to the next in one place (default); wheel: a vertical list turns one item a step, its neighbors small and dim" },
    first: { kind: "number", low: 0.05, high: 3, about: "seconds the first item shows (default 1.4)" },
    last: { kind: "number", low: 0.05, high: 3, about: "seconds the last item before the land shows (default 0.1)" },
    ramp: { kind: "choice", values: [...RAMPS], about: "how the time per item goes from first to last: expo (default), linear, or none (every item first)" },
    hold: { kind: "number", low: 0.6, high: 6, about: "seconds the land holds (default 2); with dur, the roll lands at dur minus hold" },
  },
  oneOf: [["items", "layers"]],
  example: { items: ["LAUNCHER", "HOTKEYS", "AI CHAT", "FILE SEARCH", "CLOUD SYNC", "NOTES"], land: "KINO", lead: "NEW", first: 1, at: 0.3 },
  setup: "nothing",
  build(ctx, input) {
    const layout = ctx.reduced ? "swap" : input.layout ?? "swap";
    if (input.layers && input.layout === "wheel") throw new Error("roll: wheel takes items (words or pictures); give layers with layout swap.");
    let entries = input.layers ? input.layers.map((layerId) => ({ kind: "layer", text: layerId, layer: ctx.layer(layerId, "layers") })) : input.items.map((text) => itemOf(ctx, text));
    if (input.land !== undefined) {
      const land = input.layers ? { kind: "layer", text: input.land, layer: ctx.layer(input.land, "land") } : itemOf(ctx, input.land);
      entries = entries.filter((entry) => (entry.layer?.id ?? entry.text) !== (land.layer?.id ?? land.text));
      entries.push(land);
    }
    if (entries.length < 2) throw new Error("roll needs at least two items besides the land.");
    if (input.lead !== undefined && entries.some((entry) => entry.kind !== "word")) throw new Error("roll: lead goes with words only.");

    // When each item shows: the ramp for every item before the land, then the land holds.
    const hold = input.hold ?? LAND_HOLD;
    let runs = rampTimes(entries.length - 1, input.first ?? 1.4, input.last ?? 0.1, input.ramp ?? "expo");
    // With dur, the roll lands at dur minus hold: the ramp keeps its shape, scaled to fit.
    if (ctx.dur !== null) {
      const room = ctx.dur - hold;
      if (room < 0.05 * runs.length) throw new Error(`roll: dur ${ctx.dur} s leaves ${round(room)} s before the ${hold} s hold for ${runs.length} items; give a longer dur or a shorter hold.`);
      const total = runs.reduce((sum, seconds) => sum + seconds, 0);
      runs = runs.map((seconds) => seconds * room / total);
    }
    const starts = [];
    let time = ctx.start;
    for (const seconds of runs) { starts.push(round(time)); time += seconds; }
    const landAt = round(time);
    starts.push(landAt);
    const cues = entries.map((_, index) => ({ name: `${ctx.id}.${index === entries.length - 1 ? "land" : index + 1}`, time: starts[index] }));

    // The words share one size, the look's second heading (small and quiet, as in the references).
    const words = entries.filter((entry) => entry.kind === "word");
    const frame = ctx.frame;
    // Inside the platform's safe zone, so a phone app's buttons never cover a word.
    const safe = safeArea(frame);
    const wide = { x: safe.x, y: 0, width: safe.width, height: frame.height };
    // The wheel's middle item is bigger (about a seventh of the height).
    let size = layout === "wheel" ? ctx.style.type.h1 : ctx.style.type.h2 ?? ctx.style.type.body;
    for (const entry of words) size = Math.min(size, textLayer(ctx, { part: "probe", text: entry.text, role: "label", step: "h2", size, box: wide, align: "center", valign: "middle", maxLines: 1 }).fontSize);
    const lastIndex = entries.length - 1;
    const makeWord = (entry, index, box, align) => textLayer(ctx, {
      part: `item${index + 1}`, text: entry.text, role: index === lastIndex ? "label" : "ui", step: "h2", size, box, align, valign: "middle", maxLines: 1,
      name: entry.text,
    });
    const pictureHeight = Math.round(frame.height * (ctx.portrait ? 0.24 : 0.36));
    const makePicture = (entry, index, centerY) => {
      const height = Math.min(pictureHeight, Math.round((frame.width * 0.7 * entry.picture.height) / entry.picture.width));
      const width = Math.round((height * entry.picture.width) / entry.picture.height);
      return createLayer("image", { name: entry.text, src: entry.picture.src, x: Math.round((frame.width - width) / 2), y: Math.round(centerY - height / 2), width, height, role: index === lastIndex ? "logo" : "decor" });
    };
    const textWidth = (layer) => Math.max(0, ...layoutText(layer, ctx.fonts).lines.map((line) => line.width ?? 0));
    let end = landAt + hold;

    if (layout === "swap") {
      // With a lead word, the rolling words sit right-aligned in a column right of it.
      let lead = null;
      let column = wide;
      if (input.lead !== undefined && words.length) {
        const leadAt = () => textLayer(ctx, { part: "lead", text: input.lead, role: "label", step: "h2", size, box: wide, align: "left", valign: "middle", maxLines: 1 });
        const widestAt = () => Math.max(...words.map((entry, index) => textWidth(makeWord(entry, index, wide, "right"))));
        // The lead, a gap and the widest word fit across the safe zone (a tall frame steps the size down).
        const room = (textWidth(leadAt()) + widestAt()) / size + 3;
        if (room * size > wide.width) size = Math.floor(wide.width / room);
        const probe = leadAt();
        const widest = widestAt();
        const block = Math.min(wide.width, Math.max(frame.width * 0.36, textWidth(probe) + widest + size * 3));
        const left = Math.round((frame.width - block) / 2);
        lead = ctx.add("lead", { ...probe, x: left - Math.ceil(size * 0.04) });
        column = { x: left, y: 0, width: Math.round(block), height: frame.height };
        ctx.animate(lead, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.2, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      }
      entries.forEach((entry, index) => {
        const until = index === lastIndex ? null : starts[index + 1];
        let target;
        let role = null;
        if (entry.kind === "layer") {
          target = entry.layer.id;
          role = `item${index + 1}`;
          // A clip plays from its own show time, so it shows the part of the file it was given
          // (its mediaOffset), not a part that ran while it was hidden. Clips in a group too.
          for (const clip of ctx.clipsOf(entry.layer.id)) if (Math.abs((clip.mediaStart ?? 0) - starts[index]) > 1e-6) ctx.set(clip.id, { mediaStart: starts[index] });
        }
        else if (entry.kind === "word") target = ctx.add(`item${index + 1}`, makeWord(entry, index, lead ? column : wide, lead ? "right" : "center"));
        else target = ctx.add(`item${index + 1}`, makePicture(entry, index, frame.height / 2));
        // A hard cut on: the first item since the move's start, the rest each on its own time.
        ctx.animate(target, "show", show(starts[index]), role);
        if (until !== null) ctx.animate(target, "hide", hide(until), role);
        // The land and the lead slide together into one centered line.
        if (index === lastIndex && lead && entry.kind === "word" && !ctx.reduced) {
          const gap = Math.round(size * 0.3);
          const landWidth = textWidth(target);
          const leadWidth = textWidth(lead);
          const total = leadWidth + gap + landWidth;
          const leadX = Math.round((frame.width - total) / 2);
          const landTextX = leadX + leadWidth + gap;
          // A right-aligned layer draws its words at its right edge: move the layer by the difference.
          const landX = Math.round(landTextX - (target.width - landWidth));
          const slideAt = landAt + Math.min(0.6, hold * 0.35);
          const slide = Math.min(0.9, Math.max(0.4, hold * 0.45));
          ctx.animate(lead, "together", motion({ name: "Slide together", start: slideAt, duration: slide, easing: CURVES.fly, from: { x: lead.x }, to: { x: leadX } }));
          ctx.animate(target, "together", motion({ name: "Slide together", start: slideAt, duration: slide, easing: CURVES.fly, from: { x: target.x }, to: { x: landX } }));
          end = Math.max(end, slideAt + slide + 0.4);
        }
      });
    } else {
      // The wheel: item i sits `offset` slots from the middle; each step turns it one slot up.
      const made = entries.map((entry, index) => (entry.kind === "word" ? makeWord(entry, index, wide, "center") : makePicture(entry, index, frame.height / 2)));
      const step = Math.round(Math.max(...made.map((layer) => layer.height)) * 1.1);
      const middle = frame.height / 2;
      const at = (layer, offset) => {
        const far = Math.abs(offset);
        const scale = far === 0 ? 1 : NEIGHBOR_SCALE;
        // Neighbors sit closer than a full slot, as their smaller size leaves room.
        const y = middle + Math.sign(offset) * (far === 0 ? 0 : step * (0.5 + 0.5 * NEIGHBOR_SCALE) + (far - 1) * step * NEIGHBOR_SCALE) - layer.height / 2;
        return { y: round(y, 1), scaleX: scale, scaleY: scale, opacity: far === 0 ? 1 : far === 1 ? NEIGHBOR_OPACITY : 0 };
      };
      made.forEach((base, index) => {
        const layer = ctx.add(`item${index + 1}`, { ...base, ...at(base, index) });
        for (let turn = 1; turn <= lastIndex; turn += 1) {
          const before = index - (turn - 1);
          const after = index - turn;
          if (Math.min(Math.abs(before), Math.abs(after)) > 1) continue;
          const landing = turn === lastIndex;
          const seconds = landing ? Math.max(WHEEL_LAND, runs.at(-1) * 2) : runs[turn];
          ctx.animate(layer, `turn${turn}`, motion({ name: landing ? "Land" : "Turn", start: starts[turn], duration: seconds, easing: CURVES.settle,
            from: at(base, before), to: at(base, after) }));
        }
        // The item above the land fades away, so the land holds alone.
        if (index === lastIndex - 1) ctx.animate(layer, "clear", motion({ name: "Fade out", kind: "out", start: landAt + WHEEL_LAND, duration: 0.4, easing: CURVES.fade, from: { opacity: NEIGHBOR_OPACITY }, to: { opacity: 0 } }));
      });
      // A short hold still ends after the landing turn and the fade that clears the item above.
      end = Math.max(end, landAt + Math.max(WHEEL_LAND, runs.at(-1) * 2), landAt + WHEEL_LAND + 0.4);
    }
    return { end: round(Math.max(ctx.end, end)), cues };
  },
};
