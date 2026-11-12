// Polish rules: the things a viewer calls sloppy even when every gate passes. They came from a
// trailer that passed check and was judged "horrible":
//   font_fallback (gate)   a text drawn in another face than the one asked for
//   text_wrap              a short title that breaks, punctuation alone on a line, an orphan
//   text_collision (gate)  two texts (or a text and another text's plate) touching on screen
//   text_ghost (gate)      two texts crossfading in one place, so their letters mix
//   cut_off_at_rest        a picture or device cut by, or crowding, the frame edge while still
//   held_static            nothing moves on screen for more than 1.5 s
//   off_brand_font         text outside the brand's fonts, or 3+ type families with no brand
//   text_on_busy (rendered)    text over fine detail (a phone screen, a busy recording)
//   small_on_empty (rendered)  the picture is a small island on a flat empty frame (a hint, no auto fix)
//   render_artifact (rendered) flat saturated slabs an RGB split draws over the picture
// The rendered ones share the frames the contrast check renders (ctx.renderFrames caches them).
import { atFullOpacity, coversFrame, drawnSize, headlines, inMask, inRest, isHelperLayer, maxOpacity, readableFloor, readableRuns, readingTexts, sec, shownShare, wordsOf } from "../analysis.js";
import { area, boxAt, chainOf, fillColorsAt, hexRgba, intersection, itemById, longestRun, luminance, overlapArea, roundBox, runs, tweensOf, visibleBoxAt } from "../model.js";
import { coveredAt } from "../techniques.js";
import { looksLikeScreen } from "../../imageFacts.js";
import { frozenStretches } from "./screens.js";
import { coveringItems } from "../pixels.js";
import { safeRect } from "./layout.js";
import { volumeAt } from "../../animation.js";
import { mediaPlaybackRange } from "../../playback.js";

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
const frameShare = (model, box) => area(intersection(box, FRAME(model))) / (model.width * model.height);
const percent = (value) => `${Math.round(value * 100)}%`;
const familyKey = (family) => String(family ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
const seconds = (model, run) => run.length / model.fps;
const spanOf = (model, run) => ({ at: sec(model.times[run.from]), until: sec(model.times[run.to]) });
// Samples in `fraction` of a second, at least one.
const samplesIn = (model, fraction) => Math.max(1, Math.round(fraction * model.fps));
// The brand's font families (set_brand fonts, or the fonts the brief names).
const brandFamilies = (ctx) => (ctx.brandFonts ?? []).map((font) => (typeof font === "string" ? font : font?.family)).filter(Boolean);
// Where the layer's x sits for a text aligned this way: 0 left, 0.5 center, 1 right.
const anchorOf = (item) => (item.textAlign === "center" ? 0.5 : item.textAlign === "right" ? 1 : 0);

// ---------------------------------------------------------------- font_fallback

/**
 * A text the renderer cannot draw in the face it asks for: the family is not loaded (it draws in
 * Inter or another family) or the weight is not (it draws the nearest weight, 100 or more away).
 * One finding per asked face, naming every layer that asks for it.
 */
export function fontFallback(model, ctx) {
  const byFace = new Map();
  const axesOff = [];
  for (const item of readingTexts(model)) {
    const font = item.font;
    if (!font) continue;
    const familyOff = !font.sameFamily;
    const weightOff = Math.abs(font.drawnWeight - font.weight) >= 100;
    const styleOff = font.drawnStyle !== font.style;
    // Axes (fontAxes.js) the face drawn does not have: the variable face did not load.
    if (!familyOff && !weightOff && !styleOff && font.missingAxes?.length) {
      axesOff.push({ item, font });
      continue;
    }
    if (!familyOff && !weightOff && !styleOff) continue;
    const key = `${familyKey(font.family)}|${font.weight}|${font.style}`;
    if (!byFace.has(key)) byFace.set(key, { font, items: [], familyOff });
    byFace.get(key).items.push(item);
  }
  const brand = brandFamilies(ctx);
  const axisFindings = axesOff.map(({ item, font }) => ({
    rule: "font_fallback", severity: "error", itemId: item.id, itemIds: [item.id],
    measured: `${font.drawnFamily} has no ${font.missingAxes.join(", ")} axis`, required: `a variable ${font.family} with ${font.missingAxes.join(", ")}`,
    message: `${ctx.name(item)} asks for the ${font.missingAxes.join(", ")} axis, but the ${font.drawnFamily} face loaded is not variable on it, so the axes do nothing. Import the variable ${font.family} file, or remove axes.`,
  }));
  return [...axisFindings, ...[...byFace.values()].map(({ font, items, familyOff }) => {
    const face = (family, weight, style) => `${family} ${weight}${style === "italic" ? " italic" : ""}`;
    const asked = face(font.family, font.weight, font.style);
    const drawn = face(font.drawnFamily, font.drawnWeight, font.drawnStyle);
    const names = items.slice(0, 4).map((item) => ctx.name(item)).join(", ") + (items.length > 4 ? ` and ${items.length - 4} more` : "");
    const itemIds = items.map((item) => item.id);
    // The automatic fix asks for a face kino has: the nearest loaded weight of the same family,
    // else the brand's first font (at the nearest weight it has), else the face it draws now.
    const fix = !familyOff ? { kind: "font", itemIds, family: font.family, weight: font.drawnWeight, style: font.drawnStyle, auto: true, why: `the nearest weight loaded (${font.drawnWeight})` }
      : brand.length ? { kind: "font", itemIds, family: brand[0], weight: font.weight, nearest: true, auto: true, why: `the brand font ${brand[0]}` }
      : { kind: "font", itemIds, family: font.drawnFamily, weight: font.drawnWeight, style: font.drawnStyle, auto: true, why: `the face it draws in now (${drawn})` };
    return {
      rule: "font_fallback", severity: "error", itemId: items[0].id, itemIds,
      measured: `drawn in ${drawn}`, required: asked,
      message: `${names} ${items.length === 1 ? "asks" : "ask"} for ${asked}, which is not loaded, so ${items.length === 1 ? "it draws" : "they draw"} in ${drawn}${familyOff ? ", another typeface" : `, the nearest weight kino has`}. The fix asks for a face kino has; to get ${asked} instead, set_font it again when the font catalog has it.`,
      fix,
    };
  })];
}

// ---------------------------------------------------------------- text_wrap

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

// What is wrong with one set of lines, or null: a title of 1 to 3 words that the layout wraps,
// a line that is only punctuation, or a last line of one short word under a much longer line.
function wrapProblem(item, lines) {
  if (!lines.some((line) => line.soft)) return null;
  const words = wordsOf(item.text).length;
  const lone = lines.find((line, index) => index > 0 && lines[index - 1].soft && PUNCTUATION_ONLY.test(line.text));
  if (lone) return { kind: "punctuation", severity: "error", text: `"${lone.text}" alone on a line` };
  // One word broken over lines is always wrong; a 2 or 3 word title stacked by the wrap may be
  // on purpose (a slam title), so it is a warning.
  if (words <= 3) return { kind: "title", severity: words === 1 ? "error" : "warn", text: `a ${words}-word title broken over ${lines.length} lines` };
  for (let index = 1; index < lines.length; index += 1) {
    const [above, line] = [lines[index - 1], lines[index]];
    if (!above.soft || line.soft) continue;
    if (wordsOf(line.text).length === 1 && line.width <= 0.4 * above.width)
      return { kind: "orphan", severity: "warn", text: `"${line.text}" alone under "${above.text}"` };
  }
  return null;
}

// The fix for a wrapped text: the width that fits it on one line (inside the safe area), or the
// narrowest width that balances its lines. A title of 1 to 3 words too wide for one line gets a
// smaller size that fits, when that size is still over the type minimum. Applied automatically
// only when the layer's own box is in frame pixels (no group around it, drawn at its own size).
function wrapFix(model, item, run, safe) {
  const hint = { kind: "hint", text: "Make the text box wider, set fewer words per line, or put a line break where it reads best." };
  const widths = item.wrapWidths;
  if (!widths || item.textResize === "width-height") return hint;
  const scale = item.samples.scale[run.from] || 1;
  const plain = !item.parentId && Math.abs(scale - 1) < 0.02;
  const anchor = anchorOf(item);
  const safeWidth = safe.x1 - safe.x0;
  // Keeps the text's anchor (its left, middle or right) where it is, then pulls the box inside the safe area.
  const place = (width) => {
    const x = item.restX - (width - item.restWidth) * anchor;
    return Math.round(plain ? Math.min(Math.max(x, safe.x0), safe.x1 - width) : x);
  };
  const fitsOne = widths.oneLine * scale <= safeWidth;
  if (fitsOne || wordsOf(item.text).length > 3) {
    const width = fitsOne ? widths.oneLine : widths.balanced;
    if (Math.abs(width - item.restWidth) < 2) return hint;
    return { kind: "item", itemId: item.id, properties: { width, x: place(width) }, auto: plain && width * scale <= safeWidth,
      why: fitsOne ? "width fits one line" : `width balances its ${widths.lines} lines` };
  }
  // The same floor type_min holds it to: the headline share only for a text marked role headline.
  const floor = readableFloor(model);
  const least = (item.role === "headline" ? floor.headline : floor.body) / scale;
  const size = Math.floor((item.fontSize * (safeWidth / scale - 4)) / widths.oneLine);
  if (size < least) return { kind: "hint", text: `It is too long for one line at a readable size (${Math.ceil(least)}px or more): say it in fewer letters, or set the line break yourself.` };
  const width = Math.min(Math.floor(safeWidth / scale), Math.ceil((widths.oneLine * size) / item.fontSize) + 4);
  return { kind: "item", itemId: item.id, properties: { fontSize: size, width, x: place(width) }, auto: plain, why: `size ${size} fits one line` };
}

export function textWrap(model, ctx) {
  const findings = [];
  const safe = safeRect(model);
  for (const item of readingTexts(model)) {
    if (!item.lineSets?.length) continue;
    const problems = item.lineSets.map((lines) => wrapProblem(item, lines));
    if (!problems.some(Boolean)) continue;
    // The longest stretch the text shows a wrong set of lines at full opacity.
    const run = longestRun(runs(model.times.length, (index) => atFullOpacity(item, index) && Boolean(problems[item.samples.lineSet[index]])));
    if (!run || seconds(model, run) < 0.2) continue;
    const problem = problems[item.samples.lineSet[run.from]];
    const lines = item.lineSets[item.samples.lineSet[run.from]];
    // The fix: the width that fits it on one line when that fits in the safe zone, else the
    // narrowest width that keeps its line count (balanced lines, no orphan).
    const fix = wrapFix(model, item, run, safe);
    findings.push({
      rule: "text_wrap", severity: problem.severity, itemId: item.id, ...spanOf(model, run), bbox: roundBox(boxAt(item, run.from)),
      measured: problem.text, required: problem.kind === "orphan" ? "no one-word last line" : "no wrap",
      message: `${ctx.name(item)} wraps as ${lines.map((line) => `"${line.text}"`).join(" / ")}: ${problem.text} (${sec(seconds(model, run))}s).`,
      fix,
    });
  }
  return findings;
}

// ---------------------------------------------------------------- text_collision

// A plate: a painted shape drawn just under a text that holds it (a pill, a tile, a card), no
// more than 6 times the text's area and 15% of the frame. Its edge belongs to the text.
function platesOf(model, text, index, shapes) {
  const box = boxAt(text, index);
  const size = area(box);
  if (!size) return [];
  return shapes.filter((shape) => shape.z < text.z && shape.samples.opacity[index] >= 0.3 && !chainOf(model, text).includes(shape)
    && overlapArea(boxAt(shape, index), box) >= 0.9 * size
    && area(boxAt(shape, index)) <= 6 * size && frameShare(model, boxAt(shape, index)) <= 0.15);
}

const sharesBox = (a, b) => {
  const shared = intersection(a, b);
  return shared.x1 - shared.x0 >= 2 && shared.y1 - shared.y0 >= 2;
};

// How much a text matters when two collide: a caption least, a headline, logo or call to action most.
function textPriority(item) {
  if (item.role === "caption") return 0;
  return ["headline", "logo", "cta"].includes(item.role) ? 2 : 1;
}
const firstShown = (item) => item.samples.opacity.findIndex((value) => value >= 0.5);

/** [mover, keeper] of two colliding texts: the lower priority one moves, else the later one, else the one on top. */
export function collisionMover(model, one, two) {
  const rank = (item) => [textPriority(item), -firstShown(item), -item.z];
  const [a, b] = [rank(one), rank(two)];
  for (let key = 0; key < a.length; key += 1) if (a[key] !== b[key]) return a[key] < b[key] ? [one, two] : [two, one];
  return [two, one];
}

const shifted = (box, dx, dy) => ({ x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy });
const padded = (box, pad) => ({ x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad });
const unionOf = (boxes) => boxes.reduce((all, box) => ({ x0: Math.min(all.x0, box.x0), y0: Math.min(all.y0, box.y0), x1: Math.max(all.x1, box.x1), y1: Math.max(all.y1, box.y1) }));
const insideRect = (box, rect) => box.x0 >= rect.x0 - 0.5 && box.y0 >= rect.y0 - 0.5 && box.x1 <= rect.x1 + 0.5 && box.y1 <= rect.y1 + 0.5;

/**
 * The nearest move {dx, dy} (in frame pixels) that puts `group` (a text and what moves with it)
 * where, at every sample it shows, nothing in `obstaclesAt(index)` is within `gap`, and that keeps
 * it inside the safe area wherever it is fully shown. `first` orders the directions tried
 * ("up" or "down" first). Null when no place in the frame works. `allowed(dx, dy)`, if given,
 * can turn down a place for other reasons (busy detail behind it).
 */
export function freeSpot(model, group, { gap, obstaclesAt, first = "up", allowed = null }) {
  const safe = safeRect(model);
  const showing = (index) => group.filter((item) => item.samples.opacity[index] >= 0.05);
  const shown = [];
  for (let index = 0; index < model.times.length; index += 1) if (showing(index).length) shown.push(index);
  if (!shown.length) return null;
  // At most 160 samples are tested: plenty for texts that rest most of their time.
  const every = Math.max(1, Math.ceil(shown.length / 160));
  const tests = shown.filter((_, position) => position % every === 0 || position === shown.length - 1).map((index) => ({
    box: unionOf(showing(index).map((item) => boxAt(item, index))), still: showing(index).some((item) => atFullOpacity(item, index)),
    obstacles: obstaclesAt(index).map((box) => padded(box, gap)),
  }));
  const fits = (dx, dy) => tests.every(({ box, still, obstacles }) => {
    const moved = shifted(box, dx, dy);
    if (still && !insideRect(moved, safe)) return false;
    return !obstacles.some((other) => sharesBox(moved, other));
  }) && (!allowed || allowed(dx, dy));
  const step = Math.max(4, Math.round(gap / 2));
  const reach = Math.max(model.width, model.height);
  for (let distance = step; distance <= reach; distance += step) {
    const vertical = first === "down" ? [[0, distance], [0, -distance]] : [[0, -distance], [0, distance]];
    for (const [dx, dy] of [...vertical, [-distance, 0], [distance, 0]]) if (fits(dx, dy)) return { dx, dy };
  }
  return null;
}

// The fix for a collision: move the mover (and a plate only it sits on) to the nearest free
// place in the safe area; if there is none, end it before the collision, or start it after.
function collisionFix(model, mover, run, at, { texts, platesFor }) {
  const scale = mover.samples.scale[at] || 1;
  const gap = Math.max(4, Math.round(0.25 * (mover.fontSize ?? 40) * scale));
  const others = texts.filter((text) => text !== mover);
  const carried = platesFor(mover, at).filter((plate) => !others.some((text) => text.samples.opacity[at] >= 0.05 && overlapArea(boxAt(plate, at), boxAt(text, at)) > 0));
  const obstaclesAt = (index) => others.filter((text) => text.samples.opacity[index] >= 0.05)
    .flatMap((text) => [boxAt(text, index), ...platesFor(text, index).filter((plate) => !carried.includes(plate)).map((plate) => boxAt(plate, index))]);
  const box = boxAt(mover, at);
  const keeperBoxes = obstaclesAt(at);
  const keeperMiddle = keeperBoxes.length ? (unionOf(keeperBoxes).y0 + unionOf(keeperBoxes).y1) / 2 : 0;
  const spot = freeSpot(model, [mover, ...carried], { gap, obstaclesAt, first: keeperMiddle <= (box.y0 + box.y1) / 2 ? "down" : "up" });
  if (spot) {
    const moves = [mover, ...carried].map((item) => ({ kind: "move", itemId: item.id, dx: Math.round(spot.dx), dy: Math.round(spot.dy) }));
    return { kind: "group", changes: moves, auto: true, why: `moved ${Math.round(Math.hypot(spot.dx, spot.dy))}px to a free place` };
  }
  const shown = runs(model.times.length, (index) => mover.samples.opacity[index] >= 0.05).find((span) => span.from <= run.from && span.to >= run.to);
  const half = samplesIn(model, 0.5);
  if (shown && run.from - shown.from >= half)
    return { kind: "retime", itemId: mover.id, end: sec(model.times[run.from]), auto: true, why: `leaves at ${sec(model.times[run.from])}s, before it would touch` };
  if (shown && shown.to - run.to >= half)
    return { kind: "retime", itemId: mover.id, start: sec(model.times[Math.min(shown.to, run.to + 1)]), auto: true, why: `comes on at ${sec(model.times[run.to + 1] ?? model.duration)}s, after the other` };
  return { kind: "hint", text: "There is no free place in the safe area while both show: make one of them smaller or shorter." };
}

export function textCollision(model, ctx) {
  const texts = readingTexts(model).filter((item) => !item.allowOverlap);
  if (texts.length < 2) return [];
  const shapes = model.items.filter((item) => item.painted && !item.isMask && item.kind !== "text" && item.kind !== "image" && item.kind !== "video" && !coversFrame(model, item));
  const findings = [];
  const count = model.times.length;
  const platesAt = new Map();
  const platesFor = (text, index) => {
    const key = `${text.id}@${index}`;
    if (!platesAt.has(key)) platesAt.set(key, platesOf(model, text, index, shapes));
    return platesAt.get(key);
  };
  for (let a = 0; a < texts.length; a += 1) {
    for (let b = a + 1; b < texts.length; b += 1) {
      const [one, two] = [texts[a], texts[b]];
      let what = null;
      const touching = (index) => {
        if (one.samples.opacity[index] < 0.5 || two.samples.opacity[index] < 0.5) return false;
        const [inkOne, inkTwo] = [boxAt(one, index), boxAt(two, index)];
        const inkShared = overlapArea(inkOne, inkTwo);
        // A large overlap of the letters themselves is the overlap rule's.
        if (inkShared >= 0.02 * Math.min(area(inkOne), area(inkTwo))) return false;
        if (inkShared > 0 && sharesBox(inkOne, inkTwo)) { what ??= { index, plate: null }; return true; }
        const [platesOne, platesTwo] = [platesFor(one, index), platesFor(two, index)];
        // A plate that holds both texts is a shared card, not a collision: the shape counts as
        // each text's plate, or it holds most of the other text's letters too.
        const holds = (plate, text) => overlapArea(boxAt(plate, index), boxAt(text, index)) >= 0.9 * area(boxAt(text, index));
        const own = (list, others, other) => list.filter((plate) => !others.includes(plate) && !holds(plate, other));
        for (const plate of own(platesTwo, platesOne, one)) if (sharesBox(inkOne, boxAt(plate, index))) { what ??= { index, plate, owner: two, other: one }; return true; }
        for (const plate of own(platesOne, platesTwo, two)) if (sharesBox(inkTwo, boxAt(plate, index))) { what ??= { index, plate, owner: one, other: two }; return true; }
        return false;
      };
      const run = longestRun(runs(count, touching));
      if (!run) continue;
      const at = what?.index ?? run.from;
      // The text of lower priority moves: a caption before a title or a status line, else the
      // one that comes on later, else the one drawn on top.
      const [mover, keeper] = collisionMover(model, one, two);
      const by = what?.plate ? ` touches ${ctx.name(what.owner)}'s plate ${ctx.name(what.plate)}` : " touches";
      const subject = what?.plate ? what.other : mover;
      const severity = seconds(model, run) >= 0.2 ? "error" : "info";
      findings.push({
        rule: "text_collision", severity, itemId: mover.id, otherId: keeper.id,
        ...spanOf(model, run), bbox: roundBox(intersection(boxAt(mover, at), what?.plate ? boxAt(what.plate, at) : boxAt(keeper, at))),
        measured: `${sec(seconds(model, run))}s touching`, required: "a clear gap between texts",
        message: `${ctx.name(subject)}${by}${what?.plate ? "" : ` ${ctx.name(subject === mover ? keeper : mover)}`} from ${sec(model.times[run.from])}s to ${sec(model.times[run.to])}s, so they read as one jumbled block.`,
        fix: collisionFix(model, mover, run, at, { texts, platesFor }),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- text_ghost

// The words a text shows at a sample (a text that changes shows one of `texts`), for comparing.
const wordsAt = (item, index) => String(item.texts?.[item.samples.textIndex?.[index]] ?? item.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const middleOf = (box) => [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];

// True when the text leaves by moving or by a mask or reveal during the run (a slide or mask
// swap): it travels a quarter of its height, or what its mask shows of it changes by a quarter.
function swapsAway(model, item, run, { moving = true } = {}) {
  const start = boxAt(item, run.from);
  const [x, y] = middleOf(start);
  const shown = (index) => area(visibleBoxAt(model, item, index));
  const revealed = tweensOf(model, item.id).some((tween) => tween.keys.includes("reveal") && tween.start < model.times[run.to] && tween.end > model.times[run.from]);
  if (revealed) return true;
  for (let index = run.from; index <= run.to; index += 1) {
    const [mx, my] = middleOf(boxAt(item, index));
    if (moving && Math.hypot(mx - x, my - y) >= 0.25 * Math.max(1, start.y1 - start.y0)) return true;
    if (item.clipIds?.length && Math.abs(shown(index) - shown(run.from)) >= 0.25 * Math.max(1, shown(run.from), shown(index))) return true;
  }
  return false;
}

// The fix for a ghost: the incoming text's entrance starts as the outgoing one has faded out
// (a pure timing shift, so auto) when it still finishes before the incoming text leaves.
function ghostFix(model, outgoing, incoming, run) {
  let gone = run.to + 1;
  while (gone < model.times.length && outgoing.samples.opacity[gone] > 0.05) gone += 1;
  const entrances = tweensOf(model, incoming.id).filter((tween) => tween.kind === "in");
  const offset = { kind: "hint", text: "Stagger them (the old text fully out before the new one starts, or a 0.1 s gap), or set one in another place." };
  if (gone >= model.times.length || !entrances.length) return offset;
  const start = sec(model.times[gone]);
  const delay = start - Math.min(...entrances.map((tween) => tween.start));
  const settled = Math.max(...entrances.map((tween) => tween.end)) + delay;
  const leaves = tweensOf(model, incoming.id).filter((tween) => tween.kind === "out" && tween.start >= model.times[run.to]).map((tween) => tween.start);
  if (delay <= 0 || (leaves.length && settled + 0.3 > Math.min(...leaves))) return offset;
  return { kind: "retime", itemId: incoming.id, start, auto: true, why: `its entrance starts at ${start}s, after the old text is gone` };
}

/**
 * Two different texts seen in the same place at once while one fades: "measure" dissolving out
 * as "plan" dissolves in reads "plasure". Fires when both are over 25% opacity, one of them
 * mid-fade, their seen boxes sharing over 30% of the smaller one, for more than 2 output
 * frames. A swap that slides or masks the old text away, the same words twice (a shadow copy)
 * and allowOverlap layers are left alone; a large overlap at full opacity is the overlap rule's.
 */
export function textGhost(model, ctx) {
  const texts = readingTexts(model).filter((item) => !item.allowOverlap);
  const findings = [];
  const count = model.times.length;
  const least = 2 / (ctx.outputFps || 30);
  for (let a = 0; a < texts.length; a += 1) {
    for (let b = a + 1; b < texts.length; b += 1) {
      const [one, two] = [texts[a], texts[b]];
      // Two whole shots dissolving (each text inside its own full-frame group, as sequence's
      // crossfade makes): the pictures mix too, which reads as a dissolve, not a ghost word.
      const shotOf = (item) => chainOf(model, item).slice(1).find((parent) => coversFrame(model, parent));
      if (shotOf(one) && shotOf(two) && shotOf(one) !== shotOf(two)) continue;
      const ghosted = (index) => {
        const [p, q] = [one.samples.opacity[index], two.samples.opacity[index]];
        if (p <= 0.25 || q <= 0.25 || Math.min(p, q) >= 0.95 * Math.min(maxOpacity(one), maxOpacity(two))) return false;
        if (wordsAt(one, index) === wordsAt(two, index)) return false;
        // Letters mix into one word when they are drawn near one size and at least one is sharp
        // ("plan" blurred in over a sharp "measure"): a zoom through (one 1.4x the
        // other) or a blur dissolve (both blurred over 10% of their size) is left alone.
        const sizes = [one, two].map((item) => (item.fontSize ?? 0) * (item.samples.scale[index] || 0));
        if ([one, two].every((item, k) => item.samples.blur[index] > 0.1 * sizes[k]) || Math.max(...sizes) > 1.4 * Math.min(...sizes)) return false;
        const [boxOne, boxTwo] = [visibleBoxAt(model, one, index), visibleBoxAt(model, two, index)];
        const smaller = Math.min(area(boxOne), area(boxTwo));
        return smaller > 0 && overlapArea(boxOne, boxTwo) > 0.3 * smaller;
      };
      const run = longestRun(runs(count, ghosted));
      if (!run || run.length / model.fps <= least + 1e-6) continue;
      const shownFrom = (item) => item.samples.opacity.findIndex((value) => value > 0.25);
      const [outgoing, incoming] = shownFrom(one) < shownFrom(two) || (shownFrom(one) === shownFrom(two) && one.z <= two.z) ? [one, two] : [two, one];
      if (swapsAway(model, outgoing, run) || swapsAway(model, incoming, run, { moving: false })) continue;
      const box = intersection(visibleBoxAt(model, outgoing, run.from), visibleBoxAt(model, incoming, run.from));
      findings.push({
        rule: "text_ghost", severity: "error", itemId: incoming.id, otherId: outgoing.id,
        ...spanOf(model, run), bbox: roundBox(box),
        measured: `${sec(seconds(model, run))}s both seen in one place`, required: "one text gone before the next shows there",
        message: `${ctx.name(outgoing)} fades out while ${ctx.name(incoming)} fades in on top of it from ${sec(model.times[run.from])}s to ${sec(model.times[run.to])}s, so for a moment their letters mix into a ghost word.`,
        fix: ghostFix(model, outgoing, incoming, run),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- cut_off_at_rest

// Pictures that matter: a video or image, or a group holding one (a phone mockup, a card), whose
// usual size (the median while its picture shows) is `least` of the frame or more and under 70%
// (not a full-bleed background). Only the outermost counts. Memoized on the model.
function importantPictures(model, least = 0.08) {
  model._pictures ??= new Map();
  if (model._pictures.has(least)) return model._pictures.get(least);
  const media = new Map();
  for (const item of model.items)
    if ((item.kind === "video" || item.kind === "image") && !item.isMask)
      for (const entry of chainOf(model, item)) {
        if (!media.has(entry.id)) media.set(entry.id, []);
        media.get(entry.id).push(item);
      }
  const usual = (item) => {
    const shares = [];
    for (let index = 0; index < model.times.length; index += 1)
      if (pictureShown(model, item, index, media)) shares.push(frameShare(model, visibleBoxAt(model, item, index)));
    if (!shares.length) return 0;
    shares.sort((a, b) => a - b);
    return shares[Math.floor(shares.length / 2)];
  };
  const candidates = model.items.filter((item) => media.has(item.id) && !item.isMask && !coversFrame(model, item)
    && (item.kind === "group" || item.kind === "video" || item.kind === "image")).filter((item) => {
    const share = usual(item);
    return share >= least && share < 0.7;
  });
  const ids = new Set(candidates.map((item) => item.id));
  const found = candidates.filter((item) => !chainOf(model, item).slice(1).some((parent) => ids.has(parent.id)));
  for (const item of found) item._media = media.get(item.id);
  model._pictures.set(least, found);
  return found;
}

// True when the picture (or a picture in the group) shows at a sample.
function pictureShown(model, item, index, media = null) {
  const list = media ? media.get(item.id) : item._media ?? [item];
  return item.samples.opacity[index] >= 0.3 && list.some((entry) => entry.samples.opacity[index] >= 0.3);
}

// True when the item's box barely moves around this sample: its edges move under 1% of the
// frame diagonal a second (a gentle float still counts as resting).
function restingAt(model, item, index, diagonal) {
  const lag = samplesIn(model, 0.25);
  const [a, b] = [Math.max(0, index - lag), Math.min(model.times.length - 1, index + lag)];
  if (a === b) return true;
  const [one, two] = [visibleBoxAt(model, item, a), visibleBoxAt(model, item, b)];
  const moved = Math.max(Math.abs(one.x0 - two.x0), Math.abs(one.y0 - two.y0), Math.abs(one.x1 - two.x1), Math.abs(one.y1 - two.y1));
  return (moved * model.fps) / (b - a) <= 0.01 * diagonal;
}

// Rounds a move away from zero, so a box moved by it ends up fully inside.
const outward = (value) => (value > 0 ? Math.ceil(value) : value < 0 ? Math.floor(value) : 0);

/**
 * The fix that puts a box (where a layer rests) inside the safe area: a move when it fits, else a
 * scale around its middle (keeping its shape, 1% under the most that fits) and a move.
 */
export function fitInside(box, safe, itemId) {
  const [width, height] = [box.x1 - box.x0, box.y1 - box.y0];
  const most = Math.min((safe.x1 - safe.x0) / width, (safe.y1 - safe.y0) / height);
  const scale = most < 1 ? Math.floor(most * 0.99 * 1000) / 1000 : 1;
  const [middleX, middleY] = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  const sized = { x0: middleX - (width * scale) / 2, y0: middleY - (height * scale) / 2, x1: middleX + (width * scale) / 2, y1: middleY + (height * scale) / 2 };
  const dx = outward(sized.x0 < safe.x0 ? safe.x0 - sized.x0 : sized.x1 > safe.x1 ? safe.x1 - sized.x1 : 0);
  const dy = outward(sized.y0 < safe.y0 ? safe.y0 - sized.y0 : sized.y1 > safe.y1 ? safe.y1 - sized.y1 : 0);
  if (scale === 1) return { kind: "move", itemId, dx, dy, auto: true, why: `moved ${Math.round(Math.hypot(dx, dy))}px inside the safe area` };
  return { kind: "transform", itemId, scale, dx, dy, auto: true, why: `scaled to ${Math.round(scale * 100)}% to sit inside the safe area` };
}

export function cutOffAtRest(model, ctx) {
  const findings = [];
  const safe = safeRect(model);
  const diagonal = Math.hypot(model.width, model.height);
  for (const item of importantPictures(model)) {
    // How far it crosses the frame edge (a share cut off) or how close it sits inside the margin.
    const problemAt = (index) => {
      if (!atFullOpacity(item, index) || !pictureShown(model, item, index) || coveredAt(model, item, index)) return null;
      // What is seen: a video cut by its mask or tile is judged by the tile, not the whole video.
      const box = visibleBoxAt(model, item, index);
      const whole = area(box);
      if (!whole) return null;
      const cut = 1 - area(intersection(box, FRAME(model))) / whole;
      // Mostly outside: a deliberate bleed, or on its way in or out.
      if (cut > 0.3) return null;
      if (!restingAt(model, item, index, diagonal)) return null;
      const gaps = { left: box.x0, top: box.y0, right: model.width - box.x1, bottom: model.height - box.y1 };
      const margins = { left: safe.x0, top: safe.y0, right: model.width - safe.x1, bottom: model.height - safe.y1 };
      const side = Object.keys(gaps).reduce((worst, key) => (gaps[key] / margins[key] < gaps[worst] / margins[worst] ? key : worst));
      if (gaps[side] >= margins[side] - 0.5) return null;
      // Flush with the edge (no gap, nothing cut): anchored to the frame on purpose.
      if (Math.abs(gaps[side]) <= 0.5) return null;
      return { cut, side, gap: gaps[side], margin: margins[side], box };
    };
    const found = new Map();
    const spans = runs(model.times.length, (index) => {
      const problem = problemAt(index);
      if (problem) found.set(index, problem);
      return Boolean(problem);
    }).filter((span) => seconds(model, span) >= 1);
    const run = longestRun(spans);
    if (!run) continue;
    const total = spans.reduce((sum, span) => sum + seconds(model, span), 0);
    const all = spans.length > 1 ? ` (${sec(total)}s in all, in ${spans.length} stretches from ${sec(model.times[spans[0].from])}s to ${sec(model.times[spans.at(-1).to])}s)` : "";
    let worst = null;
    for (let index = run.from; index <= run.to; index += 1) {
      const problem = found.get(index);
      if (problem && (!worst || problem.gap < worst.gap)) worst = { ...problem, index };
    }
    const { side } = worst;
    // Every box it rests in (all its stretches), so one move or scale fits them all.
    const rest = unionOf([...found.values()].map((problem) => problem.box));
    const measured = worst.cut > 0.005 ? `${percent(worst.cut)} cut off at the ${side}` : `${Math.round(worst.gap)}px from the ${side} edge`;
    findings.push({
      rule: "cut_off_at_rest", severity: "warn", itemId: item.id, ...spanOf(model, run), bbox: roundBox(worst.box),
      measured, required: `inside the ${Math.round(worst.margin)}px margin, or clearly bleeding off`,
      message: `${ctx.name(item)} sits ${measured} for ${sec(seconds(model, run))}s${all} while it is still: it looks cut off or cramped against the frame.`,
      fix: clippedFix(model, item, fitInside(rest, safe, item.id)),
    });
  }
  return findings;
}

// A picture seen through a mask or a clipping group moves with it: the fix moves the mask group
// (or the clipping group). A mask that is not in a mask group only gets a hint.
function clippedFix(model, item, fix) {
  const clip = itemById(model, item.clipIds?.at(-1));
  if (!clip) return fix;
  const holder = clip.kind === "group" ? clip : itemById(model, clip.parentId);
  if (holder && (holder === clip || holder.maskId === clip.id)) return { ...fix, itemId: holder.id };
  return { kind: "hint", text: `Move ${item.name ?? item.id} together with its mask ${clip.name ?? clip.id} (group them as a mask group), inside the safe area.` };
}

// ---------------------------------------------------------------- held_static

const STILL_SECONDS = 1.5;

/** The file facts of a picture that reads as a screenshot (engine/imageFacts.js), or null. */
export function screenSize(ctx, item) {
  const size = item.kind === "image" && item.src ? ctx.mediaSizes?.[item.src] : null;
  return size && looksLikeScreen(size) ? size : null;
}

// True when something on screen visibly moves at a sample: a playing clip, particles, an effect
// running, or a layer whose edges move fast enough to see: 1% of the frame diagonal a second
// (0.4% for a picture filling 30% of the frame or more), or that fades.
export function motionAt(model, index, { creep = true } = {}) {
  return model.items.some((item) => layerMovingAt(model, item, index, 0.002, { creep }));
}

/**
 * True when this one layer visibly moves at a sample (motionAt's test). Layers under `least` of
 * the frame do not count; frozen_screen counts a cursor of any size (least 0).
 */
export function layerMovingAt(model, item, index, least = 0.002, { creep = true } = {}) {
  if (item.isMask || item.kind === "group") return false;
  const before = Math.max(0, index - samplesIn(model, 0.5));
  const time = model.times[index];
  const opacity = item.samples.opacity[index];
  // A text being typed letter by letter reads as hidden (its last letter's state) yet changes.
  if (opacity < 0.05 && item.samples.opacity[before] < 0.05 && !item.samples.moving?.[index]) return false;
  const box = boxAt(item, index);
  const share = frameShare(model, box);
  if (share < least || share <= 0 || coveredAt(model, item, index)) return false;
  if (item.kind === "video" && opacity >= 0.3 && share >= 0.03 && !frozenAt(model, item, time)) return true;
  // Set only where the layer is drawn (particles, trims) or being revealed (typed text).
  if (item.samples.moving?.[index]) return true;
  if (opacity >= 0.05 && tweensOf(model, item.id).some((tween) => tween.keys.some((key) => key.startsWith("effect.")) && time > tween.start && time < tween.end)) return true;
  if (before === index) return false;
  if (Math.abs(opacity - item.samples.opacity[before]) >= 0.08) return true;
  const old = boxAt(item, before);
  const moved = Math.max(Math.abs(box.x0 - old.x0), Math.abs(box.y0 - old.y0), Math.abs(box.x1 - old.x1), Math.abs(box.y1 - old.y1));
  const speed = (moved * model.fps) / (index - before) / Math.hypot(model.width, model.height);
  // creep: false leaves out the large picture's lower bar (a slow push counts as still).
  return speed >= 0.01 || (creep && share >= 0.3 && speed >= 0.004);
}

// A clip frozen by a Speed animation that reaches 0, until a later one plays it again
// (freeze-shutter's release).
export function frozenAt(model, item, time) {
  const last = (model.retimes ?? []).filter((entry) => entry.itemId === item.id && entry.start <= time)
    .reduce((latest, entry) => (!latest || entry.start >= latest.start ? entry : latest), null);
  return Boolean(last && last.to === 0 && time >= last.end);
}

// A still end card: the scene's last hold, running to its end for over END_HOLD s with no sound
// starting, stopping or fading in it (a song's ending held under the card is a sound change).
// Over END_DEAD s, silent and after something else, it is dead air: an error (a first pass ended on
// 8 still, silent seconds) and is cut to END_KEEP s. Under sound it is an error over END_FROZEN s
// (three blind-judged first passes in a row lost points for a 6.5 to 11 s frozen card with music
// under it). Any but dead air gets a slow push on the whole card.
const END_HOLD = 3;
const END_FROZEN = 4.5;
const END_DEAD = 5;
const END_KEEP = 2.5;
const SOUND_STEP = 0.1;

/**
 * Whether sound is heard from `from` to `to` (an audio or video layer of the raw scene, ctx.scene,
 * scene, at an audible volume), and whether it changes there: a sound starts or stops, its volume
 * moves, or a song reaches the end of its file. Without the raw scene: model.audio, no change.
 */
function soundIn(model, ctx, from, to) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene) return { heard: Boolean(model.audio), changes: false };
  let heard = false;
  let changes = false;
  for (const layer of scene.layers ?? []) {
    if (!["audio", "video"].includes(layer.type) || layer.enabled === false || !layer.src) continue;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!range || range.end <= from + 0.05 || range.start >= to - 0.05) continue;
    let low = 1;
    let high = 0;
    for (let time = Math.max(from, range.start); time < Math.min(to, range.end); time += SOUND_STEP) {
      const volume = volumeAt(layer, time);
      low = Math.min(low, volume);
      high = Math.max(high, volume);
    }
    if (high < 0.08) continue;
    heard = true;
    const source = Number(layer.mediaSourceDuration);
    const ending = layer.type === "audio" && !range.remapped && Number.isFinite(source) && range.offset + range.duration >= source - 0.5;
    if (range.start > from + 0.25 || range.end < to - 0.25 || high - low >= 0.2 || ending) changes = true;
  }
  return { heard, changes };
}

export function heldStatic(model, ctx) {
  if (model.duration < 3) return [];
  // A planned still (scene.rests) is not a hold to fix: no finding, no added drift or push.
  const still = runs(model.times.length, (index) => !motionAt(model, index) && !inRest(model, model.times[index])).filter((run) => seconds(model, run) > STILL_SECONDS);
  if (!still.length) { const creep = creepingEnd(model, ctx); return creep ? [creep] : []; }
  const last = still.at(-1);
  const endHold = last.to === model.times.length - 1 && model.duration - model.times[last.from] > END_HOLD ? last : null;
  const endSound = endHold ? soundIn(model, ctx, model.times[endHold.from], model.duration) : null;
  const endCard = endHold && !endSound.changes ? endHold : null;
  const others = endCard ? still.filter((run) => run !== endCard) : still;
  // A creeping end over END_FROZEN s outranks a shorter still end that is only a warning.
  const card = endCard ? stillEnd(model, ctx, endCard, endSound) : null;
  const end = card?.severity === "error" ? card : creepingEnd(model, ctx) ?? card;
  const rest = end && end !== card ? others.filter((run) => model.times[run.to] < end.at) : others;
  return [...(end ? [end] : []), ...(rest.length ? heldFinding(model, ctx, rest) : [])];
}

// An end card where only a slow push or drift moves (under the 1% bar a large picture is let off
// with) for over END_FROZEN s, the sound not changing: it reads as frozen all the same (a
// 3% push over the last 6 s, judged a frozen card). A bigger push would look wrong on a card, so
// the fix is a change: end sooner, bring one more element in partway, or let the song end there.
function creepingEnd(model, ctx) {
  const last = runs(model.times.length, (index) => !motionAt(model, index, { creep: false }) && !inRest(model, model.times[index])).at(-1);
  if (!last || last.to !== model.times.length - 1) return null;
  const from = model.times[last.from];
  const length = model.duration - from;
  if (length <= END_FROZEN || from < 2) return null;
  // The song fading out over the last 2 s does not carry the seconds before it.
  const sound = soundIn(model, ctx, from, Math.max(from + 1, model.duration - 2));
  if (sound.changes) return null;
  const keep = sec(from + END_KEEP);
  return {
    rule: "held_static", severity: "error", ...spanOf(model, last),
    measured: `only a slow creep moves from ${sec(from)}s to the end (${sec(length)}s)`, required: `an end card changes within ${END_FROZEN}s`,
    message: `From ${sec(from)}s to the end (${sec(length)}s) only a slow push or drift moves${sound.heard ? " and the sound does not change" : " and nothing is heard"}: it reads as a frozen card.`,
    fix: changeHint(keep),
  };
}

// Over END_FROZEN s a push only creeps (creepingEnd): the card needs a change.
const changeHint = (keep) => ({ kind: "hint", text: `End the scene at ${keep}s (lengthen earlier shots to keep the running time), bring one more element in after ${keep}s (the link or call to action), or end the song under the card.` });

// The end card finding: how long it sits there, silent or not, and the cut or the push.
function stillEnd(model, ctx, run, sound) {
  const from = model.times[run.from];
  const length = model.duration - from;
  const dead = length > END_DEAD && !sound.heard && from >= 2;
  const frozen = length > END_FROZEN && sound.heard && from >= 2;
  const push = cardPush(model, run);
  const keep = sec(from + END_KEEP);
  const pushText = push ? push.why : "a slow push (scale 1 to 1.06) on the whole card";
  // Only dead air is cut; a held card under sound gets the push. `push` marks a fix that grows the
  // card where it is: check {fix:"auto"} applies it to layers the agent just placed too.
  const fix = dead
    ? { kind: "scene", properties: { duration: keep } }
    : frozen ? changeHint(keep) : push ? { kind: "group", changes: push.changes, auto: true, push: true, why: push.why } : { kind: "hint", text: `Add ${pushText}, or end the scene at ${keep}s.` };
  return {
    rule: "held_static", severity: dead || frozen ? "error" : "warn", itemId: push?.itemId, ...spanOf(model, run),
    measured: `the end holds still for ${sec(length)}s${sound.heard ? "" : " with no sound"}`, required: `a still end card at most ${END_HOLD}s${sound.heard ? `, never over ${END_FROZEN}s` : `, never over ${END_DEAD}s silent`}`,
    message: `Nothing moves from ${sec(from)}s to the end (${sec(length)}s)${sound.heard ? " and the sound does not change" : " and nothing is heard"}: the video ${dead ? "dies" : "stalls"} on a frozen card. End the scene at ${keep}s, or add ${pushText}; a song ending under it also carries it.`,
    fix,
  };
}

// The end card's push: everything shown on the card grows together about the card's middle (a
// camera pushing in), not a drift of one small layer. Each top layer (a group with its children)
// gets one slow eased scale over the hold, moved outward with the card. The scale is the least that
// makes the card's largest layer pass the held_static bar (sized as holdMotion does), at least
// END_PUSH_MIN; past END_PUSH_MAX the card is too small for a push to show, and the fix is the cut.
// A plain shape filling the frame stays: growing it shows nothing.
const END_PUSH_MIN = 1.04;
const END_PUSH_MAX = 1.15;
function cardPush(model, run) {
  const middle = Math.round((run.from + run.to) / 2);
  const start = model.times[run.from];
  const duration = model.duration - start;
  // A cut_out's source that shows stays in: it must grow with its copy, which sits on its pixels.
  const shown = model.items.filter((item) => !inMask(model, item) && item.kind !== "group" && !item.source?.sceneBackground && item.samples.opacity[middle] >= 0.3
    && !coveredAt(model, item, middle) && (["image", "video", "text"].includes(item.kind) || !coversFrame(model, item)));
  if (!shown.length || duration < 1.2) return null;
  const union = (boxes) => boxes.reduce((all, box) => ({ x0: Math.min(all.x0, box.x0), y0: Math.min(all.y0, box.y0), x1: Math.max(all.x1, box.x1), y1: Math.max(all.y1, box.y1) }));
  const card = union(shown.map((item) => boxAt(item, middle)));
  const [cx, cy] = [(card.x0 + card.x1) / 2, (card.y0 + card.y1) / 2];
  // The average speed the push must give some layer's fastest edge (as holdMotion works it out),
  // and the scale for it: an edge `reach` from the card's middle travels reach times (scale - 1).
  const diagonal = Math.hypot(model.width, model.height);
  const ends = (Math.PI / 2) * Math.sin(Math.min(Math.PI / 2, (1.2 * Math.PI) / Math.max(1.2, duration)));
  const needed = Math.min(...shown.map((item) => {
    const box = boxAt(item, middle);
    const reach = Math.max(Math.abs(box.x0 - cx), Math.abs(box.x1 - cx), Math.abs(box.y0 - cy), Math.abs(box.y1 - cy));
    const travel = (1.1 / ends) * (frameShare(model, box) >= 0.3 ? 0.004 : 0.01) * diagonal * duration;
    return reach > 0 ? 1 + travel / reach : Infinity;
  }));
  if (needed > END_PUSH_MAX) return null;
  const scale = Math.round(Math.max(END_PUSH_MIN, needed) * 1000) / 1000;
  // One push per top layer. A scale another animation moves during the hold, unless it spans most
  // of it (the push then grows that animation), leaves the card to the cut.
  const tops = [...new Set(shown.map((item) => chainOf(model, item).at(-1)))];
  const busy = tops.some((top) => chainOf(model, top).flatMap((entry) => tweensOf(model, entry.id))
    .some((tween) => tween.end > start && tween.keys.some((key) => key.startsWith("scale")) && tween.end - Math.max(tween.start, start) < 0.6 * duration));
  if (busy) return null;
  const changes = tops.map((top) => {
    const box = union(shown.filter((item) => chainOf(model, item).includes(top)).map((item) => boxAt(item, middle)));
    const [dx, dy] = [((box.x0 + box.x1) / 2 - cx) * (scale - 1), ((box.y0 + box.y1) / 2 - cy) * (scale - 1)].map(Math.round);
    return { kind: "motion", technique: "slow-push", card: true, itemId: top.id, start: sec(start), duration: sec(duration), easing: HOLD_EASING, scale, dx, dy };
  });
  const main = shown.reduce((best, item) => (area(boxAt(item, middle)) > area(boxAt(best, middle)) ? item : best));
  return { changes, itemId: main.id, why: `a slow push (scale 1 to ${scale}) on the whole end card at ${sec(start)}s` };
}

// One finding for the scene's other holds, at the longest, listing the rest.
function heldFinding(model, ctx, still) {
  const longest = longestRun(still);
  // The largest thing shown there: what a drift or push would move.
  const middle = Math.round((longest.from + longest.to) / 2);
  // Not a cut_out's source or a mask helper: the finding (and the drift it adds) belongs to what is drawn.
  const shown = model.items.filter((item) => !isHelperLayer(model, item) && item.kind !== "group" && !item.source?.sceneBackground && item.samples.opacity[middle] >= 0.3 && !coveredAt(model, item, middle));
  const main = shown.reduce((best, item) => (!best || area(boxAt(item, middle)) > area(boxAt(best, middle)) ? item : best), null);
  const holdText = (run) => `${sec(model.times[run.from])}s for ${sec(seconds(model, run))}s${run.to === model.times.length - 1 ? " (to the end)" : ""}`;
  const pixels = Math.round(0.01 * Math.hypot(model.width, model.height));
  // The automatic fix: a slow motion on the main picture or text of every hold.
  const motions = still.slice(0, 8).map((run) => holdMotion(model, run, ctx)).filter(Boolean).flatMap((motion) => withCutouts(model, motion));
  const hint = { kind: "hint", text: `Keep it alive through the hold: a drift of ${main ? ctx.name(main) : "the main layer"} of at least ${pixels} px a second, a slow push on a full-frame picture (scale 1 to 1.06), type that keeps building, particles or a light sweep; or cut the hold shorter.` };
  return [{
    rule: "held_static", severity: "warn", itemId: main?.id, ...spanOf(model, longest),
    measured: `${still.length} ${still.length === 1 ? "hold" : "holds"} with nothing moving (longest ${sec(seconds(model, longest))}s)`, required: `motion at least every ${STILL_SECONDS}s`,
    message: `Nothing moves on screen at ${still.slice(0, 4).map(holdText).join(", ")}${still.length > 4 ? ` and ${still.length - 4} more` : ""}${main ? `; at the longest, ${ctx.name(main)} just sits there` : ""}. A held frame reads as a slide.`,
    fix: motions.length ? { kind: "group", changes: motions, auto: true, why: [...new Set(motions.map((motion) => motion.why))].join("; ") } : hint,
  }];
}

// A cut_out copy sits on its source's pixels: a hold motion on one of them goes on the clip and
// every copy of it, so the subject never shows twice.
function withCutouts(model, change) {
  const item = itemById(model, change.itemId);
  const root = item?.cutoutOf && itemById(model, item.cutoutOf) ? item.cutoutOf : change.itemId;
  const family = model.items.filter((other) => other.id === root || other.cutoutOf === root);
  return family.length > 1 ? family.map((other) => ({ ...change, itemId: other.id })) : [change];
}

// Slow motions kino adds to a hold, by the deck technique they are: a push on a picture, a drift,
// or text whose letters slowly spread (type-kinetic). Never a loop or a bounce: one eased move.
const HOLD_EASING = [0.37, 0, 0.63, 1];
const PICTURE_MOTIONS = ["slow-push", "drift"];
const TEXT_MOTIONS = ["type-kinetic", "drift"];

/**
 * The motion for one hold, or null: the largest picture or text shown there moves just fast
 * enough for the eye (1.3 times the held_static bar), a push of 2 to 4% or a drift of at most 4%
 * of the frame diagonal, in a property nothing else animates then. The deck's techniques go first.
 */
function holdMotion(model, run, ctx) {
  const middle = Math.round((run.from + run.to) / 2);
  const candidates = model.items.filter((item) => ["image", "video", "text"].includes(item.kind) && !isHelperLayer(model, item) && !["decor", "background"].includes(item.role)
    && !item.source?.sceneBackground && item.samples.opacity[middle] >= 0.3 && !coveredAt(model, item, middle));
  const main = candidates.reduce((best, item) => (!best || area(boxAt(item, middle)) > area(boxAt(best, middle)) ? item : best), null);
  if (!main) return null;
  const start = model.times[run.from];
  const end = run.to === model.times.length - 1 ? model.duration : model.times[run.to];
  const duration = end - start;
  if (duration < 1.2) return null;
  // A screenshot frozen_screen finds still here gets its stronger push instead (rules/screens.js).
  if (screenSize(ctx, main) && frozenStretches(model, main).some((still) => still.from <= run.to && run.from <= still.to)) return null;
  const box = boxAt(main, middle);
  const diagonal = Math.hypot(model.width, model.height);
  const share = frameShare(model, box);
  // The speed (frame pixels a second) its fastest edge should keep on average. An eased move is
  // slow at both ends: it peaks at about 1.6 times its average, and it must be over the
  // held_static bar by 1.2 s from each end (so no still stretch reaches 1.5 s), with 10% to spare.
  const ends = (Math.PI / 2) * Math.sin(Math.min(Math.PI / 2, (1.2 * Math.PI) / Math.max(1.2, duration)));
  const speed = (1.1 / ends) * (share >= 0.3 ? 0.004 : 0.01) * diagonal;
  const travel = speed * duration;
  // Properties another animation of the layer (or a group around it) moves during the hold.
  const busy = new Set(chainOf(model, main).flatMap((entry) => tweensOf(model, entry.id)).filter((tween) => tween.start < end && tween.end > start).flatMap((tween) => tween.keys));
  const free = (...keys) => !keys.some((key) => busy.has(key));
  const deck = new Set((ctx.deck?.cards ?? []).map((card) => card.tag));
  const order = (list) => [...list.filter((tag) => deck.has(tag)), ...list.filter((tag) => !deck.has(tag))];
  const safe = safeRect(model);
  const base = { kind: "motion", itemId: main.id, start: sec(start), duration: sec(duration), easing: HOLD_EASING };
  for (const technique of order(main.kind === "text" ? TEXT_MOTIONS : PICTURE_MOTIONS)) {
    if (technique === "slow-push" && free("scaleX", "scaleY")) {
      const scale = 1 + (2 * travel) / Math.max(box.x1 - box.x0, box.y1 - box.y0);
      if (scale <= 1.04) return { ...base, technique, scale: Math.round(Math.max(1.02, scale) * 1000) / 1000, why: `a slow push on ${ctx.name(main)} at ${sec(start)}s` };
    }
    // Only a text that sizes itself to its line: in a fixed box, wider letters would wrap.
    if (technique === "type-kinetic" && free("letterSpacing") && main.textAlign === "center" && main.textResize === "width-height") {
      const gaps = Math.max(1, String(main.text ?? "").length - 1);
      const spread = (2 * travel) / gaps;
      // Letter spacing is a percentage of the font size (engine/letterSpacing.js): at most 12% more.
      const percentMore = (100 * spread) / ((main.fontSize ?? 48) * (main.samples.scale[middle] || 1));
      if (percentMore <= 12) return { ...base, technique, spacing: Math.round(percentMore * 10) / 10, why: `the letters of ${ctx.name(main)} spread slowly from ${sec(start)}s` };
    }
    if (technique === "drift") {
      const distance = Math.round(Math.min(travel, 0.04 * diagonal));
      // A picture drifts sideways; a text toward the side with more free room.
      // A picture inside a mask or a clipping group would show its edge: it only gets the push.
      if (main.kind !== "text" && main.clipIds?.length) continue;
      const sideways = main.kind !== "text" && free("x");
      if (sideways) return { ...base, technique, dx: -distance, dy: 0, why: `a slow drift of ${ctx.name(main)} at ${sec(start)}s` };
      if (free("y")) {
        // The room above and below: to the safe area's edge, or to the nearest other thing shown.
        const others = model.items.filter((item) => item !== main && !item.isMask && item.kind !== "group" && !item.source?.sceneBackground && item.samples.opacity[middle] >= 0.3
          && !coversFrame(model, item)).map((item) => boxAt(item, middle)).filter((other) => other.x1 > box.x0 && other.x0 < box.x1);
        const above = Math.min(box.y0 - safe.y0, ...others.filter((other) => other.y1 <= box.y0).map((other) => box.y0 - other.y1));
        const below = Math.min(safe.y1 - box.y1, ...others.filter((other) => other.y0 >= box.y1).map((other) => other.y0 - box.y1));
        return { ...base, technique, dx: 0, dy: above >= below ? -distance : distance, why: `a slow drift of ${ctx.name(main)} at ${sec(start)}s` };
      }
    }
  }
  return null;
}


// ---------------------------------------------------------------- off_brand_font

export function offBrandFont(model, ctx) {
  const texts = readingTexts(model);
  if (!texts.length) return [];
  const families = new Map();
  for (const item of texts) {
    const key = familyKey(item.fontFamily || "Inter");
    if (!families.has(key)) families.set(key, { family: item.fontFamily || "Inter", items: [] });
    families.get(key).items.push(item);
  }
  const brand = brandFamilies(ctx);
  const heads = new Set(headlines(model).map((item) => item.id));
  const findings = [];
  if (brand.length) {
    const allowed = new Set(brand.map(familyKey));
    for (const [key, { family, items }] of families) {
      if (allowed.has(key)) continue;
      // Headlines take the first brand font, the rest the second (or the first when there is one).
      const target = items.some((item) => heads.has(item.id)) ? brand[0] : brand[1] ?? brand[0];
      findings.push({
        rule: "off_brand_font", severity: "warn", itemId: items[0].id, itemIds: items.map((item) => item.id),
        measured: family, required: brand.join(" or "),
        message: `${items.length} text layer${items.length === 1 ? "" : "s"} (${items.slice(0, 3).map((item) => ctx.name(item)).join(", ")}) use${items.length === 1 ? "s" : ""} ${family}; the brand's fonts are ${brand.join(" and ")}.`,
        fix: { kind: "font", itemIds: items.map((item) => item.id), family: target, nearest: true, auto: true, why: `the brand font ${target}` },
      });
    }
    return findings;
  }
  // No brand: a video in three or more typefaces looks unplanned. The two most used stay.
  if (families.size < 3) return [];
  const ranked = [...families.values()].sort((a, b) => b.items.length - a.items.length);
  for (const { family, items } of ranked.slice(2)) {
    findings.push({
      rule: "off_brand_font", severity: "warn", itemId: items[0].id, itemIds: items.map((item) => item.id),
      measured: `${families.size} type families (${ranked.map((entry) => `${entry.family} ×${entry.items.length}`).join(", ")})`, required: "1 or 2 families",
      message: `${ctx.name(items[0])}${items.length > 1 ? ` and ${items.length - 1} more` : ""} use${items.length === 1 ? "s" : ""} ${family}, a third typeface next to ${ranked[0].family} and ${ranked[1].family}. Say the brand's fonts with set_brand {fonts}, then keep to them.`,
      fix: { kind: "font", itemIds: items.map((item) => item.id), family: ranked[0].family, why: `the video's main typeface` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- rendered: shared

// The frame's brightness as the eye sees it (gamma-encoded luma, 0 to 1) at pixel x, y.
const lumaAt = (frame, x, y) => {
  const at = (y * frame.width + x) * 4;
  return (0.299 * frame.pixels[at] + 0.587 * frame.pixels[at + 1] + 0.114 * frame.pixels[at + 2]) / 255;
};

// ---------------------------------------------------------------- text_on_busy

const BUSY_WIDTH = 384;
// A pixel whose brightness jumps by this much to its right or lower neighbor is an edge.
const EDGE_STEP = 0.08;
// Over this share of edge pixels behind a text, the background is busy (fine UI, text, foliage
// in sharp focus). Measured on a trailer and the golden scenes.
const BUSY_SHARE = 0.16;
// Over a picture set in the frame (a phone, a card) the bar is lower: what crowds the words there
// is its frame line and the small detail of its screen.
const INSET_SHARE = 0.02;

/** The share (0 to 1) of edge pixels in `box` (frame pixels) of a rendered frame. */
export function edgeShare(frame, box, modelWidth) {
  const k = frame.width / modelWidth;
  const x0 = Math.max(0, Math.floor(box.x0 * k)), y0 = Math.max(0, Math.floor(box.y0 * k));
  const x1 = Math.min(frame.width - 1, Math.ceil(box.x1 * k)), y1 = Math.min(frame.height - 1, Math.ceil(box.y1 * k));
  let edges = 0, total = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const here = lumaAt(frame, x, y);
      const step = Math.max(Math.abs(lumaAt(frame, x + 1, y) - here), Math.abs(lumaAt(frame, x, y + 1) - here));
      total += 1;
      if (step >= EDGE_STEP) edges += 1;
    }
  return total ? edges / total : 0;
}

// Pictures set inside the frame (a phone, a screen recording, a card): a video or image, or a
// group holding one, between 3% and 70% of the frame, drawn below the text.
function insetsUnder(model, text, index) {
  const box = boxAt(text, index);
  const size = area(box);
  if (!size) return [];
  return importantPictures(model, 0.03).filter((item) => item.z < text.z && pictureShown(model, item, index)
    && frameShare(model, boxAt(item, index)) < 0.7 && overlapArea(boxAt(item, index), box) >= 0.15 * size);
}

export async function textOnBusy(model, ctx) {
  if (!ctx.renderFrames) return [];
  const texts = readingTexts(model);
  // The middle of each text's longest readable stretch, and of its second longest.
  const picks = new Map();
  for (const item of texts) {
    const list = [...readableRuns(model, item)].sort((a, b) => b.length - a.length).slice(0, 2);
    for (const run of list) {
      const index = Math.round((run.from + run.to) / 2);
      if (!picks.has(index)) picks.set(index, []);
      picks.get(index).push({ item, run });
    }
  }
  if (!picks.size) return [];
  const indexes = [...picks.keys()].sort((a, b) => a - b).slice(0, 80);
  // The same frames the contrast check renders: the texts left out, so what is behind them shows.
  const hide = [...texts.map((item) => item.id), ...coveringItems(model, texts)];
  const frames = await ctx.renderFrames(indexes.map((index) => model.times[index]), { width: Math.min(BUSY_WIDTH, model.width), hide });
  const worst = new Map();
  indexes.forEach((index, position) => {
    const frame = frames[position];
    if (!frame) return;
    for (const { item, run } of picks.get(index)) {
      const box = boxAt(item, index);
      // A little around the letters too: an edge just past them still crowds them.
      const pad = 0.15 * drawnSize(model, item);
      const padded = { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
      // Over an inset picture (a phone, a card), the part of the text over it is judged on its
      // own, with the lower bar: its frame edges and screen detail crowd the words.
      const inset = insetsUnder(model, item, index)[0] ?? null;
      const share = edgeShare(frame, inset ? intersection(padded, boxAt(inset, index)) : padded, model.width);
      const limit = inset ? INSET_SHARE : BUSY_SHARE;
      const best = worst.get(item.id);
      if (!best || share / limit > best.share / best.limit) worst.set(item.id, { item, index, run, share, limit, inset });
    }
  });
  const findings = [];
  for (const { item, index, run, share, limit, inset } of worst.values()) {
    if (share < limit) continue;
    const hint = { kind: "hint", text: `Move ${ctx.name(item)} to a calm part of the frame${inset ? ` beside ${ctx.name(inset)}, not across it` : ""}, blur or dim what is behind it, or give it a solid plate. A shadow does not fix it.` };
    findings.push({
      rule: "text_on_busy", severity: "warn", itemId: item.id, otherId: inset?.id, ...spanOf(model, run), bbox: roundBox(boxAt(item, index)),
      measured: `${percent(share)} edge pixels behind it${inset ? ` where it crosses ${ctx.name(inset)}` : ""}`, required: `under ${percent(limit)}`,
      message: `${ctx.name(item)} sits over ${inset ? `${ctx.name(inset)} (its frame and screen detail)` : "busy detail"} at ${sec(model.times[index])}s; the words fight the picture.`,
      // A caption word moved alone leaves its phrase: the captions take a plate as a whole.
      fix: item.role === "caption" && !item.move
        ? { kind: "hint", text: "Run add_captions again with box:\"#000000B8\" (a plate behind every caption), or position:\"top\" if the top is calm." }
        : (await calmFix(model, item, texts, { hide, ctx })) ?? hint,
    });
  }
  return findings;
}

// The texts that move together: the parts of one move (the chunks of one caption), else the text.
const partsOf = (texts, item) => (item.move ? texts.filter((text) => text.move === item.move) : [item]);

// How busy the frame is behind a text box at one rendered frame, against the bar for that place:
// over an inset picture (a phone, a card) the part over it, with the lower bar.
function busyAt(model, frame, item, index, box) {
  const pad = 0.15 * drawnSize(model, item);
  const around = { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
  const size = area(box);
  const inset = importantPictures(model, 0.03).find((picture) => picture.z < item.z && pictureShown(model, picture, index)
    && frameShare(model, boxAt(picture, index)) < 0.7 && overlapArea(boxAt(picture, index), box) >= 0.15 * size) ?? null;
  const share = edgeShare(frame, inset ? intersection(around, boxAt(inset, index)) : around, model.width);
  return share / (inset ? INSET_SHARE : BUSY_SHARE);
}

/**
 * The fix for text over busy detail: the nearest place in the safe area where every part of the
 * text (all chunks of one caption) sits over calm pixels (under 80% of the bar) at the start,
 * middle and end of each readable stretch, clear of the other texts; else a plate sized to the
 * text, dark under light letters and light under dark ones. Null when neither is safe.
 */
async function calmFix(model, item, texts, { hide, ctx }) {
  const parts = partsOf(texts, item);
  const others = texts.filter((text) => !parts.includes(text));
  // Frames at the start, middle and end of each part's longest readable stretch.
  const checks = [];
  for (const part of parts) {
    const run = longestRun(readableRuns(model, part));
    if (!run) continue;
    for (const share of [0.15, 0.5, 0.85]) checks.push({ part, index: Math.round(run.from + share * (run.to - run.from)) });
  }
  if (!checks.length || checks.length > 60) return null;
  const frames = await ctx.renderFrames(checks.map(({ index }) => model.times[index]), { width: Math.min(BUSY_WIDTH, model.width), hide });
  const calm = (dx, dy) => checks.every(({ part, index }, position) => !frames[position] || busyAt(model, frames[position], part, index, shifted(boxAt(part, index), dx, dy)) < 0.8);
  const gap = Math.max(4, Math.round(0.25 * drawnSize(model, item)));
  // Clear of the other texts, and beside a picture set in the frame (a phone, a card), not across its edge.
  const insets = importantPictures(model, 0.03).filter((picture) => picture.z < item.z);
  const obstaclesAt = (index) => [...others.filter((text) => text.samples.opacity[index] >= 0.05),
    ...insets.filter((picture) => pictureShown(model, picture, index) && frameShare(model, boxAt(picture, index)) < 0.7)].map((entry) => boxAt(entry, index));
  const spot = freeSpot(model, parts, { gap, obstaclesAt, allowed: calm });
  if (spot) return {
    kind: "group", changes: parts.map((part) => ({ kind: "move", itemId: part.id, dx: Math.round(spot.dx), dy: Math.round(spot.dy) })), auto: true,
    why: `moved ${Math.round(Math.hypot(spot.dx, spot.dy))}px to a calm place${parts.length > 1 ? ` with its ${parts.length - 1} other parts` : ""}`,
  };
  // A plate under each part, while it shows. Only for texts whose own box is in frame pixels.
  if (parts.some((part) => part.parentId)) return null;
  const plates = parts.map((part) => {
    const run = longestRun(readableRuns(model, part));
    if (!run) return null;
    const index = Math.round((run.from + run.to) / 2);
    const box = boxAt(part, index);
    const size = drawnSize(model, part);
    const color = hexRgba(fillColorsAt(part, index)[0] ?? "#ffffff") ?? [255, 255, 255, 255];
    const light = luminance(color) >= 0.4;
    return { kind: "plate", itemId: part.id, box: { x0: Math.round(box.x0 - 0.35 * size), y0: Math.round(box.y0 - 0.2 * size), x1: Math.round(box.x1 + 0.35 * size), y1: Math.round(box.y1 + 0.2 * size) },
      fill: light ? "#0D0D0F" : "#F5F5F2", opacity: light ? 0.78 : 0.86, radius: Math.round(0.22 * size) };
  });
  if (plates.some((plate) => !plate)) return null;
  return { kind: "group", changes: plates, auto: true, why: `no calm place, so a ${plates[0].fill === "#0D0D0F" ? "dark" : "light"} plate under ${plates.length > 1 ? `its ${plates.length} parts` : "it"}` };
}

// ---------------------------------------------------------------- small_on_empty

const EMPTY_WIDTH = 96;
const EMPTY_STEP = 0.75;
const EMPTY_CONTENT = 0.25;
const EMPTY_FOOTAGE = 0.4;

/** The share (0 to 1) of a rendered frame that is not its one most common flat color. */
export function contentShare(frame) {
  const counts = new Map();
  const total = frame.width * frame.height;
  const keyAt = (pixel) => ((frame.pixels[pixel * 4] >> 4) << 8) | ((frame.pixels[pixel * 4 + 1] >> 4) << 4) | (frame.pixels[pixel * 4 + 2] >> 4);
  for (let pixel = 0; pixel < total; pixel += 1) counts.set(keyAt(pixel), (counts.get(keyAt(pixel)) ?? 0) + 1);
  let top = 0, key = 0;
  for (const [entry, value] of counts) if (value > top) { top = value; key = entry; }
  const center = [(key >> 8) & 15, (key >> 4) & 15, key & 15].map((value) => value * 16 + 8);
  let flat = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const at = pixel * 4;
    if (Math.abs(frame.pixels[at] - center[0]) <= 20 && Math.abs(frame.pixels[at + 1] - center[1]) <= 20 && Math.abs(frame.pixels[at + 2] - center[2]) <= 20) flat += 1;
  }
  return 1 - flat / total;
}

// The pictures shown at a sample: video, or images that are not just a small logo (a logo on a
// flat color is a logo sting, not an empty frame).
function picturesAt(model, index) {
  const shown = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask && !["logo", "background"].includes(item.role)
    && item.samples.opacity[index] >= 0.3 && !coveredAt(model, item, index));
  const images = shown.filter((item) => item.kind === "image");
  const imageShare = images.reduce((sum, item) => sum + frameShare(model, boxAt(item, index)), 0);
  return shown.some((item) => item.kind === "video") || images.length >= 3 || imageShare >= 0.05 ? shown : [];
}

// The share of the frame the largest picture shown fills, inside its groups and masks.
function largestPicture(model, index) {
  let best = 0;
  for (const item of picturesAt(model, index)) best = Math.max(best, shownShare(model, item, index) * area(boxAt(item, index)) / (model.width * model.height));
  return best;
}

export async function smallOnEmpty(model, ctx) {
  if (!ctx.renderFrames) return [];
  const step = samplesIn(model, EMPTY_STEP);
  const candidates = [];
  for (let index = 0; index < model.times.length; index += step)
    if (picturesAt(model, index).length && largestPicture(model, index) < 0.5) candidates.push(index);
  if (!candidates.length) return [];
  const chosen = candidates.slice(0, 120);
  // A frame another rule already rendered within half a step serves (the contrast frames
  // leave the texts out, which changes little here); the rest are rendered small.
  const frames = new Map();
  const near = ctx.renderFrames.nearest;
  for (const index of chosen) {
    const found = near?.(model.times[index], EMPTY_STEP / 2);
    if (found) frames.set(index, found);
  }
  const missing = chosen.filter((index) => !frames.has(index));
  if (missing.length) {
    const rendered = await ctx.renderFrames(missing.map((index) => model.times[index]), { width: Math.min(EMPTY_WIDTH, model.width), hide: [] });
    missing.forEach((index, position) => { if (rendered[position]) frames.set(index, rendered[position]); });
  }
  const empty = new Map();
  for (const index of chosen) {
    if (!frames.has(index)) continue;
    const share = contentShare(frames.get(index));
    // Footage pillarboxed on a flat frame reads as empty even at a third of it.
    const limit = picturesAt(model, index).some((item) => item.kind === "video") ? EMPTY_FOOTAGE : EMPTY_CONTENT;
    if (share < limit) empty.set(index, { share, limit });
  }
  // The picture to grow at a sample: the outermost holder (a card, a group) of the largest
  // picture, short of a full-frame group.
  const holderAt = (index) => {
    const pictures = picturesAt(model, index);
    const largest = pictures.reduce((best, item) => (!best || area(boxAt(item, index)) > area(boxAt(best, index)) ? item : best), null);
    const holder = largest ? chainOf(model, largest).filter((entry) => frameShare(model, boxAt(entry, index)) < 0.9).at(-1) ?? largest : null;
    // Loose pictures in one full-frame group (a ring or a field of tiles) count as that group.
    return holder?.parentId && !chainOf(model, holder).slice(1).some((entry) => frameShare(model, boxAt(entry, index)) < 0.9) ? itemById(model, holder.parentId) : holder;
  };
  // Stretches of empty samples one step apart, with the same picture.
  const stretches = [];
  for (const index of [...empty.keys()].sort((a, b) => a - b)) {
    const last = stretches.at(-1);
    const holder = holderAt(index);
    if (last && index - last.to <= step && last.holder === holder) last.to = index;
    else stretches.push({ from: index, to: index, holder });
  }
  const findings = [];
  for (const { from, to, holder } of stretches) {
    const length = (to - from) / model.fps + EMPTY_STEP;
    if (length < 1.5) continue;
    const middle = [...empty.keys()].filter((index) => index >= from && index <= to).reduce((best, index) => (empty.get(index).share < empty.get(best).share ? index : best));
    const { share, limit } = empty.get(middle);
    const grow = Math.max(1.2, Math.min(3, Math.sqrt(0.6 / Math.max(0.02, share))));
    // No auto fix: a blurred copy behind every small picture made every shot one template.
    const name = holder ? ctx.name(holder) : "it";
    const hint = { kind: "hint", text: `If the empty frame is not the design: scale ${name} up about ${Math.round(grow * 10) / 10}x and crop to the subject, set it in a scene (device-in-scene, split-screen beside another shot), move the camera on it (slow-push, parallax), or give the frame its own color or texture. If the space is designed (a lone product on black), waive_check small_on_empty with why.` };
    findings.push({
      rule: "small_on_empty", severity: "warn", itemId: holder?.id, at: sec(model.times[from]), until: sec(Math.min(model.duration, model.times[to] + EMPTY_STEP)),
      measured: `${percent(share)} of the frame has anything in it`, required: `${percent(limit)} or more, or something behind it`,
      message: `From ${sec(model.times[from])}s for ${sec(length)}s, ${holder ? ctx.name(holder) : "the picture"} is a small island on a flat empty frame (${percent(share)} of the frame has anything in it).`,
      fix: hint,
    });
  }
  return findings;
}

// ---------------------------------------------------------------- render_artifact

const SPLIT_EFFECTS = ["rgb-shift"];
const ARTIFACT_WIDTH = 96;
const ARTIFACT_SHARE = 0.03;

/** The share (0 to 1) of a frame in loud, flat saturated color: a channel near full, another near 0. */
export function slabShare(frame) {
  const total = frame.width * frame.height;
  let loud = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const at = pixel * 4;
    const values = [frame.pixels[at], frame.pixels[at + 1], frame.pixels[at + 2]];
    if (Math.max(...values) >= 190 && Math.min(...values) <= 40) loud += 1;
  }
  return loud / total;
}

// The update that softens an RGB split to 40% of its amount, or null when its animation is not found.
function softenSplit(model, effect) {
  const amount = Number(effect.to?.amount);
  if (!effect.animationId || !Number.isFinite(amount)) return null;
  return { kind: "animation", animationId: effect.animationId, itemId: effect.itemId, properties: { to: { ...effect.to, amount: Math.round(amount * 40) / 100 } }, auto: false, why: "softens the split to 40%" };
}

export async function renderArtifact(model, ctx) {
  if (!ctx.renderFrames) return [];
  // A split shorter than 0.3 s (a quick fade of one) passes too fast to read as a slab.
  const splits = (model.effects ?? []).filter((entry) => SPLIT_EFFECTS.includes(entry.effect) && entry.end - entry.start >= 0.3 && itemById(model, entry.itemId));
  if (!splits.length) return [];
  // For each split: a frame just before it (the picture's own colors) and two while it runs (it is usually strongest late),
  // all rendered in one call.
  const plan = splits.slice(0, 8).map((effect) => ({
    effect,
    before: Math.max(0, effect.start - 0.1),
    during: [0.5, 0.8].map((share) => effect.start + share * (effect.end - effect.start)),
  }));
  const times = [...new Set(plan.flatMap((entry) => [entry.before, ...entry.during]))].sort((a, b) => a - b);
  const frames = await ctx.renderFrames(times, { width: Math.min(ARTIFACT_WIDTH, model.width), hide: [] });
  const shareAt = new Map(times.map((time, position) => [time, frames[position] ? slabShare(frames[position]) : 0]));
  const findings = [];
  for (const { effect, before, during } of plan) {
    const base = shareAt.get(before);
    let worst = { share: 0, time: during[0] };
    for (const time of during) if (shareAt.get(time) - base > worst.share) worst = { share: shareAt.get(time) - base, time };
    if (worst.share < ARTIFACT_SHARE) continue;
    const item = itemById(model, effect.itemId);
    findings.push({
      rule: "render_artifact", severity: "warn", itemId: item.id, at: sec(worst.time), until: sec(effect.end),
      measured: `${percent(worst.share)} of the frame in flat saturated color the picture does not have`, required: `under ${percent(ARTIFACT_SHARE)}`,
      message: `The ${effect.effect} on ${ctx.name(item)} draws flat saturated slabs over ${percent(worst.share)} of the frame at ${sec(worst.time)}s; they read as a glitch in the render, not a color split.`,
      // Not automatic: a split is a look someone chose. The fix softens it to 40%; deleting the
      // animation (delete_animation) or keeping it to a few frames also works.
      fix: softenSplit(model, effect) ?? { kind: "hint", text: `Lower the split's amount, keep it to a few frames, or apply it to a smaller layer; look mode:"frame" t:${sec(worst.time)} shows it.` },
    });
  }
  return findings;
}
