// covered_layer: a layer that its own timing and opacity put on screen but that an opaque layer
// above it hides for all of that time (a flash or fade-to-black added before the footage, so the
// footage was stacked above it and the render never shows it). Rendering shows nothing wrong, so
// this is found from the layer order and the boxes.
import { area, boxAt, intersection, roundBox, tweensOf, visibleBoxAt } from "../model.js";
import { coversFrame, sec } from "../analysis.js";

const SEEN = 0.05; // the layer's opacity (its parents' included) from which it shows
const PEAK = 0.3; // the most opacity it must reach, so a fade's last faint frames are not a layer
const SOLID = 0.98; // a cover is opaque from here
const SHORT_FLASH = 2; // an opaque full-frame overlay shown this long or less is a flash or a fade, not a plate

const opacityAt = (item, index) => item.samples.opacity[index];

// Files whose format has no alpha channel, so every pixel is opaque. A png, webp, gif, webm or mov
// may be a grain, frame or alpha overlay with clear pixels (it hides nothing), and the model
// holds no alpha flag, so only these count as covers.
const OPAQUE_VIDEO = /\.(mp4|m4v|mkv|avi)(\?|#|$)/i;
const OPAQUE_IMAGE = /\.(jpe?g|bmp)(\?|#|$)/i;

// The shapes and footage that can hide what is under them: a solid rectangle, an opaque-format
// video, or an opaque-format picture that fills the frame (a smaller one has edges to spare).
function canCover(model, item) {
  if (!item.painted || item.isMask || item.allowOverlap || (item.blendMode ?? "normal") !== "normal") return false;
  if (item.kind === "video") return OPAQUE_VIDEO.test(item.src ?? "");
  if (item.kind === "image") return OPAQUE_IMAGE.test(item.src ?? "") && coversFrame(model, item);
  return item.kind === "rectangle" && item.fill != null && (item.paintAlpha ?? 1) >= SOLID;
}

// A box of the target inside the frame, or null when none of it is on screen.
function shownBox(model, item, index) {
  const box = intersection(visibleBoxAt(model, item, index), { x0: 0, y0: 0, x1: model.width, y1: model.height });
  return area(box) > 4 ? box : null;
}

// True when the cover hides the whole box at this sample: fully opaque, sharp, not turned, and a
// rounded corner no bigger than its 30% inset off the box.
function hides(model, cover, box, index) {
  if (cover.samples.opacity[index] < SOLID || cover.samples.blur[index] > 0.5 || Math.abs(cover.samples.turn?.[index] ?? 0) > 0.01) return false;
  const edge = visibleBoxAt(model, cover, index);
  const inset = 0.3 * (cover.radius || 0) + 0.5;
  return box.x0 >= edge.x0 + inset - 1 && box.y0 >= edge.y0 + inset - 1 && box.x1 <= edge.x1 - inset + 1 && box.y1 <= edge.y1 - inset + 1;
}

// An overlay by construction: a full-frame shape that fades (a flash, a fade to black: opaque but
// short), or a grade, tint or vignette (clear somewhere, a gradient with a clear stop, or blended).
// A plate or a background (an opaque gradient too) that is meant to sit under the footage is not,
// so it is only told to the agent.
function overlayByConstruction(model, item, seen) {
  if (!["rectangle", "ellipse", "path", "star"].includes(item.kind) || !coversFrame(model, item)) return false;
  const fades = tweensOf(model, item.id).some((tween) => tween.keys.includes("opacity"));
  const tint = (item.blendMode ?? "normal") !== "normal" || (item.paintAlpha ?? 1) < SOLID;
  if (tint) return true;
  return fades && seen / model.fps <= SHORT_FLASH;
}

export function coveredLayer(model, ctx) {
  const findings = [];
  const covers = model.items.filter((item) => canCover(model, item));
  if (!covers.length) return findings;
  for (const target of model.items) {
    if (!target.painted || target.isMask || target.allowOverlap || target.kind === "group" || target.kind === "text") continue;
    if (target.role === "background" || target.sceneBackground) continue;
    const above = covers.filter((cover) => cover.parentId === target.parentId && cover.z > target.z);
    if (!above.length) continue;
    const seen = [];
    for (let index = 0; index < model.times.length; index += 1)
      if (opacityAt(target, index) >= SEEN && shownBox(model, target, index)) seen.push(index);
    if (seen.length < 2 || Math.max(...seen.map((index) => opacityAt(target, index))) < PEAK) continue;
    // Who hides it at each sample it shows: one miss and it is seen at some time, so it is left alone.
    const hiders = new Map();
    let missed = false;
    for (const index of seen) {
      const box = shownBox(model, target, index);
      const found = above.filter((cover) => hides(model, cover, box, index)).sort((a, b) => b.z - a.z)[0];
      if (!found) { missed = true; break; }
      hiders.set(found, (hiders.get(found) ?? 0) + 1);
    }
    if (missed) continue;
    const used = [...hiders.keys()].sort((a, b) => hiders.get(b) - hiders.get(a) || b.z - a.z);
    const top = used.reduce((best, cover) => (cover.z > best.z ? cover : best));
    const [from, to] = [model.times[seen[0]], model.times[seen.at(-1)]];
    const names = used.length === 1 ? ctx.name(used[0]) : `${ctx.name(used[0])} and ${used.length - 1} more layer${used.length === 2 ? "" : "s"}`;
    const overlay = overlayByConstruction(model, target, seen.length);
    findings.push({
      rule: "covered_layer", severity: "warn", itemId: target.id, otherId: top.id,
      at: sec(from), until: sec(to), bbox: roundBox(boxAt(target, seen[0])),
      measured: `${sec(seen.length / model.fps)}s on screen, all of it covered`, required: "seen at some time",
      message: `${ctx.name(target)} never shows: ${names} ${used.length === 1 ? "is" : "are"} drawn over it and opaque for all of its time on screen (${sec(from)}s to ${sec(to)}s).${overlay ? " It is an overlay, so it belongs above the footage." : ""}`,
      fix: { kind: "reorder", itemId: target.id, aboveId: top.id, auto: overlay },
    });
  }
  return findings;
}
