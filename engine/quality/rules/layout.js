// Layout rules. Gates: overlap, safe_zone. Warnings: centered_run, card_grid, accent_stripe,
// glow_blob_pill.
import { atFullOpacity, coversFrame, isPortrait, primaryItems, readingTexts, scaleOf, sec, sections } from "../analysis.js";
import { area, boxAt, chainOf, frameAt, insideShare, intersection, itemById, longestRun, movingAt, overlapArea, roundBox, runs, tweensOf, visibleBoxAt } from "../model.js";

/**
 * Safe zones, as insets from each edge in shares of the frame. Each says where its numbers come
 * from. The vertical numbers are third-party measurements that disagree; kino uses the stricter
 * of each, and they are not yet re-measured (see COMPATIBILITY.md).
 */
export const SAFE_ZONES = {
  landscape: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05, source: "EBU R95 graphics-safe area, 5% each side" },
  portrait: {
    top: 270 / 1920, bottom: 707 / 1920, left: 120 / 1080, right: 120 / 1080,
    source: "Reels and TikTok interface areas from third-party measurements, unverified, 2026-10",
  },
};

export function safeRect(model) {
  const zone = isPortrait(model) ? SAFE_ZONES.portrait : SAFE_ZONES.landscape;
  return { x0: zone.left * model.width, y0: zone.top * model.height, x1: model.width * (1 - zone.right), y1: model.height * (1 - zone.bottom), zone };
}

// Text and logos must not be covered or clipped; CTAs and logos must stay in the safe zone too.
function protectedItems(model) {
  const texts = readingTexts(model);
  const ids = new Set(texts.map((item) => item.id));
  const extra = model.items.filter((item) => !ids.has(item.id) && ["logo", "cta"].includes(item.role) && !item.isMask);
  return [...texts, ...extra];
}

const atRest = (model, item, index) => !movingAt(model, item, model.times[index]);
const persistence = (model, run) => (run.length <= 2 ? "info" : "error");

// The share of the box left inside the item's clipping groups and masks (not the frame), and
// the clip that cuts the most of it.
function clipped(model, item, index) {
  let box = boxAt(item, index);
  const whole = area(box);
  if (!whole || !item.clipIds?.length) return { share: 1, clipId: null };
  let clipId = null;
  let least = Infinity;
  for (const id of item.clipIds) {
    const clip = itemById(model, id);
    if (!clip) continue;
    const kept = overlapArea(boxAt(item, index), boxAt(clip, index));
    if (kept < least) { least = kept; clipId = id; }
    box = intersection(box, boxAt(clip, index));
  }
  return { share: area(box) / whole, clipId };
}

// An exit that ends before the overlap, or an entrance that starts after it, that moves, blurs,
// turns or grows the layer but never fades it: the layer stays on screen outside its moment. The
// fix adds a fade with the same timing.
const HIDING_KEYS = ["opacity", "reveal"];
function unfaded(model, item, run) {
  const from = model.times[run.from];
  const to = model.times[run.to];
  const tweens = tweensOf(model, item.id);
  const hides = (tween) => tween.keys.some((key) => HIDING_KEYS.includes(key));
  const exit = tweens.filter((tween) => tween.kind === "out" && tween.end <= from + 1e-6).at(-1);
  if (exit && !hides(exit) && !tweens.some((tween) => tween !== exit && hides(tween) && tween.end <= from + 1e-6 && tween.start >= exit.start - 1e-6))
    return { item, tween: exit, mode: "out" };
  const entrance = tweens.find((tween) => tween.kind === "in" && tween.start >= to - 1e-6);
  if (entrance && !hides(entrance) && !tweens.some((tween) => tween !== entrance && hides(tween) && tween.kind === "in" && tween.start <= entrance.start + 1e-6 && tween.start >= to - 1e-6))
    return { item, tween: entrance, mode: "in" };
  return null;
}

// Two texts placed apart but not far enough (a line set on top of another): the upper one moves
// just below the lower one, or just above it when below leaves the frame. Two in the same spot
// are a timing problem, not a placement one, so they keep the hint.
function stackFix(model, lower, upper, run) {
  const [one, two] = [visibleBoxAt(model, lower, run.to), visibleBoxAt(model, upper, run.to)];
  const height = Math.min(one.y1 - one.y0, two.y1 - two.y0);
  if (Math.abs(one.x0 - two.x0) + Math.abs(one.y0 - two.y0) < 0.1 * height) return null;
  const gap = Math.round(0.25 * height);
  const margin = 0.05 * model.height;
  // Clear of the other text all through the overlap (an entrance may still be sliding in).
  let [below, above, top, bottom] = [-Infinity, Infinity, Infinity, -Infinity];
  for (let index = run.from; index <= run.to; index += 1) {
    const [a, b] = [visibleBoxAt(model, lower, index), visibleBoxAt(model, upper, index)];
    below = Math.max(below, a.y1 + gap - b.y0);
    above = Math.min(above, a.y0 - gap - b.y1);
    top = Math.min(top, b.y0);
    bottom = Math.max(bottom, b.y1);
  }
  const dy = bottom + below <= model.height - margin ? below : top + above >= margin ? above : null;
  return dy === null ? null : { kind: "move", itemId: upper.id, dx: 0, dy: Math.round(dy), auto: true, why: `moved ${Math.round(Math.abs(dy))}px ${dy > 0 ? "below" : "above"} the other text` };
}

export function overlap(model, ctx) {
  const findings = [];
  const guarded = protectedItems(model).filter((item) => !item.allowOverlap);
  const count = model.times.length;

  // Text or a logo on top of other text or a logo.
  for (let a = 0; a < guarded.length; a += 1) {
    for (let b = a + 1; b < guarded.length; b += 1) {
      const [lower, upper] = guarded[a].z < guarded[b].z ? [guarded[a], guarded[b]] : [guarded[b], guarded[a]];
      if (!lower.text && !upper.text) continue;
      const touching = (index) => {
        if (lower.samples.opacity[index] < 0.5 || upper.samples.opacity[index] < 0.5) return false;
        // What is seen of each: a mask or clipping group hides the rest.
        const one = visibleBoxAt(model, lower, index);
        const two = visibleBoxAt(model, upper, index);
        // A box with no area (a layer at scale 0) is not drawn, so it overlaps nothing.
        const shared = overlapArea(one, two);
        return shared > 0 && shared >= 0.02 * Math.min(area(one), area(two));
      };
      const run = longestRun(runs(count, touching));
      if (!run) continue;
      const causes = [unfaded(model, upper, run), unfaded(model, lower, run)].filter(Boolean);
      const why = causes.map(({ item, tween, mode }) => mode === "out"
        ? ` ${ctx.name(item)}'s exit "${tween.name}" ends at ${sec(tween.end)}s without fading it, so it stays on screen.`
        : ` ${ctx.name(item)}'s entrance "${tween.name}" starts at ${sec(tween.start)}s without fading it in, so it shows before then.`).join("");
      findings.push({
        rule: "overlap", severity: persistence(model, run), itemId: upper.id, otherId: lower.id,
        at: sec(model.times[run.from]), until: sec(model.times[run.to]), bbox: roundBox(intersection(visibleBoxAt(model, upper, run.from), visibleBoxAt(model, lower, run.from))),
        measured: `${sec(run.length / model.fps)}s overlapping`, required: "no overlap",
        message: `${ctx.name(upper)} overlaps ${ctx.name(lower)} from ${sec(model.times[run.from])}s to ${sec(model.times[run.to])}s.${why}`,
        fix: causes.length
          ? { kind: "fades", changes: causes.map(({ item, tween, mode }) => ({ itemId: item.id, tweenId: tween.id, mode, start: tween.start, end: tween.end })), auto: true }
          : stackFix(model, lower, upper, run) ?? { kind: "hint", text: `Move one of them, or set allowOverlap on ${ctx.name(upper)} if the overlap is on purpose.` },
      });
    }
  }

  // Something opaque drawn above text or a logo, hiding part of it.
  const covers = model.items.filter((item) => item.painted && item.opaque && !item.isMask && !item.allowOverlap && !coversFrame(model, item));
  for (const target of guarded) {
    for (const cover of covers) {
      if (cover.z <= target.z || cover.id === target.id || guarded.includes(cover)) continue;
      const hidden = (index) => {
        if (target.samples.opacity[index] < 0.5 || cover.samples.opacity[index] < 0.5) return false;
        const box = visibleBoxAt(model, target, index);
        const shared = overlapArea(box, visibleBoxAt(model, cover, index));
        return shared > 0 && shared >= 0.15 * area(box);
      };
      const run = longestRun(runs(count, hidden));
      if (!run) continue;
      findings.push({
        rule: "overlap", severity: persistence(model, run), itemId: target.id, otherId: cover.id,
        at: sec(model.times[run.from]), until: sec(model.times[run.to]), bbox: roundBox(intersection(visibleBoxAt(model, target, run.from), visibleBoxAt(model, cover, run.from))),
        measured: `${sec(run.length / model.fps)}s hidden`, required: "not hidden",
        message: `${ctx.name(cover)} is drawn over ${ctx.name(target)} and hides part of it from ${sec(model.times[run.from])}s to ${sec(model.times[run.to])}s.`,
        fix: { kind: "hint", text: `Move ${ctx.name(cover)} below ${ctx.name(target)} in the layer order, move it aside, or set allowOverlap on it if that is on purpose.` },
      });
    }
  }

  // Text or a logo partly cut off by its group or mask while it is not moving. Text wholly
  // outside its clip is not shown (it is often waiting to slide in), so it is not cut off.
  for (const target of guarded) {
    if (!target.clipIds?.length) continue;
    const cut = (index) => {
      if (!atFullOpacity(target, index) || !atRest(model, target, index)) return false;
      const { share } = clipped(model, target, index);
      return share > 0 && share < 0.95;
    };
    const run = longestRun(runs(count, cut));
    if (!run) continue;
    const { share, clipId } = clipped(model, target, run.from);
    findings.push({
      rule: "overlap", severity: persistence(model, run), itemId: target.id, otherId: clipId,
      at: sec(model.times[run.from]), until: sec(model.times[run.to]), bbox: roundBox(boxAt(target, run.from)),
      measured: `${Math.round((1 - share) * 100)}% cut off`, required: "fully shown at rest",
      message: `${ctx.name(target)} is cut off by ${ctx.name(itemById(model, clipId) ?? { name: "its group" })} (${Math.round((1 - share) * 100)}% hidden) while it is still.`,
      fix: { kind: "hint", text: "Make the group or mask larger, or move the layer inside it." },
    });
  }
  return findings;
}

// The hint when a layer's places at rest are further apart than the safe zone is tall (or
// wide), naming the animations that move it that far.
function apartText(model, item, all, safeWidth, safeHeight) {
  const tall = all.y1 - all.y0 > safeHeight;
  const [span, zone, key] = tall ? [all.y1 - all.y0, safeHeight, "y"] : [all.x1 - all.x0, safeWidth, "x"];
  const movers = tweensOf(model, item.id).filter((tween) => tween.keys.includes(key)).map((tween) => `"${tween.name}"`);
  const what = movers.length ? `the move${movers.length > 1 ? "s" : ""} (${movers.slice(0, 3).join(", ")})` : "its move";
  return `Its places at rest span ${Math.round(span)} px ${tall ? "top to bottom" : "side to side"}, but the safe zone is ${Math.round(zone)} px ${tall ? "tall" : "wide"}, so no one move brings them all in. Shorten ${what} so its start and its end both fit, or make the layer smaller.`;
}

export function safeZone(model, ctx) {
  const findings = [];
  const safe = safeRect(model);
  const [safeWidth, safeHeight] = [safe.x1 - safe.x0, safe.y1 - safe.y0];
  for (const item of protectedItems(model)) {
    // The samples judged: at full opacity, at rest and not wholly outside the frame (off_canvas
    // covers a layer that never shows).
    const judged = (index) => atFullOpacity(item, index) && atRest(model, item, index) && insideShare(model, boxAt(item, index)) > 0;
    const outside = (index) => {
      if (!judged(index)) return false;
      const box = boxAt(item, index);
      return box.x0 < safe.x0 - 0.5 || box.y0 < safe.y0 - 0.5 || box.x1 > safe.x1 + 0.5 || box.y1 > safe.y1 + 0.5;
    };
    const spans = runs(model.times.length, outside);
    const run = longestRun(spans);
    if (!run) continue;
    // The fix is worked out from every stretch outside the zone (the largest overshoot on each
    // side), so one move brings them all in: a slide's held first frame below the zone and a
    // drift that ends below it both. Before, only the longest stretch counted, and the next
    // check found the other one and gave a second, different move.
    const union = (test) => {
      let found = null;
      for (let index = 0; index < model.times.length; index += 1) {
        if (!test(index)) continue;
        const box = boxAt(item, index);
        found = found ? { x0: Math.min(found.x0, box.x0), y0: Math.min(found.y0, box.y0), x1: Math.max(found.x1, box.x1), y1: Math.max(found.y1, box.y1) } : { ...box };
      }
      return found;
    };
    // Every judged place moves with the layer, so they must all fit in the zone together. When
    // they do not (a climb from below the zone to above it), no one move brings them all in: a
    // move worked out from the longest stretch alone pushed another stretch further out, and
    // the next check moved it back, for ever. Then the fix is a hint to shorten the move.
    let all = union(judged);
    let outBox = union(outside);
    let together = all.x1 - all.x0 <= safeWidth && all.y1 - all.y0 <= safeHeight;
    // A camera tour: a group around the layer rests in several places (stops), and the layer is
    // seen at another place at each. Then the places are only combined within the stop of the
    // longest stretch outside the zone, never across stops.
    const ancestors = chainOf(model, item).slice(1);
    const stopOf = (index) => ancestors.map((group) => roundBox(boxAt(group, index)).join(",")).join(";");
    const stopStarts = new Map();
    for (let index = 0; index < model.times.length; index += 1) if (judged(index) && !stopStarts.has(stopOf(index))) stopStarts.set(stopOf(index), index);
    const tour = !together && stopStarts.size > 1;
    if (tour) {
      const stop = stopOf(run.from);
      all = union((index) => judged(index) && stopOf(index) === stop);
      outBox = union((index) => outside(index) && stopOf(index) === stop);
      together = all.x1 - all.x0 <= safeWidth && all.y1 - all.y0 <= safeHeight;
    }
    const longestBox = boxAt(item, run.from);
    const fits = longestBox.x1 - longestBox.x0 <= safeWidth && longestBox.y1 - longestBox.y0 <= safeHeight;
    // The move goes a few pixels past the edge (4 px at 1080p, scaled with the frame, at least
    // 2), so a layer that misses by 1 px is not put back right on the line, where the next
    // measure can miss again. The margin never pushes the layer out of the other side.
    const margin = Math.max(2, Math.round(4 * scaleOf(model)));
    const roomX = Math.max(0, Math.min(margin, safeWidth - (all.x1 - all.x0)));
    const roomY = Math.max(0, Math.min(margin, safeHeight - (all.y1 - all.y0)));
    const dx = outBox.x0 < safe.x0 ? safe.x0 - outBox.x0 + roomX : outBox.x1 > safe.x1 ? safe.x1 - outBox.x1 - roomX : 0;
    const dy = outBox.y0 < safe.y0 ? safe.y0 - outBox.y0 + roomY : outBox.y1 > safe.y1 ? safe.y1 - outBox.y1 - roomY : 0;
    // On a tour, the move must also keep the layer inside the zone, or wholly off screen, at
    // every other stop; else no move of the layer fixes it, and the hint names the stops.
    const moveWorks = !tour || model.times.every((_, index) => {
      if (!atFullOpacity(item, index) || !atRest(model, item, index)) return true;
      const box = boxAt(item, index);
      const moved = { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy };
      const inside = moved.x0 >= safe.x0 - 0.5 && moved.y0 >= safe.y0 - 0.5 && moved.x1 <= safe.x1 + 0.5 && moved.y1 <= safe.y1 + 0.5;
      return inside || insideShare(model, moved) === 0;
    });
    const stopTimes = [...stopStarts.values()].map((index) => `${sec(model.times[index])}s`);
    const tourText = `Its group rests in ${stopTimes.length} places while it shows (from ${stopTimes.slice(0, 4).join(", ")}${stopTimes.length > 4 ? " and more" : ""}), and no one move of it fits them all. It is outside the zone at ${sec(model.times[run.from])}s: keep it hidden until its group reaches the place where it is read, move it further from the layers shown at ${sec(model.times[run.from])}s, or change where the group rests then.`;
    // The fix moves the layer's animated places with it (backend/agent/quality.mjs). It is
    // applied by check {fix:"auto"} unless a custom animation moves the layer, whose path the
    // agent chose: then it is only shown.
    const placed = tweensOf(model, item.id).some((tween) => tween.kind === "custom" && (tween.keys.includes("x") || tween.keys.includes("y")));
    const spanText = (span) => (span.from === span.to ? `at ${sec(model.times[span.from])}s` : `from ${sec(model.times[span.from])}s to ${sec(model.times[span.to])}s`);
    const listed = spans.slice(0, 3).map(spanText);
    const when = `${listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed[0]}${spans.length > 3 ? ` and ${spans.length - 3} more times` : ""}`;
    findings.push({
      rule: "safe_zone", severity: persistence(model, run), itemId: item.id,
      at: sec(model.times[run.from]), until: sec(model.times[run.to]), bbox: roundBox(longestBox),
      measured: roundBox(outBox), required: roundBox(safe),
      message: `${ctx.name(item)} is outside the safe zone (${safe.zone.source}) ${when}, so a TV or app may cut or cover it.`,
      fix: !fits
        ? { kind: "hint", text: `It is larger than the safe zone (${Math.round(safeWidth)}×${Math.round(safeHeight)}); make it smaller.` }
        : !together ? { kind: "hint", text: apartText(model, item, all, safeWidth, safeHeight) }
        : !moveWorks ? { kind: "hint", text: tourText }
        : { kind: "move", itemId: item.id, dx: Math.round(dx), dy: Math.round(dy), auto: !placed },
    });
  }
  return findings;
}

// Whether every primary text shown in a section is centred (by alignment and by place).
function sectionCentered(model, section) {
  const from = frameAt(model, section.start);
  const to = Math.max(from, frameAt(model, section.end) - 1);
  const texts = primaryItems(model).filter((item) => item.text);
  const shown = texts.filter((item) => item.samples.opacity.subarray(from, to + 1).some((value) => value >= 0.5));
  if (!shown.length) return null;
  return shown.every((item) => {
    const index = from + item.samples.opacity.subarray(from, to + 1).findIndex((value) => value >= 0.5);
    const box = boxAt(item, index);
    return item.textAlign === "center" && Math.abs((box.x0 + box.x1) / 2 - model.width / 2) <= 0.02 * model.width;
  });
}

export function centeredRun(model, ctx) {
  const list = sections(model).map((section) => ({ section, centered: sectionCentered(model, section) })).filter((entry) => entry.centered !== null);
  let streak = [];
  let longest = [];
  for (const entry of list) {
    streak = entry.centered ? [...streak, entry] : [];
    if (streak.length > longest.length) longest = streak;
  }
  if (longest.length < 3) return [];
  return [{
    rule: "centered_run", severity: "warn", at: sec(longest[0].section.start), until: sec(longest.at(-1).section.end),
    measured: `${longest.length} sections centred`, required: "at most 2 in a row",
    message: `Everything is centered in ${longest.length} sections in a row (${sec(longest[0].section.start)}s–${sec(longest.at(-1).section.end)}s) in ${ctx.sceneName}.`,
    fix: { kind: "hint", text: "Left-align or offset one section's text to give the layout a direction." },
  }];
}

const isCardShape = (item) => (item.kind === "rectangle" || item.kind === "group") && item.painted && item.radius > 0 && item.restWidth > 0 && item.restHeight > 0;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b), 1);

export function cardGrid(model, ctx) {
  const cards = model.items.filter(isCardShape);
  if (cards.length < 3) return [];
  const step = Math.max(1, Math.round(model.fps / 2));
  for (let index = 0; index < model.times.length; index += step) {
    const shown = cards.filter((item) => item.samples.opacity[index] >= 0.5);
    for (const first of shown) {
      const same = shown.filter((item) => near(item.restWidth, first.restWidth, 0.02) && near(item.restHeight, first.restHeight, 0.02) && near(item.radius, first.radius, 0.05));
      const box = boxAt(first, index);
      const row = same.filter((item) => Math.abs(boxAt(item, index).y0 - box.y0) <= 0.02 * model.height);
      const column = same.filter((item) => Math.abs(boxAt(item, index).x0 - box.x0) <= 0.02 * model.width);
      const line = row.length >= 3 ? row : column.length >= 3 ? column : null;
      if (!line) continue;
      return [{
        rule: "card_grid", severity: "warn", itemId: first.id, itemIds: line.map((item) => item.id), at: sec(model.times[index]),
        measured: `${line.length} identical cards`, required: "varied layout",
        message: `${line.length} identical rounded cards (${line.slice(0, 4).map((item) => ctx.name(item)).join(", ")}) sit in a ${line === row ? "row" : "column"}; identical card grids are a common generic look.`,
        fix: { kind: "hint", text: "Give one card more weight, change the sizes, or show them one at a time." },
      }];
    }
  }
  return [];
}

export function accentStripe(model, ctx) {
  const s = scaleOf(model);
  // A product's own UI (role ui: a text caret, a scrollbar) is not a designed accent stripe.
  const stripes = model.items.filter((item) => item.kind === "rectangle" && item.role !== "ui" && item.painted && item.restWidth > 0 && item.restWidth <= 12 * s && item.restHeight >= 3 * item.restWidth);
  const findings = [];
  for (const stripe of stripes) {
    const step = Math.max(1, Math.round(model.fps / 2));
    for (let index = 0; index < model.times.length; index += step) {
      if (stripe.samples.opacity[index] < 0.5) continue;
      const box = boxAt(stripe, index);
      const height = box.y1 - box.y0;
      const partner = model.items.find((other) => {
        if (other.id === stripe.id || other.samples.opacity[index] < 0.5) return false;
        const target = boxAt(other, index);
        const shared = Math.min(box.y1, target.y1) - Math.max(box.y0, target.y0);
        if (shared < 0.6 * height) return false;
        if (isCardShape(other) && target.x1 - target.x0 > 6 * (box.x1 - box.x0))
          return box.x0 >= target.x0 - 1 && box.x0 - target.x0 <= 0.08 * (target.x1 - target.x0);
        if (other.text) return target.x0 - box.x1 >= 0 && target.x0 - box.x1 <= 24 * s && shared >= 0.6 * (target.y1 - target.y0);
        return false;
      });
      if (!partner) continue;
      findings.push({
        rule: "accent_stripe", severity: "warn", itemId: stripe.id, otherId: partner.id, at: sec(model.times[index]), bbox: roundBox(box),
        measured: `${Math.round(box.x1 - box.x0)}px stripe`, required: "no left-edge accent stripe",
        message: `${ctx.name(stripe)} is a thin accent stripe on the left edge of ${ctx.name(partner)}, a common generic look.`,
        fix: { kind: "hint", text: "Remove the stripe, or mark the emphasis with type size, weight or colour instead." },
      });
      break;
    }
  }
  return findings;
}

export function glowBlobPill(model, ctx) {
  const s = scaleOf(model);
  const frame = model.width * model.height;
  const glow = model.items.find((item) => item.shadow && item.shadow.blur >= 16 * s && Math.abs(item.shadow.x) <= 4 * s && Math.abs(item.shadow.y) <= 4 * s);
  const blob = model.items.find((item) => {
    if (item.isMask) return false;
    const largest = Math.max(...Array.from(item.samples.opacity, (value, index) => (value > 0.05 ? area(boxAt(item, index)) : 0)));
    return (item.blur >= 30 * s && largest >= 0.05 * frame) || (item.kind === "ellipse" && item.fill && typeof item.fill === "object" && largest >= 0.1 * frame);
  });
  const texts = model.items.filter((item) => item.text);
  const pill = model.items.find((item) => {
    if (!(item.kind === "rectangle" || item.kind === "group") || !item.painted) return false;
    const short = Math.min(item.restWidth, item.restHeight);
    // A button is tall enough to hold a readable label (24 px at 1080p): a thin bar is not one.
    if (!(short >= 24 * s) || item.radius < 0.45 * short || item.restWidth < 2 * item.restHeight) return false;
    // ...and its label sits wholly inside it, not just across it.
    const slack = 2 * s;
    return texts.some((text) => item.samples.opacity.some((value, index) => {
      if (value < 0.5 || text.samples.opacity[index] < 0.5) return false;
      const box = boxAt(item, index);
      const inner = boxAt(text, index);
      return inner.x0 >= box.x0 - slack && inner.x1 <= box.x1 + slack && inner.y0 >= box.y0 - slack && inner.y1 <= box.y1 + slack;
    }));
  });
  if (!glow || !blob || !pill) return [];
  return [{
    rule: "glow_blob_pill", severity: "warn", itemId: pill.id, itemIds: [glow.id, blob.id, pill.id],
    measured: "glow + blob + pill", required: "not all three",
    message: `${ctx.sceneName} combines a glow (${ctx.name(glow)}), a blurred blob (${ctx.name(blob)}) and a pill button (${ctx.name(pill)}), the most common generic AI look.`,
    fix: { kind: "hint", text: "Drop at least one: a plain button, no glow, or a flat background." },
  }];
}

