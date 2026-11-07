// text_load (a warning): too much text competing for the eye at once. It came from a footage
// trailer where a caption of the spoken words, a how-it-works line, a status label and labeled
// graphics were all on screen together, and a reviewer called it "text overloady".
//
// Two measures, both general (no house style):
//   reading rate   each readable text asks for its characters divided by the time it is readable
//                  (a 30-character line shown 2 s asks for 15 characters a second). The rates of
//                  the texts on screen together add up. Over 24 a second (20% above the common
//                  subtitle limit of 20, which is already "reading and nothing else") for 1 s or
//                  more, with 2 texts or more adding to it, nobody can read it all. A single text
//                  too fast is reading_time's job.
//   separate texts 3 or more separate blocks of text (texts whose boxes are not stacked
//                  together) at once over playing footage, for 1.5 s or more. Footage asks for
//                  the eye too; finished edits over footage keep to one or two (a caption line and
//                  one label). Over a still or flat frame, text can be the picture (kinetic type,
//                  a lyric video, a labeled diagram), so only the reading rate is measured there.
// Left alone: a logo, a text readable for half the video or more (a logo bug, a status line),
// and the end card (the last section, when it starts in the second half of the video).
import { charactersOf, drawnSize, readableAt, readableRuns, readingTexts, sec, sections, wordsOf } from "../analysis.js";
import { area, boxAt, runs } from "../model.js";
import { stringsOf } from "./text.js";

// Characters a second the texts on screen together may ask for (the subtitle limit of 20, plus 20%).
export const LOAD_CPS = 24;
// How long the rate may stay over before it is a finding.
const RATE_SECONDS = 1;
// Separate blocks of text over footage, and for how long.
export const MAX_BLOCKS = 2;
const BLOCK_SECONDS = 1.5;
// A text readable for this share of the video or more is a persistent label.
const PERSISTENT = 0.5;
// Two readable stretches of one text this close together are one stretch (a blip while moving).
const JOIN_SECONDS = 0.25;

/** The time the end card starts: the last section, when it starts in the second half. Else Infinity. */
export function endCardStart(model) {
  const parts = sections(model);
  const last = parts.at(-1);
  return parts.length > 1 && last.start >= model.duration / 2 ? last.start : Infinity;
}

// Texts the load counts: reading texts with words, not a logo.
const countedTexts = (model) => readingTexts(model).filter((item) => item.role !== "logo" && wordsOf(item.text).length);

const isPersistent = (model, item) => {
  const shown = readableRuns(model, item).reduce((sum, run) => sum + run.length, 0);
  return shown >= PERSISTENT * model.times.length;
};

// Joins runs with short gaps between them.
function joined(list, gap) {
  const out = [];
  for (const run of list) {
    const last = out.at(-1);
    if (last && run.from - last.to - 1 <= gap) Object.assign(last, { to: run.to, length: run.to - last.from + 1 });
    else out.push({ ...run });
  }
  return out;
}

// Per sample: the characters a second each readable text asks for, as [{item, text, rate}].
export function demandBySample(model) {
  const demand = model.times.map(() => []);
  const gap = Math.round(JOIN_SECONDS * model.fps);
  for (const item of countedTexts(model)) {
    for (const { text, textIndex } of stringsOf(item)) {
      const characters = charactersOf(text);
      if (!characters) continue;
      for (const run of joined(readableRuns(model, item, textIndex), gap)) {
        if (run.length < 2) continue;
        const rate = characters / (run.length / model.fps);
        for (let index = run.from; index <= run.to; index += 1) demand[index].push({ item, text, rate });
      }
    }
  }
  return demand;
}

// True when footage plays big enough to watch (a video shown on a quarter of the frame or more).
function footageAt(model, index) {
  const frame = model.width * model.height;
  return model.items.some((item) => item.kind === "video" && !item.isMask && item.samples.opacity[index] >= 0.5 && area(boxAt(item, index)) >= 0.25 * frame);
}

// The texts grouped into blocks: two texts are one block when their boxes, grown by half the
// drawn type size, touch (lines of one paragraph, a list, a title and its subtitle).
function blocksOf(model, items, index) {
  const grown = items.map((item) => {
    const box = boxAt(item, index);
    const pad = drawnSize(model, item) / 2;
    return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
  });
  const group = items.map((_, position) => position);
  const root = (position) => (group[position] === position ? position : (group[position] = root(group[position])));
  for (let a = 0; a < items.length; a += 1)
    for (let b = a + 1; b < items.length; b += 1) {
      const touch = grown[a].x0 <= grown[b].x1 && grown[b].x0 <= grown[a].x1 && grown[a].y0 <= grown[b].y1 && grown[b].y0 <= grown[a].y1;
      if (touch) group[root(a)] = root(b);
    }
  const blocks = new Map();
  items.forEach((item, position) => blocks.set(root(position), [...(blocks.get(root(position)) ?? []), item]));
  return [...blocks.values()];
}

const FIX_CHOICES = "Pick what serves the story: drop a line the voice or the picture already says, merge two lines into one, or move one to its own moment (before or after this one). Waive text_load if the text is the picture here on purpose.";

/** text_load: too much text competing at once (reading rate, and separate texts over footage). */
export function textLoad(model, ctx) {
  const texts = countedTexts(model);
  if (texts.length < 2) return [];
  const endCard = endCardStart(model);
  const findings = [];

  // Reading rate.
  const demand = demandBySample(model);
  const total = (index) => demand[index].reduce((sum, entry) => sum + entry.rate, 0);
  const over = (index) => model.times[index] < endCard && demand[index].length >= 2 && total(index) > LOAD_CPS;
  for (const run of joined(runs(model.times.length, over), Math.round(0.5 * model.fps))) {
    if (run.length < RATE_SECONDS * model.fps) continue;
    let peak = run.from;
    let sum = 0;
    for (let index = run.from; index <= run.to; index += 1) {
      sum += total(index);
      if (total(index) > total(peak)) peak = index;
    }
    const average = sum / run.length;
    const parts = [...demand[peak]].sort((a, b) => b.rate - a.rate);
    const list = parts.map((entry) => `${ctx.name(entry.item)} "${ctx.quote(entry.text)}" ${Math.round(entry.rate)}`).join(", ");
    findings.push({
      rule: "text_load", severity: "warn", itemId: parts[0].item.id, at: sec(model.times[run.from]),
      measured: `${Math.round(average)} characters a second to read for ${sec(run.length / model.fps)} s (${sec(model.times[run.from])} to ${sec(model.times[run.to])} s); at ${sec(model.times[peak])} s: ${list}`,
      required: `the texts on screen together ask for at most ${LOAD_CPS} characters a second (each text's characters ÷ the time it is readable)`,
      message: `Too much to read from ${sec(model.times[run.from])} s: ${parts.length} texts ask for ${Math.round(total(peak))} characters a second together; nobody reads that and watches too.`,
      fix: { kind: "hint", text: FIX_CHOICES },
    });
  }

  // Separate texts over footage.
  const counted = texts.filter((item) => !isPersistent(model, item));
  const blocksAt = model.times.map((time, index) => {
    if (time >= endCard || !footageAt(model, index)) return null;
    const shown = counted.filter((item) => readableAt(model, item, index));
    return shown.length > MAX_BLOCKS ? blocksOf(model, shown, index) : null;
  });
  const crowded = (index) => (blocksAt[index]?.length ?? 0) > MAX_BLOCKS;
  for (const run of joined(runs(model.times.length, crowded), Math.round(0.5 * model.fps))) {
    if (run.length < BLOCK_SECONDS * model.fps) continue;
    let most = run.from;
    for (let index = run.from; index <= run.to; index += 1) if ((blocksAt[index]?.length ?? 0) > (blocksAt[most]?.length ?? 0)) most = index;
    const blocks = blocksAt[most];
    const names = blocks.map((block) => block.map((item) => `${ctx.name(item)} "${ctx.quote(textAt(item, most))}"`).join(" + "));
    findings.push({
      rule: "text_load", severity: "warn", itemId: blocks[0][0].id, at: sec(model.times[run.from]),
      measured: `${blocks.length} separate texts over footage for ${sec(run.length / model.fps)} s (${sec(model.times[run.from])} to ${sec(model.times[run.to])} s): ${names.join("; ")}`,
      required: `at most ${MAX_BLOCKS} separate texts at once over playing footage (a label shown half the video or more and the end card do not count)`,
      message: `${blocks.length} texts compete over the footage from ${sec(model.times[run.from])} s: ${names.join("; ")}.`,
      fix: { kind: "hint", text: FIX_CHOICES },
    });
  }
  return findings;
}

// The string a text shows at a sample (a Change text shows one of its texts).
function textAt(item, index) {
  const shown = item.samples.textIndex?.[index];
  return item.texts && shown != null ? item.texts[shown] : item.text;
}
