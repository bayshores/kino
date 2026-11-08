import { layoutText, textUnits, unitGlyphs, glyphPath, glyphPathBounds, glyphDrawBounds, resizeTextLayer } from "./textLayout.js";
import { defaultFonts } from "./fonts.js";
import { MEDIA_SAMPLE_TOLERANCE, gifFrameIndex, mediaDesignTime, mediaFrameState, resolvePlayback, videoFrameIndex } from "./playback.js";
import { evaluateLayer } from "./animation.js";
import { effectsAt } from "./effects/animation.js";
import { smearLength } from "./effects/motionBlurs.js";
import { renderEffectPreset } from "./effects/presets.js";
import { calmLightAnimations } from "./effects/light.js";
import { copyContent } from "./effects/svg.js";
import { renderBackdropBlur, renderGlassBackdrop } from "./effects/backdrop.js";
import { effectiveBoxStyle } from "./boxStyles.js";
import { maskSwitchedOff } from "./maskVisibility.js";
import { FULL_REVEAL, isGeneralReveal, normalizeReveal } from "./reveal.js";
import { generalReveal } from "./wipe.js";
import { shadowAlpha, withShadowAlpha } from "./shadowInterpolation.js";
import { expandEffectBounds, mappedBounds, mergeBounds } from "./effectBounds.js";
import { enabledAnimations } from "./animationEnabled.js";
import { hasTextChanges } from "./textChange.js";
import { plainPaintKey, rememberForLayout } from "./textSvgCache.js";
import { textDrawingsAt } from "./textChangeDraw.js";
import { textAnimationMode, textAnimationPlan, textAnimationUnitState } from "./textAnimation.js";
import { resolvedCornerRadii, shapePath } from "./shapes.js";
import { contourLengths, hasStrokePattern, trimDash } from "./strokeTrim.js";
import { repeatBounds, repeatMarkup, repeaterOf } from "./repeater.js";
import { gradientCoordinates, isFillEnabled, pathGradientBounds } from "./paints.js";
import { pathBounds, parsePath, serializePath } from "./vectorPath.js";
import { backgroundPaintAt } from "./sceneBackground.js";
import { IDENTITY, inverse, layerMatrix, multiply } from "./geometry.js";
import { PREVIEW_BLUR_FROM, previewSampleTimes, previewShutter, shutterTravel, smearTag, whipShutter } from "./previewBlur.js";
import { TILT_TOLERANCE, hasTilt, tiltPivot, tiltTriangles, tiltVisiblePart, tiltedBounds } from "./tilt.js";

const SAFE_RASTER_DATA =
  /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[a-z0-9+/=]+$/i;
// Media files, plus decoded GIF frames at /api/media/<file>/frames/<index>.png?decoder=<version>.
// Either may end with the share link's ?share=... (&share=... after the decoder version).
const SAFE_MEDIA_PATH =
  /^\/api\/media\/[a-z0-9_-]{1,128}(?:\.[a-z0-9]{1,8})?(?:\/frames\/\d{1,6}\.png\?decoder=\d{1,4}(?:&share=[A-Za-z0-9._~-]{1,128})?|(?:\/frames\/\d{1,6}\.png)?(?:\?share=[A-Za-z0-9._~-]{1,128})?)$/i;
const SAFE_POSTER_PATH = /^\/api\/media\/[a-z0-9_-]{1,128}\.[a-z0-9]{1,8}\/poster\/(?:0|[1-9]\d{0,7})\.png(?:\?share=[A-Za-z0-9._~-]{1,128})?$/i;
// The editor decodes GIF/video pictures into PNG Blobs and shows them through object URLs
// (blob:<page origin>/<uuid>). These are accepted only from the frame maps the editor passes in,
// never from a layer's src or embedMedia, which come from the document.
const DECODED_FRAME_URL =
  /^blob:https?:\/\/[a-z0-9.:[\]-]{1,255}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A picture file of a server export that Chromium draws: kino-frame://media/<absolute path of a
// file in the export's own folder> (backend/chromium-raster.mjs mediaUrl; desktop/raster-worker.cjs
// answers it). Like DECODED_FRAME_URL, accepted only from the frame maps the export passes in.
export const EXPORT_FRAME_URL =
  /^kino-frame:\/\/media\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]{1,4096}\.(?:png|jpe?g|webp|gif|avif)$/i;
const frameUrl = (value) => typeof value === "string" && (DECODED_FRAME_URL.test(value) || EXPORT_FRAME_URL.test(value));
const BLEND_MODES = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  // Add (linear dodge): the layer's colour is added to what is below it, clipped at white.
  // CSS calls it plus-lighter. Resvg cannot draw it, so exports use Chromium for it
  // (backend/raster-policy.mjs).
  "add",
]);
const SAFE_COLOR =
  /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?)\([\d.% ,/+\-]+\)|[a-z]{1,24}|currentColor)$/i;

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const fmt = (value) => String(Math.round(finite(value) * 10000) / 10000);

export function escapeXml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
}

function safeColor(value, fallback = "none") {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  return SAFE_COLOR.test(color) ? color : fallback;
}

function checkedNumber(value, fallback = 0, minimum = -1e6, maximum = 1e6) {
  const number = finite(value, fallback);
  return Math.max(minimum, Math.min(maximum, number));
}

// The layer at the drawing's time (as designed in Design mode). The drawing's fonts measure
// Auto height text that a Resize rewraps (animation.js addAutoTextHeights).
function getAnimatedLayer(
  layer,
  context,
  unitIndex = 0,
  unitCount = 1,
  unit,
) {
  if (context.design) return { ...effectiveBoxStyle(layer) };
  if (unitIndex === 0 && unitCount === 1 && !unit) return { ...shownState(layer, context) };
  return evaluatedState(layer, context, { unitIndex, unitCount, unit });
}

function evaluatedState(layer, context, { unitIndex = 0, unitCount = 1, unit } = {}) {
  const evaluated = evaluateLayer(layer, context.time, {
    unitIndex,
    unitCount,
    ...(unit ? { unit } : {}),
    fonts: context.fonts,
    // The renderer only reads the animations: share them (and, in the live preview, whose
    // documents are replaced and never changed in place, their sorted lists) between frames.
    shareAnimations: context.interactiveMedia ? "remember" : true,
  });
  const values = evaluated?.values ?? evaluated?.properties ?? evaluated ?? {};
  // evaluateLayer's result is already a new copy of the layer with its values.
  return values === evaluated ? evaluated : { ...effectiveBoxStyle(layer), ...values };
}

// A drawing reads a layer several times (backdrops, its children's matrices, bounds), so its
// state at the drawing's time is worked out once. Read only: getAnimatedLayer gives a copy.
function shownState(layer, context) {
  if (context.design) return effectiveBoxStyle(layer);
  const saved = context.animated.get(layer);
  if (saved && saved.time === context.time) return saved.state;
  const state = evaluatedState(layer, context);
  context.animated.set(layer, { time: context.time, state });
  return state;
}


// `who` names the layer in errors ("video layer “clip”"); export.mjs passes its own wording.
function normalizeHref(value, layer = {}, label = "image", who = `${label} layer “${layer.name ?? layer.id}”`) {
  if (value instanceof Uint8Array) {
    const mime = layer.mimeType ?? layer.mime ?? "image/png";
    if (!/^image\/(?:png|jpeg|jpg|webp|gif|avif)$/i.test(mime)) {
      throw new Error(`${who} uses an unsupported media type.`);
    }
    const bytes =
      typeof Buffer !== "undefined"
        ? Buffer.from(value).toString("base64")
        : btoa(String.fromCharCode(...value));
    return `data:${mime};base64,${bytes}`;
  }
  if (value && typeof value === "object") {
    if (value.buffer instanceof Uint8Array)
      return normalizeHref(
        value.buffer,
        { ...layer, mimeType: value.mimeType ?? value.type },
        label,
        who,
      );
    value = value.href ?? value.src ?? value.url;
  }
  // An image or video layer made without a file: say so, not that its address is wrong.
  if (value === "" || (typeof value === "string" && !value.trim()))
    throw new Error(
      `${who} has no src (no media file). Import the file with project import and set src to the /api/media/... address it answers, or delete the layer.`,
    );
  if (typeof value !== "string")
    throw new Error(`${who} has no usable frame or image.`);
  if (SAFE_RASTER_DATA.test(value) || SAFE_MEDIA_PATH.test(value) || SAFE_POSTER_PATH.test(value)) return value;
  throw new Error(
    `${who} has src “${value.length > 60 ? `${value.slice(0, 59)}…` : value}”, which is not a kino media path: it must use /api/media/... or an embedded raster image. External and SVG media are not loaded.`,
  );
}

function mapValue(map, layer) {
  if (!map) return undefined;
  if (map instanceof Map) return map.get(layer.id) ?? map.get(layer.src);
  return map[layer.id] ?? map[layer.src];
}

// `sourceTime` is the time inside the media file, from mediaFrameState.
function videoFrameFor(layer, time, sourceTime, videoFrames) {
  let value = mapValue(videoFrames, layer);
  if (typeof value === "function") value = value({ layer, time, sourceTime });
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    // Timestamped frames carry their own source time in seconds.
    if (
      value.some(
        (frame) =>
          frame &&
          typeof frame === "object" &&
          Number.isFinite(frame.time ?? frame.timestamp),
      )
    ) {
      const ordered = value
        .slice()
        .sort(
          (a, b) =>
            finite(a.time ?? a.timestamp) - finite(b.time ?? b.timestamp),
        );
      let selected = ordered[0];
      for (const frame of ordered) {
        if (finite(frame.time ?? frame.timestamp) <= sourceTime + MEDIA_SAMPLE_TOLERANCE)
          selected = frame;
        else break;
      }
      return selected;
    }
    // Untimed frames are spread evenly across Play, starting at the source offset.
    const duration = finite(layer.mediaDuration, 0);
    const fps = duration > 0 ? value.length / duration : 30;
    return value[videoFrameIndex(sourceTime, Math.max(0, finite(layer.mediaOffset, 0)), fps, value.length)];
  }
  return value;
}

function videoHref(layer, time, sourceTime, context) {
  const frame = videoFrameFor(layer, time, sourceTime, context.videoFrames);
  if (frameUrl(frame)) return frame;
  return normalizeHref(frame, layer, "video");
}

// Decoded GIF frames: { durations: seconds per frame, frames: hrefs or bytes } or a provider function.
function imageFrameFor(layer, time, sourceTime, imageFrames) {
  let value = mapValue(imageFrames, layer);
  if (typeof value === "function") value = value({ layer, time, sourceTime });
  if (!value || typeof value !== "object" || !Array.isArray(value.frames)) return value;
  const index = gifFrameIndex(value.durations, sourceTime);
  return index < 0 ? undefined : value.frames[Math.min(index, value.frames.length - 1)];
}

// The picture an image layer shows: its decoded GIF frame for this moment when imageFrames has one,
// otherwise the embedded media or the layer's own src.
function imageHref(layer, time, sourceTime, context) {
  const frame = imageFrameFor(layer, time, sourceTime, context.imageFrames);
  if (frameUrl(frame)) return frame;
  return normalizeHref(frame ?? mapValue(context.embedMedia, layer) ?? layer.src, layer, "image");
}

// Layer clock (after component holds) and the matching time inside the media file.
// Motion blur draws one output frame at a few nearby times (`context.time`), but footage keeps the
// picture of the output frame's own time (`context.mediaTime`): the shutter smears the layer's
// movement, not two file frames laid over each other. This holds for every clip, a video that
// blends or flows between its file frames (mediaInterpolation) too: its picture is the blend of
// the frame's own time, the one the draft and look show (each sample's own blend mixed in a
// little of the file frames on either side, a faint ghost in every frame of a 1× blended clip).
function mediaClock(layer, context) {
  if (context.design) return { time: 0, sourceTime: mediaDesignTime(layer) };
  const time = resolvePlayback(layer, context.mediaTime).time;
  return { time, sourceTime: mediaFrameState(layer, time).sourceTime };
}

function makeTree(layers) {
  const nodes = new Map();
  for (const layer of layers ?? [])
    nodes.set(layer.id, { layer, children: [] });
  const roots = [];
  for (const node of nodes.values()) {
    const parent =
      node.layer.parentId == null ? null : nodes.get(node.layer.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const visiting = new Set();
  const checked = new Set();
  const visit = (node) => {
    if (visiting.has(node.layer.id))
      throw new Error("Layer parent references contain a cycle.");
    if (checked.has(node.layer.id)) return;
    visiting.add(node.layer.id);
    for (const child of node.children) visit(child);
    visiting.delete(node.layer.id);
    checked.add(node.layer.id);
  };
  for (const root of roots) visit(root);
  if (checked.size !== nodes.size)
    throw new Error("Layer parent references contain an unreachable cycle.");
  return roots;
}

function idFor(context, kind) {
  // Border rendering derives a context with different hit behavior, but shares the same defs.
  // Keep the allocator shared too, so sibling borders cannot reuse a gradient or mask ID.
  context.ids.sequence += 1;
  return `${context.idPrefix}${kind}-${context.ids.sequence}`;
}

function parentWorldMatrix(id, context) {
  if (!id || !context.layersById.has(id)) return IDENTITY;
  if (!context.worldMatrices.has(id)) {
    const parent = context.layersById.get(id);
    const shown = shownState(parent, context);
    context.worldMatrices.set(id, multiply(parentWorldMatrix(parent.parentId, context), layerMatrix(shown)));
  }
  return context.worldMatrices.get(id);
}

// resvg 2.6.2 aborts in fit_to_rect when an offscreen clipping group's bounds do not
// intersect its raster surface. Transparent geometry around the scene center keeps bounds
// valid. Nested clips share that point; it paints nothing and takes no canvas hits. Keeping
// this in SVG also protects PNG/video/GIF exports without changing the browser's artwork.
function rasterClipRectangle(state, context, extraTransform = IDENTITY) {
  if (context.canvas) return null;
  let matrix = multiply(multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state)), extraTransform);
  if (context.captureInverse) matrix = multiply(context.captureInverse, matrix);
  const local = inverse(matrix);
  if (!local) return null;
  const center = context.captureBounds
    ? { x: context.captureBounds.x + context.captureBounds.width / 2, y: context.captureBounds.y + context.captureBounds.height / 2 }
    : { x: context.width / 2, y: context.height / 2 };
  const cx = local[0] * center.x + local[2] * center.y + local[4];
  const cy = local[1] * center.x + local[3] * center.y + local[5];
  // Retain a nonzero extent in the native renderer's float32 local coordinates even under
  // very large nested scales. A tiny inverse-transformed pixel can otherwise round to zero.
  const halfWidth = Math.max(1, (Math.abs(local[0]) + Math.abs(local[2])) * 2, Math.abs(cx) * 1e-5);
  const halfHeight = Math.max(1, (Math.abs(local[1]) + Math.abs(local[3])) * 2, Math.abs(cy) * 1e-5);
  return { x: cx - halfWidth, y: cy - halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
}

function rasterClipBounds(state, context, extraTransform = IDENTITY) {
  const box = rasterClipRectangle(state, context, extraTransform);
  return box ? `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="transparent" pointer-events="none"/>` : "";
}

function canCullRasterLayer(state, context) {
  if (!context.raster || context.capture?.id === state.id) return false;
  return ancestorsOnlyMove(state, context);
}

// Ancestor effects (blur, shadow, copies) can bring an otherwise offscreen child back into view.
// True when every ancestor merely transforms/composites its paint, so offscreen paint can go.
function ancestorsOnlyMove(state, context) {
  let parent = state.parentId;
  while (parent && context.layersById.has(parent)) {
    const source = context.layersById.get(parent), shown = shownState(source, context);
    if (hasFilterEffect(shown) || shown.effectPreset || effectsAt(source, context.time).length) return false;
    parent = source.parentId;
  }
  return true;
}

function revealRectangle(state, reveal) {
  const width = Math.max(0, finite(state.width));
  const height = Math.max(0, finite(state.height));
  const progress = reveal.progress;
  switch (reveal.direction) {
    case "right": return { x: 0, y: 0, width: width * progress, height };
    case "left": return { x: width * (1 - progress), y: 0, width: width * progress, height };
    case "down": return { x: 0, y: 0, width, height: height * progress };
    case "up": return { x: 0, y: height * (1 - progress), width, height: height * progress };
    default: throw new TypeError("Reveal direction is invalid");
  }
}

function revealPath(rect) {
  const x = fmt(rect.x), y = fmt(rect.y);
  const width = fmt(rect.width), height = fmt(rect.height);
  return `M${x} ${y}h${width}v${height}h-${width}z`;
}

function revealAttributes(state, reveal, context) {
  if (reveal.progress >= 1) return { attribute: "", sentinel: "", hidden: false };
  if (reveal.progress <= 0 || finite(state.width) <= 0 || finite(state.height) <= 0)
    return { attribute: "", sentinel: "", hidden: true };

  if (isGeneralReveal(reveal)) {
    const general = generalReveal(finite(state.width), finite(state.height), reveal, context.defs, (kind) => idFor(context, kind));
    return { ...general, sentinel: context.canvas ? "" : rasterClipBounds(state, context), hidden: false };
  }
  const rect = revealRectangle(state, reveal);
  let attribute;
  if (reveal.softness <= 0) {
    const id = idFor(context, "reveal-clip");
    context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${revealPath(rect)}"/></clipPath>`);
    attribute = ` clip-path="url(#${id})"`;
  } else {
    const maskId = idFor(context, "reveal-mask");
    const gradientId = idFor(context, "reveal-gradient");
    const horizontal = reveal.direction === "right" || reveal.direction === "left";
    const dimension = horizontal ? Math.max(1e-6, finite(state.width)) : Math.max(1e-6, finite(state.height));
    const feather = reveal.softness / 100;
    const visibleLow = reveal.direction === "right" || reveal.direction === "down";
    // Sweep the whole feather beyond the box at each endpoint. Clamping its stops to the
    // box would pop half a feather into view at 0 and leave a faded strip until exactly 1.
    const edge = reveal.progress * (1 + feather);
    const from = (visibleLow ? edge - feather : 1 - edge) * dimension;
    const to = from + feather * dimension;
    const lowColor = visibleLow ? "white" : "black";
    const highColor = visibleLow ? "black" : "white";
    const gradientAxis = horizontal
      ? `x1="${fmt(from)}" y1="0" x2="${fmt(to)}" y2="0"`
      : `x1="0" y1="${fmt(from)}" x2="0" y2="${fmt(to)}"`;
    context.defs.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" spreadMethod="pad" ${gradientAxis}><stop offset="0" stop-color="${lowColor}"/><stop offset="1" stop-color="${highColor}"/></linearGradient>`);
    context.defs.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" style="mask-type:luminance"><rect x="-100000" y="-100000" width="200000" height="200000" fill="black"/><rect x="0" y="0" width="${fmt(Math.max(0, finite(state.width)))}" height="${fmt(Math.max(0, finite(state.height)))}" fill="url(#${gradientId})"/></mask>`);
    attribute = ` mask="url(#${maskId})"`;
  }
  return { attribute, sentinel: context.canvas ? "" : rasterClipBounds(state, context), hidden: false };
}

function paintFor(layer, context, bounds) {
  const fill = layer.fill;
  if (fill && typeof fill === "object") {
    if (
      !["linear", "radial"].includes(fill.type) ||
      !Array.isArray(fill.stops) ||
      fill.stops.length < 2
    ) {
      throw new Error(
        `Layer “${layer.name ?? layer.id}” has an invalid gradient.`,
      );
    }
    const id = idFor(context, "gradient");
    const { start, end } = gradientCoordinates(fill, bounds);
    const stops = fill.stops
      .map(
        (stop) =>
          `<stop offset="${fmt(checkedNumber(stop.offset, 0, 0, 1) * 100)}%" stop-color="${escapeXml(safeColor(stop.color, "#000000"))}"/>`,
      )
      .join("");
    const definition =
      fill.type === "radial"
        ? `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(start[0])}" cy="${fmt(start[1])}" r="${fmt(Math.hypot(end[0] - start[0], end[1] - start[1]))}">${stops}</radialGradient>`
        : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(start[0])}" y1="${fmt(start[1])}" x2="${fmt(end[0])}" y2="${fmt(end[1])}">${stops}</linearGradient>`;
    context.defs.push(definition);
    return `url(#${id})`;
  }
  return safeColor(fill, "none");
}

// The fill to draw: "none" when the layer's Fill is turned off (its paint stays stored).
function fillPaintFor(state, context, bounds) {
  return isFillEnabled(state) ? paintFor(state, context, bounds) : "none";
}

// True when a picture's box (local 0..width, 0..height) covers the whole frame: footage that
// fills the screen.
function coversFrame(state, context) {
  const width = finite(state.width), height = finite(state.height);
  if (!(width > 0 && height > 0 && context.width > 0 && context.height > 0)) return false;
  const back = inverse(multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state)));
  if (!back) return false;
  const [a, b, c, d, e, f] = back;
  return [[0, 0], [context.width, 0], [0, context.height], [context.width, context.height]].every(([x, y]) => {
    const u = a * x + c * y + e, v = b * x + d * y + f;
    return u >= -0.5 && v >= -0.5 && u <= width + 0.5 && v <= height + 0.5;
  });
}

// A blurred picture that fills the frame repeats its edges, as a mirror image around its box
// (the "repeat edge pixels" of video editors): its blur then reads the picture, not the empty
// outside of the box, so the frame's edges do not darken and a blur-through does not dim. The
// copies sit outside the box, so outside the frame, and only the blur shows them. A letterboxed
// picture keeps its soft top and bottom: the copies hold its empty bands too.
function mirroredEdges(body, state, context) {
  const id = idFor(context, "edges");
  const w = fmt(2 * finite(state.width)), h = fmt(2 * finite(state.height));
  const flips = [[-1, 1, 0, 0], [-1, 1, w, 0], [1, -1, 0, 0], [1, -1, 0, h], [-1, -1, 0, 0], [-1, -1, w, 0], [-1, -1, 0, h], [-1, -1, w, h]];
  return `<g id="${id}">${body}</g>` + flips.map(([sx, sy, x, y]) => `<use href="#${id}" transform="matrix(${sx} 0 0 ${sy} ${x} ${y})"/>`).join("");
}

function filterFor(layer, context, bounds = null) {
  const blur = Math.max(0, checkedNumber(layer.blur, 0, 0, 1000));
  const shadow =
    layer.shadow && typeof layer.shadow === "object" && shadowAlpha(layer.shadow.color) > 0 ? layer.shadow : null;
  if (!blur && !shadow) return "";
  const id = idFor(context, "filter");
  const effects = [];
  if (shadow) {
    // Spell out the drop-shadow filter: the rasterizer's feDropShadow shorthand
    // brightens non-primary RGB colors under sRGB filters. These standard steps
    // retain the same straight color and alpha in browsers and raster exports.
    const shadowColor = withShadowAlpha(shadow.color, 1);
    let dx = shadow.x, dy = shadow.y;
    if (context.raster) {
      // resvg-js 2.6.2 scales filter offsets by matrix row lengths but discards
      // their direction (upstream resvg #949/#1081). Pre-map the vector so the
      // native rasterizer produces the browser's rotated/skewed/mirrored offset.
      const [a, b, c, d] = multiply(parentWorldMatrix(layer.parentId, context), layerMatrix(layer));
      const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
      dx = sx > 1e-12 ? (a * shadow.x + c * shadow.y) / sx : 0;
      dy = sy > 1e-12 ? (b * shadow.x + d * shadow.y) / sy : 0;
    }
    effects.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${fmt(Math.max(0, finite(shadow.blur)) / 2)}" result="shadow-blur"/>` +
      `<feOffset in="shadow-blur" dx="${fmt(dx)}" dy="${fmt(dy)}" result="shadow-offset"/>` +
      `<feFlood flood-color="${escapeXml(shadowColor)}" flood-opacity="${shadowAlpha(shadow.color)}" result="shadow-color"/>` +
      '<feComposite in="shadow-color" in2="shadow-offset" operator="in" result="shadow-paint"/>' +
      '<feMerge result="shadowed"><feMergeNode in="shadow-paint"/><feMergeNode in="SourceGraphic"/></feMerge>',
    );
  }
  if (blur)
    effects.push(
      `<feGaussianBlur in="${shadow ? "shadowed" : "SourceGraphic"}" stdDeviation="${fmt(blur / 2)}" result="blurred"/>`,
    );
  let region = 'x="-100%" y="-100%" width="300%" height="300%"';
  if (bounds) {
    // Include the actual offset, independent of how narrow the source paint is.
    const box = expandEffectBounds(bounds, layer);
    region = `filterUnits="userSpaceOnUse" x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(Math.max(1, box.width))}" height="${fmt(Math.max(1, box.height))}"`;
  }
  context.defs.push(`<filter id="${id}" ${region} color-interpolation-filters="sRGB">${effects.join("")}</filter>`);
  return ` filter="url(#${id})"`;
}

function blendStyle(layer) {
  const mode = String(layer.blendMode ?? "normal").toLowerCase();
  if (!BLEND_MODES.has(mode))
    throw new Error(
      `Layer “${layer.name ?? layer.id}” uses unsupported blend mode “${mode}”.`,
    );
  return mode === "normal" ? "" : ` style="mix-blend-mode:${mode === "add" ? "plus-lighter" : mode}"`;
}

// On the editor canvas, a shape whose Fill is turned off still takes clicks inside it, the same
// as a 0% alpha fill, so it can be hovered, selected and dragged from its middle. The canvas
// finds the layers under the pointer with elementsFromPoint (Stage.jsx), and the browser skips
// unpainted insides unless pointer-events says otherwise. `value` is "visibleFill" for the
// inside only, or "visible" for an element that also draws the stroke. Exports never set
// `canvas`, and rasterizers ignore pointer-events anyway.
function offFillClickArea(state, context, value) {
  return context.canvas && !isFillEnabled(state) ? ` pointer-events="${value}"` : "";
}

// A trimmed or dashed stroke (strokeTrim.js): one <path> per contour of `d`, each with the dash
// list that draws its kept part. Nothing for a contour the trim hides.
function patternStroke(d, state) {
  return (attributes) => contourLengths(d).map((contour) => {
    const dash = trimDash(contour.length, state);
    if (!dash) return `<path d="${escapeXml(contour.d)}" ${attributes}/>`;
    if (!dash.array.length) return "";
    return `<path d="${escapeXml(contour.d)}" ${attributes} stroke-dasharray="${dash.array.map(fmt).join(" ")}" stroke-dashoffset="${fmt(dash.offset)}"/>`;
  }).join("");
}

// `strokeElement` draws the stroke apart from the fill (a trimmed or dashed stroke).
function paintedVector(element, state, context, fill, bounds, paintBounds = bounds, strokeElement = null) {
  const weight = Math.max(0, finite(state.strokeWidth));
  const alignment = state.strokeAlign ?? "center";
  const fillGraphic = element(`fill="${escapeXml(fill)}" stroke="none"${offFillClickArea(state, context, "visibleFill")}`);
  if (!weight) return fillGraphic;
  const stroke = paintFor({ ...state, fill: state.stroke }, context, paintBounds);
  if (stroke === "none") return fillGraphic;
  const strokeAttributes = `fill="none" stroke="${escapeXml(stroke)}" stroke-width="${fmt(alignment === "center" ? weight : weight * 2)}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"`;
  if (alignment === "center" && strokeElement) return `${fillGraphic}${strokeElement(strokeAttributes)}`;
  if (alignment === "center")
    return element(`fill="${escapeXml(fill)}" ${strokeAttributes.replace('fill="none" ', "")}${offFillClickArea(state, context, "visible")}`);
  const stroked = strokeElement ?? element;
  const id = idFor(context, "stroke");
  if (alignment === "inside") {
    context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${element('fill="white" stroke="none"')}</clipPath>`);
    return `${fillGraphic}<g clip-path="url(#${id})">${context.rasterClipBounds ?? ""}${stroked(strokeAttributes)}</g>`;
  }
  if (alignment !== "outside") throw new Error(`Unsupported stroke position “${alignment}”.`);
  // An inverse luminance mask keeps the entire outer half, including holes in
  // compound paths. Its margin includes the longest allowed miter join.
  const margin = weight * 10 + 1;
  context.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${fmt(bounds.x - margin)}" y="${fmt(bounds.y - margin)}" width="${fmt(bounds.width + margin * 2)}" height="${fmt(bounds.height + margin * 2)}" style="mask-type:luminance"><rect x="${fmt(bounds.x - margin)}" y="${fmt(bounds.y - margin)}" width="${fmt(bounds.width + margin * 2)}" height="${fmt(bounds.height + margin * 2)}" fill="white"/>${element('fill="black" stroke="none"')}</mask>`);
  return `${fillGraphic}<g mask="url(#${id})">${context.rasterClipBounds ?? ""}${stroked(strokeAttributes)}</g>`;
}

function geometry(layer, state, context, overrides = {}) {
  const width = Math.max(0, finite(state.width));
  const height = Math.max(0, finite(state.height));
  // A trimmed or dashed stroke follows the shape's path data, so it starts where Lottie's does.
  const patterned = finite(state.strokeWidth) > 0 && hasStrokePattern(state);
  const paint = (element, bounds = { x: 0, y: 0, width, height }, d = null) => {
    const fill = overrides.fill ?? fillPaintFor(state, context, bounds);
    const stroke = patterned ? patternStroke(d ?? shapePath(layer.type, state), state) : null;
    return paintedVector(element, state, context, fill, bounds, bounds, stroke);
  };
  if (layer.type === "rectangle") {
    if (Array.isArray(state.cornerRadii))
      return paint((attributes) => `<path d="${escapeXml(shapePath(layer.type, state))}" ${attributes}/>`);
    const radius = Math.max(
      0,
      Math.min(finite(state.radius), width / 2, height / 2),
    );
    return paint((attributes) => `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" rx="${fmt(radius)}" ry="${fmt(radius)}" ${attributes}/>`);
  }
  if (layer.type === "ellipse") {
    if (finite(state.donut) !== 0 || finite(state.sweep, 1) !== 1)
      return paint((attributes) => `<path d="${escapeXml(shapePath(layer.type, state))}" ${attributes}/>`);
    return paint((attributes) => `<ellipse cx="${fmt(width / 2)}" cy="${fmt(height / 2)}" rx="${fmt(width / 2)}" ry="${fmt(height / 2)}" ${attributes}/>`);
  }
  if (layer.type === "star")
    return paint((attributes) => `<path d="${escapeXml(shapePath(layer.type, state))}" ${attributes}/>`);
  if (layer.type === "path") {
    const path = String(state.path ?? "");
    if (!path.trim()) return "";
    if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE ,.\t\r\n+\-]+$/.test(path)) {
      throw new Error(
        `Path layer “${layer.name ?? layer.id}” contains invalid SVG path data.`,
      );
    }
    const bounds = state.pathBounds ?? layer.pathBounds;
    const scaleX =
      bounds && finite(bounds.width) > 0 ? width / finite(bounds.width) : 1;
    const scaleY =
      bounds && finite(bounds.height) > 0 ? height / finite(bounds.height) : 1;
    const point = ([x, y]) => [x * scaleX, y * scaleY];
    const scaledPath = scaleX === 1 && scaleY === 1 ? path : serializePath(parsePath(path).map((contour) => ({
      start: point(contour.start), closed: contour.closed,
      segments: contour.segments.map((segment) => ({ c1: point(segment.c1), c2: point(segment.c2), end: point(segment.end) })),
    })));
    const localBox = { x: 0, y: 0, width, height };
    const paintBounds = layer.convertedFrom ? localBox : pathGradientBounds(pathBounds(scaledPath), localBox);
    const fillRule = state.fillRule === "evenodd" ? "evenodd" : "nonzero";
    return paint((attributes) => `<path d="${escapeXml(scaledPath)}" fill-rule="${fillRule}" ${attributes}/>`, paintBounds, scaledPath);
  }
  return "";
}

// The first animation by letters, words or lines that is used in playback sets the units.
function textUnitMode(layer) { return textAnimationMode(layer); }

function clipTextUnit(markup, state, context) {
  for (const polygon of state._textClips ?? []) {
    const id = idFor(context, "text-clip");
    context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><polygon points="${polygon.map(({ x, y }) => `${fmt(x)},${fmt(y)}`).join(" ")}"/></clipPath>`);
    markup = `<g clip-path="url(#${id})">${markup}</g>`;
  }
  return markup;
}

// The glyph outlines of `unit` (its `glyphs` in textbox coordinates), painted with `state`'s
// fill and stroke.
function textGlyphPaths(unit, state, context) {
  const paints = new Map();
  return unit.glyphs.filter((glyph) => glyph.path || glyph.color).map((glyph) => {
    if (glyph.color?.kind === "image") {
      const bounds = glyphDrawBounds(glyph);
      return `<image x="${fmt(bounds.x)}" y="${fmt(bounds.y)}" width="${fmt(bounds.width)}" height="${fmt(bounds.height)}" href="${escapeXml(glyph.color.href)}" preserveAspectRatio="none"/>`;
    }
    if (glyph.color?.kind === "layers") return glyph.color.layers.map((part) =>
      `<path d="${escapeXml(glyphPath({ ...glyph, path: part.path }))}" fill="${escapeXml(part.fill)}"/>`).join("");
    const styled = glyph.fill === undefined ? state : { ...state, fill: glyph.fill };
    const key = JSON.stringify(styled.fill);
    if (!paints.has(key)) paints.set(key, fillPaintFor(styled, context, { width: state.width, height: state.height }));
    const path = glyphPath(glyph);
    return paintedVector((attributes) => `<path d="${escapeXml(path)}" ${attributes}/>`, styled, context, paints.get(key), glyphPathBounds(glyph), { width: state.width, height: state.height });
  }).join("");
}

const hasFilterEffect = (state) => state.blur > 0 || (state.shadow && shadowAlpha(state.shadow.color) > 0);
function textGlyphBounds(unit) {
  return mergeBounds(unit.glyphs.map(glyphDrawBounds).filter(Boolean));
}

// Text drawing remembered on its layout between frames (textSvgCache.js). context.ids is made
// once per renderSceneSvg call and shared by the contexts derived from it, so it tells one
// drawing from the next.
const remember = (layout, context, key, make) => rememberForLayout(layout, context.ids, key, make);

// The glyphs one unit of `layout` draws. `range` names the unit's characters: "layer" for the
// whole text, or the unit's source start and end; `list()` lists its glyphs. They are frozen so
// that their path data and bounds are remembered too (textLayout.js glyphPath). `gradientFill`
// tells whether a style range gives some of the letters a gradient.
function layoutUnit(layout, range, list, context) {
  return remember(layout, context, `glyphs ${range}`, () => {
    const glyphs = Object.freeze(list().map((glyph) => Object.freeze(glyph)));
    return { glyphs, gradientFill: glyphs.some((glyph) => glyph.fill !== null && typeof glyph.fill === "object") };
  });
}

const wholeLayout = (layout, context) => layoutUnit(layout, "layer", () => textUnits(layout, "layer")[0].glyphs, context);
const unitRange = (unit) => `${unit.sourceStart} ${unit.sourceEnd}`;

// The bounds of a layout unit's glyphs (textGlyphBounds). Shared: read them, do not change them.
function layoutUnitBounds(layout, range, unit, context) {
  return remember(layout, context, `bounds ${range}`, () => {
    const bounds = textGlyphBounds(unit);
    return bounds && Object.freeze(bounds);
  });
}

// textGlyphPaths for a layout unit. Plain paints are remembered per paint; gradients and
// inside or outside strokes are drawn fresh every time, because they add <defs> with new ids.
function layoutUnitPaths(layout, range, unit, state, context) {
  const paint = unit.gradientFill ? null : plainPaintKey(state, context);
  if (paint === null) return textGlyphPaths(unit, state, context);
  return remember(layout, context, `paths ${range} ${paint}`, () => textGlyphPaths(unit, state, context));
}

// Conservative local paint bounds keep a group's effects around children that
// extend outside its design box, including animated text units and child effects.
function contentBounds(node, state, context) {
  if (state.type === "text") {
    const layout = layoutText(state, context.fonts);
    return repeatBounds(layoutUnitBounds(layout, "layer", wholeLayout(layout, context), context), state);
  }
  return repeatBounds(mergeBounds([{ x: 0, y: 0, width: Math.max(0, state.width), height: Math.max(0, state.height) },
    ...node.children.map((child) => paintBoundsInParent(child, context))]), state);
}

// What a group's children draw before effects that keep paint inside a box (Noise Mask, a
// contained filter) cut it, for repeat effects that need the whole drawing (copySource's home).
function drawnContentBounds(node, state, context) {
  if (state.type === "text") return contentBounds(node, state, context);
  return repeatBounds(mergeBounds([{ x: 0, y: 0, width: Math.max(0, state.width), height: Math.max(0, state.height) },
    ...node.children.map((child) => context.drawnBounds.has(child.layer.id)
      ? context.drawnBounds.get(child.layer.id) : paintBoundsInParent(child, context))]), state);
}

function paintBoundsInParent(node, context) {
  const { layer } = node;
  if (context.renderedBounds.has(layer.id)) return context.renderedBounds.get(layer.id);
  if (layer.visible === false || layer.type === "audio") return null;
  const state = resizeTextLayer(getAnimatedLayer(layer, context), context.fonts);
  if (state.visible === false) return null;
  const boundUnit = ({ unit, state: shown }) => shown.visible === false ? null
    : mappedBounds(expandEffectBounds(textGlyphBounds({ glyphs: unitGlyphs(layoutText(shown, context.fonts), unit) }), shown), layerMatrix(shown));
  if (layer.type === "text" && !context.design && hasTextChanges(layer))
    return mergeBounds(textDrawingsAt(layer, context.time, context.fonts).flatMap((drawing) => drawing.units.map(boundUnit)));
  if (layer.type === "text" && (textUnitMode(layer) !== "layer" || enabledAnimations(layer.animations).some((animation) => animation.textClip))) {
    const plan = textAnimationPlan(layer, context.fonts);
    return mergeBounds(plan.units.map((unit, index) => boundUnit({ unit,
      state: textAnimationUnitState(plan, index, context.time, { design: context.design }) })));
  }
  return mappedBounds(expandEffectBounds(contentBounds(node, state, context), state), layerMatrix(state));
}

function effectContent(content, layer, state, context, paintBounds, drawnBounds = paintBounds) {
  if (context.design) return { content, bounds: paintBounds, drawn: drawnBounds };
  if (!context.effectFrames.has(layer)) context.effectFrames.set(layer, effectsAt(context.calmLight ? { ...layer, animations: calmLightAnimations(layer.animations) } : layer, context.time));
  let frames = context.effectFrames.get(layer);
  if (state.effectPreset) {
    const value = state.effectPreset;
    const order = enabledAnimations(layer.animations).map((animation) => animation.id);
    frames = [...frames, { operation: state._effectPresetOperation ?? { start: 0 },
      effect: { render: (frame) => renderEffectPreset(value.id, frame) },
      parameters: value.parameters, progress: Math.max(0, Math.min(1, value.progress)), time: 0 }]
      .sort((left, right) => left.operation.start - right.operation.start ||
        order.indexOf(left.operation.id) - order.indexOf(right.operation.id));
  }
  if (!frames.length) return { content, bounds: paintBounds, drawn: drawnBounds };
  // Maps keep a fixed layer-local coordinate system, while filter regions follow any overflow
  // from preceding effects. The layer's own shadow/blur is applied to the resulting paint later.
  const bounds = { x: 0, y: 0, width: Math.max(0.001, finite(state.width)), height: Math.max(0.001, finite(state.height)) };
  let extent = expandEffectBounds(paintBounds ?? bounds, { strokeWidth: state.strokeWidth });
  extent = { ...extent, width: Math.max(0.001, extent.width), height: Math.max(0.001, extent.height) };
  // Everything drawn so far, also where a later effect keeps the paint inside a smaller box.
  let drawn = mergeBounds([expandEffectBounds(drawnBounds ?? bounds, { strokeWidth: state.strokeWidth }), extent]);
  // The scene's size and this layer's place in it, for effects that reach across the picture
  // (lens flare) or stop at its edge (light rays). `tilted`: the matrix leaves out a 3D tilt.
  const scene = { width: context.width, height: context.height, matrix: multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state)), tilted: hasTilt(state) };
  for (const frame of frames) {
    content = frame.effect.render({ content, bounds, paintBounds: extent, drawnBounds: drawn,
      // The operation lets an effect read its settings at other moments (particle births).
      parameters: frame.parameters, time: frame.time, progress: frame.progress, operation: frame.operation,
      helpers: { defs: context.defs, id: (kind) => idFor(context, `effect-${kind}`), raster: context.raster, scene,
        transform: multiply(context.rasterMatrix, multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state))),
        clipSentinel: (matrix) => rasterClipBounds(state, context, matrix),
        // Loaded .cube LUTs by src, for the lut effect (see the `luts` option of renderSceneSvg).
        luts: context.luts,
        includeBounds: (next) => { extent = next; drawn = mergeBounds([drawn, next]); } } });
  }
  return { content, bounds: extent, drawn };
}

function backdropHelpers(state, context) {
  return { defs: context.defs, id: (kind) => idFor(context, kind), raster: context.raster,
    transform: multiply(context.rasterMatrix, multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state))),
    clipSentinel: () => rasterClipBounds(state, context) };
}

// Our glass design rounds a square box's bevel as Depth grows. Existing larger
// corners remain intact. Other vector shapes keep their exact silhouettes.
function glassSilhouetteState(state) {
  if (!state.glass?.enabled) return state;
  const radius = Math.min(state.width, state.height) * 0.225 * checkedNumber(state.glass.depth, 50, 0, 100) / 100;
  return { ...state, radius: Math.max(state.radius ?? 0, radius),
    ...(Array.isArray(state.cornerRadii) ? { cornerRadii: state.cornerRadii.map((value) => Math.max(value, radius)) } : {}) };
}

// Geometry supplies the mask even when the layer's own Fill is off or translucent.
// Media retain their source alpha; groups use their design box, and text uses glyph
// outlines (including a color glyph's alpha image). This is separate from hit targets.
function backdropSilhouette(layer, state, context, mediaContent, unit) {
  const white = { ...glassSilhouetteState(state), fill: "#FFFFFF", fillEnabled: true, strokeWidth: 0 };
  if (layer.type === "text") {
    const glyphs = unit ?? textUnits(layoutText(state, context.fonts), "layer")[0];
    return { markup: copyContent(textGlyphPaths(glyphs, white, context)),
      path: glyphs.glyphs.flatMap((glyph) => {
        if (glyph.path) return glyphPath(glyph);
        if (glyph.color?.kind === "layers") return glyph.color.layers.map((part) => glyphPath({ ...glyph, path: part.path }));
        const box = glyphDrawBounds(glyph);
        return box ? `M${box.x} ${box.y}h${box.width}v${box.height}h-${box.width}z` : "";
      }).join(" "), fillRule: "nonzero" };
  }
  if (layer.type === "image" || layer.type === "video")
    return { markup: copyContent(mediaContent), path: shapePath("rectangle", white), fillRule: "nonzero" };
  const type = layer.type === "group" ? "rectangle" : layer.type;
  const markup = geometry({ ...layer, type }, white, { ...context, canvas: false }, { fill: "#FFFFFF" });
  return { markup, path: type === "path" ? (markup.match(/\bd="([^"]*)"/)?.[1] ?? "") : shapePath(type, white),
    fillRule: state.fillRule === "evenodd" ? "evenodd" : "nonzero" };
}

function backdropContent(content, layer, state, context, { mediaContent = content, unit } = {}) {
  const blur = state.backgroundBlur?.enabled ? state.backgroundBlur : null;
  const glass = state.glass?.enabled ? state.glass : null;
  if (!blur && !glass) return content;
  const blurBlend = blur ? checkedNumber(blur.blend, 20, 0, 100) / 100 : 1;
  const blend = blurBlend * (glass ? checkedNumber(glass.blend, 0, 0, 100) / 100 : 1);
  // Preserve the original semantic/hit source at zero blend without painting it.
  if (!glass && blend === 0) return `<g opacity="0">${content}</g>`;
  const local = inverse(layerMatrix(state));
  const bounds = { x: 0, y: 0, width: Math.max(0.001, finite(state.width)), height: Math.max(0.001, finite(state.height)) };
  if (!local) return content;
  const frame = { content: `<g transform="matrix(${local.map(fmt).join(" ")})">${context.backdrop ?? ""}</g>`,
    bounds, helpers: backdropHelpers(state, context) };
  const silhouette = backdropSilhouette(layer, state, context, mediaContent, unit);
  let backdrop = blur && blurBlend > 0 ? renderBackdropBlur(frame, blur.radius, silhouette) : frame.content;
  if (glass) backdrop = renderGlassBackdrop({ ...frame, content: backdrop }, glass, silhouette);
  return `${backdrop}<g opacity="${fmt(blend)}">${content}</g>`;
}

function isolatesBackdrop(layer, state, context) {
  return layer.clipContent || layer.isMaskGroup || layer.isMask || state.opacity < 1 ||
    (state.blendMode && state.blendMode !== "normal") || hasFilterEffect(state) ||
    state.backgroundBlur?.enabled || state.glass?.enabled || state.effectPreset ||
    (!context.design && effectsAt(layer, context.time).length > 0);
}

function recordTextUnitBounds(layer, state, { bounds, drawn }, context) {
  const painted = mappedBounds(expandEffectBounds(bounds, state), layerMatrix(state));
  context.renderedBounds.set(layer.id, mergeBounds([context.renderedBounds.get(layer.id), painted]));
  const whole = mappedBounds(expandEffectBounds(drawn ?? bounds, state), layerMatrix(state));
  context.drawnBounds.set(layer.id, mergeBounds([context.drawnBounds.get(layer.id), whole]));
}

function textSvg(layer, base, context) {
  const plan = textAnimationPlan(layer, context.fonts);
  const { units } = plan;
  if (!plan.separate) {
    const layout = layoutText(base, context.fonts);
    const missing = layout.lines.some((line) => line.glyphs.some((glyph) => glyph.missing));
    return `<g role="img" aria-label="${escapeXml(layout.text)}"${missing ? ' data-missing-glyphs="true"' : ""}>${missing ? "<title>Some characters are unavailable and are shown as boxes.</title>" : ""}${layoutUnitPaths(layout, "layer", wholeLayout(layout, context), base, context)}</g>`;
  }
  return units.map((unit, index) => {
    const state = textAnimationUnitState(plan, index, context.time, { design: context.design });
    // The unit's own letters, laid out in its state: a Letter spacing, size or width change can
    // wrap the text onto other lines (textLayout.js unitGlyphs).
    const layout = layoutText(state, context.fonts), range = unitRange(unit);
    const current = layoutUnit(layout, range, () => unitGlyphs(layout, unit), context);
    if (state.visible === false) return "";
    // Independently animated text units keep their motion and blur. They sample the same
    // layer-local field/clock before each unit's shadow/blur, rather than warping the parent
    // coordinate system or applying its transform twice. This ordering is our own design.
    const painted = effectContent(backdropContent(layoutUnitPaths(layout, range, current, state, context), layer, state, context, { unit: current }), layer, state, context, layoutUnitBounds(layout, range, current, context));
    recordTextUnitBounds(layer, state, painted, context);
    return clipTextUnit(`<g opacity="${fmt(Math.max(0, Math.min(1, finite(state.opacity, 1))))}" transform="${transformFor(state)}"${filterFor(state, context, hasFilterEffect(state) ? painted.bounds : null)} aria-label="${escapeXml(unit.text)}">${painted.content}</g>`, state, context);
  }).join("");
}

// A text layer with Change text operations (textChange.js): each string drawn at this time, with
// each of its units in its own state (textChangeDraw.js), as one labelled image per string.
function changedTextSvg(layer, context) {
  return textDrawingsAt(layer, context.time, context.fonts).map((drawing) => {
    const units = drawing.units.map(({ unit, state }) => {
      if (state.visible === false) return "";
      // The unit's own letters, laid out in its state, as textSvg draws them.
      const layout = layoutText(state, context.fonts), range = unitRange(unit);
      const current = layoutUnit(layout, range, () => unitGlyphs(layout, unit), context);
      const painted = effectContent(backdropContent(layoutUnitPaths(layout, range, current, state, context), layer, state, context, { unit: current }), layer, state, context, layoutUnitBounds(layout, range, current, context));
      recordTextUnitBounds(layer, state, painted, context);
      return clipTextUnit(`<g opacity="${fmt(Math.max(0, Math.min(1, finite(state.opacity, 1))))}" transform="${transformFor(state)}"${filterFor(state, context, hasFilterEffect(state) ? painted.bounds : null)}>${painted.content}</g>`, state, context);
    }).join("");
    return `<g role="img" aria-label="${escapeXml(drawing.text)}">${units}</g>`;
  }).join("");
}

function transformFor(state) {
  const width = finite(state.width);
  const height = finite(state.height);
  return `translate(${fmt(state.x)} ${fmt(state.y)}) translate(${fmt(width / 2)} ${fmt(height / 2)}) rotate(${fmt(state.rotation)}) scale(${fmt(state.scaleX ?? 1)} ${fmt(state.scaleY ?? 1)}) skewX(${fmt(state.skewX ?? 0)}) translate(${fmt(-width / 2)} ${fmt(-height / 2)})`;
}

// How long before a video shows that the live preview puts it in the page, hidden, and the
// times it looks ahead at (seconds).
export const VIDEO_PREROLL_SECONDS = 1;
const PREROLL_STEPS = [0.25, 0.5, 0.75, 1];

// In the live preview, a <video> element that is made when its layer appears has no picture for
// its first frames (it loads and seeks then): a playing scene showed it late or not at all. So a
// hidden layer that is or holds such a video, and shows within VIDEO_PREROLL_SECONDS, is put in
// the page already, hidden (visibility="hidden"), on its first frame. When it shows, the same
// element plays on. Exports and still frames never do this (interactiveMedia is off there).
function showsSoon(node, context, maskContent) {
  if (!context.interactiveMedia || context.design || maskContent || node.layer.isMask ||
    !context.videoHolders?.has(node.layer.id)) return false;
  // One context a step for the whole drawing, so each keeps its own remembered states.
  context.ahead ??= PREROLL_STEPS.map((ahead) => ({ ...context, time: context.time + ahead, animated: new Map() }));
  return context.ahead.some((later) => shownState(node.layer, later).visible !== false);
}

// The IDs of the layers that are, or hold, a video the live preview plays as a <video> element
// (one without captured frames in `videoFrames`).
function videoHolderIds(roots, context) {
  const ids = new Set();
  const visit = (node) => {
    let holds = node.layer.type === "video" && mapValue(context.videoFrames, node.layer) === undefined &&
      !context.decodedVideos?.has(node.layer.id);
    for (const child of node.children) holds = visit(child) || holds;
    if (holds) ids.add(node.layer.id);
    return holds;
  };
  for (const root of roots) visit(root);
  return ids;
}

// Live preview only: a playing <video> with a big blur cost the graphics card nearly a whole
// frame, its blur redrawn at full size 30 times a second. Such a video is drawn instead into a
// small canvas (one pixel per third of the blur's spread), blurred there and stretched back over
// the layer, which looks the same (softVideo.js draws it). Exports never do this.
const SOFT_VIDEO_FROM = 16;
function softVideoBlur(state) {
  const blur = Math.max(0, checkedNumber(state.blur, 0, 0, 1000));
  const shadow = state.shadow && typeof state.shadow === "object" && shadowAlpha(state.shadow.color) > 0;
  return blur >= SOFT_VIDEO_FROM && !shadow ? blur : 0;
}

// The video, hidden and playing, and the canvas it is drawn into: the layer plus three spreads
// of the blur on each side, where the blur fades out as the filter's does. The canvas's
// data-soft-video is the layer's width, height, margin and blur spread in canvas pixels.
function softVideoMarkup(layer, state, source, blur) {
  const sigma = blur / 2, margin = sigma * 3, scale = sigma / 3;
  const width = Math.max(0, finite(state.width)), height = Math.max(0, finite(state.height));
  const outerWidth = width + margin * 2, outerHeight = height + margin * 2;
  return `<foreignObject x="${fmt(-margin)}" y="${fmt(-margin)}" width="${fmt(outerWidth)}" height="${fmt(outerHeight)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;position:relative">` +
    `<video data-media-layer-id="${escapeXml(String(layer.id ?? ""))}" src="${escapeXml(source)}" preload="auto" muted="" playsinline="" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0"/>` +
    `<canvas data-soft-video="${fmt(width / scale)} ${fmt(height / scale)} ${fmt(margin / scale)} 3" width="${Math.max(1, Math.round(outerWidth / scale))}" height="${Math.max(1, Math.round(outerHeight / scale))}" style="display:block;width:100%;height:100%"/></div></foreignObject>`;
}

// Live preview only: a video whose frames the preview captures while an effect changes it
// (videoPreview.js videoCaptureWindows) is drawn at other times from that same hidden decoder
// <video> into a canvas (softVideo.js), never from a <video> made here: a new element loads and
// seeks, and showed nothing at the switch. A heavy blur is drawn small, as softVideoMarkup's.
const DECODED_VIDEO_SIDE = 1920;
function decoderVideoMarkup(layer, state, blur) {
  const width = Math.max(0, finite(state.width)), height = Math.max(0, finite(state.height));
  const sigma = blur / 2, margin = sigma * 3;
  const scale = blur ? sigma / 3 : Math.max(1, Math.max(width, height) / DECODED_VIDEO_SIDE);
  const outerWidth = width + margin * 2, outerHeight = height + margin * 2;
  return `<foreignObject x="${fmt(-margin)}" y="${fmt(-margin)}" width="${fmt(outerWidth)}" height="${fmt(outerHeight)}"><canvas xmlns="http://www.w3.org/1999/xhtml" data-decoder="${escapeXml(String(layer.id ?? ""))}" ` +
    `data-soft-video="${fmt(width / scale)} ${fmt(height / scale)} ${fmt(margin / scale)} ${blur ? 3 : 0}" width="${Math.max(1, Math.round(outerWidth / scale))}" height="${Math.max(1, Math.round(outerHeight / scale))}" style="display:block;width:100%;height:100%"/></foreignObject>`;
}

function renderLayer(node, context, { maskContent = false } = {}) {
  const { layer } = node;
  if (layer.visible === false || layer.type === "audio") return "";
  let state = resizeTextLayer(getAnimatedLayer(layer, context), context.fonts);
  // Drawn ahead, hidden: a video about to show (showsSoon).
  let ahead = false;
  if (state.visible === false) {
    if (!showsSoon(node, context, maskContent)) return "";
    ahead = true;
    state = { ...state, visible: true };
  }
  const paintState = glassSilhouetteState(state);
  // Units, and the strings of a Change text, each draw with their own transform and opacity.
  const changingText = layer.type === "text" && !context.design && hasTextChanges(layer);
  const textHasUnits = layer.type === "text" && (changingText || textUnitMode(layer) !== "layer" || enabledAnimations(layer.animations).some((animation) => animation.textClip));
  let opacity = textHasUnits
    ? 1
    : Math.max(0, Math.min(1, finite(state.opacity, 1)));
  const reveal = context.design ? FULL_REVEAL : normalizeReveal(state.reveal);
  const revealRender = revealAttributes(state, reveal, context);
  if (revealRender.hidden) opacity = 0;
  const blend = blendStyle(layer);
  const transform = textHasUnits ? "" : transformFor(state);
  let children = context.trackBackdrop ? "" : renderSiblings(node.children, context, layer.type === "group" && layer.isMaskGroup === true);
  let body = "";
  // A heavily blurred live <video>, drawn small and soft by the page (softVideoMarkup).
  let soft = 0, leadImage = "";
  if (
    layer.type === "rectangle" ||
    layer.type === "ellipse" ||
    layer.type === "star" ||
    layer.type === "path"
  )
    body = geometry(layer, paintState, context);
  else if (changingText) body = changedTextSvg(layer, context);
  else if (layer.type === "text") body = textSvg(layer, state, context);
  else if (layer.type === "video" && context.interactiveMedia && mapValue(context.videoFrames, layer) === undefined) {
    const source = mapValue(context.embedMedia, layer) ?? layer.src;
    if (typeof source !== "string" || !SAFE_MEDIA_PATH.test(source)) {
      throw new Error(
        `Video layer “${layer.name ?? layer.id}” needs a local /api/media/... source for interactive preview.`,
      );
    }
    soft = softVideoBlur(state);
    if (context.decodedVideos?.has(layer.id)) {
      // Drawn from the preview's own decoder <video> (decoderVideoMarkup).
      const lead = mapValue(context.videoLead, layer);
      if (lead) leadImage = `<image x="0" y="0" width="${fmt(Math.max(0, finite(state.width)))}" height="${fmt(Math.max(0, finite(state.height)))}" href="${escapeXml(lead)}" preserveAspectRatio="xMidYMid meet" opacity="0.004"/>`;
      body = decoderVideoMarkup(layer, state, soft);
    } else body = soft ? softVideoMarkup(layer, state, source, soft)
      : `<foreignObject x="0" y="0" width="${fmt(Math.max(0, finite(state.width)))}" height="${fmt(Math.max(0, finite(state.height)))}"><video xmlns="http://www.w3.org/1999/xhtml" data-media-layer-id="${escapeXml(String(layer.id ?? ""))}" src="${escapeXml(source)}" preload="auto" muted="" playsinline="" style="width:100%;height:100%;object-fit:contain"/></foreignObject>`;
  } else if (layer.type === "image" || layer.type === "video") {
    const { time, sourceTime } = mediaClock(layer, context);
    const href =
      layer.type === "video"
        ? videoHref(layer, time, sourceTime, context)
        : imageHref(layer, time, sourceTime, context);
    body = `<image x="0" y="0" width="${fmt(Math.max(0, finite(state.width)))}" height="${fmt(Math.max(0, finite(state.height)))}" href="${escapeXml(href)}" preserveAspectRatio="xMidYMid ${layer.type === "image" ? "slice" : "meet"}"/>`;
  } else if (!["group", "audio"].includes(layer.type)) {
    throw new Error(
      `Layer “${layer.name ?? layer.id}” has unsupported type “${layer.type}”.`,
    );
  }
  const safeId = escapeXml(String(layer.id ?? ""));
  const isMedia = layer.type === "image" || layer.type === "video";
  const rasterBounds = (isMedia || layer.type === "group") ? rasterClipBounds(state, context) : "";
  const clipState = { ...paintState, width: Math.max(0, finite(state.width)), height: Math.max(0, finite(state.height)) };
  // A raster picture with square corners needs no clip group: <image> stays inside its box. resvg
  // 2.6.2 cuts a clip group inside an opacity or filter group 2x the canvas height below that
  // group's top, so a tall faded or blurred backdrop lost its lower part.
  const squareRasterMedia = isMedia && context.raster && resolvedCornerRadii(clipState).every((radius) => radius <= 0);
  if (squareRasterMedia) body = `${rasterBounds}${body}`;
  else if (isMedia || (layer.clipContent && layer.type === "group")) {
    const id = idFor(context, "clip");
    context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escapeXml(shapePath("rectangle", clipState))}"/></clipPath>`);
    // A soft video draws inside the layer itself and its blur spills past it, as the filter's.
    // A decoded video's faint next picture (videoLead) comes first, where the captured <image>
    // is drawn, so the page keeps that element when the capture takes over.
    if (isMedia && soft) body = `${leadImage ? `<g clip-path="url(#${id})">${rasterBounds}${leadImage}</g>` : ""}${rasterBounds}${body}`;
    else if (isMedia) body = `<g clip-path="url(#${id})">${rasterBounds}${leadImage}${body}</g>`;
    else children = `<g clip-path="url(#${id})">${rasterBounds}${children}</g>`;
  }
  // A live <video> (preview) is not mirrored: Chromium draws no <foreignObject> inside a <use>.
  const liveVideo = layer.type === "video" && context.interactiveMedia && mapValue(context.videoFrames, layer) === undefined;
  if (isMedia && !soft && !liveVideo && Math.max(0, finite(state.blur)) > 0 && coversFrame(state, context)) body = mirroredEdges(body, state, context);
  // The group background sits behind children; its border sits above them. Only the children
  // are clipped, so an outside stroke survives. Transparent, unstyled groups stay child-hit-only.
  if (layer.type === "group" && isFillEnabled(state))
    body = geometry({ type: "rectangle" }, { ...paintState, strokeWidth: 0 }, context);
  if (context.trackBackdrop && node.children.length) {
    const local = inverse(layerMatrix(state));
    const inherited = !isolatesBackdrop(layer, state, context) && local
      ? `<g transform="matrix(${local.map(fmt).join(" ")})">${context.backdrop ?? ""}</g>` : "";
    children = renderSiblings(node.children, { ...context, backdrop: `${inherited}${body}` }, layer.type === "group" && layer.isMaskGroup === true);
    if (layer.clipContent && layer.type === "group") {
      const id = idFor(context, "children-clip");
      context.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escapeXml(shapePath("rectangle", paintState))}"/></clipPath>`);
      children = `<g clip-path="url(#${id})">${rasterBounds}${children}</g>`;
    }
  }
  let border = "";
  if ((isMedia || layer.type === "group") && state.strokeWidth > 0)
    border = geometry({ type: "rectangle" }, { ...paintState, fillEnabled: false }, { ...context, canvas: false, rasterClipBounds: rasterBounds });
  const owner =
    (layer.componentOwnerId ? ` data-component-owner="${escapeXml(layer.componentOwnerId)}"` : "") +
    (layer.componentOwnerId && layer.componentPath ? ` data-component-path="${escapeXml(layer.componentPath)}"` : "");
  let content = `${body}${children}${border}`;
  // A repeater draws the layer's drawing once per copy (repeater.js).
  if (repeaterOf(state)) content = repeatMarkup(content, state, idFor(context, "repeat"));
  // A wipe's edge band draws over the layer's own drawing (wipe.js).
  if (revealRender.band) content = revealRender.band(content);
  content = `${revealRender.sentinel}${content}`;
  let filter = "";
  if (!textHasUnits) {
    content = backdropContent(content, layer, state, context, { mediaContent: body });
    const painted = effectContent(content, layer, state, context, contentBounds(node, state, context), drawnContentBounds(node, state, context));
    content = painted.content;
    const filtered = soft ? { ...state, blur: 0 } : state;
    filter = filterFor(filtered, context, hasFilterEffect(filtered) ? painted.bounds : null);
    context.renderedBounds.set(layer.id, mappedBounds(expandEffectBounds(painted.bounds, state), layerMatrix(state)));
    context.drawnBounds.set(layer.id, mappedBounds(expandEffectBounds(painted.drawn ?? painted.bounds, state), layerMatrix(state)));
  }
  let tag = `<g data-layer-id="${safeId}"${owner}${ahead ? ' visibility="hidden"' : ""} transform="${transform}" opacity="${fmt(opacity)}"${filter}${blend}${revealRender.attribute}>${content}</g>`;
  if (hasTilt(state)) tag = tiltedTag(tag, node, state, context);
  if (!context.design && !ahead && !maskContent) tag = motionSmear(tag, node, state, context);
  if (ahead) {
    // Hidden, it paints nothing: its groups measure it as they measure a hidden layer.
    context.renderedBounds.set(layer.id, null);
    context.drawnBounds.set(layer.id, null);
    return tag;
  }
  if (context.capture?.id === layer.id) {
    const local = inverse(layerMatrix(state));
    if (local) context.capture.result = {
      content: `<g transform="matrix(${local.map(fmt).join(" ")})">${tag}</g>`,
      bounds: mappedBounds(context.renderedBounds.get(layer.id), local) ?? { x: 0, y: 0, width: Math.max(1, state.width), height: Math.max(1, state.height) },
      state,
    };
  }
  if (canCullRasterLayer(state, context)) {
    let painted = mappedBounds(context.renderedBounds.get(layer.id), parentWorldMatrix(state.parentId, context));
    const viewport = context.captureBounds ?? { x: 0, y: 0, width: context.width, height: context.height };
    if (context.captureInverse) painted = mappedBounds(painted, context.captureInverse);
    if (painted && (painted.x + painted.width <= viewport.x || painted.y + painted.height <= viewport.y ||
      painted.x >= viewport.x + viewport.width || painted.y >= viewport.y + viewport.height)) {
      // No output pixel can use this branch. Omitting it also avoids resvg's
      // native abort on filter/clip regions entirely beyond its raster surface.
      context.renderedBounds.set(layer.id, null);
      context.drawnBounds.set(layer.id, null);
      return "";
    }
  }
  return maskContent ? tag : tag;
}

// The preview's motion blur and a whip's smear (previewBlur.js): a layer that moves far enough
// while the shutter is open is smeared along its path. A live <video> or decoder canvas in the
// dashboard is left sharp (Chromium does not filter it the same way).
function motionSmear(tag, node, state, context) {
  const { layer } = node;
  const animations = enabledAnimations(layer.animations);
  if (!animations.length) return tag;
  const shutter = Math.max(context.previewBlur, whipShutter(animations, context.time));
  if (!shutter || holdsLiveVideo(node, context)) return tag;
  // A layer smeared by its own directional, zoom or spin blur right now already shows its motion:
  // the preview adds none on top (a whip-in recipe would smear twice).
  if (smearLength(effectsAt(layer, context.time), state) > 0) return tag;
  const parent = parentWorldMatrix(state.parentId, context);
  const times = previewSampleTimes(context.time, shutter, context.duration);
  const travel = shutterTravel((time) => time === context.time ? state : evaluatedState(layer, { ...context, time }), times, parent);
  if (!travel || travel.pixels < PREVIEW_BLUR_FROM) return tag;
  const bounds = context.renderedBounds.get(layer.id);
  if (!bounds) return tag;
  return smearTag(tag, travel.vector, bounds, { defs: context.defs, id: (kind) => idFor(context, `preview-${kind}`), raster: context.raster,
    transform: multiply(context.rasterMatrix, parent),
    includeBounds: (next) => { context.renderedBounds.set(layer.id, mergeBounds([bounds, next])); } });
}

function holdsLiveVideo(node, context) {
  if (!context.interactiveMedia) return false;
  if (node.layer.type === "video" && mapValue(context.videoFrames, node.layer) === undefined) return true;
  return node.children.some((child) => holdsLiveVideo(child, context));
}

// A layer turned in 3D (rotateX, rotateY; tilt.js): its usual drawing, moved so its pivot sits at
// 0 0, is drawn once per triangle of a grid, each with its own affine transform and clipped to
// its triangle, so the whole reads as the plane seen in perspective. Its painted bounds become
// the projected ones, so groups, culling and effects around it measure the tilted drawing.
function tiltedTag(tag, node, state, context) {
  const { layer } = node;
  const pivot = tiltPivot(state);
  const painted = mergeBounds([context.renderedBounds.get(layer.id) ?? paintBoundsInParent(node, context),
    mappedBounds({ x: 0, y: 0, width: Math.max(0, finite(state.width)), height: Math.max(0, finite(state.height)) }, layerMatrix(state))]);
  if (!painted || !(painted.width > 0) || !(painted.height > 0)) return tag;
  // A pixel of margin keeps the clip edges on transparent paint: the triangles are drawn without
  // anti-aliasing (triangleTiltTag), so the plane's outer edge must cut nothing visible.
  const box = { x: painted.x - pivot.x - 2, y: painted.y - pivot.y - 2, width: painted.width + 4, height: painted.height + 4 };
  const live = liveTiltTag(tag, state, box, pivot, context);
  if (live) {
    const projected = tiltedBounds(state, box);
    const moved = { x: projected.x + pivot.x, y: projected.y + pivot.y, width: projected.width, height: projected.height };
    if (context.renderedBounds.get(layer.id)) context.renderedBounds.set(layer.id, moved);
    if (context.drawnBounds.get(layer.id)) context.drawnBounds.set(layer.id, moved);
    const key = `l${context.liveTilts.size}`;
    context.liveTilts.set(key, () => triangleTiltTag(tag, layer, state, box, pivot, context));
    return live.replace('data-tilt-layer-id=""', `data-tilt-layer-id="${escapeXml(String(layer.id ?? ""))}" data-kino-live-tilt="${key}"`);
  }
  return triangleTiltTag(tag, layer, state, box, pivot, context);
}

// The triangles not wholly off screen (a margin around the scene), for a draft. A triangle is off
// screen when all its corners lie outside one edge of the screen (the screen is convex).
function onScreenTriangles(triangles, state, pivot, context) {
  const back = inverse(parentWorldMatrix(state.parentId, context));
  if (!back) return triangles;
  const margin = 8;
  const screen = [[-margin, -margin], [context.width + margin, -margin], [context.width + margin, context.height + margin], [-margin, context.height + margin]]
    .map(([x, y]) => [back[0] * x + back[2] * y + back[4] - pivot.x, back[1] * x + back[3] * y + back[5] - pivot.y]);
  const area = screen.reduce((sum, [x, y], index) => { const [nx, ny] = screen[(index + 1) % 4]; return sum + x * ny - nx * y; }, 0);
  const turn = area > 0 ? 1 : -1;
  const outside = (points) => screen.some(([x0, y0], index) => {
    const [x1, y1] = screen[(index + 1) % 4];
    return points.every(([x, y]) => turn * ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)) < 0);
  });
  return triangles.filter(({ clip }) => !outside(clip));
}

// A draft (check and look frames) allows the grid's error in output pixels rather than scene
// units, and leaves out the triangles wholly off screen. On a trailer's 64 px check frames a
// tilted page went from 2,048 triangles to a few dozen, and a zoom through one kept about 300.
// Final renders keep the full grid.
// A live <video> (preview) inside a tilted layer: each triangle's <use> copy of the drawing is a
// new media element with its own decoder, yet Chromium draws no <foreignObject> inside a <use>.
// A tilted app recording made hundreds of them a second (2,500 decoder threads) and crashed the
// page, so the triangles draw none: the layer shows its captured frame (videoCaptureWindows).
const LIVE_VIDEO_BOX = /<foreignObject\b[^>]*>(?:(?!<\/foreignObject>)[\s\S])*?<video\b(?:(?!<\/foreignObject>)[\s\S])*<\/foreignObject>/g;

function triangleTiltTag(tag, layer, state, box, pivot, context) {
  if (context.interactiveMedia) tag = tag.replace(LIVE_VIDEO_BOX, "");
  const [rasterX, , , rasterY] = context.rasterMatrix;
  const outputScale = Math.min(1, Math.abs(rasterX), Math.abs(rasterY));
  let { triangles } = tiltTriangles(state, box, context.draft && outputScale > 0 ? TILT_TOLERANCE / outputScale : TILT_TOLERANCE);
  if (context.draft && !context.capture && ancestorsOnlyMove(state, context)) triangles = onScreenTriangles(triangles, state, pivot, context);
  const source = idFor(context, "tilt");
  const clips = [], uses = [];
  // Each triangle is filled with a pattern of its own cell of the drawing (a small tile, where
  // a clip path would cost the renderer a whole-canvas mask per triangle). Crisp edges: neighbors
  // share their edges exactly, so each pixel is painted once (anti-aliased edges let the background
  // through, grown ones painted partly transparent paint twice: a seam either way).
  for (const { matrix, clip, cell } of triangles) {
    const id = idFor(context, "tilt-cell");
    clips.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${fmt(cell.x)}" y="${fmt(cell.y)}" width="${fmt(cell.width)}" height="${fmt(cell.height)}" patternTransform="matrix(${matrix.map(fmt).join(" ")})"><use href="#${source}" transform="translate(${fmt(-cell.x)} ${fmt(-cell.y)})"/></pattern>`);
    uses.push(`<path d="M${clip.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z" fill="url(#${id})" shape-rendering="crispEdges"/>`);
  }
  // The export's Chromium page draws the source once into a bitmap that every triangle shares
  // (desktop/raster-page.cjs, flattenTilts): it says how many output pixels one unit of the flat
  // drawing reaches at most, and which box of it the triangles use. Other renderers ignore it.
  let flatten = "";
  {
    const reach = (matrix) => {
      const [a, b, c, d] = matrix;
      const sum = a * a + b * b + c * c + d * d, det = a * d - b * c;
      return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
    };
    const outer = reach(multiply(context.rasterMatrix, parentWorldMatrix(state.parentId, context)));
    const most = Math.max(0, ...triangles.map(({ matrix }) => reach(matrix))) * outer;
    if (Number.isFinite(most) && most > 0) flatten = ` data-kino-flatten="${fmt(most)}" data-kino-box="${[box.x, box.y, box.width, box.height].map(fmt).join(" ")}"`;
  }
  const projected = tiltedBounds(state, box);
  const moved = { x: projected.x + pivot.x, y: projected.y + pivot.y, width: projected.width, height: projected.height };
  if (context.renderedBounds.has(layer.id) && context.renderedBounds.get(layer.id)) context.renderedBounds.set(layer.id, moved);
  if (context.drawnBounds.has(layer.id) && context.drawnBounds.get(layer.id)) context.drawnBounds.set(layer.id, moved);
  return `<g data-tilt-layer-id="${escapeXml(String(layer.id ?? ""))}" transform="translate(${fmt(pivot.x)} ${fmt(pivot.y)})"><defs>${clips.join("")}<g id="${source}"${flatten}><g transform="translate(${fmt(-pivot.x)} ${fmt(-pivot.y)})">${tag}</g></g></defs>${uses.join("")}</g>`;
}

// FNV-1a over a string: tells the page whether a tilted layer's flat drawing changed.
function textHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36) + text.length.toString(36);
}

// The app's live picture (canvas mode) draws a tilted layer on the GPU (frontend/liveTilt.js): its flat
// drawing once into a bitmap, then one quad with the exact perspective. The triangle grid below
// made the page copy the whole drawing once per triangle (2,048 copies of a page of code took
// over 5 s a frame and grew the window past 2.8 GB). The flat drawing stays here, out of sight,
// for the page to draw. Null where the page could not draw it from an SVG picture (media, live
// <text>, links) or where the eye clamp bends the plane: those keep the triangles.
function liveTiltTag(tag, state, box, pivot, context) {
  if (!context.canvas || context.design) return null;
  // A tilted layer inside this one: its triangles go into this flat drawing instead (the page draws
  // the drawing as an SVG picture, where a canvas shows nothing).
  if (tag.includes("data-kino-live-tilt=")) {
    tag = tag.replace(/<g data-tilt-layer-id="[^"]*" data-kino-live-tilt="(l\d+)"[\s\S]*?<\/foreignObject><\/g>/g, (whole, key) => context.liveTilts.get(key)?.() ?? whole);
    if (tag.includes("data-kino-live-tilt=")) return null;
  }
  if (/<foreignObject|<text[\s>]|<video|<canvas/.test(tag)) return null;
  for (const match of tag.matchAll(/href="([^"]*)"/g)) if (!match[1].startsWith("#") && !match[1].startsWith("data:")) return null;
  // Only the part of the plane in front of the eye and on screen (a margin around the scene).
  const back = inverse(parentWorldMatrix(state.parentId, context));
  if (!back) return null;
  const margin = 8;
  const screen = [[-margin, -margin], [context.width + margin, -margin], [context.width + margin, context.height + margin], [-margin, context.height + margin]]
    .map(([x, y]) => [back[0] * x + back[2] * y + back[4] - pivot.x, back[1] * x + back[3] * y + back[5] - pivot.y]);
  const part = tiltVisiblePart(state, box, screen);
  if (!part) return null;
  // The bitmap's box on the plane: the part's, grown out to a coarse grid (an eighth of its size,
  // a power of 2) within `box`, so a plane that turns a little keeps its bitmap.
  const us = part.plane.map(([u]) => u), vs = part.plane.map(([, v]) => v);
  const step = 2 ** Math.ceil(Math.log2(Math.max(1, Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)) / 8));
  const plane = { x: Math.max(box.x, Math.floor(Math.min(...us) / step) * step), y: Math.max(box.y, Math.floor(Math.min(...vs) / step) * step) };
  plane.width = Math.min(box.x + box.width, Math.ceil(Math.max(...us) / step) * step) - plane.x;
  plane.height = Math.min(box.y + box.height, Math.ceil(Math.max(...vs) / step) * step) - plane.y;
  const xs = part.points.map(([x]) => x), ys = part.points.map(([, y]) => y);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
  if (!(width > 0) || !(height > 0) || !(plane.width > 0) || !(plane.height > 0)) return null;
  // The most units of this layer's parent one unit of the flat drawing reaches: where the plane
  // is nearest the eye. The page multiplies in the parent's own scale on screen.
  const reach = Math.max(...part.points.map(([, , h]) => 1 / h));
  const source = idFor(context, "tilt");
  const attributes = [
    `data-kino-tilt="${source}"`,
    `data-kino-tilt-plane="${[plane.x, plane.y, plane.width, plane.height].map(fmt).join(" ")}"`,
    // Each corner of the part: on screen (x y in the canvas box, h) and on the plane (u v).
    `data-kino-tilt-points="${part.points.map(([x, y, h], index) => [fmt(x - left), fmt(y - top), h.toFixed(6), fmt(part.plane[index][0]), fmt(part.plane[index][1])].join(" ")).join(" ")}"`,
    `data-kino-tilt-reach="${fmt(reach)}"`,
    `data-kino-tilt-key="${textHash(tag)}"`,
  ].join(" ");
  return `<g data-tilt-layer-id="" transform="translate(${fmt(pivot.x)} ${fmt(pivot.y)})"><defs><g id="${source}"><g transform="translate(${fmt(-pivot.x)} ${fmt(-pivot.y)})">${tag}</g></g></defs>` +
    `<foreignObject x="${fmt(left)}" y="${fmt(top)}" width="${fmt(width)}" height="${fmt(height)}"><canvas xmlns="http://www.w3.org/1999/xhtml" ${attributes} style="display:block;width:100%;height:100%"/></foreignObject></g>`;
}

// Adds a <mask> made from a mask layer to the SVG definitions and returns its ID.
function maskDefinition(node, context) {
  const maskId = idFor(context, "mask");
  const maskGraphic = renderLayer(node, context, { maskContent: true });
  context.defs.push(
    // The mask's own area is as large as its black backing: without x, y, width and height it is
    // the frame plus 10% in the masked layer's own units, so a scaled-down group lost what it drew
    // past that (a phone screen's map showed in a band).
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" style="mask-type:luminance"><rect x="-100000" y="-100000" width="200000" height="200000" fill="black"/>${maskGraphic}</mask>`,
  );
  return maskId;
}

// Draws the layers of one parent from the bottom up. A mask layer masks the next visible
// layer. In a mask group (`maskGroup`), the bottom-most mask layer masks every visible layer
// above it instead; layers below it are drawn as usual. A mask that a Hide operation hides at
// this time masks nothing, like a mask whose eye is off (maskVisibility.js).
function renderSiblings(nodes, context, maskGroup = false) {
  const groupMask = maskGroup ? nodes.findIndex((node) => node.layer.isMask) : -1;
  if (groupMask >= 0 && nodes[groupMask].layer.visible !== false &&
    maskSwitchedOff(nodes[groupMask].layer, context.time, context.design))
    return renderSiblings(nodes.filter((_, index) => index !== groupMask), context);
  if (groupMask >= 0 && nodes[groupMask].layer.visible !== false) {
    const below = renderSiblings(nodes.slice(0, groupMask), context);
    const above = nodes.slice(groupMask + 1);
    if (!above.some((node) => node.layer.visible !== false)) return below;
    const maskId = maskDefinition(nodes[groupMask], context);
    return `${below}<g mask="url(#${maskId})">${renderSiblings(above, context.trackBackdrop ? { ...context, backdrop: `${context.backdrop ?? ""}${below}` } : context)}</g>`;
  }
  const visible = nodes.filter((node) => node.layer.visible !== false);
  const output = [];
  for (let index = 0; index < visible.length; index += 1) {
    const node = visible[index];
    const drawContext = context.trackBackdrop ? { ...context, backdrop: `${context.backdrop ?? ""}${output.join("")}` } : context;
    if (node.layer.isMask) {
      const target = visible[index + 1];
      if (!target || target.layer.isMask)
        throw new Error(
          `Mask layer “${node.layer.name ?? node.layer.id}” needs a following visible layer. Put the layer to mask just above it: move_layers {layers:["<layer>"], position:"above", referenceId:${JSON.stringify(node.layer.name ?? node.layer.id)}, mask:true}.`,
        );
      index += 1;
      if (maskSwitchedOff(node.layer, context.time, context.design)) {
        output.push(renderLayer(target, drawContext));
        continue;
      }
      const maskId = maskDefinition(node, context);
      // The mask and target share their parent's coordinates. Attach the mask
      // outside the target's transform so moving the target does not move it twice.
      output.push(`<g mask="url(#${maskId})">${renderLayer(target, drawContext)}</g>`);
      continue;
    }
    output.push(renderLayer(node, drawContext));
  }
  return output.join("");
}

export function renderLayerSvg(layer, time = 0, options = {}) {
  const scene = {
    width: layer.width || 1,
    height: layer.height || 1,
    background: "transparent",
    layers: [layer],
  };
  return renderSceneSvg(scene, time, options);
}

// `canvas` is true only when drawing the editor canvas (Stage.jsx), where shapes whose Fill is
// off keep a clickable inside (offFillClickArea). `mediaTime` is the scene time whose footage
// pictures videos and GIFs show; motion blur sets it to the output frame's time (see mediaClock).
// `luts` is a Map of .cube src → parsed LUT (null while loading, { error } when unusable) for the
// lut effect: the export loads it from the media folder, the dashboard with useSceneLuts.
// `calmLight` (the dashboard preview under reduced motion) calms short Light bursts such as a
// glow flashing on a beat (calmLightAnimations in effects/light.js); exports never set it.
export function renderSceneSvg(
  scene,
  time = 0,
  { design = false, embedMedia, videoFrames, decodedVideos, videoLead, imageFrames, interactiveMedia = false, canvas = false, raster = false, rasterScale = { x: 1, y: 1 }, fonts = defaultFonts, idPrefix = "", capture, mediaTime = time, luts, calmLight = false, draft = false, previewBlur = false } = {},
) {
  if (!scene || !Array.isArray(scene.layers))
    throw new TypeError("A scene with a layers array is required.");
  const width = Math.max(
    1,
    Math.round(checkedNumber(scene.width, 1, 1, 100000)),
  );
  const height = Math.max(
    1,
    Math.round(checkedNumber(scene.height, 1, 1, 100000)),
  );
  const context = {
    width, height,
    layersById: new Map(scene.layers.map((layer) => [layer.id, layer])),
    worldMatrices: new Map(),
    time: finite(time),
    mediaTime: finite(mediaTime),
    design: Boolean(design),
    embedMedia,
    videoFrames, decodedVideos, videoLead,
    imageFrames,
    interactiveMedia: Boolean(interactiveMedia),
    canvas: Boolean(canvas),
    raster: Boolean(raster),
    draft: Boolean(draft),
    rasterMatrix: [checkedNumber(rasterScale.x, 1, 0.000001, 100000), 0, 0, checkedNumber(rasterScale.y, 1, 0.000001, 100000), 0, 0],
    fonts,
    // Multiple inline artboards share the browser's SVG ID namespace. Hex-encode the caller's
    // stable instance prefix so punctuation cannot collide or escape a url(#...) reference.
    idPrefix: idPrefix ? `svg-${Array.from(String(idPrefix), (char) => char.codePointAt(0).toString(16)).join("-")}-` : "",
    ids: { sequence: 0 },
    defs: [],
    effectFrames: new Map(),
    // Layer -> its state at a time, worked out once a drawing (getAnimatedLayer).
    animated: new Map(),
    renderedBounds: new Map(),
    drawnBounds: new Map(),
    // Live tilted layer id -> a function that draws it as triangles (liveTiltTag).
    liveTilts: new Map(),
    capture,
    // Map of .cube LUT src → parsed LUT (parseCubeLut), null while it loads, or { error }.
    luts,
    // Reduced motion in the dashboard preview: short Light bursts are drawn calmly (light.js).
    calmLight: Boolean(calmLight),
    // The motion-blur preview's shutter in seconds, 0 when off (previewBlur.js). Never in Design.
    previewBlur: design ? 0 : previewShutter(previewBlur),
    duration: Number.isFinite(scene.duration) && scene.duration > 0 ? scene.duration : Infinity,
  };
  if (capture) {
    const target = context.layersById.get(capture.id);
    if (!target) throw new RangeError(`Layer “${capture.id}” could not be captured.`);
    const state = resizeTextLayer(getAnimatedLayer(target, context), context.fonts);
    context.captureInverse = inverse(multiply(parentWorldMatrix(state.parentId, context), layerMatrix(state)));
    if (!context.captureInverse) {
      capture.result = { content: "", bounds: { x: 0, y: 0, width: 1, height: 1 }, state };
      return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    }
    context.captureBounds = capture.bounds ?? { x: 0, y: 0, width: Math.max(1, state.width), height: Math.max(1, state.height) };
    context.rasterMatrix = multiply(context.rasterMatrix, multiply(
      [1, 0, 0, 1, -context.captureBounds.x, -context.captureBounds.y], context.captureInverse));
  }
  const roots = makeTree(scene.layers);
  if (context.interactiveMedia && !context.design) context.videoHolders = videoHolderIds(roots, context);
  context.trackBackdrop = scene.layers.some((layer) => {
    const state = shownState(layer, context);
    return state.backgroundBlur?.enabled || state.glass?.enabled;
  });
  const paint = backgroundPaintAt(scene, context.time, { design: context.design });
  let background;
  const sceneBackground = () => paint === null ? "transparent" : typeof paint === "string"
    ? safeColor(paint, "transparent")
    : paintFor({ fill: paint, name: "Scene background" }, context, { x: 0, y: 0, width, height });
  if (context.trackBackdrop) {
    background = sceneBackground();
    context.backdrop = `<rect width="${width}" height="${height}" fill="${escapeXml(background)}"/>`;
  }
  const layers = renderSiblings(roots, context);
  background ??= sceneBackground();
  const definitions = context.defs.length
    ? `<defs>${context.defs.join("")}</defs>`
    : "";
  if (capture) capture.definitions = context.defs;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${definitions}<rect data-scene-background="true" width="${width}" height="${height}" fill="${escapeXml(background)}"/>${layers}</svg>`;
}

export { normalizeHref as normalizeMediaHref };

function captureDefinitions(content, definitions) {
  const byId = new Map();
  definitions.forEach((definition, index) => {
    for (const match of definition.matchAll(/\bid="([^"]+)"/g)) byId.set(match[1], index);
  });
  const needed = new Set();
  const visit = (markup) => {
    const references = [...markup.matchAll(/url\(#([^\s)]+)\)|(?:href|xlink:href)="#([^"]+)"/g)];
    for (const match of references) {
      const index = byId.get(match[1] ?? match[2]);
      if (index === undefined || needed.has(index)) continue;
      needed.add(index);
      visit(definitions[index]);
    }
  };
  visit(content);
  return definitions.filter((_, index) => needed.has(index)).join("");
}

/**
 * Paint one complete layer subtree in its own coordinates, with its real
 * lower-layer backdrop. Ancestor transforms/opacity/mattes remain the caller's
 * responsibility. The first SVG pass measures effect overflow; the second uses
 * the exact cropped raster viewport so native filter maps get the right affine
 * sampling and clip sentinels. This is the shared Lottie raster fallback input.
 */
export function captureLayerSvg(scene, layerId, time = 0, options = {}) {
  const capture = { id: layerId };
  renderSceneSvg(scene, time, { ...options, canvas: false, interactiveMedia: false, raster: false, capture });
  const found = capture.result;
  const raw = found?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.floor(raw.x - 1), y = Math.floor(raw.y - 1);
  const bounds = { x, y, width: Math.max(1, Math.ceil(raw.x + raw.width + 1) - x), height: Math.max(1, Math.ceil(raw.y + raw.height + 1) - y) };
  const scale = options.rasterScale ?? { x: 1, y: 1 };
  const width = Math.max(1, Math.round(bounds.width * checkedNumber(scale.x, 1, 0.000001, 100000)));
  const height = Math.max(1, Math.round(bounds.height * checkedNumber(scale.y, 1, 0.000001, 100000)));
  const measured = { id: layerId, bounds };
  renderSceneSvg(scene, time, { ...options, canvas: false, interactiveMedia: false, raster: options.raster !== false,
    rasterScale: { x: width / bounds.width, y: height / bounds.height }, capture: measured });
  const content = measured.result?.content ?? "";
  const defs = captureDefinitions(content, measured.definitions ?? []);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><defs>${defs}</defs>${content}</svg>`;
  return { svg, bounds, width, height, state: measured.result?.state ?? found?.state ?? null };
}
