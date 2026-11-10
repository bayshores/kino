// Warnings for design defaults nobody chose, the tells viewers name when an edit "looks AI
// edited": every layer fading or blurring in (fade_only_entrances), a slow drift
// on every shot (drift_on_every_shot), shots of even length (even_shot_lengths), a big number
// beside a small framed card on a flat frame (split_card_layout), and small tracked caps
// labels or a progress bar left on screen (page_chrome). Each is a warning with a measured
// value: one use is a choice, the same default everywhere is the template.
import { maxOpacity, neverShown, scaleOf, sec } from "../analysis.js";
import { area, chainOf, insideShare, isText, runs, tweensOf, visibleBoxAt } from "../model.js";
import { shotBounds } from "./style.js";

// fade_only_entrances: judged from this many entering layers, warns above this share that only
// fade, or come in through a blur (blur, blur+fade, blur-rise: every model reaches for it;
// ai-tells-viewers.md 1: "everything fades in from opacity 0").
const FADE_MIN_ENTRANCES = 5;
const FADE_SHARE = 0.6;
// drift_on_every_shot: a shot is footage filling this share of the frame; a drift changes its
// size or place by 0.5% to 5% over the shot (ai-tool-patterns.md: "slow push-in on every shot",
// "Ken Burns on every still"); judged from this many shots.
const SHOT_FILL = 0.7;
const DRIFT_MIN = 0.005;
const DRIFT_MAX = 0.05;
const DRIFT_MIN_SHOTS = 3;
// even_shot_lengths: shot-length spread (stdev / mean) under this with this many shots or more
// (ai-tool-patterns.md: AI ad 0.52, pro 0.91; pro-craft.md 4: "avoid even lengths").
const EVEN_CV = 0.6;
const EVEN_MIN_SHOTS = 6;
// split_card_layout: big type (px at 1080) on one half, a framed card under this share of the
// frame width on the other, for this long (ai-tells-viewers.md 2: headline left, card right).
const SPLIT_TYPE = 160;
const SPLIT_CARD_WIDTH = 0.6;
const SPLIT_CARD_AREA = 0.08;
const SPLIT_SECONDS = 4;
// page_chrome: labels under this size (px at 1080) in tracked caps (letter spacing over this
// percent of the font size), or a row of this many bars this thin, on screen over this long
// (ai-tells-viewers.md 2: "Page chrome is the number one slop tell"; ai-tool-patterns.md:
// tiny mono all-caps labels).
const CHROME_LABEL = 40;
const CHROME_TRACKING = 2;
const CHROME_BAR = 24;
const CHROME_ROW = 4;
const CHROME_SECONDS = 8;

const pct = (value) => `${Math.round(value * 100)}%`;
const MOVE_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation", "width", "height", "reveal", "skewX", "skewY"]);
const FADE_ONLY = new Set(["opacity", "blur"]);
const DRAWN = new Set(["text", "rectangle", "ellipse", "path", "polygon", "star", "line", "image", "video", "group"]);

const firstShown = (item, threshold = 0.05) => item.samples.opacity.findIndex((value) => value > threshold);

/**
 * How each layer that comes on during the scene enters: "cut" (no animation where it appears),
 * "blur" (any entrance that blurs: blur, blur+fade, a blur-rise), "fade" (only opacity) or "move"
 * (a move, scale, wipe or a reveal by words). A layer that appears with the group around it is
 * that group's entrance.
 */
export function entranceKinds(model) {
  const step = 1 / model.fps + 1e-6;
  const list = [];
  for (const item of model.items) {
    if (item.isMask || item.perpetual || item.sceneBackground || !DRAWN.has(item.kind) || neverShown(item) || maxOpacity(item) < 0.3) continue;
    const first = firstShown(item);
    if (first <= 0) continue;
    const at = model.times[first];
    const covering = (entry) => tweensOf(model, entry.id).filter((tween) => tween.start <= at + step && tween.end >= at - step
      && tween.keys.some((key) => key !== "visible"));
    const own = covering(item);
    const parents = chainOf(model, item).slice(1);
    if (!own.length && parents.some((parent) => Math.abs(firstShown(parent) - first) <= 1)) continue;
    const tweens = [...own, ...parents.flatMap(covering)];
    const keys = tweens.flatMap((tween) => tween.keys).filter((key) => key !== "visible");
    const byUnit = tweens.some((tween) => tween.unit && tween.unit !== "layer" && (tween.stagger ?? 0) > 0);
    const kind = !keys.length ? "cut" : keys.includes("blur") ? "blur" : byUnit || keys.some((key) => MOVE_KEYS.has(key)) || !keys.every((key) => FADE_ONLY.has(key)) ? "move" : "fade";
    list.push({ item, at, kind });
  }
  return list;
}

/** Most layers that come on only fade in or blur in: the default entrance nobody chose. */
export function fadeOnlyEntrances(model, ctx) {
  const list = entranceKinds(model);
  if (list.length < FADE_MIN_ENTRANCES) return [];
  const fades = list.filter((entry) => entry.kind === "fade" || entry.kind === "blur");
  const share = fades.length / list.length;
  if (share <= FADE_SHARE) return [];
  const blurs = fades.filter((entry) => entry.kind === "blur").length;
  return [{
    rule: "fade_only_entrances", severity: "warn", itemId: fades[0].item.id, at: sec(fades[0].at),
    measured: `${fades.length} of ${list.length} entrances only fade or blur in (${pct(share)})${blurs ? `, ${blurs} through a blur` : ""}`, required: `${pct(FADE_SHARE)} or fewer`,
    message: `${fades.length} of the ${list.length} layers that come on in ${ctx.sceneName} only fade${blurs ? " or blur" : ""} in (${fades.slice(0, 3).map((entry) => ctx.name(entry.item)).join(", ")}${fades.length > 3 ? ", ..." : ""}); a fade on everything reads as a template${blurs ? ", and a blur, blur+fade or blur-rise in is the entrance every AI model reaches for" : ""}.`,
    fix: { kind: "hint", text: `Cut most layers in on a motion or on the beat (show with no fade), and give the few that matter a move with the entrance (a slide, scale or wipe)${blurs ? "; replace each blur or blur+fade in with a cut-on or a plain slide, unless a reference shows the blur" : ""}.` },
  }];
}

/** Footage shots (video filling most of the frame), each with how much it drifts: [{item, from, to, change}]. */
export function footageShots(model) {
  const frame = model.width * model.height;
  const shots = [];
  for (const item of model.items) {
    if (item.kind !== "video" || item.isMask || neverShown(item)) continue;
    for (const run of runs(model.times.length, (index) => item.samples.opacity[index] > 0.5)) {
      if (run.length < 0.5 * model.fps) continue;
      const middle = Math.round((run.from + run.to) / 2);
      const seen = visibleBoxAt(model, item, middle);
      if (insideShare(model, seen) * area(seen) / frame < SHOT_FILL) continue;
      const { x0, y0, x1, y1 } = item.samples;
      const sizeAt = (index) => Math.max(x1[index] - x0[index], 1e-6);
      const centerAt = (index) => [(x0[index] + x1[index]) / 2, (y0[index] + y1[index]) / 2];
      const [cx, cy] = centerAt(run.from);
      let most = 0;
      for (let index = run.from; index <= run.to; index += 1) {
        const [x, y] = centerAt(index);
        most = Math.max(most, Math.abs(sizeAt(index) / sizeAt(run.from) - 1), Math.hypot(x - cx, y - cy) / model.width);
      }
      const [ex, ey] = centerAt(run.to);
      const end = Math.max(Math.abs(sizeAt(run.to) / sizeAt(run.from) - 1), Math.hypot(ex - cx, ey - cy) / model.width);
      // A drift ends where it went (most of its change still there at the end) and stays small.
      const drifts = most >= DRIFT_MIN && most <= DRIFT_MAX + 1e-6 && end >= 0.6 * most;
      shots.push({ item, from: model.times[run.from], to: model.times[run.to], change: most, drifts });
    }
  }
  return shots.sort((a, b) => a.from - b.from);
}

/** Every footage shot carries a slow scale or position drift. */
export function driftOnEveryShot(model, ctx) {
  const shots = footageShots(model);
  if (shots.length < DRIFT_MIN_SHOTS || !shots.every((shot) => shot.drifts)) return [];
  const changes = shots.map((shot) => shot.change);
  return [{
    rule: "drift_on_every_shot", severity: "warn", itemId: shots[0].item.id, at: sec(shots[0].from),
    measured: `${shots.length} of ${shots.length} shots drift (${pct(Math.min(...changes))} to ${pct(Math.max(...changes))})`, required: "most shots locked off",
    message: `Every footage shot in ${ctx.sceneName} (${shots.length}) drifts slowly in size or place; a push on every shot is the auto-edit look.`,
    fix: { kind: "hint", text: "Lock most shots off (remove the slow scale or x/y animation), and keep a move only where it means something: a push into the detail the line is about." },
  }];
}

/** Shot lengths spread too evenly (stdev / mean under 0.6): the cut rate of a generated ad. */
export function evenShotLengths(model, ctx) {
  const bounds = shotBounds(model);
  const lengths = bounds.slice(1).map((time, index) => time - bounds[index]);
  if (lengths.length < EVEN_MIN_SHOTS) return [];
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  const spread = mean ? Math.sqrt(lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length) / mean : 0;
  if (spread >= EVEN_CV) return [];
  return [{
    rule: "even_shot_lengths", severity: "warn", at: 0,
    measured: `spread ${Math.round(spread * 100) / 100} over ${lengths.length} shots (${sec(Math.min(...lengths))}s to ${sec(Math.max(...lengths))}s)`, required: `spread ${EVEN_CV} or more (pro work about 0.9)`,
    message: `The ${lengths.length} shots of ${ctx.sceneName} are close in length (stdev / mean ${Math.round(spread * 100) / 100}); pro edits mix quick cuts with one long hold.`,
    fix: { kind: "hint", text: "Let one shot hold 2 to 3 times the median (a 9 to 20 s hold a minute), and cut a few others short on an action." },
  }];
}

// A layer that clips what is inside it: a group with clipContent (some item lists it in clipIds).
function clippingIds(model) {
  return new Set(model.items.flatMap((item) => item.clipIds ?? []));
}

/** Big type on one half and a small framed card on the other, over a flat frame, for 4 s or more. */
export function splitCardLayout(model, ctx) {
  const scale = scaleOf(model);
  const frame = model.width * model.height;
  const portrait = model.height > model.width;
  const clips = clippingIds(model);
  const texts = model.items.filter((item) => isText(item) && !item.isMask && item.fontSize * Math.max(...item.samples.scale) >= SPLIT_TYPE * scale);
  if (!texts.length) return [];
  const cards = model.items.filter((item) => !item.isMask && ((item.kind === "group" && (item.radius > 0 || clips.has(item.id))) || (["video", "image"].includes(item.kind) && item.radius > 0)));
  if (!cards.length) return [];
  const media = model.items.filter((item) => ["video", "image"].includes(item.kind) && !item.isMask);
  const middle = (box) => (portrait ? (box.y0 + box.y1) / 2 / model.height : (box.x0 + box.x1) / 2 / model.width);
  let found = null;
  const pairAt = (index) => {
    const text = texts.find((item) => item.samples.opacity[index] > 0.5 && item.fontSize * item.samples.scale[index] >= SPLIT_TYPE * scale);
    if (!text) return null;
    const side = middle(visibleBoxAt(model, text, index)) < 0.5;
    const card = cards.find((item) => {
      if (item.samples.opacity[index] <= 0.5) return false;
      const box = visibleBoxAt(model, item, index);
      return (box.x1 - box.x0) < SPLIT_CARD_WIDTH * model.width && area(box) >= SPLIT_CARD_AREA * frame && (middle(box) < 0.5) !== side;
    });
    if (!card) return null;
    // Flat behind: no picture fills half the frame except the card's own footage.
    const flat = !media.some((item) => item.samples.opacity[index] > 0.5 && !chainOf(model, item).includes(card)
      && area(visibleBoxAt(model, item, index)) * insideShare(model, visibleBoxAt(model, item, index)) >= 0.5 * frame);
    return flat ? { text, card } : null;
  };
  const pairs = model.times.map((_, index) => pairAt(index));
  for (const run of runs(model.times.length, (index) => Boolean(pairs[index]))) {
    const seconds = run.length / model.fps;
    if (seconds >= SPLIT_SECONDS && (!found || seconds > found.seconds)) found = { ...pairs[run.from], seconds, from: model.times[run.from], to: model.times[run.to] };
  }
  if (!found) return [];
  return [{
    rule: "split_card_layout", severity: "warn", itemId: found.text.id, at: sec(found.from), until: sec(found.to),
    measured: `${sec(found.seconds)}s of ${ctx.name(found.text)} beside the card ${ctx.name(found.card)}`, required: `under ${SPLIT_SECONDS}s`,
    message: `${ctx.name(found.text)} sits on one half of the frame and the card ${ctx.name(found.card)} on the other, over a flat frame, for ${sec(found.seconds)}s: the slide-deck layout viewers read as AI made.`,
    fix: { kind: "hint", text: "Let the real footage or screen fill the frame and put the number or words on it, not beside it in a card." },
  }];
}

const isTrackedCaps = (item) => {
  const value = String(item.text ?? "");
  const caps = item.textCase === "upper" || ((value.match(/\p{L}/gu) ?? []).length >= 2 && value === value.toUpperCase() && value !== value.toLowerCase());
  return caps && (item.letterSpacing ?? 0) > CHROME_TRACKING;
};

/** Small tracked all-caps labels or a row of thin bars (a progress bar) left on screen. */
export function pageChrome(model, ctx) {
  const scale = scaleOf(model);
  const findings = [];
  const longest = (test) => runs(model.times.length, test).reduce((best, run) => (!best || run.length > best.length ? run : best), null);
  // Labels: each one's longest stretch on screen.
  let label = null;
  for (const item of model.items) {
    if (!isText(item) || item.isMask || item.role === "ui" || !(item.fontSize < CHROME_LABEL * scale) || !isTrackedCaps(item)) continue;
    const run = longest((index) => item.samples.opacity[index] > 0.3);
    if (run && run.length / model.fps > CHROME_SECONDS && (!label || run.length > label.run.length)) label = { item, run };
  }
  if (label) findings.push({
    rule: "page_chrome", severity: "warn", itemId: label.item.id, at: sec(model.times[label.run.from]), until: sec(model.times[label.run.to]),
    measured: `label ${ctx.name(label.item)} on ${sec(label.run.length / model.fps)}s`, required: `chrome under ${CHROME_SECONDS}s`,
    message: `${ctx.name(label.item)} is a small tracked all-caps label ("${ctx.quote(label.item.text)}") left on screen for ${sec(label.run.length / model.fps)}s: page chrome reads as a template.`,
    fix: { kind: "hint", text: "Remove the label; say it with the voice, a caption on the moment, or the real UI." },
  });
  // Bars: thin rectangles side by side in one row.
  const bars = model.items.filter((item) => item.kind === "rectangle" && !item.isMask && !item.sceneBackground && !neverShown(item));
  const rowAt = (index) => {
    const rows = new Map();
    for (const item of bars) {
      if (item.samples.opacity[index] <= 0.3) continue;
      const { x0, y0, x1, y1 } = item.samples;
      const tall = y1[index] - y0[index];
      if (!(tall > 0) || tall > CHROME_BAR * scale || x1[index] - x0[index] > 0.5 * model.width) continue;
      const key = Math.round((y0[index] + y1[index]) / 2 / (6 * scale));
      if (!rows.has(key)) rows.set(key, { xs: new Set(), item });
      rows.get(key).xs.add(Math.round((x0[index] + x1[index]) / 2 / (4 * scale)));
    }
    return [...rows.values()].find((row) => row.xs.size >= CHROME_ROW) ?? null;
  };
  const rows = model.times.map((_, index) => rowAt(index));
  const bar = longest((index) => Boolean(rows[index]));
  if (bar && bar.length / model.fps > CHROME_SECONDS) {
    const row = rows[bar.from];
    findings.push({
      rule: "page_chrome", severity: "warn", itemId: row.item.id, at: sec(model.times[bar.from]), until: sec(model.times[bar.to]),
      measured: `a row of ${row.xs.size} bars on ${sec(bar.length / model.fps)}s`, required: `chrome under ${CHROME_SECONDS}s`,
      message: `A row of ${row.xs.size} thin bars (${ctx.name(row.item)} and more) stays on screen for ${sec(bar.length / model.fps)}s: a progress bar is page chrome.`,
      fix: { kind: "hint", text: "Remove the progress bar; let the picture show the progress (the distance closing, the real app) or say it in the voice." },
    });
  }
  return findings;
}
