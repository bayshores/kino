// Text rules: reading_time (gate), type_min (gate) and hold (warning).
import { charactersOf, drawnSize, headlines, readableRuns, readingTexts, recommendedHold, sec, typeLimits, wordsOf } from "../analysis.js";

export { typeLimits };
import { boxAt, longestRun, roundBox, runs, tweensOf } from "../model.js";

// A text layer's name and what it says, once when its name is already its text.
function labelOf(ctx, item, text) {
  const name = ctx.name(item);
  const said = `"${ctx.quote(text)}"`;
  return name === said ? name : `${name} ${said}`;
}

// Common subtitle timing: 20 characters a second, and never less than 20 frames (at 30 fps).
const CHARACTERS_PER_SECOND = 20;
const MIN_READ_SECONDS = 20 / 30;

// The strings a text shows: one, or each string of a Change text (a Counter counts as one).
export function stringsOf(item) {
  if (!item.texts || item.counter) return [{ text: item.text, textIndex: null }];
  return item.texts.map((text, textIndex) => ({ text, textIndex }));
}

// The tween that hides the text after `time` (its exit), if any.
// (Within two samples: the readable stretch ends a sample or so after the exit starts.)
// The exit that ends a readable stretch: the first fade or exit that starts inside it (or
// just after) and is still running when the text stops being readable. An ease-in exit can
// start well before that moment, since the text stays readable while it begins.
function exitAfter(model, item, readStart, readEnd) {
  const leaving = (tween) => tween.kind !== "in" && (tween.kind === "out" || tween.keys.includes("visible") || tween.keys.includes("opacity"));
  return tweensOf(model, item.id)
    .filter((tween) => leaving(tween) && tween.start >= readStart && tween.end >= readEnd - 2 / model.fps)
    .sort((a, b) => a.start - b.start)[0];
}

function entranceBefore(model, item, time) {
  return tweensOf(model, item.id).filter((tween) => tween.end <= time + 2 / model.fps && tween.kind === "in").at(-1);
}

// Product text (role ui: a UI label, a row, a small caption in the product's own words) is read
// as part of the screen, not as copy: it keeps the contrast check but skips the size, reading
// time and hold checks (launch films show every UI string small and briefly).
const isUiText = (item) => item.role === "ui";

// A line typed letter by letter or word by word is read while it types: the typing up to its
// readable stretch counts, when the whole line then stays at least 20 frames (a viewer finishes
// the last words). Without this a typed prompt had to hold 2.4 s after its last letter, the
// dead spot two viewers flagged.
function typedBefore(model, item, run) {
  const from = model.times[run.from];
  if (run.length / model.fps + 0.5 / model.fps < MIN_READ_SECONDS) return 0;
  const typing = tweensOf(model, item.id).find((tween) => tween.kind === "in" && tween.unit !== "layer" && tween.spread > 0
    && tween.keys.includes("opacity") && Math.abs(tween.end - from) <= 3 / model.fps);
  return typing ? Math.max(0, from - typing.start) : 0;
}

export function readingTime(model, ctx) {
  const findings = [];
  for (const item of readingTexts(model)) {
    if (isUiText(item)) continue;
    for (const { text, textIndex } of stringsOf(item)) {
      if (!String(text ?? "").trim()) continue;
      const required = Math.max(charactersOf(text) / CHARACTERS_PER_SECOND, MIN_READ_SECONDS);
      // Every readable stretch of half a second or more counts (a camera tour shows a card at
      // its stop and again in the pull-back); the longest one counts even when shorter.
      const readable = readableRuns(model, item, textIndex);
      const best = longestRun(readable);
      const summed = readable.filter((run) => run.length >= 0.5 * model.fps).reduce((sum, run) => sum + run.length, 0);
      const measured = best ? Math.max(best.length / model.fps + typedBefore(model, item, best), summed / model.fps) : 0;
      if (measured + 0.5 / model.fps >= required) continue;
      const short = sec(required - measured);
      const at = best ? model.times[best.from] : model.times[item.samples.opacity.findIndex((value) => value >= 0.3)] ?? 0;
      let fix;
      const readEnd = best ? model.times[best.to] : at;
      const exit = exitAfter(model, item, best ? model.times[best.from] : at, readEnd);
      const entrance = best ? entranceBefore(model, item, model.times[best.from]) : null;
      if (exit && exit.end + short <= model.duration + 1e-6)
        fix = { kind: "tween", tweenId: exit.id, itemId: item.id, properties: { start: sec(exit.start + short) }, why: `starts the exit ${short}s later` };
      else if (entrance && entrance.start - short >= 0)
        fix = { kind: "tween", tweenId: entrance.id, itemId: item.id, properties: { start: sec(entrance.start - short) }, why: `starts the entrance ${short}s earlier` };
      else fix = { kind: "hint", text: `Show it ${short}s longer: start its entrance earlier, its exit later, or make the scene longer.` };
      findings.push({
        rule: "reading_time", severity: "error", itemId: item.id, at, bbox: best ? roundBox(boxAt(item, best.from)) : null,
        measured: sec(measured), required: sec(required),
        message: `${labelOf(ctx, item, text)} is readable for ${sec(measured)}s; ${charactersOf(text)} characters need ${sec(required)}s (20 a second).`,
        fix,
      });
    }
  }
  return findings;
}

export function hold(model, ctx) {
  const findings = [];
  for (const item of readingTexts(model)) {
    if (item.role === "logo" || item.role === "caption" || isUiText(item)) continue;
    for (const { text, textIndex } of stringsOf(item)) {
      if (!wordsOf(text).length) continue;
      const shown = longestRun(runs(model.times.length, (index) => item.samples.opacity[index] >= 0.5 && (textIndex === null || item.samples.textIndex?.[index] === textIndex)));
      if (!shown) continue;
      const measured = shown.length / model.fps;
      // A text shown until the end of the video only has the time the video gives it.
      const required = Math.min(recommendedHold(text), model.duration);
      if (measured + 0.5 / model.fps >= required) continue;
      findings.push({
        rule: "hold", severity: "warn", itemId: item.id, at: model.times[shown.from],
        measured: sec(measured), required: sec(required),
        message: `${labelOf(ctx, item, text)} is on screen ${sec(measured)}s; the recommended hold for ${wordsOf(text).length} words is ${sec(required)}s.`,
        fix: { kind: "hint", text: "Keep it on longer, or say less." },
      });
    }
  }
  return findings;
}

export function typeMin(model, ctx) {
  const findings = [];
  const limits = typeLimits(model);
  const heads = new Set(headlines(model).map((item) => item.id));
  for (const item of readingTexts(model)) {
    if (isUiText(item)) continue;
    const headline = heads.has(item.id);
    const required = headline ? limits.headline : limits.body;
    const measured = drawnSize(model, item);
    if (measured + 0.5 >= required) continue;
    const factor = required / Math.max(1, measured);
    const fontSize = Math.ceil((item.fontSize ?? 0) * factor);
    // The box grows with the size, so the text keeps its line breaks: around its anchor (left,
    // middle or right). A box that sizes itself to the text (auto width) needs nothing more.
    const properties = { fontSize };
    if (item.textResize !== "width-height" && item.restWidth > 0) {
      const grow = fontSize / Math.max(1, item.fontSize ?? fontSize);
      // The widest its lines are drawn (in the layer's own pixels), at the new size.
      const run = longestRun(readableRuns(model, item));
      const scale = run ? item.samples.scale[run.from] || 1 : 1;
      const ink = run ? (item.samples.x1[run.from] - item.samples.x0[run.from]) / scale : item.restWidth;
      // A box already wide enough for the bigger lines stays; else it grows, but a box with no
      // group around it stays inside the frame (the lines may wrap then).
      let width = ink * grow + 2 <= item.restWidth ? item.restWidth : Math.ceil(item.restWidth * grow);
      if (!item.parentId) width = Math.min(width, Math.floor(0.9 * model.width));
      if (width !== item.restWidth) {
        const anchor = item.textAlign === "center" ? 0.5 : item.textAlign === "right" ? 1 : 0;
        let x = Math.round(item.restX - (width - item.restWidth) * anchor);
        if (!item.parentId) x = Math.min(Math.max(x, Math.round(0.05 * model.width)), Math.round(0.95 * model.width) - width);
        Object.assign(properties, { width, x });
      }
      if (item.textResize === "fixed" && item.restHeight > 0) properties.height = Math.ceil(item.restHeight * grow);
    }
    findings.push({
      rule: "type_min", severity: "error", itemId: item.id,
      measured: Math.round(measured), required: Math.round(required),
      message: `${ctx.name(item)} is drawn at ${Math.round(measured)}px; ${headline ? "the headline" : "text"} needs at least ${Math.round(required)}px in a ${limits.frame} frame of ${model.width}×${model.height}.`,
      fix: { kind: "item", itemId: item.id, properties, auto: true, why: `size ${fontSize}` },
    });
  }
  return findings;
}
