// Screen rules: an app screenshot is the hardest picture to hold. The blind judge called a fresh
// agent's launch film "stalled on frozen, hard-to-read screenshots" (2026-10-29):
//   frozen_screen      a screenshot that barely moves for 2.5 s with nothing moving over it
//   screen_unreadable  a screenshot drawn so small its words cannot be read, with no push or crop
// A picture is a screenshot when its file facts say so (engine/imageFacts.js looksLikeScreen); the
// agent service hands them in with ctx.mediaSizes.
import { sec } from "../analysis.js";
import { area, boxAt, chainOf, intersection, isText, longestRun, roundBox, runs, tweensOf } from "../model.js";
import { coveredAt } from "../techniques.js";
import { layerMovingAt, screenSize } from "./polish.js";

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
const frameShare = (model, box) => area(intersection(box, FRAME(model))) / (model.width * model.height);
const seconds = (model, run) => run.length / model.fps;
const spanOf = (model, run) => ({ at: sec(model.times[run.from]), until: sec(model.times[run.to]) });
const centerOf = (box) => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });
const widthOf = (box) => box.x1 - box.x0;
const hits = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// ---------------------------------------------------------------- frozen_screen

const WINDOW = 2.5;
// Over any WINDOW it grows by less than this share and its middle moves less than MOVE of the diagonal.
const GROW = 0.03;
const MOVE = 0.015;
// Screens smaller than this share of the frame are details, not the shot.
const SHOT = 0.08;
// The fix: a push of 1.06 to 1.18 about the busy region, eased gently so no 2.5 s stays still.
const PUSH_EASING = [0.4, 0.2, 0.6, 0.8];

/** frozen_screen: a screenshot that holds still for 2.5 s or more with nothing moving over it. */
export function frozenScreen(model, ctx) {
  const findings = [];
  for (const item of model.items) {
    const size = screenSize(ctx, item);
    if (!size || item.isMask) continue;
    const stretches = frozenStretches(model, item);
    const longest = longestRun(stretches);
    if (!longest) continue;
    const fixes = stretches.slice(0, 6).map((run) => screenMotion(model, item, run, size, ctx)).filter(Boolean);
    const total = stretches.reduce((sum, run) => sum + seconds(model, run), 0);
    const at = Math.round((longest.from + longest.to) / 2);
    findings.push({
      rule: "frozen_screen", severity: "warn", itemId: item.id, ...spanOf(model, longest), bbox: roundBox(boxAt(item, at)),
      measured: `still for ${sec(seconds(model, longest))}s${stretches.length > 1 ? ` (${sec(total)}s in ${stretches.length} stretches)` : ""}`,
      required: `a screenshot grows ${Math.round(GROW * 100)}% or moves ${MOVE * 100}% of the frame diagonal every ${WINDOW}s, or something moves over it`,
      message: `${ctx.name(item)} is a screenshot that sits still for ${sec(seconds(model, longest))}s from ${sec(model.times[longest.from])}s with nothing moving over it: it reads as a frozen slide. Push into the part that matters (region, or the screen-detail recipe), or move a cursor or a callout over it.`,
      fix: fixes.length ? { kind: "group", changes: fixes, auto: true, why: fixes.map((fix) => fix.why).join("; ") }
        : { kind: "hint", text: `Push ${ctx.name(item)} into its region (screen-detail, or region:[x,y,w,h] on its recipe), crop it, or move a cursor over it.` },
    });
  }
  return findings;
}

/** The still stretches (sample runs) of one screenshot layer; held_static leaves these to frozen_screen. */
export function frozenStretches(model, item) {
  const span = Math.max(1, Math.round(WINDOW * model.fps));
  const diagonal = Math.hypot(model.width, model.height);
  const chain = chainOf(model, item);
  const above = model.items.filter((other) => other.z > item.z && !chain.includes(other) && other.kind !== "group" && !other.isMask);
  const quiet = (index) => {
    if (item.samples.opacity[index] < 0.5 || coveredAt(model, item, index)) return false;
    const box = boxAt(item, index);
    if (frameShare(model, box) < SHOT) return false;
    return !above.some((other) => hits(boxAt(other, index), box) && layerMovingAt(model, other, index, 0));
  };
  // An eased push or drift is judged by its whole run, not by its slow ends: one that grows 3% or
  // moves 1.5% of the diagonal per 2.5 s on average moves the screen while it plays.
  const indexAt = (time) => Math.min(model.times.length - 1, Math.max(0, Math.round(time * model.fps)));
  const pushes = chain.flatMap((part) => tweensOf(model, part.id)).filter((tween) => tween.end - tween.start > 0
    && tween.keys.some((key) => /^(scale|x$|y$|width|height)/.test(key))).filter((tween) => {
    const [first, last] = [boxAt(item, indexAt(tween.start)), boxAt(item, indexAt(tween.end))];
    const [a, b] = [centerOf(first), centerOf(last)];
    const per = WINDOW / (tween.end - tween.start);
    const grown = Math.max(widthOf(first), widthOf(last)) / Math.max(1e-6, Math.min(widthOf(first), widthOf(last))) - 1;
    return grown * per >= GROW || Math.hypot(a.x - b.x, a.y - b.y) * per >= MOVE * diagonal;
  });
  const pushed = (index) => pushes.some((tween) => model.times[index] > tween.start && model.times[index] < tween.end);
  const frozen = new Uint8Array(model.times.length);
  for (const run of runs(model.times.length, (index) => quiet(index) && !pushed(index))) {
    for (let from = run.from; from + span <= run.to; from += 1) {
      const first = boxAt(item, from);
      const middle = centerOf(first);
      let [least, most, moved] = [widthOf(first), widthOf(first), 0];
      for (let index = from + 1; index <= from + span; index += 1) {
        const box = boxAt(item, index);
        least = Math.min(least, widthOf(box));
        most = Math.max(most, widthOf(box));
        const center = centerOf(box);
        moved = Math.max(moved, Math.hypot(center.x - middle.x, center.y - middle.y));
      }
      if (least > 0 && most / least - 1 < GROW && moved < MOVE * diagonal) frozen.fill(1, from, from + span + 1);
    }
  }
  return runs(model.times.length, (index) => frozen[index] === 1);
}

/**
 * The fix for one still stretch: a slow push about the screenshot's busy region (its file facts),
 * so that part stays put while the rest leaves the frame, as screenPush does in the recipes
 * (engine/blocks/hold.js). The push stops before the file is drawn at 1.95 file pixels a pixel.
 */
function screenMotion(model, item, run, size, ctx) {
  const start = model.times[run.from];
  const end = run.to === model.times.length - 1 ? model.duration : model.times[run.to];
  const duration = end - start;
  const box = boxAt(item, run.from);
  const width = widthOf(box);
  if (!(width > 0)) return null;
  const wanted = Math.min(1.18, Math.max(1.06, 1 + (1.5 * GROW * duration) / WINDOW));
  const scale = Math.round(Math.min(wanted, (1.95 * size.width) / width) * 1000) / 1000;
  if (scale < 1.04) return null;
  const [rx, ry, rw, rh] = Array.isArray(size.busy) ? size.busy : [30, 30, 40, 40];
  const point = { x: box.x0 + (width * (rx + rw / 2)) / 100, y: box.y0 + ((box.y1 - box.y0) * (ry + rh / 2)) / 100 };
  const center = centerOf(box);
  const dx = Math.round((center.x - point.x) * (scale - 1));
  const dy = Math.round((center.y - point.y) * (scale - 1));
  return {
    kind: "motion", technique: "slow-push", itemId: item.id, start: sec(start), duration: sec(duration), easing: PUSH_EASING, scale, dx, dy,
    why: `a ${Math.round((scale - 1) * 100)}% push into the busy part of ${ctx.name(item)} at ${sec(start)}s`,
  };
}

// ---------------------------------------------------------------- screen_unreadable

// Drawn at under this share of its file's width, a screenshot's words are too small to read.
const READABLE = 0.55;
const UNREADABLE_SECONDS = 1.5;
// A push that grows the screen this much in the stretch shows its detail on the way in.
const DETAIL_PUSH = 1.4;
// Screens smaller than this share of the frame are thumbnails nobody is asked to read.
const SEEN = 0.05;

/** screen_unreadable: a screenshot shown for over 1.5 s too small to read, with no push or crop. */
// A capture 2400 px or wider is taken at 2x (a Retina screen): its words are drawn twice as large,
// so it reads at half the drawn share a 1x capture needs.
export const pointWidth = (size) => (size.width >= 2400 ? size.width / 2 : size.width);

export function screenUnreadable(model, ctx) {
  const findings = [];
  for (const item of model.items) {
    const found = screenSize(ctx, item);
    if (!found || item.isMask) continue;
    const size = { ...found, width: pointWidth(found) };
    const small = (index) => {
      if (item.samples.opacity[index] < 0.5 || coveredAt(model, item, index)) return false;
      const box = boxAt(item, index);
      return frameShare(model, box) >= SEEN && widthOf(box) / size.width < READABLE;
    };
    // A crop of the same file (screen-detail's lifted card, a clipped copy) shown then shows the detail.
    const crops = model.items.filter((other) => other !== item && other.src === item.src && other.clipIds?.length);
    const shown = (index) => item.samples.opacity[index] >= 0.5;
    const stretches = runs(model.times.length, small).filter((run) => {
      if (seconds(model, run) <= UNREADABLE_SECONDS) return false;
      // A push that grows it 1.4x while it stays on screen shows its detail on the way in, even
      // once it is drawn large enough to end the small stretch.
      const widths = [];
      for (let index = run.from; index < model.times.length && (index <= run.to || shown(index)); index += 1) widths.push(widthOf(boxAt(item, index)));
      if (Math.max(...widths) >= DETAIL_PUSH * Math.min(...widths)) return false;
      return !crops.some((crop) => crop.samples.opacity.slice(run.from, run.to + 1).some((opacity) => opacity >= 0.5));
    });
    const longest = longestRun(stretches);
    if (!longest) continue;
    const at = Math.round((longest.from + longest.to) / 2);
    const drawn = widthOf(boxAt(item, at)) / size.width;
    const region = Array.isArray(size.busy) ? ` (its busiest part is region:[${size.busy.join(",")}])` : "";
    const hint = { kind: "hint", text: `Push into the part being talked about${region}: the screen-detail recipe, region on device-slide, or crop ${ctx.name(item)} to that part and draw it larger.` };
    const push = detailPush(model, item, longest, size, found.width, ctx);
    findings.push({
      rule: "screen_unreadable", severity: "warn", itemId: item.id, ...spanOf(model, longest), bbox: roundBox(boxAt(item, at)),
      measured: `drawn at ${Math.round(drawn * 100)}% of its ${size.width} px width${found.width !== size.width ? ` (a 2x capture, ${found.width} px)` : ""} for ${sec(seconds(model, longest))}s`,
      required: `${Math.round(READABLE * 100)}% or more, a push past ${DETAIL_PUSH}x, or a crop of the detail`,
      message: `${ctx.name(item)} is a screenshot shown at ${Math.round(drawn * 100)}% of its size for ${sec(seconds(model, longest))}s: its words are too small to read.`,
      fix: push ? { kind: "group", changes: [push], auto: true, why: push.why } : hint,
    });
  }
  return findings;
}

// The most a detail push grows a screenshot: past this it reads as a jump, not a push.
const DETAIL_MOST = 1.7;

/**
 * screen_unreadable's fix: a push past 1.4x (toward its readable size) about the busy region over
 * the small stretch, as screenMotion does for frozen_screen. Null (a hint instead) when the pushed
 * picture would leave the frame, leave a card it sits on, or newly cover a text shown then.
 */
function detailPush(model, item, run, size, fileWidth, ctx) {
  const start = model.times[run.from];
  const end = run.to === model.times.length - 1 ? model.duration : model.times[run.to];
  const box = boxAt(item, run.from);
  const width = widthOf(box);
  if (!(width > 0) || end - start < 1) return null;
  const wanted = Math.max(1.45, (READABLE * size.width) / width);
  const scale = Math.round(Math.min(wanted, DETAIL_MOST, (1.95 * fileWidth) / width) * 1000) / 1000;
  if (scale <= DETAIL_PUSH) return null;
  const [rx, ry, rw, rh] = Array.isArray(size.busy) ? size.busy : [30, 30, 40, 40];
  const point = { x: box.x0 + (width * (rx + rw / 2)) / 100, y: box.y0 + ((box.y1 - box.y0) * (ry + rh / 2)) / 100 };
  const grown = { x0: point.x + (box.x0 - point.x) * scale, y0: point.y + (box.y0 - point.y) * scale, x1: point.x + (box.x1 - point.x) * scale, y1: point.y + (box.y1 - point.y) * scale };
  const within = (inner, outer) => inner.x0 >= outer.x0 - 0.5 && inner.y0 >= outer.y0 - 0.5 && inner.x1 <= outer.x1 + 0.5 && inner.y1 <= outer.y1 + 0.5;
  if (within(box, FRAME(model)) && !within(grown, FRAME(model))) return null;
  // A card it sits inside (a shape under it): the push stays on the card.
  const cards = model.items.filter((other) => other !== item && other.kind !== "image" && other.kind !== "group" && !isText(other) && other.z < item.z && within(box, boxAt(other, run.from)));
  if (cards.some((card) => !within(grown, boxAt(card, run.from)))) return null;
  for (const other of model.items.filter(isText)) {
    for (let index = run.from; index <= run.to; index += 1) {
      if (other.samples.opacity[index] < 0.5) continue;
      const words = boxAt(other, index);
      if (hits(grown, words) && !hits(box, words)) return null;
    }
  }
  const center = centerOf(box);
  const dx = Math.round((center.x - point.x) * (scale - 1));
  const dy = Math.round((center.y - point.y) * (scale - 1));
  return {
    kind: "motion", technique: "slow-push", itemId: item.id, start: sec(start), duration: sec(end - start), easing: PUSH_EASING, scale, dx, dy,
    why: `a ${scale}x push into the busy part of ${ctx.name(item)} at ${sec(start)}s, so its words can be read`,
  };
}
